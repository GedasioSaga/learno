#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::search` against a real Postgres instance.
//! `#[ignore]`d for the same reason as `tests/db_pages.rs`: it needs a live
//! Postgres cluster, which `cargo test` never starts on its own. Run
//! `scripts/dev-db.ps1 start` (or `reset`), then `cargo test -- --ignored`
//! with `LEARNO_TEST_DATABASE_URL` set — see `docs/rust-tests.md`.
//!
//! Each test provisions its own private database via
//! `support::IsolatedDatabase` — this used to run every test against the
//! shared, long-lived `LEARNO_TEST_DATABASE_URL` database directly, which
//! needed a `clear_previous_matches_for` cleanup step and a suite-wide lock
//! just to keep prior runs' leftover rows from crowding a fresh fixture out
//! of `SearchRepository`'s ranked, limited results (a real flake, not a
//! timing issue). A private database has no leftover rows to crowd anything
//! out with, so neither workaround is needed any more.

mod support;

use learno_lib::db::{PageRepository, SearchRepository};
use support::IsolatedDatabase;
use sqlx::SqlitePool;
use uuid::Uuid;

const RESULT_LIMIT: i64 = 20;

/// No block repository exists yet (Fase 2 owns `blocks`) — inserting one
/// directly is the cheapest way to set up a content-match fixture without
/// waiting on that builder.
async fn insert_block(pool: &SqlitePool, page_id: Uuid, plain_text: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, page_id, block_type, content, plain_text, position) \
         VALUES ($1, $2, 'paragraph', '{}'::jsonb, $3, 'a0')",
    )
    .bind(Uuid::now_v7())
    .bind(page_id)
    .bind(plain_text)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_finds_a_page_by_title_ignoring_accents() {
    let db = IsolatedDatabase::setup("search").await;
    let pages = PageRepository::new(db.pool.clone());
    let search = SearchRepository::new(db.pool.clone());

    let page = pages.create(None, "Revisão de Biologia").await.unwrap();

    let results = search.search("revisao", RESULT_LIMIT).await.unwrap();

    assert!(results.iter().any(|r| r.page_id == page.id));

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_finds_a_page_by_partial_title_substring() {
    let db = IsolatedDatabase::setup("search").await;
    let pages = PageRepository::new(db.pool.clone());
    let search = SearchRepository::new(db.pool.clone());

    let page = pages.create(None, "Biologia Celular").await.unwrap();

    let results = search.search("Bio", RESULT_LIMIT).await.unwrap();

    assert!(results.iter().any(|r| r.page_id == page.id && r.match_kind == "title"));

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_finds_a_page_by_block_content_ignoring_accents() {
    let db = IsolatedDatabase::setup("search").await;
    let pages = PageRepository::new(db.pool.clone());
    let search = SearchRepository::new(db.pool.clone());

    let page = pages.create(None, "Aula 4").await.unwrap();
    insert_block(&db.pool, page.id, "Hoje é dia de revisão geral da matéria.").await;

    let results = search.search("revisao", RESULT_LIMIT).await.unwrap();

    assert!(results.iter().any(|r| r.page_id == page.id && r.match_kind == "content"));

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_unmatched_term_returns_no_results() {
    let db = IsolatedDatabase::setup("search").await;
    let pages = PageRepository::new(db.pool.clone());
    let search = SearchRepository::new(db.pool.clone());

    pages.create(None, "Biologia Celular").await.unwrap();

    let results = search
        .search("termoquenuncavaiaparecer", RESULT_LIMIT)
        .await
        .unwrap();

    assert!(results.is_empty());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_blank_query_returns_no_results_without_erroring() {
    let db = IsolatedDatabase::setup("search").await;
    let search = SearchRepository::new(db.pool.clone());

    let results = search.search("   ", RESULT_LIMIT).await.unwrap();

    assert!(results.is_empty());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_037_trashed_pages_are_excluded() {
    let db = IsolatedDatabase::setup("search").await;
    let pages = PageRepository::new(db.pool.clone());
    let search = SearchRepository::new(db.pool.clone());

    let page = pages.create(None, "Rascunho Descartado").await.unwrap();
    pages.trash(page.id).await.unwrap();

    let results = search.search("Descartado", RESULT_LIMIT).await.unwrap();

    assert!(!results.iter().any(|r| r.page_id == page.id));

    db.teardown().await;
}
