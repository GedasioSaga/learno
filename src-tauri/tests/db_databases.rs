#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::databases` contra um banco SQLite real.
//!
//! Cada teste cria seu próprio arquivo SQLite descartável via
//! `support::IsolatedDatabase`, já migrado — mesmo padrão de todo outro
//! `tests/db_*.rs` deste crate.
//!
//! Esta é a primeira suíte que exercita `databases`/`database_properties`/
//! `database_views` através de um repositório de verdade, em vez de SQL cru
//! de fixture (`tests/db_relations.rs`, `tests/db_trilha.rs`,
//! `tests/db_timestamps.rs`, `tests/db_value_invariants.rs` inserem essas
//! três tabelas por SQL cru porque, até esta peça, não existia outro
//! caminho). `create_page` continua sendo a única fixture crua aqui — a
//! página-container em si é `db::pages::PageRepository`, peça de outra
//! fase, e este arquivo só a usa para ter algo válido para
//! `container_page_id` apontar.

mod support;

use learno_lib::db::{
    DatabaseRepository, IdBind, PageRepository, RecordValueChangeInput, RecordValueRepository, TrilhaRepository,
};
use learno_lib::Error;
use serde_json::json;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// --- Fixtures ----------------------------------------------------------

async fn create_page(pool: &SqlitePool, title: &str) -> Uuid {
    PageRepository::new(pool.clone()).create(None, title).await.unwrap().id
}

/// Toda `trail_views`/`trail_lanes` some quando a VIEW é apagada
/// (`ON DELETE CASCADE`) — usado pelo teste que prova que apagar a
/// PROPRIEDADE de agrupamento, ao contrário, só desliga a raia (`SET
/// NULL`), sem apagar a view.
async fn read_trail_group_property(pool: &SqlitePool, view_id: Uuid) -> Option<Uuid> {
    let raw: Option<String> = sqlx::query_scalar("SELECT group_property_id FROM trail_views WHERE view_id = ?")
        .bind(view_id.db())
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten();
    raw.map(|text| Uuid::parse_str(&text).unwrap())
}

async fn count(pool: &SqlitePool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql).bind(id.db()).fetch_one(pool).await.unwrap()
}

// --- 1. Criar database, propriedade e view, e ler os três de volta -----

#[tokio::test]
async fn cria_database_propriedade_e_view_e_le_os_tres_de_volta() {
    let db = IsolatedDatabase::setup("cria-le-de-volta").await;
    let repo = DatabaseRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Projetos").await;
    let database = repo.create_database(container, "Projetos").await.unwrap();
    // Capturado ANTES de `database` ser movido para dentro dos `vec![...]`
    // mais abaixo — reestruturação, não `.clone()` reflexo (regra 4): o
    // resto do teste só precisa do id, nunca da struct inteira depois
    // daquele ponto.
    let database_id = database.id;
    assert_eq!(database.name, "Projetos");
    assert_eq!(database.container_page_id, container);
    assert!(!database.is_locked);
    assert_eq!(database.data_version, 0);
    assert_eq!(database.config, json!({}));

    let property = repo
        .create_property(database_id, "Status", "select", Some(json!({"options": [{"id": "todo", "name": "A fazer"}]})))
        .await
        .unwrap();
    assert_eq!(property.name, "Status");
    assert_eq!(property.property_type, "select");
    assert_eq!(property.database_id, database_id);

    let view = repo.create_view(database_id, "Tabela", "table", None).await.unwrap();
    assert_eq!(view.name, "Tabela");
    assert_eq!(view.view_type, "table");
    assert_eq!(view.config, json!({}));

    // Ler de volta: `get_database`/`list_databases_in_page` e as duas
    // listagens concordam com o que `create_*` já tinha devolvido.
    let lido = repo.get_database(database_id).await.unwrap();
    assert_eq!(lido, database);

    let na_pagina = repo.list_databases_in_page(container).await.unwrap();
    assert_eq!(na_pagina, vec![database]);

    let propriedades = repo.list_properties(database_id).await.unwrap();
    assert_eq!(propriedades, vec![property]);

    let views = repo.list_views(database_id).await.unwrap();
    assert_eq!(views, vec![view]);

    db.teardown().await;
}

// --- 2. Apagar database apaga propriedade, view, registro e valor ------

