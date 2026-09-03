//! Repository for the page tree — Fase 1's FUN items (create, read, rename,
//! move/reorder, duplicate, trash, restore, permanent delete, list tree) all
//! operate on the `pages` table (`0003_pages.sql`).
//!
//! Sibling order is a fractional index (see `db::position`): every mutation
//! that changes where a page sits writes exactly one `position` value
//! between its two new neighbours, never a renumbering pass over the rest
//! of the list.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::db::position;
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
pub struct PageRow {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub database_id: Option<Uuid>,
    pub title: String,
    pub icon: Option<String>,
    pub position: String,
    pub is_favorite: bool,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Where a moved or duplicated page should land relative to its new active
/// siblings.
///
/// `Deserialize` (adjacently tagged as `{ "type": ..., "value": ... }`) is
/// here for `ipc::commands::move_page`, whose caller is the frontend's drag
/// target / keyboard-move logic, not another Rust module — plain `#[derive]`
/// keeps that wire format explicit instead of guessing serde's untagged
/// default for a mixed unit/tuple enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum SiblingPosition {
    Start,
    End,
    /// Immediately after the given sibling, which must already be an active
    /// child of the destination parent.
    After(Uuid),
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SubtreeRow {
    id: Uuid,
    parent_id: Option<Uuid>,
    database_id: Option<Uuid>,
    title: String,
    icon: Option<String>,
    position: String,
    is_favorite: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct BlockCopyRow {
    id: Uuid,
    parent_block_id: Option<Uuid>,
    block_type: String,
    content: serde_json::Value,
    plain_text: String,
    position: String,
}

pub struct PageRepository {
    pool: PgPool,
}

impl PageRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// FUN-001/FUN-002: creates a page as the last active child of
    /// `parent_id` (or as a new root page when `parent_id` is `None`).
    pub async fn create(&self, parent_id: Option<Uuid>, title: &str) -> Result<PageRow> {
        let new_position = self.next_position_under(parent_id).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, PageRow>(
            "INSERT INTO pages (id, parent_id, title, position) VALUES ($1, $2, $3, $4) \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(parent_id)
        .bind(title)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// Reads a page regardless of trash state — callers that only want
    /// active pages check `deleted_at` themselves.
    pub async fn get(&self, id: Uuid) -> Result<PageRow> {
        sqlx::query_as::<_, PageRow>(
            "SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM pages WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página {id}")))
    }

    pub async fn rename(&self, id: Uuid, title: &str) -> Result<PageRow> {
        sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET title = $2 WHERE id = $1 \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(title)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página {id}")))
    }

    /// FUN-008/FUN-009.
    pub async fn set_favorite(&self, id: Uuid, is_favorite: bool) -> Result<PageRow> {
        sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET is_favorite = $2 WHERE id = $1 AND deleted_at IS NULL \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(is_favorite)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página ativa {id}")))
    }

    /// FUN-011: `icon` is one emoji (or `None` to clear it back to the
    /// default book icon the sidebar falls back to) — this layer stores
    /// whatever string it is handed and leaves "is this a single emoji"
    /// validation to the picker UI that produced it.
    pub async fn set_icon(&self, id: Uuid, icon: Option<&str>) -> Result<PageRow> {
        sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET icon = $2 WHERE id = $1 AND deleted_at IS NULL \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(icon)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página ativa {id}")))
    }

    /// FUN-004 (reorder among siblings), FUN-005/FUN-006 (aninhar/desaninhar
    /// via drag), FUN-022 ("Move to"): all of these are "place this page
    /// among `new_parent_id`'s active children, at `target`".
    pub async fn move_page(
        &self,
        id: Uuid,
        new_parent_id: Option<Uuid>,
        target: SiblingPosition,
    ) -> Result<PageRow> {
        let page = self.get(id).await?;
        if page.deleted_at.is_some() {
            return Err(Error::Invalid(
                "não é possível mover uma página que está na lixeira".into(),
            ));
        }

        if let Some(candidate_parent) = new_parent_id {
            if candidate_parent == id || self.is_within_subtree(id, candidate_parent).await? {
                return Err(Error::Invalid(
                    "não é possível mover uma página para dentro de sua própria subárvore".into(),
                ));
            }
        }

        let siblings = self.active_siblings(new_parent_id, id).await?;
        let (before_raw, after_raw) = neighbours_for(&siblings, target)?;
        let before = before_raw.map(position::parse).transpose()?;
        let after = after_raw.map(position::parse).transpose()?;
        let new_position = position::between(before.as_ref(), after.as_ref())?;

        let row = sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET parent_id = $2, position = $3 WHERE id = $1 \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(new_parent_id)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// FUN-020: copies the page and, recursively, every active descendant
    /// (plus each one's blocks) under fresh ids, leaving the originals
    /// untouched. The new top-level copy is titled "<original> (cópia)" and
    /// inserted as the sibling immediately after the original; descendants
    /// keep their original titles and relative order.
    pub async fn duplicate(&self, id: Uuid) -> Result<PageRow> {
        let mut tx = self.pool.begin().await?;

        let subtree = fetch_active_subtree(&mut tx, id).await?;
        let Some(root) = subtree.first().cloned() else {
            // Query returned nothing: either the page never existed, or it
            // does but sits in the trash — `get` tells us which, then we
            // still refuse the trashed case explicitly.
            drop(tx);
            self.get(id).await?;
            return Err(Error::Invalid(
                "não é possível duplicar uma página que está na lixeira".into(),
            ));
        };

        let sibling_position = {
            let after = position::parse(&root.position)?;
            let next_raw = fetch_next_sibling_position(&mut tx, root.parent_id, &root.position).await?;
            let next = next_raw.as_deref().map(position::parse).transpose()?;
            position::between(Some(&after), next.as_ref())?
        };

        let mut id_map: HashMap<Uuid, Uuid> = HashMap::with_capacity(subtree.len());
        for row in &subtree {
            id_map.insert(row.id, Uuid::now_v7());
        }

        for row in &subtree {
            let new_id = *id_map.get(&row.id).ok_or_else(|| {
                Error::Invalid("mapeamento de duplicação corrompido: id de página ausente".into())
            })?;
            let is_root = row.id == id;
            let new_parent_id = if is_root {
                root.parent_id
            } else {
                row.parent_id.and_then(|old_parent| id_map.get(&old_parent).copied())
            };
            let new_title = if is_root {
                duplicate_title(&row.title)
            } else {
                row.title.clone()
            };
            let new_position = if is_root {
                sibling_position.clone()
            } else {
                row.position.clone()
            };

            sqlx::query(
                "INSERT INTO pages (id, parent_id, database_id, title, icon, position, is_favorite) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(new_id)
            .bind(new_parent_id)
            .bind(row.database_id)
            .bind(&new_title)
            .bind(&row.icon)
            .bind(&new_position)
            .bind(row.is_favorite)
            .execute(&mut *tx)
            .await?;

            duplicate_blocks_for_page(&mut tx, row.id, new_id).await?;
        }

        let new_root_id = *id_map.get(&id).ok_or_else(|| {
            Error::Invalid("mapeamento de duplicação corrompido: raiz ausente".into())
        })?;

        tx.commit().await?;

        self.get(new_root_id).await
    }

    /// FUN-027: soft-delete. Rejects a page that is already trashed instead
    /// of silently no-op'ing, so a caller retrying a stale action finds out.
    pub async fn trash(&self, id: Uuid) -> Result<PageRow> {
        let row = sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(row),
            None => {
                self.get(id).await?;
                Err(Error::Invalid("página já está na lixeira".into()))
            }
        }
    }

    /// FUN-029/FUN-030: un-trashes the page. If its original parent is gone
    /// or itself still trashed, the page comes back at the root instead of
    /// failing — see [`resolve_restore_parent`].
    pub async fn restore(&self, id: Uuid) -> Result<PageRow> {
        let page = self.get(id).await?;
        if page.deleted_at.is_none() {
            return Err(Error::Invalid("página não está na lixeira".into()));
        }

        let parent_is_active = match page.parent_id {
            Some(parent_id) => self.page_is_active(parent_id).await?,
            None => true,
        };
        let target_parent = resolve_restore_parent(page.parent_id, parent_is_active);

        let new_position = if target_parent == page.parent_id {
            // Same parent as before deletion (or both still root): keep the
            // original slot rather than spend a query recomputing one.
            page.position.clone()
        } else {
            self.next_position_under(target_parent).await?
        };

        let row = sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET parent_id = $2, position = $3, deleted_at = NULL WHERE id = $1 \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id)
        .bind(target_parent)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// FUN-031: only ever removes a page that is already in the trash.
    pub async fn permanently_delete(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM pages WHERE id = $1 AND deleted_at IS NOT NULL")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            self.get(id).await?;
            return Err(Error::Invalid(
                "só é possível excluir permanentemente uma página que está na lixeira".into(),
            ));
        }

        Ok(())
    }

    /// Active descendants of `root` (excluding `root` itself), ordered
    /// depth-first then by sibling position — enough for a caller to
    /// reconstruct the tree. `root = None` lists the whole active tree.
    pub async fn list_tree(&self, root: Option<Uuid>) -> Result<Vec<PageRow>> {
        let rows = sqlx::query_as::<_, PageRow>(
            "WITH RECURSIVE tree AS ( \
                 SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at, 0 AS depth \
                 FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL \
                 UNION ALL \
                 SELECT p.id, p.parent_id, p.database_id, p.title, p.icon, p.position, p.is_favorite, p.deleted_at, p.created_at, p.updated_at, t.depth + 1 \
                 FROM pages p JOIN tree t ON p.parent_id = t.id \
                 WHERE p.deleted_at IS NULL \
             ) \
             SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM tree ORDER BY depth, position",
        )
        .bind(root)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// Every trashed page (`deleted_at IS NOT NULL`), most recently deleted
    /// first — backs the Lixeira screen (FUN-027/029/030/031). Deliberately
    /// flat with no tree walk: a page can end up here with its former parent
    /// also trashed or gone, so "where it used to sit" is not something this
    /// listing needs to reconstruct, only `restore` (which already falls
    /// back to root when that parent is unusable).
    pub async fn list_trash(&self) -> Result<Vec<PageRow>> {
        let rows = sqlx::query_as::<_, PageRow>(
            "SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// FUN-019: the page itself plus every ancestor, root-first.
    pub async fn breadcrumb(&self, id: Uuid) -> Result<Vec<PageRow>> {
        let rows = sqlx::query_as::<_, PageRow>(
            "WITH RECURSIVE ancestors AS ( \
                 SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at, 0 AS depth \
                 FROM pages WHERE id = $1 \
                 UNION ALL \
                 SELECT p.id, p.parent_id, p.database_id, p.title, p.icon, p.position, p.is_favorite, p.deleted_at, p.created_at, p.updated_at, a.depth + 1 \
                 FROM pages p JOIN ancestors a ON p.id = a.parent_id \
             ) \
             SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM ancestors ORDER BY depth DESC",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Err(Error::NotFound(format!("página {id}")));
        }

        Ok(rows)
    }

    async fn next_position_under(&self, parent_id: Option<Uuid>) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL ORDER BY position DESC LIMIT 1",
        )
        .bind(parent_id)
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }

    async fn active_siblings(&self, parent_id: Option<Uuid>, exclude_id: Uuid) -> Result<Vec<(Uuid, String)>> {
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL AND id <> $2 ORDER BY position",
        )
        .bind(parent_id)
        .bind(exclude_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    async fn page_is_active(&self, id: Uuid) -> Result<bool> {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL)")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;

        Ok(exists)
    }

    /// True when `candidate` is `ancestor` itself or lies anywhere in its
    /// subtree — used to reject reparenting a page into its own descendant.
    async fn is_within_subtree(&self, ancestor: Uuid, candidate: Uuid) -> Result<bool> {
        let exists: bool = sqlx::query_scalar(
            "WITH RECURSIVE descendants AS ( \
                 SELECT id FROM pages WHERE id = $1 \
                 UNION ALL \
                 SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id \
             ) \
             SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $2)",
        )
        .bind(ancestor)
        .bind(candidate)
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }
}

/// Pure: given the ordered active siblings a page will land among (as
/// `(id, position)`, excluding the page being placed), finds the two
/// neighbour position strings the new position must sit strictly between.
/// This is the part of "reorder without rewriting the list" that needs no
/// database to verify — see the tests below.
fn neighbours_for(
    ordered_siblings: &[(Uuid, String)],
    target: SiblingPosition,
) -> Result<(Option<&str>, Option<&str>)> {
    match target {
        SiblingPosition::Start => Ok((None, ordered_siblings.first().map(|(_, p)| p.as_str()))),
        SiblingPosition::End => Ok((ordered_siblings.last().map(|(_, p)| p.as_str()), None)),
        SiblingPosition::After(sibling_id) => {
            let index = ordered_siblings
                .iter()
                .position(|(id, _)| *id == sibling_id)
                .ok_or_else(|| Error::Invalid("página de referência não é irmã ativa no destino".into()))?;
            let before = ordered_siblings[index].1.as_str();
            let after = ordered_siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after))
        }
    }
}

