#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::search`.
//!
//! Cada teste provisiona seu próprio banco descartável via
//! `support::IsolatedDatabase` — um arquivo SQLite temporário, migrado do
//! zero — então não há mais estado compartilhado entre testes para
//! atrapalhar o rankeamento limitado de `SearchRepository`, nem preparação
//! nenhuma fora do `cargo test` (a migração para SQLite tirou o cluster
//! Postgres, `LEARNO_TEST_DATABASE_URL` e o `#[ignore]` que dependia dos
//! dois — ver `docs/MIGRACAO-SQLITE.md`).

mod support;

use learno_lib::db::{IdBind, PageRepository, SearchRepository};
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
         VALUES ($1, $2, 'paragraph', '{}', $3, 'a0')",
    )
    .bind(Uuid::now_v7().db())
    .bind(page_id.db())
    .bind(plain_text)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
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
async fn fun_037_blank_query_returns_no_results_without_erroring() {
    let db = IsolatedDatabase::setup("search").await;
    let search = SearchRepository::new(db.pool.clone());

    let results = search.search("   ", RESULT_LIMIT).await.unwrap();

    assert!(results.is_empty());

    db.teardown().await;
}

#[tokio::test]
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
