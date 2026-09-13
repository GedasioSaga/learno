#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::trilha` contra um banco SQLite real.
//!
//! Nenhum teste aqui precisa de `#[ignore]`: cada um cria seu próprio arquivo
//! SQLite descartável via `support::IsolatedDatabase`, já migrado, numa
//! pasta temporária — mesmo padrão de todo outro `tests/db_*.rs` deste crate.
//!
//! Nenhuma migração é escrita por este arquivo (0023 já existe e está
//! aplicada). A maioria dos fixtures ainda insere `databases`/
//! `database_views`/`database_properties` por SQL cru — mesma convenção que
//! `tests/db_relations.rs` já usa (comentário lá explica com mais detalhe) —
//! mesmo com `db::databases::DatabaseRepository` já existindo neste crate;
//! trocar cada fixture por ele é refator fora do escopo desta peça. Os
//! testes de `criar_trilha_completa` são a exceção de propósito: exercitam
//! esse repositório pela API pública, porque é exatamente o que aquele
//! método reusa. Toda escrita em `database_record_values` (valor de raia)
//! passa por `RecordValueRepository` — o único caminho de escrita daquela
//! tabela (I4) — e toda escrita em `database_record_dependencies` (flecha)
//! passa por `TrilhaRepository::criar_flecha`/`apagar_flecha` — os dois
//! únicos caminhos de escrita dessas tabelas, nunca SQL cru, mesmo aqui em
//! teste.

mod support;

use learno_lib::db::{
    IdBind, PageRepository, RecordValueChangeInput, RecordValueRepository, SiblingPosition, SituacaoNoCaminho,
    TrilhaRepository,
};
use learno_lib::Error;
use serde_json::json;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// --- Fixtures --------------------------------------------------------------

