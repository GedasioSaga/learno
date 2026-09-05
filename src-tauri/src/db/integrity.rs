//! "Check Database" (PLT-014): finds and repairs rows that violate the
//! schema's own invariants but slipped past its constraints anyway.
//!
//! The schema's foreign keys (`cards.note_id REFERENCES notes(id) ON DELETE
//! CASCADE`, in particular) already make an orphaned card impossible through
//! any of this app's own code paths — deleting a note takes its cards with
//! it. This exists for the cases that don't go through those code paths at
//! all: a `.apkg`/`.colpkg` import (PLT-004) that inserts rows out of order,
//! a `pg_restore` (PLT-011) of a dump taken mid-write, or direct `psql`
//! surgery. Anki's own "Check Database" exists for exactly the same reason,
//! on a database (SQLite, historically without foreign keys enforced) where
//! this kind of drift was the common case rather than the rare one.

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::Result;

/// What one run of [`IntegrityRepository::check_and_repair`] found and fixed.
/// `total_repaired` is redundant with the vector lengths but is what the
/// UI's "N problemas corrigidos" summary line reads directly, so it doesn't
/// have to know which fields exist to compute it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct IntegrityReport {
    pub orphaned_card_ids: Vec<Uuid>,
    pub total_repaired: usize,
}

pub struct IntegrityRepository {
    pool: SqlitePool,
}

impl IntegrityRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// PLT-014: deletes every card whose `note_id` no longer matches an
    /// existing note and reports which ones. A single statement rather than
    /// select-then-delete: nothing has to be true of the row set between the
    /// two steps for this to stay correct, because there is only one step.
    pub async fn check_and_repair(&self) -> Result<IntegrityReport> {
        let orphaned_card_ids: Vec<Uuid> =
            sqlx::query_scalar("DELETE FROM cards WHERE note_id NOT IN (SELECT id FROM notes) RETURNING id")
                .fetch_all(&self.pool)
                .await?;

        let total_repaired = orphaned_card_ids.len();
        Ok(IntegrityReport { orphaned_card_ids, total_repaired })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use sqlx::Connection;

    use super::*;

    /// A private, throwaway database on the same cluster as
    /// `LEARNO_TEST_DATABASE_URL`, migrated and ready to use.
    ///
    /// `check_and_repair` scans the *entire* `cards` table by design — a
    /// consistency checker has no `WHERE` clause to scope itself behind, so
    /// there's no way to make its tests deterministic on a database shared
    /// with anything else that touches `cards`/`notes` while `cargo test`
    /// runs everything in parallel by default. The two tests below used to
    /// `DELETE FROM cards` and assert on the whole table, which only held up
    /// when nothing else happened to be running at the same time (PLT-014's
    /// own regression, caught by two runs of the full suite disagreeing on
    /// pass/fail with no code change in between). Each test now gets a
    /// database nothing else can see instead, the same pattern `db::pool`'s
    /// PLT-020 test already uses for the same reason.
    struct IsolatedDatabase {
        pool: SqlitePool,
        admin_conn: sqlx::PgConnection,
        db_name: String,
    }

    impl IsolatedDatabase {
        async fn setup() -> Self {
            let cluster_url = std::env::var("LEARNO_TEST_DATABASE_URL")
                .expect("LEARNO_TEST_DATABASE_URL must be set to run ignored DB tests");
            let db_name = format!("learno_integrity_test_{}", Uuid::new_v4().simple());

            let mut admin_conn = sqlx::PgConnection::connect(&cluster_url)
                .await
                .expect("failed to open an admin connection to the test cluster");
            sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
                .execute(&mut admin_conn)
                .await
                .expect("failed to create the isolated test database");

            let mut database_url =
                url::Url::parse(&cluster_url).expect("LEARNO_TEST_DATABASE_URL must be a valid URL");
            // `postgres://` isn't one of the URL crate's "special" schemes,
            // so `set_path` won't add the leading `/` on its own the way it
            // would for `http://` — without it Postgres sees an empty
            // database name and connects back to `cluster_url`'s own database.
            database_url.set_path(&format!("/{db_name}"));

            let pool = crate::db::pool::connect_and_migrate(database_url.as_str())
                .await
                .expect("failed to connect/migrate the isolated test database");

            Self { pool, admin_conn, db_name }
        }

        /// Drops the database this test created. Not a `Drop` impl: dropping
        /// a Postgres database needs an `async` query and `Drop` can't run
        /// one, so every test below calls this explicitly once it's done —
        /// the same manual cleanup `db::pool`'s PLT-020 test already does
        /// for its own scratch database.
        async fn teardown(mut self) {
            self.pool.close().await;
            sqlx::query(&format!("DROP DATABASE \"{}\" WITH (FORCE)", self.db_name))
                .execute(&mut self.admin_conn)
                .await
                .expect("failed to drop the isolated test database");
        }
    }

    /// Inserts a card whose `note_id` points at nothing, bypassing the
    /// `cards.note_id` foreign key for this one session only
    /// (`session_replication_role = replica`, the same mechanism Postgres's
    /// own logical-replication apply process uses to skip trigger/FK checks
    /// when it knows a row is already valid on the source). This is the only
    /// way to reproduce PLT-014's "inconsistência introduzida artificialmente"
    /// scenario at all, given the constraint that prevents it through every
    /// normal write path — and it leaves no lasting change: the setting is
    /// per-connection, reset before the connection is returned.
    async fn insert_orphaned_card(pool: &SqlitePool) -> Uuid {
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("SET session_replication_role = replica").execute(&mut *conn).await.unwrap();

        let card_id = Uuid::now_v7();
        sqlx::query("INSERT INTO cards (id, note_id, deck_id) VALUES ($1, $2, $3)")
            .bind(card_id)
            .bind(Uuid::now_v7())
            .bind(Uuid::now_v7())
            .execute(&mut *conn)
            .await
            .unwrap();

        sqlx::query("SET session_replication_role = origin").execute(&mut *conn).await.unwrap();
        card_id
    }

    #[tokio::test]
    #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
    async fn plt_014_an_orphaned_card_is_detected_and_deleted() {
        let db = IsolatedDatabase::setup().await;

        let orphan_id = insert_orphaned_card(&db.pool).await;

        let repo = IntegrityRepository::new(db.pool.clone());
        let report = repo.check_and_repair().await.unwrap();

        assert_eq!(report.total_repaired, 1);
        assert_eq!(report.orphaned_card_ids, vec![orphan_id]);

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id = $1")
            .bind(orphan_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);

        db.teardown().await;
    }

    #[tokio::test]
    #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
    async fn plt_014_a_database_with_no_orphans_reports_nothing_repaired() {
        let db = IsolatedDatabase::setup().await;

        let repo = IntegrityRepository::new(db.pool.clone());
        let report = repo.check_and_repair().await.unwrap();

        assert_eq!(report.total_repaired, 0);
        assert!(report.orphaned_card_ids.is_empty());

        db.teardown().await;
    }
}
