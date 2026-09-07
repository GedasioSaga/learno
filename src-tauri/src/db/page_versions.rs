//! Version history for a page's content (FUN-034/FUN-035/FUN-036), backed by
//! `page_versions` (`0005_page_versions.sql`).
//!
//! Deliberately independent of the `blocks` table: a version is a frozen,
//! opaque snapshot of "what the page looked like" at a moment in time, while
//! `blocks` holds the live, editable structure Fase 2's editor writes to.
//! Restoring a version never has to reverse-engineer block rows from a blob,
//! and taking a snapshot never has to understand every block type.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{SqlitePool, Sqlite, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::error::{Error, Result};

/// Why a given [`PageVersionRow`] was captured — matches the `reason` CHECK
/// constraint in `0005_page_versions.sql`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotReason {
    /// FUN-034: taken automatically on a timer while editing.
    Autosave,
    Manual,
    /// FUN-036: taken automatically when an older version is restored, so
    /// the timeline before the restore is never lost.
    Restore,
}

impl SnapshotReason {
    fn as_db_str(self) -> &'static str {
        match self {
            SnapshotReason::Autosave => "autosave",
            SnapshotReason::Manual => "manual",
            SnapshotReason::Restore => "restore",
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct PageVersionRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub page_id: Uuid,
    pub title: String,
    pub content: serde_json::Value,
    pub reason: String,
    pub created_at: DateTime<Utc>,
}

pub struct PageVersionRepository {
    pool: SqlitePool,
}

impl PageVersionRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// FUN-034: freezes the page's current title/content as a new snapshot.
    pub async fn snapshot(
        &self,
        page_id: Uuid,
        title: &str,
        content: serde_json::Value,
        reason: SnapshotReason,
    ) -> Result<PageVersionRow> {
        let mut tx = self.pool.begin().await?;
        let row = insert_snapshot(&mut tx, page_id, title, content, reason).await?;
        tx.commit().await?;

        Ok(row)
    }

    /// FUN-035: newest snapshot first.
    ///
    /// `rowid` como desempate não é enfeite: `created_at` é TEXT com precisão
    /// de milissegundo (`strftime('%Y-%m-%dT%H:%M:%fZ')`), e dois snapshots do
    /// mesmo milissegundo — um autosave logo antes de um "restaurar", por
    /// exemplo — empatam. Sem desempate, "mais novo primeiro" vira ordem
    /// indefinida justamente no par que o usuário mais olha. `rowid` é a ordem
    /// de inserção do SQLite, monotônica e nunca reutilizada dentro da tabela,
    /// então empate resolve pelo que entrou depois. No Postgres o problema não
    /// aparecia: `now()` tem precisão de microssegundo.
    pub async fn list(&self, page_id: Uuid) -> Result<Vec<PageVersionRow>> {
        let rows = sqlx::query_as::<_, PageVersionRow>(
            "SELECT id, page_id, title, content, reason, created_at \
             FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC, rowid DESC",
        )
        .bind(page_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// FUN-036: makes `version_id`'s title/content the page's current one,
    /// then records the restoration as a brand new snapshot. Every version
    /// already in history — including the one just restored — is untouched.
    ///
    /// The title update and the restoration snapshot share one transaction:
    /// without that, a crash or lost connection between the two writes would
    /// leave the page's title changed with no corresponding snapshot ever
    /// recorded, contradicting the "a new restoration snapshot is created"
    /// half of this feature's acceptance criterion.
    pub async fn restore(&self, page_id: Uuid, version_id: Uuid) -> Result<PageVersionRow> {
        let mut tx = self.pool.begin().await?;

        let version = sqlx::query_as::<_, PageVersionRow>(
            "SELECT id, page_id, title, content, reason, created_at \
             FROM page_versions WHERE id = $1 AND page_id = $2",
        )
        .bind(version_id.db())
        .bind(page_id.db())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("versão {version_id} da página {page_id}")))?;

        let updated = sqlx::query("UPDATE pages SET title = $2 WHERE id = $1 AND deleted_at IS NULL")
            .bind(page_id.db())
            .bind(&version.title)
            .execute(&mut *tx)
            .await?;

        if updated.rows_affected() == 0 {
            return Err(Error::NotFound(format!("página ativa {page_id}")));
        }

        let snapshot = insert_snapshot(
            &mut tx,
            page_id,
            &version.title,
            version.content,
            SnapshotReason::Restore,
        )
        .await?;

        tx.commit().await?;

        Ok(snapshot)
    }
}

/// Shared by `snapshot` (its own single-statement transaction) and `restore`
/// (a transaction it shares with the page's title update) so the INSERT
/// itself only has to be written once.
async fn insert_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    page_id: Uuid,
    title: &str,
    content: serde_json::Value,
    reason: SnapshotReason,
) -> Result<PageVersionRow> {
    let id = Uuid::now_v7();

    let row = sqlx::query_as::<_, PageVersionRow>(
        "INSERT INTO page_versions (id, page_id, title, content, reason) VALUES ($1, $2, $3, $4, $5) \
         RETURNING id, page_id, title, content, reason, created_at",
    )
    .bind(id.db())
    .bind(page_id.db())
    .bind(title)
    .bind(content)
    .bind(reason.as_db_str())
    .fetch_one(&mut **tx)
    .await?;

    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reason_maps_to_the_check_constraint_values() {
        assert_eq!(SnapshotReason::Autosave.as_db_str(), "autosave");
        assert_eq!(SnapshotReason::Manual.as_db_str(), "manual");
        assert_eq!(SnapshotReason::Restore.as_db_str(), "restore");
    }
}
