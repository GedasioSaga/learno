#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration test for PLT-011's full round trip — `pg_dump` a populated
//! database, then `pg_restore` it into an empty one and confirm the content
//! comes back.
//!
//! `#[ignore]`d because it needs a live Postgres cluster and the
//! `pg_dump`/`pg_restore` binaries on PATH, not because either is
//! unreachable: run `scripts/dev-db.ps1 start` (or `reset`), then
//! `cargo test -- --ignored` with `LEARNO_TEST_DATABASE_URL` set — see
//! `docs/rust-tests.md`. Both the source and restore-target databases are
//! created and dropped by this test itself, via `support::EmptyDatabase`
//! and `support::IsolatedDatabase` — no database has to be created by hand
//! ahead of time (a `LEARNO_TEST_RESTORE_DATABASE_URL` pointing at a
//! `learno_restore_test` a human created once used to be required here,
//! then that database stopped existing and nothing noticed until the next
//! run of this test failed).
//!
//! Confirmed while writing this file: `pg_dump`/`pg_restore` are on PATH
//! (they ship with the Postgres 18 install `scripts/dev-db.ps1` also uses)
//! and the test binary itself starts and runs fine against that cluster.
//!
//! `connect_and_migrate` previously failed here — and in every other
//! migration-backed integration test in this crate — because migration
//! `0015_global_search_accent_insensitive.sql`'s `immutable_unaccent`
//! function raised `function unaccent(unknown, text) does not exist`
//! (Postgres error 42883) while Postgres inlined it into a generated
//! column/index expression. Fixed by schema-qualifying both the
//! dictionary literal and the `unaccent` call inside that function;
//! re-verified with `cargo test --include-ignored --test-threads=1`
//! against a disposable cluster from `scripts/dev-db.ps1 reset` — this
//! test now passes.
//!
//! Everything provable without a database — the exact `pg_dump`/`pg_restore`
//! arguments built, the backup filename format, and how a missing binary or
//! a nonzero exit code is reported — is already a plain (non-ignored) test
//! inside `src-tauri/src/backup/dump.rs`.

mod support;

use learno_lib::backup::run_backup;
use learno_lib::backup::run_restore;
use learno_lib::config::AppConfig;
use learno_lib::db::{connect_and_migrate, PageRepository};
use support::{EmptyDatabase, IsolatedDatabase};

fn config_from_url(url: &url::Url) -> (AppConfig, String) {
    let config = AppConfig {
        host: url.host_str().expect("test DB URL must have a host").to_string(),
        port: url.port().unwrap_or(5432),
        database: url.path().trim_start_matches('/').to_string(),
        user: url.username().to_string(),
    };
    let password = url.password().unwrap_or_default().to_string();
    (config, password)
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster and pg_dump/pg_restore on PATH (scripts/dev-db.ps1)"]
async fn plt_011_a_backup_restored_into_an_empty_database_recovers_all_content() {
    let source = IsolatedDatabase::setup("backup_dump_source").await;
    let marker_title = format!("PLT-011 marker {}", uuid::Uuid::new_v4());
    PageRepository::new(source.pool.clone()).create(None, &marker_title).await.unwrap();

    let (source_config, source_password) = config_from_url(&source.url);

    let output_dir = std::env::temp_dir().join(format!("learno-plt011-{}", uuid::Uuid::new_v4()));
    let dump_path = run_backup(&source_config, &source_password, &output_dir).await.unwrap();
    assert!(dump_path.is_file());

    let restore_target = EmptyDatabase::create("backup_dump_restore").await;
    let (restore_config, restore_password) = config_from_url(&restore_target.url);
    run_restore(&restore_config, &restore_password, &dump_path).await.unwrap();

    let restore_pool = connect_and_migrate(restore_target.url.as_str()).await.unwrap();
    let restored = PageRepository::new(restore_pool).list_tree(None).await.unwrap();
    assert!(restored.iter().any(|page| page.title == marker_title));

    let _ = std::fs::remove_dir_all(&output_dir);
    source.teardown().await;
    restore_target.teardown().await;
}