async fn create_page(pool: &SqlitePool, title: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, $2, 'a0')")
        .bind(id.db())
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_database(pool: &SqlitePool, container_page_id: Uuid, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, $3)")
        .bind(id.db())
        .bind(container_page_id.db())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_trail_database_view(pool: &SqlitePool, database_id: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO database_views (id, database_id, name, view_type, position) \
         VALUES ($1, $2, 'Trilha', 'trail', 'a0')",
    )
    .bind(id.db())
    .bind(database_id.db())
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn create_select_property(pool: &SqlitePool, database_id: Uuid, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO database_properties (id, database_id, name, property_type, position) VALUES ($1, $2, $3, 'select', 'a0')")
        .bind(id.db())
        .bind(database_id.db())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

/// Uma etapa: página-registro (`database_id` setado).
async fn create_step(pool: &SqlitePool, database_id: Uuid, title: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, $3, 'a0')")
        .bind(id.db())
        .bind(database_id.db())
        .bind(title)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_deck(pool: &SqlitePool, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO decks (id, name, position) VALUES ($1, $2, 'a0')").bind(id.db()).bind(name).execute(pool).await.unwrap();
    id
}

/// A ÚNICA forma permitida de gravar o valor da propriedade de raia numa
/// etapa — passa por `RecordValueRepository` (I4), nunca por SQL cru, mesmo
/// dentro de um teste.
async fn set_lane_value(pool: &SqlitePool, step_id: Uuid, property_id: Uuid, value: &str) {
    let repo = RecordValueRepository::new(pool.clone());
    repo.apply_record_value_changes(vec![RecordValueChangeInput { record_id: step_id, property_id, value: json!(value) }])
        .await
        .unwrap();
}

// --- 1. Leitura da trilha inteira ------------------------------------------

#[tokio::test]
async fn leitura_da_trilha_devolve_raias_etapas_flechas_progresso_e_materiais_coerentes() {
    let db = IsolatedDatabase::setup("leitura-coerente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let databricks = create_step(&db.pool, database_id, "Databricks").await;
    let azure = create_step(&db.pool, database_id, "Azure").await;
    set_lane_value(&db.pool, databricks, group_property, "T.I.").await;
    set_lane_value(&db.pool, azure, group_property, "T.I.").await;
    // Azure é bloqueada por Databricks — a flecha vai de databricks -> azure.
    trilha.criar_flecha(azure, databricks, None).await.unwrap();

    trilha.marcar_progresso_etapa(databricks, "done").await.unwrap();

    let material_alvo = create_page(&db.pool, "Doc do Databricks").await;
    trilha.anexar_material_etapa(databricks, "page", Some(material_alvo), None).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();

    assert_eq!(cena.raias.len(), 1);
    assert_eq!(cena.raias[0].lane_value, "T.I.");

    assert_eq!(cena.etapas.len(), 2);
    let etapa_databricks = cena.etapas.iter().find(|e| e.id == databricks).unwrap();
    let etapa_azure = cena.etapas.iter().find(|e| e.id == azure).unwrap();

    assert_eq!(etapa_databricks.lane_value, "T.I.");
    assert_eq!(etapa_databricks.state.as_deref(), Some("done"));
    assert!(etapa_databricks.is_unlocked, "sem bloqueadora, nasce disponível");
    assert_eq!(etapa_databricks.level, 0);

    assert_eq!(etapa_azure.lane_value, "T.I.");
    assert_eq!(etapa_azure.state, None, "azure não foi marcada, não iniciada é ausência de linha");
    assert!(etapa_azure.is_unlocked, "databricks (bloqueadora) já está done");
    assert_eq!(etapa_azure.level, 1);

    assert_eq!(cena.flechas.len(), 1);
    assert_eq!(cena.flechas[0].blocked_id, azure);
    assert_eq!(cena.flechas[0].blocking_id, databricks);

    assert_eq!(cena.materiais.len(), 1);
    assert_eq!(cena.materiais[0].step_id, databricks);
    assert_eq!(cena.materiais[0].page_id, Some(material_alvo));

    db.teardown().await;
}

// --- 2. Nível topológico: cadeia, árvore, isolada, dois ciclos -------------

#[tokio::test]
async fn nivel_topologico_cobre_cadeia_arvore_isolada_e_dois_ciclos() {
    let db = IsolatedDatabase::setup("niveis").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Grafo").await;
    let database_id = create_database(&db.pool, container, "Grafo").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    // Cadeia simples: a -> b -> c (níveis 0, 1, 2).
    let a = create_step(&db.pool, database_id, "a").await;
    let b = create_step(&db.pool, database_id, "b").await;
    let c = create_step(&db.pool, database_id, "c").await;
    trilha.criar_flecha(b, a, None).await.unwrap();
    trilha.criar_flecha(c, b, None).await.unwrap();

    // Etapa solta: nível 0.
    let isolada = create_step(&db.pool, database_id, "isolada").await;

    // Árvore que se junta: e e f bloqueiam g (nível 2, o maior + 1).
    let e = create_step(&db.pool, database_id, "e").await;
    let f = create_step(&db.pool, database_id, "f").await;
    let g = create_step(&db.pool, database_id, "g").await;
    trilha.criar_flecha(f, e, None).await.unwrap(); // e -> f (f fica nível 1)
    trilha.criar_flecha(g, e, None).await.unwrap();
    trilha.criar_flecha(g, f, None).await.unwrap();

    // Ciclo de dois.
    let h = create_step(&db.pool, database_id, "h").await;
    let i = create_step(&db.pool, database_id, "i").await;
    trilha.criar_flecha(h, i, None).await.unwrap();
    trilha.criar_flecha(i, h, None).await.unwrap();

    // Ciclo de três.
    let j = create_step(&db.pool, database_id, "j").await;
    let k = create_step(&db.pool, database_id, "k").await;
    let l = create_step(&db.pool, database_id, "l").await;
    trilha.criar_flecha(k, j, None).await.unwrap();
    trilha.criar_flecha(l, k, None).await.unwrap();
    trilha.criar_flecha(j, l, None).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    let nivel = |id: Uuid| cena.etapas.iter().find(|etapa| etapa.id == id).unwrap().level;
    let em_ciclo = |id: Uuid| cena.etapas.iter().find(|etapa| etapa.id == id).unwrap().in_cycle;

    assert_eq!(nivel(a), 0);
    assert_eq!(nivel(b), 1);
    assert_eq!(nivel(c), 2);
    assert_eq!(nivel(isolada), 0);
    assert_eq!(nivel(e), 0);
    assert_eq!(nivel(f), 1);
    assert_eq!(nivel(g), 2);

    assert!(em_ciclo(h) && em_ciclo(i));
    assert!(em_ciclo(j) && em_ciclo(k) && em_ciclo(l));
    assert!(!em_ciclo(a) && !em_ciclo(isolada) && !em_ciclo(g));

    db.teardown().await;
}

// --- 3. TRL-003: apagar a dependência apaga a flecha ------------------------

#[tokio::test]
async fn apagar_a_dependencia_pela_tabela_de_0020_faz_a_flecha_sumir_da_trilha() {
    let db = IsolatedDatabase::setup("flecha-some").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let a = create_step(&db.pool, database_id, "a").await;
    let b = create_step(&db.pool, database_id, "b").await;
    trilha.criar_flecha(b, a, None).await.unwrap();

    let antes = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(antes.flechas.len(), 1, "a flecha precisa existir antes de apagar a dependência");
    assert_eq!(antes.etapas.iter().find(|e| e.id == b).unwrap().level, 1);

    trilha.apagar_flecha(b, a).await.unwrap();

    let depois = trilha.obter_trilha(view_id).await.unwrap();
    assert!(depois.flechas.is_empty(), "TRL-003: a flecha é a MESMA aresta — apagá-la some da trilha");
    assert_eq!(depois.etapas.iter().find(|e| e.id == b).unwrap().level, 0, "sem bloqueadora, b volta ao nível 0");

    db.teardown().await;
}

// --- 4. Apagar a view: cascata na config/raias, páginas-etapa sobrevivem ---

#[tokio::test]
async fn apagar_a_view_apaga_configuracao_e_raias_em_cascata_mas_nao_as_paginas_etapa() {
    let db = IsolatedDatabase::setup("apaga-view").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;

    sqlx::query("DELETE FROM database_views WHERE id = $1").bind(view_id.db()).execute(&db.pool).await.unwrap();

    let trail_views_restantes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_views WHERE view_id = $1").bind(view_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(trail_views_restantes, 0, "a configuração da trilha precisa cair junto com a view");

    let raias_restantes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_lanes WHERE view_id = $1").bind(view_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(raias_restantes, 0, "as raias precisam cair junto com a view");

    let pagina_ainda_existe: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = $1").bind(etapa.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(pagina_ainda_existe, 1, "a página-etapa NÃO pode ser apagada — ela não pertence à view, à trilha");

    assert!(trilha.obter_trilha(view_id).await.is_err(), "sem trail_views, obter_trilha não acha mais a trilha");

    db.teardown().await;
}

// --- 5. Material órfão não derruba a leitura -------------------------------

#[tokio::test]
async fn material_apontando_para_baralho_apagado_nao_derruba_a_leitura_da_trilha() {
    let db = IsolatedDatabase::setup("material-orfao").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    let deck_id = create_deck(&db.pool, "Databricks — flashcards").await;
    trilha.anexar_material_etapa(etapa, "deck", None, Some(deck_id)).await.unwrap();

    sqlx::query("DELETE FROM decks WHERE id = $1").bind(deck_id.db()).execute(&db.pool).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena.materiais.is_empty(), "o vínculo caiu junto com o baralho via ON DELETE CASCADE");
    assert_eq!(cena.etapas.len(), 1, "a etapa continua existindo mesmo com o material órfão removido");

    db.teardown().await;
}

// --- 6. Trilha vazia é estado válido ---------------------------------------

#[tokio::test]
async fn trilha_recem_criada_sem_raia_e_sem_etapa_e_estado_valido_nao_erro() {
    let db = IsolatedDatabase::setup("trilha-vazia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena.raias.is_empty());
    assert!(cena.etapas.is_empty());
    assert!(cena.flechas.is_empty());
    assert!(cena.materiais.is_empty());

    db.teardown().await;
}

// --- Progresso: marcar, recusar conclusão bloqueada, desmarcar ------------

#[tokio::test]
async fn marcar_progresso_recusa_concluir_etapa_bloqueada_e_aceita_apos_a_bloqueadora_terminar() {
    let db = IsolatedDatabase::setup("progresso-bloqueio").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let databricks = create_step(&db.pool, database_id, "Databricks").await;
    let azure = create_step(&db.pool, database_id, "Azure").await;
    trilha.criar_flecha(azure, databricks, None).await.unwrap();

    assert!(!trilha.etapa_esta_desbloqueada(azure).await.unwrap());
    let recusado = trilha.marcar_progresso_etapa(azure, "done").await;
    assert!(recusado.is_err(), "não pode concluir azure enquanto databricks não está done");

    // `in_progress`, ao contrário, é aceito mesmo bloqueada.
    trilha.marcar_progresso_etapa(azure, "in_progress").await.unwrap();

    trilha.marcar_progresso_etapa(databricks, "done").await.unwrap();
    assert!(trilha.etapa_esta_desbloqueada(azure).await.unwrap());
    let concluido = trilha.marcar_progresso_etapa(azure, "done").await.unwrap();
    assert_eq!(concluido.state, "done");
    assert!(concluido.completed_at.is_some());

    trilha.desmarcar_progresso_etapa(azure).await.unwrap();
    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.iter().find(|e| e.id == azure).unwrap().state, None, "desmarcar volta para ausência de linha");

    db.teardown().await;
}

// --- Raia: criar, renomear (reescreve os valores), reordenar, recolher ----

#[tokio::test]
async fn renomear_raia_reescreve_o_valor_em_toda_etapa_e_migra_a_configuracao() {
    let db = IsolatedDatabase::setup("renomear-raia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    set_lane_value(&db.pool, etapa, group_property, "T.I.").await;

    let raia_renomeada = trilha.renomear_raia(view_id, "T.I.", "Tecnologia").await.unwrap();
    assert_eq!(raia_renomeada.lane_value, "Tecnologia");

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.raias.len(), 1);
    assert_eq!(cena.raias[0].lane_value, "Tecnologia");
    assert_eq!(cena.etapas.iter().find(|e| e.id == etapa).unwrap().lane_value, "Tecnologia");

    db.teardown().await;
}

#[tokio::test]
async fn mover_etapa_para_raia_grava_o_novo_valor_e_a_leitura_reflete() {
    let db = IsolatedDatabase::setup("mover-etapa").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();
    trilha.criar_raia(view_id, "Inglês").await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    set_lane_value(&db.pool, etapa, group_property, "T.I.").await;

    trilha.mover_etapa_para_raia(etapa, view_id, "Inglês").await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.iter().find(|e| e.id == etapa).unwrap().lane_value, "Inglês");

    db.teardown().await;
}

