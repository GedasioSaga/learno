#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration test for FUN-023's database leg — fetching a real page's
//! blocks from SQLite and confirming the schema `fetch_page_blocks` reads
//! (`blocks.block_type`/`content`/`plain_text`/`position`, see
//! `0006_blocks.sql`) still matches what's actually in the table.
//!
//! Migração para SQLite (`docs/MIGRACAO-SQLITE.md`): não há mais cluster
//! Postgres nem `LEARNO_TEST_DATABASE_URL` como pré-requisito, então nenhum
//! teste aqui é `#[ignore]`d. Cada teste provisiona seu próprio arquivo de
//! banco descartável via `support::IsolatedDatabase` — ver
//! `tests/support/mod.rs` — e roda num `cargo test` limpo, em qualquer
//! máquina, sem preparação nenhuma.
//!
//! A conversão em si — renderização Markdown, escaping, aninhamento de
//! lista, cerca de código, sanitização de nome de arquivo — não usa banco e
//! já é coberta pelos testes simples (não-`#[ignore]`) em
//! `src-tauri/src/backup/markdown_export.rs`. Só `fetch_page_blocks`, a
//! única função aqui que de fato lê o banco, precisa de um banco de verdade,
//! e é isso que este arquivo cobre.

mod support;

use learno_lib::backup::{export_page_to_markdown, fetch_page_blocks};
use learno_lib::db::ids::IdBind;
use learno_lib::db::PageRepository;
use support::IsolatedDatabase;
use sqlx::SqlitePool;
use uuid::Uuid;

async fn insert_block(
    pool: &SqlitePool,
    page_id: Uuid,
    parent_block_id: Option<Uuid>,
    block_type: &str,
    content: serde_json::Value,
    plain_text: &str,
    position: &str,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, position) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id.db())
    .bind(page_id.db())
    .bind(parent_block_id.db())
    .bind(block_type)
    .bind(content)
    .bind(plain_text)
    .bind(position)
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn fun_023_exports_a_real_page_with_a_heading_and_a_nested_list() {
    let db = IsolatedDatabase::setup("export_markdown").await;
    let page = PageRepository::new(db.pool.clone()).create(None, "Notas").await.unwrap();

    insert_block(&db.pool, page.id, None, "heading", serde_json::json!({"level": 1}), "Notas", "10").await;
    let list_item = insert_block(
        &db.pool,
        page.id,
        None,
        "bulleted_list_item",
        serde_json::json!({}),
        "Item de topo",
        "20",
    )
    .await;
    insert_block(
        &db.pool,
        page.id,
        Some(list_item),
        "bulleted_list_item",
        serde_json::json!({}),
        "Item aninhado",
        "10",
    )
    .await;

    let blocks = fetch_page_blocks(&db.pool, page.id).await.unwrap();
    let markdown = export_page_to_markdown(&page.title, &blocks);

    assert!(markdown.contains("# Notas"));
    assert!(markdown.contains("- Item de topo"));
    assert!(markdown.contains("  - Item aninhado"));

    db.teardown().await;
}

#[tokio::test]
async fn fun_023_a_trashed_block_is_excluded_from_the_export() {
    let db = IsolatedDatabase::setup("export_markdown").await;
    let page = PageRepository::new(db.pool.clone()).create(None, "Com Lixeira").await.unwrap();

    insert_block(&db.pool, page.id, None, "paragraph", serde_json::json!({}), "Visível", "10").await;
    let trashed_id = insert_block(
        &db.pool,
        page.id,
        None,
        "paragraph",
        serde_json::json!({}),
        "Não deveria aparecer",
        "20",
    )
    .await;
    // `deleted_at` é TEXT (ver `0006_blocks.sql`); `strftime(...)` no lugar do
    // `now()` de Postgres, mesmo formato que os defaults `created_at`/
    // `updated_at` da tabela já usam.
    sqlx::query("UPDATE blocks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1")
        .bind(trashed_id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let blocks = fetch_page_blocks(&db.pool, page.id).await.unwrap();
    let markdown = export_page_to_markdown(&page.title, &blocks);

    assert!(markdown.contains("Visível"));
    assert!(!markdown.contains("Não deveria aparecer"));

    db.teardown().await;
}
