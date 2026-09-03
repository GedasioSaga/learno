#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::page_versions` against a real Postgres
//! instance. `#[ignore]`d for the same reason as `tests/db_pages.rs`: it
//! needs a live Postgres cluster, which `cargo test` never starts on its
//! own. Run `scripts/dev-db.ps1 start` (or `reset`), then `cargo test --
//! --ignored` with `LEARNO_TEST_DATABASE_URL` set — see
//! `docs/rust-tests.md`. Each test provisions its own private database via
//! `support::IsolatedDatabase`.

mod support;

use learno_lib::db::{PageRepository, PageVersionRepository, SnapshotReason};
use support::IsolatedDatabase;

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_034_snapshots_accumulate_with_distinct_content() {
    let db = IsolatedDatabase::setup("page_versions").await;
    let pages = PageRepository::new(db.pool.clone());
    let versions = PageVersionRepository::new(db.pool.clone());

    let page = pages.create(None, "Anotações").await.unwrap();
    versions
        .snapshot(page.id, "Anotações", serde_json::json!({"text": "primeiro"}), SnapshotReason::Autosave)
        .await
        .unwrap();
    versions
        .snapshot(page.id, "Anotações", serde_json::json!({"text": "segundo"}), SnapshotReason::Autosave)
        .await
        .unwrap();

    let list = versions.list(page.id).await.unwrap();
    assert!(list.len() >= 2);
    assert_ne!(list[0].content, list[1].content);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_035_history_lists_newest_first() {
    let db = IsolatedDatabase::setup("page_versions").await;
    let pages = PageRepository::new(db.pool.clone());
    let versions = PageVersionRepository::new(db.pool.clone());

    let page = pages.create(None, "Histórico").await.unwrap();
    let first = versions
        .snapshot(page.id, "v1", serde_json::json!([]), SnapshotReason::Manual)
        .await
        .unwrap();
    let second = versions
        .snapshot(page.id, "v2", serde_json::json!([]), SnapshotReason::Manual)
        .await
        .unwrap();

    let list = versions.list(page.id).await.unwrap();
    let ids: Vec<_> = list.iter().map(|v| v.id).collect();
    let first_index = ids.iter().position(|id| *id == first.id).unwrap();
    let second_index = ids.iter().position(|id| *id == second.id).unwrap();
    // Newest (second) must be listed before the older (first) one.
    assert!(second_index < first_index);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_036_restoring_a_version_updates_the_page_and_adds_a_new_snapshot() {
    let db = IsolatedDatabase::setup("page_versions").await;
    let pages = PageRepository::new(db.pool.clone());
    let versions = PageVersionRepository::new(db.pool.clone());

    let page = pages.create(None, "Original").await.unwrap();
    let old_version = versions
        .snapshot(page.id, "rascunho inicial", serde_json::json!([]), SnapshotReason::Manual)
        .await
        .unwrap();
    pages.rename(page.id, "Editado depois").await.unwrap();

    let before_restore_count = versions.list(page.id).await.unwrap().len();
    versions.restore(page.id, old_version.id).await.unwrap();

    let restored_page = pages.get(page.id).await.unwrap();
    assert_eq!(restored_page.title, "rascunho inicial");

    let after_restore = versions.list(page.id).await.unwrap();
    // The restore itself creates a new snapshot; nothing existing is removed.
    assert_eq!(after_restore.len(), before_restore_count + 1);
    assert!(after_restore.iter().any(|v| v.id == old_version.id));

    db.teardown().await;
}