#[tokio::test]
async fn apagar_database_apaga_propriedade_view_registro_e_valor_em_cascata() {
    let db = IsolatedDatabase::setup("apaga-database-cascata").await;
    let repo = DatabaseRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database = repo.create_database(container, "Estudos").await.unwrap();
    let property = repo.create_property(database.id, "Nota", "number", None).await.unwrap();
    let view = repo.create_view(database.id, "Tabela", "table", None).await.unwrap();
    let record = repo.create_record(database.id, "Prova 1").await.unwrap();

    let values = RecordValueRepository::new(db.pool.clone());
    values
        .apply_record_value_changes(vec![RecordValueChangeInput { record_id: record.id, property_id: property.id, value: json!(9.5) }])
        .await
        .unwrap();
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_record_values WHERE record_id = ?", record.id).await, 1);

    repo.delete_database(database.id).await.unwrap();

    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_properties WHERE id = ?", property.id).await, 0);
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_views WHERE id = ?", view.id).await, 0);
    // O registro é uma PÁGINA — cascata de `pages.database_id` a apaga por
    // inteiro, não só o campo `database_id`.
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM pages WHERE id = ?", record.id).await, 0);
    // A prova pedida: o valor gravado em `database_record_values` foi
    // junto (via cascata do registro OU da propriedade — os dois caminhos
    // levam à mesma linha desaparecida).
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_record_values WHERE record_id = ?", record.id).await, 0);

    assert!(matches!(repo.get_database(database.id).await, Err(Error::NotFound(_))));

    db.teardown().await;
}

// --- 3. Apagar propriedade: valor some, Trilha degrada para SET NULL ---

#[tokio::test]
async fn apagar_propriedade_apaga_o_valor_e_zera_o_agrupamento_da_trilha_sem_apagar_a_view() {
    let db = IsolatedDatabase::setup("apaga-propriedade").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let trilha = TrilhaRepository::new(db.pool.clone());

    let container = create_page(&db.pool, "Estudos").await;
    let database = repo.create_database(container, "Estudos").await.unwrap();
    let group_property = repo.create_property(database.id, "Trilha", "select", None).await.unwrap();
    let other_property = repo.create_property(database.id, "Nota", "number", None).await.unwrap();
    let view = repo.create_view(database.id, "Trilha", "trail", None).await.unwrap();
    trilha.criar_trilha(view.id, Some(group_property.id)).await.unwrap();

    let record = repo.create_record(database.id, "Etapa 1").await.unwrap();
    let values = RecordValueRepository::new(db.pool.clone());
    values
        .apply_record_value_changes(vec![
            RecordValueChangeInput { record_id: record.id, property_id: group_property.id, value: json!("T.I.") },
            RecordValueChangeInput { record_id: record.id, property_id: other_property.id, value: json!(7) },
        ])
        .await
        .unwrap();

    repo.delete_property(group_property.id).await.unwrap();

    // O valor desta propriedade sumiu...
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_record_values WHERE property_id = ?", group_property.id).await, 0);
    // ...mas o valor da OUTRA propriedade do mesmo registro continua.
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_record_values WHERE property_id = ?", other_property.id).await, 1);

    // A Trilha degradou para a raia única (SET NULL), não perdeu a view.
    assert_eq!(read_trail_group_property(&db.pool, view.id).await, None);
    assert_eq!(count(&db.pool, "SELECT COUNT(*) FROM database_views WHERE id = ?", view.id).await, 1);
    let cena = trilha.obter_trilha(view.id).await.unwrap();
    assert_eq!(cena.etapas.len(), 1, "a etapa continua existindo, só sem raia nomeada");

    assert!(matches!(repo.delete_property(group_property.id).await, Err(Error::NotFound(_))), "apagar de novo é NotFound, não idempotente");

    db.teardown().await;
}

// --- 4. Tipo inválido é recusado com Error legível ----------------------

#[tokio::test]
async fn tipo_de_propriedade_invalido_e_recusado_com_erro_legivel() {
    let db = IsolatedDatabase::setup("tipo-propriedade-invalido").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();

    let erro = repo.create_property(database.id, "Campo", "video", None).await.unwrap_err();
    assert!(matches!(erro, Error::Invalid(_)));
    assert!(format!("{erro}").contains("video"));

    assert_eq!(repo.list_properties(database.id).await.unwrap().len(), 0, "a propriedade inválida não foi criada");

    db.teardown().await;
}

#[tokio::test]
async fn tipo_de_view_invalido_e_recusado_com_erro_legivel() {
    let db = IsolatedDatabase::setup("tipo-view-invalido").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();

    // 'gallery' é o rascunho de 0008 nunca implementado — ver o comentário
    // de `VALID_VIEW_TYPES` em `db::databases`.
    let erro = repo.create_view(database.id, "Galeria", "gallery", None).await.unwrap_err();
    assert!(matches!(erro, Error::Invalid(_)));
    assert!(format!("{erro}").contains("gallery"));

    assert_eq!(repo.list_views(database.id).await.unwrap().len(), 0);

    db.teardown().await;
}