#[tokio::test]
async fn reordenar_e_recolher_raia() {
    let db = IsolatedDatabase::setup("reordenar-raia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    trilha.criar_raia(view_id, "T.I.").await.unwrap();
    trilha.criar_raia(view_id, "Inglês").await.unwrap();

    // Inglês nasceu depois de T.I., então a ordem natural é [T.I., Inglês].
    // Reordena Inglês para antes de T.I. (após `None`, isto é, primeira).
    trilha.reordenar_raia(view_id, "Inglês", None).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.raias[0].lane_value, "Inglês");
    assert_eq!(cena.raias[1].lane_value, "T.I.");

    let recolhida = trilha.definir_raia_recolhida(view_id, "Inglês", true).await.unwrap();
    assert!(recolhida.is_collapsed);

    db.teardown().await;
}

// --- Material: anexar e remover explicitamente -----------------------------

#[tokio::test]
async fn anexar_e_remover_material_da_etapa() {
    let db = IsolatedDatabase::setup("material-crud").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    let pagina_material = create_page(&db.pool, "Doc").await;

    let material = trilha.anexar_material_etapa(etapa, "page", Some(pagina_material), None).await.unwrap();
    assert_eq!(material.step_id, etapa);

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.materiais.len(), 1);

    trilha.remover_material_etapa(material.id).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena.materiais.is_empty());

    // Um material apontando para a própria etapa é recusado.
    let auto_referencia = trilha.anexar_material_etapa(etapa, "page", Some(etapa), None).await;
    assert!(auto_referencia.is_err());

    db.teardown().await;
}

// --- Flecha: criar, regras de validação, idempotência, ciclo permitido ----

#[tokio::test]
async fn criar_flecha_recusa_registros_de_databases_diferentes() {
    let db = IsolatedDatabase::setup("flecha-databases-diferentes").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container_a = create_page(&db.pool, "Container A").await;
    let database_a = create_database(&db.pool, container_a, "A").await;
    let etapa_a = create_step(&db.pool, database_a, "Databricks").await;

    let container_b = create_page(&db.pool, "Container B").await;
    let database_b = create_database(&db.pool, container_b, "B").await;
    let etapa_b = create_step(&db.pool, database_b, "Azure").await;

    let resultado = trilha.criar_flecha(etapa_b, etapa_a, None).await;
    assert!(matches!(resultado, Err(learno_lib::error::Error::Invalid(_))), "obtido: {resultado:?}");

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM database_record_dependencies").fetch_one(&db.pool).await.unwrap();
    assert_eq!(total, 0, "a flecha inválida não pode ter sido gravada");

    db.teardown().await;
}

