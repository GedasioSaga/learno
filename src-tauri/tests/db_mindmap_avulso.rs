#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Testes de integração de `0025_mapa_mental_avulso.sql` + `db::mindmap`
//! contra um banco SQLite real: mapa mental é uma seção própria do app —
//! `page_id` é um vínculo OPCIONAL, não um requisito.
//!
//! Cobre, nesta ordem: criar avulso, criar preso a uma página, o `ON DELETE
//! CASCADE` continuando a distinguir "mapa preso a uma página apagada" (some)
//! de "mapa avulso" (sobrevive), nós/arestas ainda caindo em cascata com o
//! mapa, e — o caso mais arriscado da migração, o que provaria uma perda de
//! dado silenciosa em produção — um mapa que já existia ANTES de
//! `0025_mapa_mental_avulso.sql` rodar continuando legível depois, com
//! `page_id`, nome e timestamps intactos.

mod support;

use std::path::Path;

use learno_lib::db::{MindmapChangeInput, MindmapRepository, NewMindmapEdgeInput, NewMindmapNodeInput, PageRepository};
use learno_lib::error::Error;
use sqlx::migrate::{Migrate, Migrator};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use support::IsolatedDatabase;
use uuid::Uuid;

#[tokio::test]
async fn criar_mapa_avulso_sem_pagina_funciona_e_aparece_na_listagem() {
    let db = IsolatedDatabase::setup("mindmap-avulso").await;
    let mindmaps = MindmapRepository::new(db.pool.clone());

    let mapa = mindmaps.create("Ideias soltas", None).await.unwrap();
    assert_eq!(mapa.page_id, None, "mapa avulso precisa gravar page_id NULL, não recusar a criação");

    let listados = mindmaps.list().await.unwrap();
    assert!(listados.iter().any(|m| m.id == mapa.id && m.page_id.is_none()), "mapa avulso precisa aparecer na listagem");

    db.teardown().await;
}

#[tokio::test]
async fn criar_mapa_preso_a_uma_pagina_real_continua_funcionando() {
    let db = IsolatedDatabase::setup("mindmap-com-pagina").await;
    let pages = PageRepository::new(db.pool.clone());
    let mindmaps = MindmapRepository::new(db.pool.clone());

    let page = pages.create(None, "Biologia").await.unwrap();
    let mapa = mindmaps.create("Célula", Some(page.id)).await.unwrap();

    assert_eq!(mapa.page_id, Some(page.id));

    db.teardown().await;
}

/// O ponto que `0025_mapa_mental_avulso.sql` precisa acertar dos dois lados:
/// apagar a página apaga (em cascata) o mapa que estava preso a ela, mas
/// NÃO tem efeito nenhum sobre um mapa avulso que nunca teve página — as
/// duas metades do mesmo `ON DELETE CASCADE` numa coluna agora opcional.
#[tokio::test]
async fn apagar_a_pagina_apaga_o_mapa_preso_a_ela_e_preserva_o_mapa_avulso() {
    let db = IsolatedDatabase::setup("mindmap-cascata-pagina").await;
    let pages = PageRepository::new(db.pool.clone());
    let mindmaps = MindmapRepository::new(db.pool.clone());

    let page = pages.create(None, "Geografia").await.unwrap();
    let mapa_preso = mindmaps.create("Relevo", Some(page.id)).await.unwrap();
    let mapa_avulso = mindmaps.create("Brainstorm livre", None).await.unwrap();

    // A exclusão definitiva exige a página já na lixeira — `permanently_delete`
    // recusa apagar uma página ativa, de propósito (FUN-031). Mandar para a
    // lixeira primeiro é o caminho que o usuário percorre, e é o único que
    // chega ao `DELETE` de verdade que dispara a cascata.
    pages.trash(page.id).await.unwrap();
    pages.permanently_delete(page.id).await.unwrap();

    let apos_apagar_pagina = mindmaps.get(mapa_preso.id).await;
    assert!(
        matches!(apos_apagar_pagina, Err(Error::NotFound(_))),
        "mapa preso à página apagada precisava ter sumido em cascata, obtido {apos_apagar_pagina:?}"
    );

    let avulso_sobrevivente = mindmaps.get(mapa_avulso.id).await.unwrap();
    assert_eq!(avulso_sobrevivente.id, mapa_avulso.id, "mapa avulso não tem página nenhuma para cascatear, precisa sobreviver");
    assert_eq!(avulso_sobrevivente.page_id, None);

    db.teardown().await;
}

