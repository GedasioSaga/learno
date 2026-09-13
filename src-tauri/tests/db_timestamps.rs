#![allow(clippy::unwrap_used, clippy::expect_used)]
//! DBS-024 ("Criado em") e DBS-026 ("Editado em") contra um banco SQLite
//! real e isolado.
//!
//! Este arquivo é NOVO e não pertence a nenhuma pasta exclusiva de outra
//! peça da Fase 3 (`docs/FASE-3-ARQUITETURA.md` §11 lista as pastas
//! disjuntas do fan-out — `src-tauri/tests/` não é uma delas, e cada
//! `db_*.rs` já é o arquivo de UMA feature, o mesmo padrão de
//! `db_backlinks.rs`/`db_synced_blocks.rs`). A peça P7 (propriedades
//! `created_time`/`last_edited_time`/`person`) só tem pasta reservada em
//! `src/features/databases/properties/{timestamps,person}/` — o lado
//! TypeScript. A prova de banco fica aqui, reusando `tests/support` e os
//! tipos já exportados de `learno_lib::db` (nenhum arquivo-núcleo tocado).
//!
//! Não precisa de `#[ignore]`: `IsolatedDatabase::setup` (`tests/support`)
//! cria um arquivo SQLite descartável em pasta temporária, já migrado, então
//! os dois testes abaixo passam num `cargo test` limpo, sem nenhum banco
//! pré-existente nem variável de ambiente — mudança que veio da migração
//! para SQLite (`docs/MIGRACAO-SQLITE.md`).
//!
//! Nenhum repositório de `database`/`database_properties` existe ainda
//! neste crate (mesma observação de `db_value_invariants.rs`) — este
//! arquivo insere essas linhas com SQL puro, só o necessário para exercitar
//! o gatilho de `0017_database_value_invariants.sql`.

mod support;

use std::time::Duration;

// `record_values::{RecordValueChangeInput, RecordValueRepository}` pelo
// caminho completo, não `learno_lib::db::{..}`: `db/mod.rs` é um
// arquivo-núcleo (arquitetura §11, "NINGUÉM edita" fora de N1) que outra
// peça está registrando ao vivo enquanto este arquivo é escrito — `pub mod
// record_values;` já existe, mas o `pub use` de conveniência no nível de
// `db::` ainda não. O caminho completo não depende dele nem corre atrás de
// um alvo em movimento.
use learno_lib::db::record_values::{RecordValueChangeInput, RecordValueRepository};
use learno_lib::db::{IdBind, PageRepository};
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// Ponte src/db/ids.rs (ver comentário do módulo `ids`): `Uuid` cru quebra o
// bind contra a coluna TEXT de uma tabela STRICT (`cannot store BLOB value
// in TEXT column`), então todo `.bind(x)` de id vira `.bind(x.db())`. E,
// diferente da versão Postgres, nenhuma das três tabelas abaixo tem
// `DEFAULT` para `id` — `0007_databases.sql`/`0008_database_properties_views.sql`/
// `0003_pages.sql` declaram `id TEXT PRIMARY KEY NOT NULL` sem gerador —
// então o id é gerado aqui, como todo repositório do crate já faz
// (`PageRepository::create`, `insert_relation_property`).

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

async fn create_property(pool: &SqlitePool, database_id: Uuid, name: &str, property_type: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO database_properties (id, database_id, name, property_type, config, position) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id.db())
    .bind(database_id.db())
    .bind(name)
    .bind(property_type)
    .bind(JsonValue::Object(serde_json::Map::new()))
    .bind("a0")
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn create_record(pool: &SqlitePool, database_id: Uuid, title: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, $3, $4)")
        .bind(id.db())
        .bind(database_id.db())
        .bind(title)
        .bind("a0")
        .execute(pool)
        .await
        .unwrap();
    id
}

/// `(database, record)` prontos, o mesmo mínimo que `db_value_invariants.rs`
/// monta antes de tocar qualquer propriedade.
struct Fixture {
    pool: SqlitePool,
    database_id: Uuid,
    record_id: Uuid,
}

async fn setup_database_and_record(db: &IsolatedDatabase, label: &str) -> Fixture {
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, &format!("Database de teste — {label}")).await.unwrap();
    let database_id = create_database(&db.pool, container.id, label).await;
    let record_id = create_record(&db.pool, database_id, "Registro de teste").await;
    Fixture { pool: db.pool.clone(), database_id, record_id }
}