#[tokio::test]
async fn criar_flecha_recusa_auto_referencia() {
    let db = IsolatedDatabase::setup("flecha-auto-referencia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let etapa = create_step(&db.pool, database_id, "Databricks").await;

    let resultado = trilha.criar_flecha(etapa, etapa, None).await;
    assert!(matches!(resultado, Err(learno_lib::error::Error::Invalid(_))), "obtido: {resultado:?}");

    db.teardown().await;
}

#[tokio::test]
async fn criar_flecha_recusa_etapa_que_nao_existe() {
    let db = IsolatedDatabase::setup("flecha-etapa-inexistente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    let inexistente = Uuid::now_v7();

    let resultado = trilha.criar_flecha(etapa, inexistente, None).await;
    assert!(matches!(resultado, Err(learno_lib::error::Error::NotFound(_))), "obtido: {resultado:?}");

    db.teardown().await;
}

#[tokio::test]
async fn criar_flecha_recusa_pagina_que_nao_e_registro() {
    let db = IsolatedDatabase::setup("flecha-pagina-comum").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    let pagina_comum = create_page(&db.pool, "Não é registro de nenhuma database").await;

    let resultado = trilha.criar_flecha(etapa, pagina_comum, None).await;
    assert!(matches!(resultado, Err(learno_lib::error::Error::Invalid(_))), "obtido: {resultado:?}");

    db.teardown().await;
}

#[tokio::test]
async fn criar_a_mesma_flecha_duas_vezes_e_idempotente() {
    let db = IsolatedDatabase::setup("flecha-idempotente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let a = create_step(&db.pool, database_id, "a").await;
    let b = create_step(&db.pool, database_id, "b").await;

    trilha.criar_flecha(b, a, None).await.unwrap();
    // O usuário arrastando a mesma ligação de novo não fez nada errado.
    trilha.criar_flecha(b, a, None).await.unwrap();

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM database_record_dependencies").fetch_one(&db.pool).await.unwrap();
    assert_eq!(total, 1, "criar a mesma flecha duas vezes não pode duplicar a linha");

    db.teardown().await;
}

#[tokio::test]
async fn apagar_flecha_que_nao_existe_e_idempotente() {
    let db = IsolatedDatabase::setup("apagar-flecha-inexistente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let a = create_step(&db.pool, database_id, "a").await;
    let b = create_step(&db.pool, database_id, "b").await;

    // Nunca existiu flecha nenhuma entre a e b — apagar não é erro.
    trilha.apagar_flecha(b, a).await.unwrap();

    db.teardown().await;
}

/// O cenário completo pedido: cria a trilha, cria três etapas, liga
/// A -> B -> C (níveis 0, 1, 2), fecha o ciclo C -> A (as três ficam
/// `in_cycle`, DECISÃO: `criar_flecha` PERMITE a aresta que fecha o ciclo —
/// ver o comentário daquela função), e depois apaga a flecha do meio (os
/// níveis se recalculam, o ciclo desfaz).
#[tokio::test]
async fn criar_flecha_permite_fechar_ciclo_e_apagar_flecha_recalcula_niveis() {
    let db = IsolatedDatabase::setup("flecha-fecha-ciclo").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let a = create_step(&db.pool, database_id, "a").await;
    let b = create_step(&db.pool, database_id, "b").await;
    let c = create_step(&db.pool, database_id, "c").await;

    // A -> B -> C: a bloqueia b, b bloqueia c.
    trilha.criar_flecha(b, a, None).await.unwrap();
    trilha.criar_flecha(c, b, None).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    let nivel = |cena: &learno_lib::db::Trilha, id: Uuid| cena.etapas.iter().find(|e| e.id == id).unwrap().level;
    assert_eq!(nivel(&cena, a), 0);
    assert_eq!(nivel(&cena, b), 1);
    assert_eq!(nivel(&cena, c), 2);
    assert!(cena.etapas.iter().all(|e| !e.in_cycle), "sem ciclo ainda");

    // Fecha o ciclo: c bloqueia a.
    trilha.criar_flecha(a, c, None).await.unwrap();

    let cena_com_ciclo = trilha.obter_trilha(view_id).await.unwrap();
    let em_ciclo = |id: Uuid| cena_com_ciclo.etapas.iter().find(|e| e.id == id).unwrap().in_cycle;
    assert!(em_ciclo(a) && em_ciclo(b) && em_ciclo(c), "as três etapas do ciclo precisam ficar in_cycle");

    // Apaga a flecha do meio (b bloqueada por a). Sobram duas arestas —
    // b bloqueia c, c bloqueia a — que não fecham mais ciclo nenhum: viram
    // a cadeia b -> c -> a, níveis 0, 1, 2.
    trilha.apagar_flecha(b, a).await.unwrap();

    let cena_recalculada = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena_recalculada.etapas.iter().all(|e| !e.in_cycle), "sem a flecha do meio, o ciclo desfaz");
    let nivel_recalculado = |id: Uuid| cena_recalculada.etapas.iter().find(|e| e.id == id).unwrap().level;
    assert_eq!(nivel_recalculado(b), 0, "b não tem mais bloqueadora");
    assert_eq!(nivel_recalculado(c), 1, "c continua bloqueada por b");
    assert_eq!(nivel_recalculado(a), 2, "a continua bloqueada por c, que agora está no nível 1");

    db.teardown().await;
}

// --- Criar trilha completa: database + view + config num passo -------------

#[tokio::test]
async fn criar_trilha_completa_cria_database_view_e_configuracao_alcancaveis() {
    let db = IsolatedDatabase::setup("trilha-completa-feliz").await;
    let trilha = TrilhaRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "Estudos").await;

    let criada = trilha.criar_trilha_completa(container, "Estudos", "Trilha", None).await.unwrap();

    assert!(criada.trilha.raias.is_empty());
    assert!(criada.trilha.etapas.is_empty());

    let view_id = criada.trilha.configuracao.view_id;
    // A trilha precisa ser alcançável por `obter_trilha` de verdade, não só
    // devolvida na resposta do comando.
    let relida = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(relida.configuracao.view_id, view_id);

    let nome_database: String =
        sqlx::query_scalar("SELECT name FROM databases WHERE id = $1").bind(criada.database_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(nome_database, "Estudos");

    let tipo_view: String =
        sqlx::query_scalar("SELECT view_type FROM database_views WHERE id = $1").bind(view_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(tipo_view, "trail");

    db.teardown().await;
}

/// A prova da regra: força a falha no ÚLTIMO passo (config da Trilha, via
/// `group_property_id` que não existe — viola a FK de `trail_views`) e
/// confirma que a database e a view criadas nos passos ANTERIORES também
/// não sobraram — a compensação (ver o comentário de `criar_trilha_completa`
/// sobre por que é compensação e não `ROLLBACK`) desfaz tudo.
#[tokio::test]
async fn criar_trilha_completa_desfaz_tudo_quando_o_ultimo_passo_falha() {
    let db = IsolatedDatabase::setup("trilha-completa-falha").await;
    let trilha = TrilhaRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "Estudos").await;

    let propriedade_inexistente = Uuid::now_v7();
    let resultado = trilha.criar_trilha_completa(container, "Estudos", "Trilha", Some(propriedade_inexistente)).await;
    assert!(resultado.is_err(), "group_property_id inexistente precisa falhar a FK de trail_views");

    let databases_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM databases").fetch_one(&db.pool).await.unwrap();
    assert_eq!(databases_restantes, 0, "a database do passo 1 precisa ter sido desfeita");

    let views_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_views").fetch_one(&db.pool).await.unwrap();
    assert_eq!(views_restantes, 0, "a view do passo 2 precisa ter sido desfeita junto");

    let trail_views_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trail_views").fetch_one(&db.pool).await.unwrap();
    assert_eq!(trail_views_restantes, 0, "o passo 3 falhou e não pode ter deixado linha nenhuma");

    // A página container, que EXISTIA ANTES da chamada, não é afetada — só
    // o que este método criou é desfeito.
    let container_sobrevive: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = $1").bind(container.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(container_sobrevive, 1);

    db.teardown().await;
}

// --- Criar etapa: registro + já na raia, num passo --------------------------

#[tokio::test]
async fn criar_etapa_cria_o_registro_e_ja_coloca_na_raia_nomeada() {
    let db = IsolatedDatabase::setup("criar-etapa-com-raia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let etapa = trilha.criar_etapa(view_id, "Databricks", "T.I.").await.unwrap();

    assert_eq!(etapa.title, "Databricks");
    assert_eq!(etapa.lane_value, "T.I.");
    assert_eq!(etapa.level, 0);
    assert!(etapa.is_unlocked, "etapa recém-criada sem bloqueadora nasce disponível");
    assert_eq!(etapa.state, None);

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.len(), 1);
    assert_eq!(cena.etapas[0].lane_value, "T.I.");

    db.teardown().await;
}

/// A recusa acontece ANTES de gravar, não depois.
///
/// `create_record` comita sozinho, então recusar só na segunda escrita
/// deixava a página-registro no banco para sempre — uma etapa fantasma em
/// `obter_trilha`, com a tela tendo recebido erro e concluído que nada mudou.
/// O caso é alcançável sem malícia: `criar_raia` não exige propriedade de
/// agrupamento para nomear a raia, então dá para nomear uma e pedir etapa nela.
#[tokio::test]
async fn criar_etapa_com_raia_nomeada_sem_agrupamento_recusa_e_nao_deixa_registro_orfao() {
    let db = IsolatedDatabase::setup("criar-etapa-orfa").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    // Trilha SEM propriedade de agrupamento — estado válido (TRL-014).
    trilha.criar_trilha(view_id, None).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let paginas_antes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages").fetch_one(&db.pool).await.unwrap();

    let resultado = trilha.criar_etapa(view_id, "Databricks", "T.I.").await;
    assert!(matches!(resultado, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {resultado:?}");

    let paginas_depois: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages").fetch_one(&db.pool).await.unwrap();
    assert_eq!(paginas_depois, paginas_antes, "a recusa não pode ter gravado página-registro nenhuma");

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena.etapas.is_empty(), "nenhuma etapa fantasma pode aparecer na trilha");

    db.teardown().await;
}

#[tokio::test]
async fn criar_etapa_com_raia_vazia_nao_exige_propriedade_de_agrupamento() {
    let db = IsolatedDatabase::setup("criar-etapa-sem-raia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    // Sem group_property_id — a trilha nasceu sem propriedade de agrupamento.
    trilha.criar_trilha(view_id, None).await.unwrap();

    let etapa = trilha.criar_etapa(view_id, "Databricks", "").await.unwrap();
    assert_eq!(etapa.lane_value, "");

    db.teardown().await;
}

// --- 0035: decisão e caminhos ----------------------------------------------

/// PROVA #2 do pedido: uma decisão com dois caminhos — escolher um libera o
/// que está atrás dele e NÃO libera o outro.
#[tokio::test]
async fn escolher_caminho_desbloqueia_um_lado_e_nao_o_outro() {
    let db = IsolatedDatabase::setup("decisao-dois-caminhos").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let decisao = create_step(&db.pool, database_id, "Fez o curso básico?").await;
    let sim = create_step(&db.pool, database_id, "Curso avançado").await;
    let nao = create_step(&db.pool, database_id, "Curso básico").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(sim, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(nao, decisao, Some("Não".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();

    // Antes de escolher: os dois ramos ficam "aguardando escolha", nenhum
    // libera.
    let antes = trilha.obter_trilha(view_id).await.unwrap();
    let situacao_de = |cena: &learno_lib::db::Trilha, id: Uuid| cena.etapas.iter().find(|e| e.id == id).unwrap().situacao_no_caminho;
    assert_eq!(situacao_de(&antes, sim), SituacaoNoCaminho::AguardandoEscolha);
    assert_eq!(situacao_de(&antes, nao), SituacaoNoCaminho::AguardandoEscolha);

    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    let depois = trilha.obter_trilha(view_id).await.unwrap();
    let etapa_sim = depois.etapas.iter().find(|e| e.id == sim).unwrap();
    let etapa_nao = depois.etapas.iter().find(|e| e.id == nao).unwrap();
    assert!(etapa_sim.is_unlocked, "caminho escolhido libera");
    assert_eq!(etapa_sim.situacao_no_caminho, SituacaoNoCaminho::Ativo);
    assert!(!etapa_nao.is_unlocked, "caminho não escolhido não libera");
    assert_eq!(etapa_nao.situacao_no_caminho, SituacaoNoCaminho::Descartado, "visível, cinza, nunca escondido");

    db.teardown().await;
}

/// O REENCONTRO que decide o desenho inteiro: dois caminhos que voltam a se
/// juntar numa etapa Z precisam liberá-la com o ramo escolhido concluído,
/// mesmo o ramo abandonado nunca tendo sido concluído.
#[tokio::test]
async fn dois_caminhos_que_se_reencontram_liberam_com_o_ramo_escolhido_concluido() {
    let db = IsolatedDatabase::setup("reencontro-de-caminhos").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "Curso avançado").await;
    let b = create_step(&db.pool, database_id, "Curso básico").await;
    let projeto_final = create_step(&db.pool, database_id, "Projeto final").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(b, decisao, Some("Não".to_string())).await.unwrap();
    trilha.criar_flecha(projeto_final, a, None).await.unwrap();
    trilha.criar_flecha(projeto_final, b, None).await.unwrap();

    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(a, "done").await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    let etapa_projeto = cena.etapas.iter().find(|e| e.id == projeto_final).unwrap();
    let etapa_b = cena.etapas.iter().find(|e| e.id == b).unwrap();
    assert!(etapa_projeto.is_unlocked, "o reencontro precisa liberar sem o ramo abandonado nunca ter sido concluído");
    assert_eq!(etapa_b.situacao_no_caminho, SituacaoNoCaminho::Descartado, "ramo abandonado, mas visível");

    db.teardown().await;
}

/// PROVA #3 do pedido: trocar de ideia depois de já ter andado no primeiro
/// caminho não pode apagar progresso, e voltar restaura a cena exata.
#[tokio::test]
async fn trocar_de_escolha_preserva_progresso_e_restaura_ao_voltar() {
    let db = IsolatedDatabase::setup("trocar-de-ideia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a1 = create_step(&db.pool, database_id, "A1").await;
    let a2 = create_step(&db.pool, database_id, "A2").await;
    let b1 = create_step(&db.pool, database_id, "B1").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a1, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(a2, a1, None).await.unwrap();
    trilha.criar_flecha(b1, decisao, Some("Não".to_string())).await.unwrap();

    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(a1, "done").await.unwrap();
    trilha.marcar_progresso_etapa(a2, "done").await.unwrap();

    let cena_antes = trilha.obter_trilha(view_id).await.unwrap();
    let completed_at_a1 = cena_antes.etapas.iter().find(|e| e.id == a1).unwrap().completed_at;
    let completed_at_a2 = cena_antes.etapas.iter().find(|e| e.id == a2).unwrap().completed_at;
    assert!(completed_at_a1.is_some() && completed_at_a2.is_some());

    // Troca para "Não" — nada em `trail_step_progress` pode ser apagado.
    trilha.escolher_caminho(decisao, Some("Não".to_string())).await.unwrap();

    let cena_nao = trilha.obter_trilha(view_id).await.unwrap();
    let etapa_a1_descartada = cena_nao.etapas.iter().find(|e| e.id == a1).unwrap();
    assert_eq!(etapa_a1_descartada.state.as_deref(), Some("done"), "progresso não pode ser apagado ao trocar de ideia");
    assert_eq!(etapa_a1_descartada.completed_at, completed_at_a1, "o carimbo de conclusão precisa sobreviver à troca");
    assert_eq!(etapa_a1_descartada.situacao_no_caminho, SituacaoNoCaminho::Descartado);

    // Volta para "Sim" — a cena tem que voltar EXATAMENTE como estava, sem
    // nada para recuperar.
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    let cena_volta = trilha.obter_trilha(view_id).await.unwrap();
    let etapa_a1_volta = cena_volta.etapas.iter().find(|e| e.id == a1).unwrap();
    let etapa_a2_volta = cena_volta.etapas.iter().find(|e| e.id == a2).unwrap();
    assert_eq!(etapa_a1_volta.completed_at, completed_at_a1);
    assert_eq!(etapa_a2_volta.completed_at, completed_at_a2);
    assert_eq!(etapa_a1_volta.situacao_no_caminho, SituacaoNoCaminho::Ativo);

    db.teardown().await;
}

/// PROVA #4 do pedido: o grafo continua acíclico e a detecção de ciclo
/// continua pegando ciclo, inclusive um que passe DENTRO de um caminho de
/// decisão.
#[tokio::test]
async fn ciclo_dentro_de_um_caminho_de_decisao_continua_detectado() {
    let db = IsolatedDatabase::setup("ciclo-em-caminho").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;
    let b = create_step(&db.pool, database_id, "B").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    // a e b fecham ciclo entre si, dentro do caminho "Sim".
    trilha.criar_flecha(b, a, None).await.unwrap();
    trilha.criar_flecha(a, b, None).await.unwrap();

    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    let etapa_a = cena.etapas.iter().find(|e| e.id == a).unwrap();
    let etapa_b = cena.etapas.iter().find(|e| e.id == b).unwrap();
    assert!(etapa_a.in_cycle && etapa_b.in_cycle, "o ciclo continua detectado mesmo dentro de um caminho escolhido");
    assert_ne!(etapa_a.situacao_no_caminho, SituacaoNoCaminho::Descartado, "conservador: nunca descarta por engano num ciclo");
    assert_ne!(etapa_b.situacao_no_caminho, SituacaoNoCaminho::Descartado);

    db.teardown().await;
}

/// PROVA #5 do pedido: rótulo vazio é recusado; dois caminhos com o MESMO
/// rótulo saindo da mesma decisão são o mesmo caminho — permitido de
/// propósito (0035: "não existe índice único sobre (blocking_id, path_label)").
#[tokio::test]
async fn rotulo_vazio_e_recusado_e_rotulo_repetido_no_mesmo_caminho_e_permitido() {
    let db = IsolatedDatabase::setup("rotulo-vazio-e-repetido").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;
    let c = create_step(&db.pool, database_id, "C").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();

    let vazio = trilha.criar_flecha(a, decisao, Some(String::new())).await;
    assert!(matches!(vazio, Err(Error::Invalid(_))), "obtido: {vazio:?}");
    let so_espacos = trilha.criar_flecha(a, decisao, Some("   ".to_string())).await;
    assert!(matches!(so_espacos, Err(Error::Invalid(_))), "obtido: {so_espacos:?}");

    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(c, decisao, Some("Sim".to_string())).await.unwrap();

    let total_sim: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM database_record_dependencies WHERE blocking_id = $1 AND path_label = 'Sim'",
    )
    .bind(decisao.db())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(total_sim, 2, "duas flechas com o mesmo rótulo são o mesmo caminho, não um erro");

    db.teardown().await;
}

/// PROVA #6 do pedido: uma decisão sem caminho nenhum não pode virar um
/// beco onde a trilha inteira trava sem explicação — comporta-se como etapa
/// comum (mesma família de TRL-014).
#[tokio::test]
async fn decisao_sem_caminho_nenhum_se_comporta_como_etapa_comum() {
    let db = IsolatedDatabase::setup("decisao-sem-caminho").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let decisao = create_step(&db.pool, database_id, "Decisão sem caminhos ainda").await;
    let marcada = trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    assert_eq!(marcada.chosen_label, None);

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.len(), 1);
    let etapa = &cena.etapas[0];
    assert!(etapa.is_unlocked, "decisão sem flecha de entrada nasce disponível, igual etapa comum");
    assert_eq!(etapa.situacao_no_caminho, SituacaoNoCaminho::Ativo);
    assert_eq!(cena.decisoes.len(), 1);

    let resultado = trilha.escolher_caminho(decisao, Some("Sim".to_string())).await;
    assert!(matches!(resultado, Err(Error::Invalid(_))), "não há rótulo nenhum para escolher ainda");

    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();

    db.teardown().await;
}

/// Risco #5 do desenho: apagar a flecha do caminho ESCOLHIDO por SQL cru
/// (simulando a view Tabela, que não sabe o que é uma escolha) zera a
/// escolha em vez de deixar todos os ramos virarem aresta morta em silêncio.
#[tokio::test]
async fn apagar_o_caminho_escolhido_por_sql_cru_zera_a_escolha_em_vez_de_travar() {
    let db = IsolatedDatabase::setup("caminho-apagado-fora-da-trilha").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    // A view Tabela apaga a dependência por SQL cru — nenhum código da
    // Trilha participa deste caminho de escrita (TRL-003).
    sqlx::query("DELETE FROM database_record_dependencies WHERE blocked_id = $1 AND blocking_id = $2")
        .bind(a.db())
        .bind(decisao.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let chosen_label: Option<String> =
        sqlx::query_scalar("SELECT chosen_label FROM trail_decisions WHERE step_id = $1")
            .bind(decisao.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(chosen_label, None, "a escolha não pode ficar pendurada apontando para um rótulo que já não existe");

    db.teardown().await;
}

/// Risco #1 do desenho: `marcar_progresso_etapa` e `etapa_esta_desbloqueada`
/// convergem na MESMA implementação de desbloqueio — concordam sobre uma
/// etapa descartada, pelos dois caminhos, no mesmo teste.
#[tokio::test]
async fn marcar_progresso_e_etapa_esta_desbloqueada_concordam_sobre_etapa_descartada() {
    let db = IsolatedDatabase::setup("dual-implementacao").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Fez o curso básico?").await;
    let sim = create_step(&db.pool, database_id, "Curso avançado").await;
    let nao = create_step(&db.pool, database_id, "Curso básico").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(sim, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(nao, decisao, Some("Não".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    let recusado = trilha.marcar_progresso_etapa(nao, "done").await;
    assert!(matches!(recusado, Err(Error::Invalid(_))), "obtido: {recusado:?}");
    if let Err(erro) = &recusado {
        let mensagem = erro.to_string();
        assert!(mensagem.contains("fora do caminho escolhido"), "mensagem própria para descartada, obtida: {mensagem}");
    }
    assert!(!trilha.etapa_esta_desbloqueada(nao).await.unwrap(), "os dois caminhos de desbloqueio precisam concordar");

    db.teardown().await;
}

/// `criar_flecha` recusa rótulo saindo de uma etapa que não é decisão —
/// espelho do gatilho de 0035.
#[tokio::test]
async fn criar_flecha_recusa_rotulo_saindo_de_etapa_que_nao_e_decisao() {
    let db = IsolatedDatabase::setup("rotulo-sem-decisao").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let comum = create_step(&db.pool, database_id, "Etapa comum").await;
    let a = create_step(&db.pool, database_id, "A").await;

    let resultado = trilha.criar_flecha(a, comum, Some("Sim".to_string())).await;
    assert!(matches!(resultado, Err(Error::Invalid(_))), "obtido: {resultado:?}");

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_record_dependencies").fetch_one(&db.pool).await.unwrap();
    assert_eq!(total, 0, "a flecha inválida não pode ter sido gravada");

    db.teardown().await;
}

/// `desmarcar_etapa_como_decisao` recusa enquanto existir caminho, e aceita
/// depois que os caminhos somem.
#[tokio::test]
async fn desmarcar_decisao_recusa_com_caminhos_e_aceita_sem_eles() {
    let db = IsolatedDatabase::setup("desmarcar-decisao").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();

    let recusado = trilha.desmarcar_etapa_como_decisao(decisao).await;
    assert!(matches!(recusado, Err(Error::Invalid(_))), "obtido: {recusado:?}");

    trilha.apagar_flecha(a, decisao).await.unwrap();
    trilha.desmarcar_etapa_como_decisao(decisao).await.unwrap();

    let ainda_decisao: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_decisions WHERE step_id = $1").bind(decisao.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(ainda_decisao, 0);

    // Idempotente: desmarcar de novo (já não é decisão) não é erro.
    trilha.desmarcar_etapa_como_decisao(decisao).await.unwrap();

    db.teardown().await;
}

/// `renomear_caminho` reescreve TODAS as flechas do caminho e preserva a
/// escolha — não pode se comportar como "dissolver e recriar".
#[tokio::test]
async fn renomear_caminho_reescreve_as_flechas_e_preserva_a_escolha() {
    let db = IsolatedDatabase::setup("renomear-caminho").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;
    let c = create_step(&db.pool, database_id, "C").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(c, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    let mudou = trilha.renomear_caminho(decisao, "Sim", Some("Curso avançado".to_string())).await.unwrap();
    assert_eq!(mudou, 2, "as duas flechas do mesmo caminho precisam mudar juntas");

    let decisao_apos: Option<String> =
        sqlx::query_scalar("SELECT chosen_label FROM trail_decisions WHERE step_id = $1").bind(decisao.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(decisao_apos.as_deref(), Some("Curso avançado"), "renomear não pode se comportar como dissolver a escolha");

    db.teardown().await;
}

/// `prever_troca_de_caminho` é leitura pura: relata quem sai (com/sem
/// progresso) e quem entra, sem gravar nada.
#[tokio::test]
async fn prever_troca_de_caminho_relata_quem_sai_com_progresso_sem_gravar_nada() {
    let db = IsolatedDatabase::setup("prever-troca").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;
    let b = create_step(&db.pool, database_id, "B").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.criar_flecha(b, decisao, Some("Não".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(decisao, "done").await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();
    trilha.marcar_progresso_etapa(a, "done").await.unwrap();

    let impacto = trilha.prever_troca_de_caminho(decisao, Some("Não".to_string())).await.unwrap();
    assert_eq!(impacto.saem_do_caminho, vec![a]);
    assert_eq!(impacto.saem_com_progresso, vec![a]);
    assert_eq!(impacto.saem_concluidas, vec![a]);
    assert_eq!(impacto.entram_no_caminho, vec![b]);

    // Nada foi gravado — é leitura pura.
    let ainda_sim: Option<String> =
        sqlx::query_scalar("SELECT chosen_label FROM trail_decisions WHERE step_id = $1").bind(decisao.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(ainda_sim.as_deref(), Some("Sim"));

    db.teardown().await;
}

// --- Remover etapa: cascata de flechas, sem religação automática -----------

/// O caso perigoso do pedido: A -> B -> C (A bloqueia B, B bloqueia C).
/// Apagar B tem que apagar as DUAS flechas que a tocam — senão C ficaria
/// bloqueada para sempre por uma bloqueadora que ninguém mais alcança — e
/// NÃO pode religar A a C por trás do usuário.
#[tokio::test]
async fn remover_etapa_do_meio_de_uma_cadeia_apaga_as_flechas_e_nao_religa_automaticamente() {
    let db = IsolatedDatabase::setup("remover-etapa-meio-cadeia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let a = create_step(&db.pool, database_id, "A").await;
    let b = create_step(&db.pool, database_id, "B").await;
    let c = create_step(&db.pool, database_id, "C").await;
    trilha.criar_flecha(b, a, None).await.unwrap(); // A bloqueia B
    trilha.criar_flecha(c, b, None).await.unwrap(); // B bloqueia C

    let removida = trilha.remover_etapa(b).await.unwrap();
    assert!(removida.deleted_at.is_some(), "a página da etapa vai para a lixeira");

    let flechas_restantes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM database_record_dependencies WHERE blocked_id = $1 OR blocking_id = $1",
    )
    .bind(b.db())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(flechas_restantes, 0, "as duas flechas que tocavam B (A->B e B->C) somem");

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.len(), 2, "B some da leitura, A e C continuam");
    assert!(cena.etapas.iter().all(|etapa| etapa.id != b));
    assert!(cena.flechas.is_empty(), "nenhuma flecha sobra desenhável");

    let etapa_c = cena.etapas.iter().find(|etapa| etapa.id == c).unwrap();
    assert_eq!(etapa_c.level, 0, "C perdeu a única bloqueadora, não foi religada a A");
    assert!(etapa_c.is_unlocked, "sem bloqueadora nenhuma, C nasce disponível");

    db.teardown().await;
}

/// Progresso e material da etapa apagada não são tocados — a operação é
/// reversível, e restaurar a página (`restore_page`, fora do escopo deste
/// repositório) precisa devolver os dois exatamente como estavam.
#[tokio::test]
async fn remover_etapa_com_material_e_progresso_preserva_os_dois() {
    let db = IsolatedDatabase::setup("remover-etapa-material-progresso").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let etapa = create_step(&db.pool, database_id, "Databricks").await;
    let material_alvo = create_page(&db.pool, "Doc").await;
    trilha.anexar_material_etapa(etapa, "page", Some(material_alvo), None).await.unwrap();
    trilha.marcar_progresso_etapa(etapa, "in_progress").await.unwrap();

    trilha.remover_etapa(etapa).await.unwrap();

    let materiais_restantes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_step_materials WHERE step_id = $1").bind(etapa.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(materiais_restantes, 1, "material da etapa apagada continua gravado, para a restauração");

    let progresso_restante: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_step_progress WHERE step_id = $1").bind(etapa.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(progresso_restante, 1, "progresso da etapa apagada continua gravado, para a restauração");

    let deleted_at: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = $1").bind(etapa.db()).fetch_one(&db.pool).await.unwrap();
    assert!(deleted_at.is_some());

    db.teardown().await;
}

#[tokio::test]
async fn remover_etapa_inexistente_e_not_found() {
    let db = IsolatedDatabase::setup("remover-etapa-inexistente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let resultado = trilha.remover_etapa(Uuid::now_v7()).await;
    assert!(matches!(resultado, Err(Error::NotFound(_))), "obtido: {resultado:?}");

    db.teardown().await;
}

/// Apagar uma etapa que é decisão com caminho JÁ ESCOLHIDO não é recusado
/// (ao contrário de `desmarcar_etapa_como_decisao`): a etapa inteira sai do
/// grafo, as flechas rotuladas que saem dela caem junto (passo 1 de
/// `remover_etapa`), e o gatilho de 0035 zera a escolha sozinho — nada fica
/// preso a um rótulo órfão.
#[tokio::test]
async fn remover_etapa_que_e_decisao_com_caminho_escolhido_e_permitido() {
    let db = IsolatedDatabase::setup("remover-etapa-decisao").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let decisao = create_step(&db.pool, database_id, "Decisão").await;
    let a = create_step(&db.pool, database_id, "A").await;

    trilha.marcar_etapa_como_decisao(decisao).await.unwrap();
    trilha.criar_flecha(a, decisao, Some("Sim".to_string())).await.unwrap();
    trilha.escolher_caminho(decisao, Some("Sim".to_string())).await.unwrap();

    trilha.remover_etapa(decisao).await.unwrap();

    let flechas_restantes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM database_record_dependencies WHERE blocked_id = $1 OR blocking_id = $1",
    )
    .bind(decisao.db())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(flechas_restantes, 0);

    db.teardown().await;
}

// --- Remover raia: etapas dentro continuam existindo, sem raia -------------

#[tokio::test]
async fn remover_raia_com_etapas_dentro_deixa_etapas_existindo_sem_raia() {
    let db = IsolatedDatabase::setup("remover-raia-com-etapas").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let databricks = create_step(&db.pool, database_id, "Databricks").await;
    let azure = create_step(&db.pool, database_id, "Azure").await;
    set_lane_value(&db.pool, databricks, group_property, "T.I.").await;
    set_lane_value(&db.pool, azure, group_property, "T.I.").await;

    trilha.remover_raia(view_id, "T.I.").await.unwrap();

    let raias_restantes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM trail_lanes WHERE view_id = $1").bind(view_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(raias_restantes, 0);

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.len(), 2, "as duas etapas continuam existindo");
    assert!(cena.etapas.iter().all(|etapa| etapa.lane_value.is_empty()), "sem raia, não apagadas");

    db.teardown().await;
}

#[tokio::test]
async fn remover_raia_vazia() {
    let db = IsolatedDatabase::setup("remover-raia-vazia").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();
    trilha.criar_raia(view_id, "Inglês").await.unwrap();

    trilha.remover_raia(view_id, "Inglês").await.unwrap();

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert!(cena.raias.is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn remover_raia_inexistente_e_not_found() {
    let db = IsolatedDatabase::setup("remover-raia-inexistente").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    trilha.criar_trilha(view_id, None).await.unwrap();

    let resultado = trilha.remover_raia(view_id, "Não existe").await;
    assert!(matches!(resultado, Err(Error::NotFound(_))), "obtido: {resultado:?}");

    db.teardown().await;
}

// --- Position da etapa: chega em obter_trilha, ordenável -------------------

/// `Etapa::position` é o que faltava para o frontend ordenar a raia por
/// algo que não seja título (ver o comentário do campo em
/// `db::trilha::Etapa`). Prova as duas metades: o campo vem preenchido, e
/// etapas criadas em sequência nascem em positions distintas e na mesma
/// ordem em que `criar_etapa` foi chamada — nunca reaproveitando a de uma
/// etapa anterior.
#[tokio::test]
async fn obter_trilha_devolve_position_distinta_e_ordenavel_por_etapa() {
    let db = IsolatedDatabase::setup("position-distinta").await;
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let databricks = trilha.criar_etapa(view_id, "Databricks", "T.I.").await.unwrap();
    let azure = trilha.criar_etapa(view_id, "Azure", "T.I.").await.unwrap();
    let gcp = trilha.criar_etapa(view_id, "GCP", "T.I.").await.unwrap();

    assert!(!databricks.position.is_empty());
    assert!(!azure.position.is_empty());
    assert!(!gcp.position.is_empty());
    assert!(databricks.position < azure.position, "databricks foi criada antes de azure");
    assert!(azure.position < gcp.position, "azure foi criada antes de gcp");

    let cena = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(cena.etapas.len(), 3);

    // `obter_trilha` já devolve na ordem de `ORDER BY p.position` — a
    // sequência de ids tem que bater com a ordem de criação.
    let ids: Vec<Uuid> = cena.etapas.iter().map(|e| e.id).collect();
    assert_eq!(ids, vec![databricks.id, azure.id, gcp.id]);

    // E a position que veio em cada `Etapa` é a mesma que `criar_etapa`
    // devolveu na hora — não uma recalculada ou truncada em algum ponto do
    // caminho de leitura.
    let cena_databricks = cena.etapas.iter().find(|e| e.id == databricks.id).unwrap();
    let cena_azure = cena.etapas.iter().find(|e| e.id == azure.id).unwrap();
    let cena_gcp = cena.etapas.iter().find(|e| e.id == gcp.id).unwrap();
    assert_eq!(cena_databricks.position, databricks.position);
    assert_eq!(cena_azure.position, azure.position);
    assert_eq!(cena_gcp.position, gcp.position);

    db.teardown().await;
}

// --- move_page reordena uma etapa dentro da raia ----------------------------

/// `move_page` (`db::pages`) não foi escrito pensando em etapa de Trilha —
/// agrupa "irmãos" por `parent_id`, e uma etapa (página-registro) nasce com
/// `parent_id = NULL` (`PageRepository::create_record` nunca grava essa
/// coluna). Isso junta, no mesmo grupo de "irmãos", toda página-registro de
/// TODAS as databases do workspace, mais toda página comum sem pai — mas
/// isso não quebra a ordem local: `position` é um único índice fracionário
/// total, comparável por ordem de string em todo o app, não por database.
/// Filtrar esse grupo global por `database_id` depois (o que
/// `fetch_step_bases`/`obter_trilha` já faz) preserva a ordem relativa das
/// etapas da mesma database, não importa quantas páginas de fora fiquem
/// misturadas no meio.
///
/// Este teste prova exatamente isso — inclusive com uma página comum
/// (`parent_id = NULL`, sem `database_id`) criada de propósito ENTRE as
/// duas etapas, disputando o mesmo espaço de position — e por isso conclui
/// que `move_page` já serve para reordenar etapas dentro de uma raia: nada
/// de comando novo.
#[tokio::test]
async fn move_page_reordena_etapa_dentro_da_raia_e_obter_trilha_reflete() {
    let db = IsolatedDatabase::setup("move-page-etapa").await;
    let trilha = TrilhaRepository::new(db.pool.clone());
    let pages = PageRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database_id = create_database(&db.pool, container, "Estudos").await;
    let view_id = create_trail_database_view(&db.pool, database_id).await;
    let group_property = create_select_property(&db.pool, database_id, "Trilha").await;
    trilha.criar_trilha(view_id, Some(group_property)).await.unwrap();
    trilha.criar_raia(view_id, "T.I.").await.unwrap();

    let databricks = trilha.criar_etapa(view_id, "Databricks", "T.I.").await.unwrap();
    // Página comum, sem `database_id`, criada entre as duas etapas — mesmo
    // `parent_id = NULL`, disputando o mesmo espaço global de position que
    // `move_page` enxerga como "irmãos".
    create_page(&db.pool, "Nota qualquer").await;
    let azure = trilha.criar_etapa(view_id, "Azure", "T.I.").await.unwrap();

    // Ordem inicial: Databricks, Azure — o mesmo caso do usuário ("Data
    // Engineer" antes de "Data Science" e sem jeito de inverter).
    let antes = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(antes.etapas.iter().map(|e| e.id).collect::<Vec<_>>(), vec![databricks.id, azure.id]);

    // Inverte: Azure passa a vir ANTES de Databricks.
    pages.move_page(azure.id, None, SiblingPosition::Start).await.unwrap();

    let depois = trilha.obter_trilha(view_id).await.unwrap();
    assert_eq!(
        depois.etapas.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![azure.id, databricks.id],
        "move_page inverteu a ordem, e obter_trilha precisa refletir sem precisar de comando novo"
    );

    db.teardown().await;
}
