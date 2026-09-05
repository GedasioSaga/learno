#![allow(clippy::unwrap_used, clippy::expect_used)]
// Each `tests/*.rs` file compiles this module as its own separate crate and
// only uses part of it (`EmptyDatabase` is only for `backup_dump.rs`,
// `IsolatedDatabase::url` is only read by tests shelling out to
// `pg_dump`/`pg_restore`) — none of that is actually dead code, just unused
// from any one binary's point of view.
#![allow(dead_code)]
//! Shared by every `#[ignore]`d integration test file in this crate: each
//! test provisions its own private, throwaway database on the cluster
//! `LEARNO_TEST_DATABASE_URL` points at, instead of running against that
//! variable's own database (`learno_test`) directly and sharing it with
//! every other test file and every other run.
//!
//! Extracted from the `IsolatedDatabase` that `src/db/integrity.rs`'s own
//! `#[cfg(test)]` module already used for exactly this reason (PLT-014's
//! flaky whole-table scan) — that copy lives on, because a `#[cfg(test)]`
//! item inside the library crate is invisible to these separately compiled
//! `tests/*.rs` binaries, so it cannot be imported from here. This module
//! is the version every file under `tests/` shares instead of each
//! reinventing its own isolation, or worse, depending on a database a human
//! had to create by hand and that then falls out of existence the moment
//! nobody remembers to recreate it — which is exactly what happened to
//! `LEARNO_TEST_RESTORE_DATABASE_URL`'s `learno_restore_test`.
//!
//! `tests/support/mod.rs` (not `tests/support.rs`) is deliberate: only files
//! directly inside `tests/` become their own `cargo test` binary, so this
//! one is never mistaken for a (empty) test suite of its own — every file
//! that wants it pulls it in with `mod support;`.

use sqlx::{Connection, PgConnection, SqlitePool};
use uuid::Uuid;

/// The admin connection string every isolated database is created on and
/// dropped from. Named for what it actually is here — a way to reach the
/// cluster — rather than for the one database it happens to name, since
/// that database itself is never touched by this module.
fn cluster_url() -> String {
    std::env::var("LEARNO_TEST_DATABASE_URL").expect("LEARNO_TEST_DATABASE_URL must be set to run ignored DB tests")
}

/// `learno_<label>_<uuid>` — unique even across tests running in parallel;
/// `label` only keeps `psql -l` readable while chasing down a stuck run.
fn fresh_db_name(label: &str) -> String {
    format!("learno_{label}_{}", Uuid::new_v4().simple())
}

async fn create_database(admin_conn: &mut PgConnection, db_name: &str) {
    sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
        .execute(admin_conn)
        .await
        .expect("failed to create the isolated test database");
}

/// `postgres://` isn't one of the URL crate's "special" schemes, so
/// `set_path` won't add the leading `/` on its own the way it would for
/// `http://` — without building it through this helper, Postgres would see
/// an empty database name and connect back to `cluster_url`'s own database.
fn database_url(cluster_url: &str, db_name: &str) -> url::Url {
    let mut url = url::Url::parse(cluster_url).expect("cluster URL must be a valid URL");
    url.set_path(&format!("/{db_name}"));
    url
}

async fn drop_database(admin_conn: &mut PgConnection, db_name: &str) {
    sqlx::query(&format!("DROP DATABASE \"{db_name}\" WITH (FORCE)"))
        .execute(admin_conn)
        .await
        .expect("failed to drop the isolated test database");
}

/// A private, fully migrated database that nothing outside the test holding
/// it can see — the shape every `db_*.rs` test wants.
pub struct IsolatedDatabase {
    pub pool: SqlitePool,
    /// This database's own connection URL — distinct from
    /// `LEARNO_TEST_DATABASE_URL`, which only ever names the cluster this
    /// database was created on. Needed by tests (`backup_dump.rs`) that
    /// have to hand Postgres connection details to something other than
    /// `sqlx`, such as a `pg_dump` child process.
    pub url: url::Url,
    admin_conn: PgConnection,
    db_name: String,
}

impl IsolatedDatabase {
    pub async fn setup(label: &str) -> Self {
        let cluster_url = cluster_url();
        let db_name = fresh_db_name(label);

        let mut admin_conn = PgConnection::connect(&cluster_url)
            .await
            .expect("failed to open an admin connection to the test cluster");
        create_database(&mut admin_conn, &db_name).await;

        let url = database_url(&cluster_url, &db_name);
        let pool = learno_lib::db::connect_and_migrate(url.as_str())
            .await
            .expect("failed to connect/migrate the isolated test database");

        Self { pool, url, admin_conn, db_name }
    }

    /// Not a `Drop` impl: dropping a Postgres database needs an `async`
    /// query and `Drop` can't run one, so every test calls this explicitly
    /// once it's done with the database.
    pub async fn teardown(mut self) {
        self.pool.close().await;
        drop_database(&mut self.admin_conn, &self.db_name).await;
    }
}

/// A private database left empty — no migrations applied — for
/// `backup_dump.rs`'s restore target. `pg_restore` builds the whole schema,
/// migration bookkeeping included, straight from the dump; a pre-migrated
/// target would just make `pg_restore --clean --if-exists` drop those
/// objects again before recreating them from the dump, for no benefit.
pub struct EmptyDatabase {
    admin_conn: PgConnection,
    db_name: String,
    pub url: url::Url,
}

impl EmptyDatabase {
    pub async fn create(label: &str) -> Self {
        let cluster_url = cluster_url();
        let db_name = fresh_db_name(label);

        let mut admin_conn = PgConnection::connect(&cluster_url)
            .await
            .expect("failed to open an admin connection to the test cluster");
        create_database(&mut admin_conn, &db_name).await;

        let url = database_url(&cluster_url, &db_name);
        Self { admin_conn, db_name, url }
    }

    pub async fn teardown(mut self) {
        drop_database(&mut self.admin_conn, &self.db_name).await;
    }
}