/// Pure: FUN-030 — restoring a page whose original parent no longer exists,
/// or is itself still in the trash, falls back to the root instead of
/// erroring or resurrecting the parent.
fn resolve_restore_parent(original_parent_id: Option<Uuid>, parent_is_active: bool) -> Option<Uuid> {
    match original_parent_id {
        Some(_) if parent_is_active => original_parent_id,
        _ => None,
    }
}

/// Pure: FUN-020's "(cópia)" suffix on the duplicated page's own title.
fn duplicate_title(original: &str) -> String {
    format!("{original} (cópia)")
}

async fn fetch_active_subtree(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<Vec<SubtreeRow>> {
    let rows = sqlx::query_as::<_, SubtreeRow>(
        "WITH RECURSIVE subtree AS ( \
             SELECT id, parent_id, database_id, title, icon, position, is_favorite, 0 AS depth \
             FROM pages WHERE id = $1 AND deleted_at IS NULL \
             UNION ALL \
             SELECT p.id, p.parent_id, p.database_id, p.title, p.icon, p.position, p.is_favorite, s.depth + 1 \
             FROM pages p JOIN subtree s ON p.parent_id = s.id \
             WHERE p.deleted_at IS NULL \
         ) \
         SELECT id, parent_id, database_id, title, icon, position, is_favorite FROM subtree ORDER BY depth",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows)
}

async fn fetch_next_sibling_position(
    tx: &mut Transaction<'_, Postgres>,
    parent_id: Option<Uuid>,
    after_position: &str,
) -> Result<Option<String>> {
    let next: Option<String> = sqlx::query_scalar(
        "SELECT position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL AND position > $2 ORDER BY position ASC LIMIT 1",
    )
    .bind(parent_id)
    .bind(after_position)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(next)
}

async fn duplicate_blocks_for_page(
    tx: &mut Transaction<'_, Postgres>,
    old_page_id: Uuid,
    new_page_id: Uuid,
) -> Result<()> {
    let blocks = sqlx::query_as::<_, BlockCopyRow>(
        "SELECT id, parent_block_id, block_type, content, plain_text, position FROM blocks WHERE page_id = $1 AND deleted_at IS NULL",
    )
    .bind(old_page_id)
    .fetch_all(&mut **tx)
    .await?;

    let mut id_map: HashMap<Uuid, Uuid> = HashMap::with_capacity(blocks.len());
    for block in &blocks {
        id_map.insert(block.id, Uuid::now_v7());
    }

    for block in &blocks {
        let new_id = *id_map.get(&block.id).ok_or_else(|| {
            Error::Invalid("mapeamento de duplicação corrompido: id de bloco ausente".into())
        })?;
        let new_parent = block.parent_block_id.and_then(|old| id_map.get(&old).copied());

        sqlx::query(
            "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, position) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(new_id)
        .bind(new_page_id)
        .bind(new_parent)
        .bind(&block.block_type)
        .bind(&block.content)
        .bind(&block.plain_text)
        .bind(&block.position)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn sibling(id: Uuid, position: &str) -> (Uuid, String) {
        (id, position.to_string())
    }

    #[test]
    fn neighbours_for_start_is_open_below_the_current_first() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let siblings = vec![sibling(a, "10"), sibling(b, "20")];

        let (before, after) = neighbours_for(&siblings, SiblingPosition::Start).unwrap();

        assert_eq!(before, None);
        assert_eq!(after, Some("10"));
    }

    #[test]
    fn neighbours_for_end_is_open_above_the_current_last() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let siblings = vec![sibling(a, "10"), sibling(b, "20")];

        let (before, after) = neighbours_for(&siblings, SiblingPosition::End).unwrap();

        assert_eq!(before, Some("20"));
        assert_eq!(after, None);
    }

    #[test]
    fn neighbours_for_after_sits_between_the_named_sibling_and_the_next() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let c = Uuid::now_v7();
        let siblings = vec![sibling(a, "10"), sibling(b, "20"), sibling(c, "30")];

        let (before, after) = neighbours_for(&siblings, SiblingPosition::After(a)).unwrap();

        assert_eq!(before, Some("10"));
        assert_eq!(after, Some("20"));
    }

    #[test]
    fn neighbours_for_after_the_last_sibling_is_open_above() {
        let a = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        let (before, after) = neighbours_for(&siblings, SiblingPosition::After(a)).unwrap();

        assert_eq!(before, Some("10"));
        assert_eq!(after, None);
    }

    #[test]
    fn neighbours_for_after_an_unknown_sibling_is_rejected() {
        let a = Uuid::now_v7();
        let stranger = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        assert!(neighbours_for(&siblings, SiblingPosition::After(stranger)).is_err());
    }

    #[test]
    fn neighbours_for_start_or_end_of_an_empty_list_has_no_bounds() {
        let siblings: Vec<(Uuid, String)> = Vec::new();

        assert_eq!(neighbours_for(&siblings, SiblingPosition::Start).unwrap(), (None, None));
        assert_eq!(neighbours_for(&siblings, SiblingPosition::End).unwrap(), (None, None));
    }

    #[test]
    fn restore_keeps_the_original_parent_when_it_is_still_active() {
        let parent = Some(Uuid::now_v7());

        assert_eq!(resolve_restore_parent(parent, true), parent);
    }

    #[test]
    fn restore_falls_back_to_root_when_the_parent_is_trashed() {
        let parent = Some(Uuid::now_v7());

        assert_eq!(resolve_restore_parent(parent, false), None);
    }

    #[test]
    fn restore_of_a_page_that_was_already_a_root_stays_a_root() {
        assert_eq!(resolve_restore_parent(None, true), None);
        assert_eq!(resolve_restore_parent(None, false), None);
    }

    #[test]
    fn duplicate_title_appends_the_expected_suffix() {
        assert_eq!(duplicate_title("Módulo 1"), "Módulo 1 (cópia)");
    }

    #[test]
    fn sibling_position_deserializes_the_wire_shape_the_frontend_sends() {
        let start: SiblingPosition = serde_json::from_str(r#"{"type":"start"}"#).unwrap();
        let end: SiblingPosition = serde_json::from_str(r#"{"type":"end"}"#).unwrap();
        let id = Uuid::now_v7();
        let after: SiblingPosition =
            serde_json::from_str(&format!(r#"{{"type":"after","value":"{id}"}}"#)).unwrap();

        assert_eq!(start, SiblingPosition::Start);
        assert_eq!(end, SiblingPosition::End);
        assert_eq!(after, SiblingPosition::After(id));
    }
}
