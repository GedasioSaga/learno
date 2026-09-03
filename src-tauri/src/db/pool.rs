//! Postgres connection pool and migration bootstrap (PLT-002).
//!
//! Nothing else in the app can run before this succeeds, so failures here
//! surface as a plain `Error` and it is up to the caller (the first-run
//! wizard, a retry prompt) to decide what the user sees.

use std::path::Path;

use sqlx::postgres::{PgPool, PgPoolOptions};

use crate::backup;
use crate::config::{self, AppConfig, ConnectionTestInput};
use crate::error::Result;

/// Bounds how many concurrent Postgres connections the app opens. Fixed
/// rather than configurable: a single local desktop user never needs more,
/// and a literal here (with this comment) reads better than a knob nobody
/// will turn.
const MAX_POOL_CONNECTIONS: u32 = 10;

/// Opens a pool against `database_url` and applies every pending migration
/// under `migrations/` before returning it, so no caller can ever observe a
/// pool whose schema isn't fully up to date.
pub async fn connect_and_migrate(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
        .connect(database_url)
        .await?;

    sqlx::migrate!().run(&pool).await?;

    Ok(pool)
}

/// Every migration embedded in this build, in version order. Shared by
/// [`connect_migrate_with_rollback`] (to know whether a migration is about
/// to run against established data) and by the tests below (to know what
/// "fully migrated" means without hard-coding a version number).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// True exactly at PLT-020's trigger moment: this database already has
/// migration history (so there's something to lose) AND at least one
/// embedded migration isn't in it yet (so a migration is actually about to
/// run). A brand-new database (no history at all) and an already-fully-
/// migrated one (history, but nothing pending) both answer `false` — the
/// first has nothing worth protecting, the second has nothing about to
/// change that a backup would guard against. `to_regclass` returns `NULL`
/// instead of erroring when `_sqlx_migrations` doesn't exist yet, so the
/// brand-new case doesn't need a separate existence check first.
async fn has_a_pending_migration_against_established_history(pool: &PgPool) -> Result<bool> {
    let table_exists: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations')::text").fetch_one(pool).await?;
    if table_exists.is_none() {
        return Ok(false);
    }

    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success").fetch_all(pool).await?;
    if applied.is_empty() {
        return Ok(false);
    }

    let applied: std::collections::HashSet<i64> = applied.into_iter().collect();
    Ok(MIGRATOR.iter().any(|migration| !applied.contains(&migration.version)))
}

/// PLT-020: like [`connect_and_migrate`], but when upgrading a database that
/// already has committed migration history to a version with a pending
/// migration, it's `pg_dump`-backed up to `backup_dir` first, and that
/// backup is restored automatically if the migration run then fails — so a
/// broken migration never leaves the schema stuck mid-upgrade with no way
/// back to the last known-good state. A brand-new database, or one that's
/// already fully migrated, has no such moment to protect, so this skips
/// straight to `sqlx::migrate!().run()`, same as `connect_and_migrate`.
///
/// Takes `connection` rather than a bare URL because restoring needs the
/// connection broken apart into `pg_restore`'s own arguments (see
/// `backup::run_restore`) — a URL would just have to be parsed back apart.
///
/// `backup_dir` holds only this function's own pre-migration safety net; it
/// is a separate concern from the user-facing PLT-011/PLT-013 backups.
pub async fn connect_migrate_with_rollback(connection: &ConnectionTestInput, backup_dir: &Path) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
        .connect_with(config::build_connect_options(connection))
        .await?;

    if !has_a_pending_migration_against_established_history(&pool).await? {
        sqlx::migrate!().run(&pool).await?;
        return Ok(pool);
    }

    let app_config = AppConfig::from(connection);
    // PLT-013: goes through the same trigger+manifest+retention machinery
    // every risky-operation backup is supposed to use — not a raw, untracked
    // `backup::run_backup` — so this pre-migration backup gets pruned by
    // `keep_risky_operation` like any other and doesn't accumulate in
    // `backup_dir` forever. `ScheduleConfig::default()`, not the user's
    // saved schedule config: this function runs from `db::pool`, before any
    // `AppHandle` exists, so there is no tauri store to read a saved one
    // from yet. Its own manifest file, scoped to `backup_dir` itself — never
    // PLT-011/013's user-facing "backups" directory (see this function's
    // doc comment above for why the two directories are deliberately never
    // shared). A failed backup here returns `Err` and this bails out below
    // `?`, without ever calling `sqlx::migrate!().run()` — the migration
    // must never run unprotected.
    let manifest_path = backup_dir.join("schedule-manifest.json");
    let backup_path = backup::trigger_risky_operation_backup(
        &app_config,
        &connection.password,
        backup_dir,
        &manifest_path,
        &backup::ScheduleConfig::default(),
        "schema_migration",
    )
    .await?;

    if let Err(migration_error) = sqlx::migrate!().run(&pool).await {
        // pg_restore's `--clean` drops and recreates every object, which
        // conflicts with locks this pool's own idle connections still hold
        // against the same database — it has to let go of them first.
        pool.close().await;
        backup::run_restore(&app_config, &connection.password, &backup_path).await?;
        return Err(migration_error.into());
    }

    Ok(pool)
}