#[tokio::test]
async fn mudar_tipo_recusa_entrar_ou_sair_de_relation_e_rollup() {
    let db = IsolatedDatabase::setup("mudar-tipo-recusa-relation").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();

    assert!(matches!(repo.create_property(database.id, "Relação", "relation", None).await, Err(Error::Invalid(_))));
    assert!(matches!(repo.create_property(database.id, "Rollup", "rollup", None).await, Err(Error::Invalid(_))));

    let texto = repo.create_property(database.id, "Descrição", "text", None).await.unwrap();
    assert!(matches!(repo.change_property_type(texto.id, "relation").await, Err(Error::Invalid(_))));

    // Tipo comum -> tipo comum continua funcionando.
    let mudado = repo.change_property_type(texto.id, "number").await.unwrap();
    assert_eq!(mudado.property_type, "number");

    db.teardown().await;
}

// --- 5. Ordem sobrevive à reordenação repetida ---------------------------

#[tokio::test]
async fn ordem_de_propriedade_sobrevive_a_reordenacao_repetida_sem_colidir_nem_inverter() {
    let db = IsolatedDatabase::setup("reordena-propriedade").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();

    let a = repo.create_property(database.id, "A", "text", None).await.unwrap();
    let b = repo.create_property(database.id, "B", "text", None).await.unwrap();
    let c = repo.create_property(database.id, "C", "text", None).await.unwrap();

    let ordem_inicial = repo.list_properties(database.id).await.unwrap();
    assert_eq!(ordem_inicial.iter().map(|p| p.id).collect::<Vec<_>>(), vec![a.id, b.id, c.id]);

    // Move A para depois de C: B, C, A.
    repo.reorder_property(database.id, a.id, Some(c.id)).await.unwrap();
    let ordem = repo.list_properties(database.id).await.unwrap();
    assert_eq!(ordem.iter().map(|p| p.id).collect::<Vec<_>>(), vec![b.id, c.id, a.id]);

    // Move C para o início: C, B, A.
    repo.reorder_property(database.id, c.id, None).await.unwrap();
    let ordem = repo.list_properties(database.id).await.unwrap();
    assert_eq!(ordem.iter().map(|p| p.id).collect::<Vec<_>>(), vec![c.id, b.id, a.id]);

    // 30 reordenações em sequência, sempre movendo o último item de volta
    // para o início — o caso que mais estressa o índice fracionário (é
    // exatamente o que `db::position`'s próprio teste
    // `repeated_insertion_at_the_start_never_needs_renumbering` prova para
    // `pages`, repetido aqui contra `database_properties`).
    let ids = [a.id, b.id, c.id];
    for i in 0..30 {
        let alvo = ids[i % ids.len()];
        repo.reorder_property(database.id, alvo, None).await.unwrap();

        let ordem = repo.list_properties(database.id).await.unwrap();
        assert_eq!(ordem.len(), 3, "nenhuma reordenação pode fazer uma propriedade sumir ou duplicar");
        assert_eq!(ordem[0].id, alvo, "o alvo desta rodada precisa estar na frente");

        // Posições estritamente crescentes na ordem devolvida — nunca
        // colidem (duas iguais) nem invertem (a lista deixa de bater com a
        // ordenação por string que o próprio SQL usou).
        for par in ordem.windows(2) {
            assert!(par[0].position < par[1].position, "posições coladas ou fora de ordem: {par:?}");
        }

        let ids_unicos: std::collections::HashSet<_> = ordem.iter().map(|p| p.id).collect();
        assert_eq!(ids_unicos.len(), 3, "nenhum id duplicado");
    }

    db.teardown().await;
}

#[tokio::test]
async fn ordem_de_view_sobrevive_a_reordenacao_repetida_sem_colidir_nem_inverter() {
    let db = IsolatedDatabase::setup("reordena-view").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();

    let a = repo.create_view(database.id, "A", "table", None).await.unwrap();
    let b = repo.create_view(database.id, "B", "board", None).await.unwrap();
    let c = repo.create_view(database.id, "C", "list", None).await.unwrap();

    let ids = [a.id, b.id, c.id];
    for i in 0..20 {
        let alvo = ids[i % ids.len()];
        repo.reorder_view(database.id, alvo, None).await.unwrap();

        let ordem = repo.list_views(database.id).await.unwrap();
        assert_eq!(ordem.len(), 3);
        assert_eq!(ordem[0].id, alvo);
        for par in ordem.windows(2) {
            assert!(par[0].position < par[1].position, "posições coladas ou fora de ordem: {par:?}");
        }
    }

    // Referência de reordenação que não existe nesta database é recusada,
    // não ignorada em silêncio.
    let fora = Uuid::now_v7();
    assert!(matches!(repo.reorder_view(database.id, a.id, Some(fora)).await, Err(Error::Invalid(_))));

    db.teardown().await;
}