/// Nós e arestas continuam presos ao MAPA (`mindmap_id`), não à página —
/// `0025` reconstruiu `mindmap_nodes`/`mindmap_edges` para sair do caminho do
/// `DROP TABLE mindmaps`, e este teste prova que o `ON DELETE CASCADE` delas
/// sobreviveu à reconstrução, num mapa que nunca teve página nenhuma.
#[tokio::test]
async fn apagar_um_mapa_avulso_apaga_seus_nos_e_arestas_em_cascata() {
    let db = IsolatedDatabase::setup("mindmap-cascata-nos").await;
    let mindmaps = MindmapRepository::new(db.pool.clone());

    let mapa = mindmaps.create("Mapa avulso com grafo", None).await.unwrap();

    let node_a = Uuid::now_v7();
    let node_b = Uuid::now_v7();
    let changes = vec![
        MindmapChangeInput::CreateNode {
            node: NewMindmapNodeInput {
                id: Some(node_a),
                label: "A".into(),
                position_x: 0.0,
                position_y: 0.0,
                color: None,
                shape: None,
                icon: None,
                image: None,
                collapsed: false,
                page_ref_id: None,
            },
        },
        MindmapChangeInput::CreateNode {
            node: NewMindmapNodeInput {
                id: Some(node_b),
                label: "B".into(),
                position_x: 10.0,
                position_y: 10.0,
                color: None,
                shape: None,
                icon: None,
                image: None,
                collapsed: false,
                page_ref_id: None,
            },
        },
        MindmapChangeInput::CreateEdge {
            edge: NewMindmapEdgeInput { id: None, source_node_id: node_a, target_node_id: node_b, label: None, style: None },
        },
    ];
    let graph = mindmaps.apply_changes(mapa.id, changes).await.unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.edges.len(), 1);

    mindmaps.delete(mapa.id).await.unwrap();

    let nos_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mindmap_nodes WHERE mindmap_id = ?")
        .bind(mapa.id.to_string())
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let arestas_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mindmap_edges WHERE mindmap_id = ?")
        .bind(mapa.id.to_string())
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(nos_restantes, 0, "nós precisavam ter sido apagados em cascata com o mapa avulso");
    assert_eq!(arestas_restantes, 0, "arestas precisavam ter sido apagadas em cascata com o mapa avulso");

    db.teardown().await;
}