#[cfg(test)]
mod tests {
    // `MIGRATOR` (defined above, at module scope) is embedded at compile
    // time by `sqlx::migrate!()`, so the two tests below run with no
    // database at all: they catch a bad filename (wrong `NNNN_` prefix,
    // duplicate version) or a migration accidentally dropped from the
    // directory, without needing LEARNO_TEST_DATABASE_URL.
    use super::MIGRATOR;

    #[test]
    fn migrations_are_embedded_and_strictly_ordered() {
        let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();

        assert!(
            !versions.is_empty(),
            "expected at least one migration under migrations/"
        );
        assert!(
            versions.windows(2).all(|pair| pair[0] < pair[1]),
            "migration versions must be strictly increasing, got {versions:?}"
        );
    }

    #[test]
    fn foundational_tables_have_a_migration() {
        let descriptions: Vec<String> = MIGRATOR
            .iter()
            .map(|migration| migration.description.to_string())
            .collect();

        // sqlx derives the description from the filename by replacing `_`
        // with a space (`0005_page_versions.sql` -> "page versions").
        for expected in ["pages", "page versions", "blocks"] {
            assert!(
                descriptions.iter().any(|d| d.contains(expected)),
                "expected a migration covering `{expected}`, got {descriptions:?}"
            );
        }
    }

    // Everything below actually opens a connection and runs `sqlx::migrate!()`
    // against a real Postgres 18 database — the two tests above only ever
    // inspected the embedded migration list, so neither one could have caught
    // migration 0015 failing against a real server the way it did (PLT-002
    // finding: `function unaccent(unknown, text) does not exist`, 42883).
    // `#[ignore]`d because these need a running Postgres cluster, which
    // `cargo test` never starts on its own: run `scripts/dev-db.ps1 start`
    // (or `reset`), then `cargo test -- --ignored` with
    // `LEARNO_TEST_DATABASE_URL` set — see `docs/rust-tests.md`.
    mod live_database {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use sqlx::Connection;

        use super::MIGRATOR;
        use crate::config::ConnectionTestInput;
        use crate::db::pool::{connect_and_migrate, connect_migrate_with_rollback};

        fn test_database_url() -> String {
            std::env::var("LEARNO_TEST_DATABASE_URL")
                .expect("LEARNO_TEST_DATABASE_URL must be set to run ignored DB tests")
        }

        /// Pulls host/port/user apart from `LEARNO_TEST_DATABASE_URL` so the
        /// PLT-020 test below can open a database of its own on the same
        /// cluster, instead of destructively rewriting `_sqlx_migrations` on
        /// a database the other integration test files also share.
        fn test_cluster_connection(database: &str) -> ConnectionTestInput {
            let url = url::Url::parse(&test_database_url()).expect("LEARNO_TEST_DATABASE_URL must be a valid URL");
            ConnectionTestInput {
                host: url.host_str().expect("LEARNO_TEST_DATABASE_URL must have a host").to_string(),
                port: url.port().unwrap_or(5432),
                database: database.to_string(),
                user: url.username().to_string(),
                password: url.password().unwrap_or_default().to_string(),
            }
        }

        #[tokio::test]
        #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
        async fn plt_002_connect_and_migrate_applies_every_migration_against_a_real_database() {
            let pool = connect_and_migrate(&test_database_url()).await.unwrap();

            let applied_versions: Vec<i64> =
                sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let expected_versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
            assert_eq!(
                applied_versions, expected_versions,
                "every embedded migration must be recorded as successfully applied"
            );

            // Proves migration 0015 didn't just run but actually works: this
            // is the exact function whose broken definition made 0015 fail
            // 42883 against a real server while `cargo test --lib` (no
            // database) still passed clean.
            let normalized: String =
                sqlx::query_scalar("SELECT immutable_unaccent('revisão')").fetch_one(&pool).await.unwrap();
            assert_eq!(normalized, "revisao");
        }