/// DBS-024: "Criado em" é `pages.created_at`, e não se move quando OUTRA
/// propriedade do mesmo registro é editada — só `drv_touch_record` (0017)
/// mexe em `updated_at`; nada mexe em `created_at` depois do INSERT.
#[tokio::test]
async fn dbs024_criado_em_vem_de_pages_created_at_e_nunca_muda() {
    let db = IsolatedDatabase::setup("timestamps_created").await;
    let fixture = setup_database_and_record(&db, "DBS-024").await;
    let pages = PageRepository::new(fixture.pool.clone());

    let before = pages.get(fixture.record_id).await.unwrap();
    assert!(before.created_at <= before.updated_at, "recém-criado: created_at nunca é depois de updated_at");

    // Uma volta de escrita real pelo único caminho de I4 — nunca um UPDATE
    // fabricado à mão, que provaria só que o SQL compila, não que o
    // registro passou pelo caminho que o app de fato usa (lição de
    // ACHADOS-FASE-2: "teste que não atravessa a fronteira não é prova").
    let property_id = create_property(&fixture.pool, fixture.database_id, "Nota", "text").await;
    let repo = RecordValueRepository::new(fixture.pool.clone());
    tokio::time::sleep(Duration::from_millis(5)).await;
    repo.apply_record_value_changes(vec![RecordValueChangeInput {
        record_id: fixture.record_id,
        property_id,
        value: serde_json::json!("qualquer edição"),
    }])
    .await
    .unwrap();

    let after = pages.get(fixture.record_id).await.unwrap();
    assert_eq!(before.created_at, after.created_at, "DBS-024: Criado em não pode mudar quando outra propriedade é editada");
    assert!(after.updated_at > before.updated_at, "a própria edição deveria ter avançado updated_at (senão o teste não provaria nada)");

    db.teardown().await;
}

/// DBS-026: "Editado em" (`pages.updated_at`) avança quando QUALQUER outra
/// propriedade do registro muda — o gatilho `drv_touch_record`
/// (`touch_record_from_value`, 0017) dispara em INSERT/UPDATE/DELETE de
/// `database_record_values`. Duas propriedades distintas, para provar
/// "qualquer", não só "a mesma de novo".
#[tokio::test]
async fn dbs026_editado_em_avanca_quando_qualquer_outra_propriedade_muda() {
    let db = IsolatedDatabase::setup("timestamps_edited").await;
    let fixture = setup_database_and_record(&db, "DBS-026").await;
    let pages = PageRepository::new(fixture.pool.clone());
    let repo = RecordValueRepository::new(fixture.pool.clone());

    let property_a = create_property(&fixture.pool, fixture.database_id, "Nota", "text").await;
    let property_b = create_property(&fixture.pool, fixture.database_id, "Feito", "checkbox").await;

    let t0 = pages.get(fixture.record_id).await.unwrap().updated_at;

    tokio::time::sleep(Duration::from_millis(5)).await;
    repo.apply_record_value_changes(vec![RecordValueChangeInput {
        record_id: fixture.record_id,
        property_id: property_a,
        value: serde_json::json!("primeira edição"),
    }])
    .await
    .unwrap();
    let t1 = pages.get(fixture.record_id).await.unwrap().updated_at;
    assert!(t1 > t0, "T1 > T0: editar \"Nota\" tem que avançar Editado em");

    tokio::time::sleep(Duration::from_millis(5)).await;
    repo.apply_record_value_changes(vec![RecordValueChangeInput {
        record_id: fixture.record_id,
        property_id: property_b,
        value: serde_json::json!(true),
    }])
    .await
    .unwrap();
    let t2 = pages.get(fixture.record_id).await.unwrap().updated_at;
    assert!(t2 > t1, "T2 > T1: uma propriedade DIFERENTE (\"Feito\") também precisa avançar Editado em — é o \"QUALQUER\" do critério");

    // I1: apagar a propriedade (DELETE em database_record_values) também é
    // uma mudança do registro — o mesmo gatilho dispara em DELETE.
    tokio::time::sleep(Duration::from_millis(5)).await;
    repo.apply_record_value_changes(vec![RecordValueChangeInput {
        record_id: fixture.record_id,
        property_id: property_a,
        value: serde_json::json!(""),
    }])
    .await
    .unwrap();
    let t3 = pages.get(fixture.record_id).await.unwrap().updated_at;
    assert!(t3 > t2, "T3 > T2: apagar uma propriedade (I1) também é uma edição do registro");

    db.teardown().await;
}