/// O caso mais arriscado desta migração: um mapa que já existia ANTES de
/// `0025_mapa_mental_avulso.sql` rodar — gravado sob o schema antigo
/// (`page_id TEXT NOT NULL`) — precisa continuar exatamente legível depois:
/// mesmo id, mesmo `page_id`, mesmo nome, mesmo `created_at`. É esse dado
/// pré-existente que a reconstrução em `0025` (tabela de backup sem FK,
/// derrubar filho-primeiro, recriar pai-primeiro) existe para proteger — se
/// a ordem estivesse errada, é aqui que apareceria como perda silenciosa.
///
/// Não há como pedir a `learno_lib::db::connect_and_migrate` para parar antes
/// da última migração (o `Migrator` embutido por `sqlx::migrate!()` é
/// privado do módulo `db::pool`), então este teste monta seu próprio
/// `Migrator` de runtime sobre o MESMO diretório `migrations/` (via
/// `sqlx::migrate::Migrator::new`, API pública), aplica manualmente só as
/// migrações anteriores à `0025`, insere o mapa "antigo" à mão, aplica a
/// `0025`, e só então lê de volta pela camada normal do repositório.
#[tokio::test]
async fn mapa_criado_antes_da_migracao_0025_continua_legivel_depois() {
    let db_path =
        std::env::temp_dir().join(format!("learno-mindmap-pre-0025-{}.sqlite", Uuid::new_v4().simple()));

    let migrations_dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"));
    let migrator = Migrator::new(migrations_dir).await.expect("lendo migrations/ do disco");

    let connect_options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(true).foreign_keys(true);
    let mut conn = SqliteConnection::connect_with(&connect_options).await.unwrap();

    conn.ensure_migrations_table().await.unwrap();

    let migracao_0025 = migrator
        .iter()
        .find(|m| m.version == 25)
        .expect("0025_mapa_mental_avulso.sql precisa estar entre as migrações resolvidas");

    for migracao in migrator.iter() {
        if migracao.version < migracao_0025.version {
            conn.apply(migracao).await.unwrap_or_else(|e| panic!("falhou aplicando migração {}: {e}", migracao.version));
        }
    }

    // A página e o mapa "antigos", gravados sob o schema pré-0025
    // (`page_id NOT NULL` já cumprido aqui — o ponto não é testar NULL nesta
    // parte, é provar que o dado que JÁ estava lá sobrevive à reconstrução).
    let now = "2026-01-15T10:00:00.000Z";
    let page_id = Uuid::now_v7();
    let mindmap_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position, created_at, updated_at) VALUES (?, 'Página pré-0025', 'a0', ?, ?)")
        .bind(page_id.to_string())
        .bind(now)
        .bind(now)
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO mindmaps (id, page_id, name, created_at, updated_at) VALUES (?, ?, 'Mapa pré-0025', ?, ?)")
        .bind(mindmap_id.to_string())
        .bind(page_id.to_string())
        .bind(now)
        .bind(now)
        .execute(&mut conn)
        .await
        .unwrap();

    // Confere, ainda sob o schema antigo, que a linha está mesmo lá antes de
    // rodar a migração que a reconstrói — sem isso, um `INSERT` que
    // silenciosamente não gravasse nada deixaria o resto do teste passando
    // por motivo errado.
    let contagem_antes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mindmaps WHERE id = ?")
        .bind(mindmap_id.to_string())
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(contagem_antes, 1, "o mapa pré-0025 precisa existir antes da migração rodar, para o teste fazer sentido");

    conn.apply(migracao_0025).await.unwrap();
    conn.close().await.unwrap();

    // Reabre pela camada normal do app (`connect_and_migrate`): não há mais
    // migração pendente (0025 é a mais recente), então isto só confirma o
    // histórico e devolve um pool utilizável pelo repositório.
    let pool = learno_lib::db::connect_and_migrate(&db_path).await.unwrap();
    let mindmaps = MindmapRepository::new(pool.clone());

    let lido = mindmaps.get(mindmap_id).await.unwrap();
    assert_eq!(lido.id, mindmap_id);
    assert_eq!(lido.page_id, Some(page_id), "page_id do mapa pré-existente precisa ter sobrevivido intacto");
    assert_eq!(lido.name, "Mapa pré-0025");

    let created_at_bruto: String = sqlx::query("SELECT created_at FROM mindmaps WHERE id = ?")
        .bind(mindmap_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("created_at");
    assert_eq!(created_at_bruto, now, "created_at do mapa pré-existente não pode ter sido regravado pela reconstrução");

    // E a coluna, agora opcional, também aceita um mapa avulso de verdade
    // no MESMO banco que acabou de herdar dado do schema antigo.
    let avulso = mindmaps.create("Avulso pós-migração", None).await.unwrap();
    assert_eq!(avulso.page_id, None);

    pool.close().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
}