        #[tokio::test]
        #[ignore = "requires LEARNO_TEST_DATABASE_URL and pg_dump/pg_restore on PATH"]
        async fn plt_020_a_failed_migration_is_rolled_back_to_the_pre_migration_backup() {
            let db_name = format!("learno_pool_rollback_test_{}", uuid::Uuid::new_v4().simple());

            // A dedicated, self-created database rather than
            // `LEARNO_TEST_DATABASE_URL` itself: this test deliberately
            // corrupts migration bookkeeping below, which would be unsafe to
            // do on a database the other `tests/db_*.rs` files also connect
            // to. `CREATE DATABASE` can run over any existing connection —
            // it doesn't need a `postgres` maintenance database specifically.
            let mut admin_conn = sqlx::PgConnection::connect(&test_database_url()).await.unwrap();
            sqlx::query(&format!("CREATE DATABASE \"{db_name}\"")).execute(&mut admin_conn).await.unwrap();

            let connection = test_cluster_connection(&db_name);
            let backup_dir = std::env::temp_dir().join(format!("learno-plt020-{}", uuid::Uuid::new_v4()));

            // First call: brand-new database, nothing to protect yet, so
            // this exercises the "skip the backup" branch and leaves a fully
            // migrated database behind for the failure scenario below.
            let pool = connect_migrate_with_rollback(&connection, &backup_dir).await.unwrap();
            assert!(!backup_dir.exists(), "a brand-new database has nothing to back up");

            // Forces a real migration failure: sqlx now believes the last
            // migration is pending, but its objects (the function, the
            // indexes) already exist, so re-running it fails with a genuine
            // Postgres error — exactly the shape of failure PLT-020 has to
            // survive.
            sqlx::query("DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;

            let result = connect_migrate_with_rollback(&connection, &backup_dir).await;
            assert!(result.is_err(), "a migration re-run against already-existing objects must fail");
            assert!(backup_dir.exists(), "a database with committed migrations must be backed up before migrating");
            // `backup_dir` now also holds this trigger's own
            // `schedule-manifest.json` (PLT-013), so the file count check
            // narrows to the `.dump` extension specifically rather than
            // counting every file in the directory.
            let backup_file_count = std::fs::read_dir(&backup_dir)
                .unwrap()
                .filter(|entry| {
                    entry.as_ref().unwrap().path().extension().and_then(|ext| ext.to_str()) == Some("dump")
                })
                .count();
            assert_eq!(backup_file_count, 1, "expected exactly one pre-migration backup file");

            // Proves the backup was routed through PLT-013's own trigger —
            // not just that some `.dump` file exists on disk, but that it
            // was tracked as a risky-operation backup labeled for this
            // caller, the actual gap PLT-013 named ("o gatilho por operação
            // de risco... não" dispara).
            let manifest =
                crate::backup::ScheduleManifest::new(backup_dir.join("schedule-manifest.json"));
            let records = manifest.load().unwrap();
            assert_eq!(records.len(), 1, "expected the pre-migration backup to be recorded exactly once");
            assert!(
                matches!(
                    &records[0].trigger,
                    crate::backup::BackupTrigger::RiskyOperation { operation } if operation == "schema_migration"
                ),
                "expected the record to be tagged as a schema_migration risky-operation backup, got {:?}",
                records[0].trigger
            );

            // The real assertion for PLT-020: the database must still be
            // queryable and intact after the failed attempt, not left in a
            // half-migrated or locked state.
            let recovered = sqlx::postgres::PgPoolOptions::new()
                .connect_with(crate::config::build_connect_options(&connection))
                .await
                .unwrap();
            let normalized: String =
                sqlx::query_scalar("SELECT immutable_unaccent('revisão')").fetch_one(&recovered).await.unwrap();
            assert_eq!(normalized, "revisao");
            recovered.close().await;

            sqlx::query(&format!("DROP DATABASE \"{db_name}\" WITH (FORCE)")).execute(&mut admin_conn).await.unwrap();
            std::fs::remove_dir_all(&backup_dir).unwrap();
        }
    }
}