// --- 6. Database vazia é estado válido -----------------------------------

#[tokio::test]
async fn database_recem_criada_sem_propriedade_sem_view_e_sem_registro_e_estado_valido() {
    let db = IsolatedDatabase::setup("database-vazia").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "Vazia").await;

    let database = repo.create_database(container, "Vazia").await.unwrap();

    assert_eq!(repo.list_properties(database.id).await.unwrap(), vec![]);
    assert_eq!(repo.list_views(database.id).await.unwrap(), vec![]);
    assert_eq!(repo.list_records(database.id).await.unwrap().len(), 0);

    db.teardown().await;
}

// --- Registro: criar, e listar com valores --------------------------------

#[tokio::test]
async fn cria_registro_como_pagina_e_lista_registros_com_seus_valores() {
    let db = IsolatedDatabase::setup("registro-com-valores").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "Pessoas").await;
    let database = repo.create_database(container, "Pessoas").await.unwrap();
    let nome = repo.create_property(database.id, "Apelido", "text", None).await.unwrap();

    let ana = repo.create_record(database.id, "Ana").await.unwrap();
    let bruno = repo.create_record(database.id, "Bruno").await.unwrap();
    assert_eq!(ana.database_id, Some(database.id));
    assert_eq!(ana.title, "Ana");
    // Registro nasce sem valor nenhum (I1) — não é linha vazia, é ausência.
    assert_eq!(ana.parent_id, None);

    let values = RecordValueRepository::new(db.pool.clone());
    values
        .apply_record_value_changes(vec![RecordValueChangeInput { record_id: ana.id, property_id: nome.id, value: json!("Aninha") }])
        .await
        .unwrap();

    let registros = repo.list_records(database.id).await.unwrap();
    assert_eq!(registros.len(), 2);

    let registro_ana = registros.iter().find(|r| r.page.id == ana.id).unwrap();
    assert_eq!(registro_ana.values.len(), 1);
    assert_eq!(registro_ana.values[0].property_id, nome.id);
    assert_eq!(registro_ana.values[0].value, json!("Aninha"));

    let registro_bruno = registros.iter().find(|r| r.page.id == bruno.id).unwrap();
    assert_eq!(registro_bruno.values.len(), 0, "sem valor gravado, values vem vazio, não erro");

    db.teardown().await;
}

// --- Renomear / config de view --------------------------------------------

#[tokio::test]
async fn renomeia_database_propriedade_e_view_e_grava_config_de_view() {
    let db = IsolatedDatabase::setup("renomeia-e-config").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let container = create_page(&db.pool, "X").await;
    let database = repo.create_database(container, "X").await.unwrap();
    let property = repo.create_property(database.id, "Nome", "text", None).await.unwrap();
    let view = repo.create_view(database.id, "Tabela", "table", None).await.unwrap();

    let database = repo.rename_database(database.id, "Y").await.unwrap();
    assert_eq!(database.name, "Y");

    let property = repo.rename_property(property.id, "Título").await.unwrap();
    assert_eq!(property.name, "Título");

    let view = repo.rename_view(view.id, "Quadro").await.unwrap();
    assert_eq!(view.name, "Quadro");

    let nova_config = json!({"visibleProperties": [property.id.to_string()], "sort": []});
    let view = repo.set_view_config(view.id, nova_config.clone()).await.unwrap();
    assert_eq!(view.config, nova_config);

    let lida = repo.list_views(database.id).await.unwrap();
    assert_eq!(lida[0].config, nova_config);

    db.teardown().await;
}

// --- NotFound em operação contra id inexistente ---------------------------

#[tokio::test]
async fn operacoes_contra_id_inexistente_devolvem_not_found() {
    let db = IsolatedDatabase::setup("not-found").await;
    let repo = DatabaseRepository::new(db.pool.clone());
    let fantasma = Uuid::now_v7();

    assert!(matches!(repo.get_database(fantasma).await, Err(Error::NotFound(_))));
    assert!(matches!(repo.rename_database(fantasma, "X").await, Err(Error::NotFound(_))));
    assert!(matches!(repo.delete_database(fantasma).await, Err(Error::NotFound(_))));
    assert!(matches!(repo.rename_property(fantasma, "X").await, Err(Error::NotFound(_))));
    assert!(matches!(repo.delete_property(fantasma).await, Err(Error::NotFound(_))));
    assert!(matches!(repo.rename_view(fantasma, "X").await, Err(Error::NotFound(_))));
    assert!(matches!(repo.delete_view(fantasma).await, Err(Error::NotFound(_))));
    assert!(matches!(repo.set_view_config(fantasma, json!({})).await, Err(Error::NotFound(_))));

    db.teardown().await;
}
