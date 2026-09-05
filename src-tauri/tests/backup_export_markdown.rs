#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration test for FUN-023's database leg — fetching a real page's
//! blocks from Postgres and confirming the schema `fetch_page_blocks` reads
//! (`blocks.block_type`/`content`/`plain_text`/`position`, see
//! `0006_blocks.sql`) still matches what's actually in the table.
//!
//! `#[ignore]`d because it needs a live Postgres cluster, which
//! `cargo test` never starts on its own: run `scripts/dev-db.ps1 start` (or
//! `reset`), then `cargo test -- --ignored` with `LEARNO_TEST_DATABASE_URL`
//! set — see `docs/rust-tests.md`. Each test provisions its own private
//! database via `support::IsolatedDatabase` rather than sharing
//! `LEARNO_TEST_DATABASE_URL`'s own database with every other test file.
//!
//! `connect_and_migrate` previously failed against that cluster on
//! migration `0015_global_search_accent_insensitive.sql` (a Postgres 42883
//! error while inlining `immutable_unaccent` into a generated column/index
//! expression) — fixed by schema-qualifying that function's body; this test
//! now passes (`cargo test --include-ignored --test-threads=1`).
//!
//! The conversion itself — Markdown rendering, escaping, list nesting, code
//! fences, filename sanitization — needs no database, is already covered by
//! the plain (non-ignored) tests in `src-tauri/src/backup/markdown_export.rs`,
//! and was actually run (not just read) via a throwaway probe binary while
//! writing this file, since `cargo test --lib` cannot start on this machine
//! for an unrelated reason (see this builder's final report).

mod support;

use learno_lib::backup::{export_page_to_markdown, fetch_page_blocks};
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
    .bind(id)
    .bind(page_id)
    .bind(parent_block_id)
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
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
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
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
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
    sqlx::query("UPDATE blocks SET deleted_at = now() WHERE id = $1")
        .bind(trashed_id)
        .execute(&db.pool)
        .await
        .unwrap();

    let blocks = fetch_page_blocks(&db.pool, page.id).await.unwrap();
    let markdown = export_page_to_markdown(&page.title, &blocks);

    assert!(markdown.contains("Visível"));
    assert!(!markdown.contains("Não deveria aparecer"));

    db.teardown().await;
}
