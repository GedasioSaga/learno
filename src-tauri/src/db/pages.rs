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
use sqlx::{SqlitePool, Sqlite, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
pub struct PageRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    pub parent_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
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
    #[sqlx(try_from = "DbId")]
    id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    parent_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
    database_id: Option<Uuid>,
    title: String,
    icon: Option<String>,
    position: String,
    is_favorite: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct BlockCopyRow {
    #[sqlx(try_from = "DbId")]
    id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    parent_block_id: Option<Uuid>,
    block_type: String,
    content: serde_json::Value,
    plain_text: String,
    position: String,
}

pub struct PageRepository {
    pool: SqlitePool,
}

impl PageRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// FUN-001/FUN-002: creates a page as the last active child of
    /// `parent_id` (or as a new root page when `parent_id` is `None`).
    /// `owner_section` is left `NULL` — this is the entry point every
    /// existing Notes call site uses, and none of them owns the page it
    /// creates.
    pub async fn create(&self, parent_id: Option<Uuid>, title: &str) -> Result<PageRow> {
        self.create_inner(parent_id, title, None).await
    }

    /// Como [`create`], mas gravando `owner_section` no INSERT em vez de
    /// deixá-lo `NULL` — para a página nascer já marcada como dono de uma
    /// seção, sem depender do backfill de `0034_dono_da_pagina.sql` (que só
    /// alcança dado que já existia no banco no momento em que a migração
    /// rodou). Hoje o único chamador é o comando IPC `create_page`, através
    /// do parâmetro opcional `owner_section` — a página-container que
    /// `features/trilha/store.ts` cria antes de chamar `criarTrilhaCompleta`.
    ///
    /// Método novo em vez de um parâmetro a mais em [`create`] de propósito:
    /// esta função já tem dezenas de chamadas em produção e teste, todas
    /// criando página de Notas de verdade — Rust não tem argumento com valor
    /// padrão, então acrescentar um parâmetro ali obrigaria editar cada uma
    /// delas só para passar `None`. Um segundo método explícito para o caso
    /// raro (uma seção marcando a própria página) deixa as dezenas de
    /// chamadas existentes exatamente como estão.
    pub async fn create_with_owner(&self, parent_id: Option<Uuid>, title: &str, owner_section: &str) -> Result<PageRow> {
        self.create_inner(parent_id, title, Some(owner_section)).await
    }

    async fn create_inner(&self, parent_id: Option<Uuid>, title: &str, owner_section: Option<&str>) -> Result<PageRow> {
        let new_position = self.next_position_under(parent_id).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, PageRow>(
            "INSERT INTO pages (id, parent_id, title, position, owner_section) VALUES ($1, $2, $3, $4, $5) \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id.db())
        .bind(parent_id.db())
        .bind(title)
        .bind(&new_position)
        .bind(owner_section)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// FASE 6 (`db::databases`): creates a record — a page with
    /// `database_id` set (0007's "a record is just a page"). Lives here,
    /// not in `db::databases`, because a record IS a page in every other
    /// respect: `trash`/`restore`/`rename`/`duplicate` above already work
    /// on it unmodified, and duplicating the tree-walking logic there would
    /// be exactly the kind of second write path this codebase's `pages`
    /// table has never needed.
    ///
    /// `parent_id` is left `NULL` on purpose — a record does NOT nest under
    /// its database's `container_page_id` (verified against every existing
    /// fixture that inserts a record: `tests/db_relations.rs`,
    /// `tests/db_trilha.rs`, `tests/db_timestamps.rs`, `tests/db_value_invariants.rs`
    /// all set only `database_id`, never `parent_id`). Sibling order among
    /// records is therefore NOT `next_position_under`'s `parent_id` scope —
    /// it is scoped by `database_id`, matching `idx_pages_database_records`
    /// (`0017_database_value_invariants.sql`, part 5) and the query
    /// `db::trilha::fetch_step_bases` already runs against it.
    pub async fn create_record(&self, database_id: Uuid, title: &str) -> Result<PageRow> {
        let new_position = self.next_position_in_database(database_id).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, PageRow>(
            "INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, $3, $4) \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id.db())
        .bind(database_id.db())
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
        .bind(id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página {id}")))
    }

    pub async fn rename(&self, id: Uuid, title: &str) -> Result<PageRow> {
        sqlx::query_as::<_, PageRow>(
            "UPDATE pages SET title = $2 WHERE id = $1 \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id.db())
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
        .bind(id.db())
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
        .bind(id.db())
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
        .bind(id.db())
        .bind(new_parent_id.db())
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
            .bind(new_id.db())
            .bind(new_parent_id.db())
            .bind(row.database_id.db())
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
            // `strftime` no lugar do `now()` do Postgres, com o mesmo formato
            // que as migrações usam como default: ISO 8601 em UTC de largura
            // fixa, `YYYY-MM-DDTHH:MM:SS.fffZ`. Largura fixa é o que faz a
            // ordenação lexicográfica de TEXT ser a ordenação cronológica.
            "UPDATE pages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1 AND deleted_at IS NULL \
             RETURNING id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at",
        )
        .bind(id.db())
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
        .bind(id.db())
        .bind(target_parent.db())
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// FUN-031: only ever removes a page that is already in the trash.
    pub async fn permanently_delete(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM pages WHERE id = $1 AND deleted_at IS NOT NULL")
            .bind(id.db())
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

    /// Active descendants of `root` (excluding `root` itself) that BELONG TO
    /// NOTES, ordered depth-first then by sibling position — enough for a
    /// caller to reconstruct the tree. `root = None` lists the whole active
    /// Notes tree.
    ///
    /// "Belong to Notes" excludes a page that some other section created for
    /// its own bookkeeping, even though every such page is a normal row in
    /// this same `pages` table (0003's tree machinery — trash, versions,
    /// blocks — is exactly what those sections wanted for free). Three
    /// conditions, each covering a shape the other two cannot:
    ///
    ///   1. `database_id IS NOT NULL` — the page IS a database record (0007):
    ///      a Trilha etapa (`TrilhaRepository::criar_etapa` ->
    ///      `DatabaseRepository::create_record`), a database template
    ///      (`is_template = 1`, 0020 — always paired with `database_id`, per
    ///      the partial index `idx_pages_templates`), or a record of any
    ///      other database the user builds inside a Notes page. Structural,
    ///      not `owner_section`, on purpose: a database can hold thousands
    ///      of records, and marking every single one at creation would be
    ///      pure waste — a record is NEVER addressed by parent/child
    ///      position in the sidebar, whichever database it belongs to, so
    ///      this condition has no false-positive risk to guard against.
    ///   2. `NOT EXISTS (library_books lb WHERE lb.page_id = p.id)` — the
    ///      page IS a livro's identity page (0022). Kept ALONGSIDE
    ///      `owner_section` rather than replaced by it: the backfill in
    ///      `0034_dono_da_pagina.sql` marks every book that existed at
    ///      migration time, but `BibliotecaRepository::import` (in
    ///      `src/db/biblioteca.rs`/`src/ipc/biblioteca_commands.rs`, a
    ///      workflow running concurrently with the change that introduced
    ///      `owner_section` — this file does not touch either of those two)
    ///      does not yet set `owner_section` on the page it creates. Until
    ///      that call site is updated (the exact line to add is in this
    ///      change's handoff), a book imported after 0034 has run would
    ///      have no mark at all, and this FK check is the only thing still
    ///      hiding it. Safe to drop only once that line lands.
    ///   3. `owner_section IS NOT NULL` (0034) — the page IS the CONTAINER a
    ///      section keeps for its own screen. Today the only example is
    ///      Trilha's: `databases.container_page_id` of the database behind
    ///      a `trail_views` view, created by
    ///      `TrilhaRepository::criar_trilha_completa` and, going forward,
    ///      marked at birth via [`create_with_owner`](Self::create_with_owner)
    ///      (the IPC command `create_page`'s new optional `owner_section`
    ///      argument — set by `features/trilha/store.ts` before it calls
    ///      `criarTrilhaCompleta`). This is the condition (1) and (2) could
    ///      never express: a database's own container page has EXACTLY the
    ///      same shape whether the user built the database themselves in
    ///      Notes or a section built it for its own screen — nothing in
    ///      `databases`/`database_views` marks which is which. The previous
    ///      design's known gap tried to infer this structurally ("a
    ///      container whose database has a `trail`-type view") and rejected
    ///      it on purpose: a user is free to add a legitimate `trail` view
    ///      to their OWN database (proven by the regression test
    ///      `list_tree_keeps_a_users_own_database_with_a_trail_view`
    ///      below), and that heuristic would have hidden it. Marking the
    ///      page directly at creation — plus one narrowly-scoped backfill
    ///      for what already existed (see 0034's own comment for exactly
    ///      why that backfill is safe today, and may stop being safe later)
    ///      — is the only way to hide the container without that risk.
    ///
    /// All three conditions are on the page being excluded, not on its
    /// ancestors, so a normal Notes sub-page keeps appearing at any depth —
    /// but because the recursive leg only descends from a row already
    /// inside `tree`, an excluded page's own descendants (a sub-page a user
    /// added under an etapa or a livro, which the schema does not forbid)
    /// are excluded too: they are reachable through that section's own
    /// screen, never through Notes.
    ///
    /// Deliberately NOT excluded, and why:
    ///
    ///   - A database's OWN container page in the general case
    ///     (`databases.container_page_id` with `owner_section IS NULL`).
    ///     This IS a page the user made in Notes and chose to put a
    ///     database into (DBS-001/002) — it must keep showing, `trail` view
    ///     on it or not.
    ///   - Mapa Mental and Cartões: read in full for the change that
    ///     introduced this filter (0010, 0011, 0013, 0025, `db::mindmap`,
    ///     `db::decks`, `features/cartoes`, `features/mapa-mental`) and
    ///     neither creates a `pages` row at all. `mindmaps.page_id` is the
    ///     REVERSE direction — an optional pointer FROM an independent mind
    ///     map TO an existing Notes page the user picked, not a page mind
    ///     maps own — so a page a mind map points to is a real Notes page
    ///     and must keep showing.
    ///
    /// A new section that starts stashing pages of its own must call
    /// [`create_with_owner`](Self::create_with_owner) at creation time, add
    /// its tag to the `CHECK` in `0034_dono_da_pagina.sql`, and extend this
    /// comment.
    pub async fn list_tree(&self, root: Option<Uuid>) -> Result<Vec<PageRow>> {
        let rows = sqlx::query_as::<_, PageRow>(
            "WITH RECURSIVE tree AS ( \
                 SELECT p.id, p.parent_id, p.database_id, p.title, p.icon, p.position, p.is_favorite, p.deleted_at, p.created_at, p.updated_at, 0 AS depth \
                 FROM pages p \
                 WHERE p.parent_id IS NOT DISTINCT FROM $1 AND p.deleted_at IS NULL \
                   AND p.database_id IS NULL \
                   AND p.owner_section IS NULL \
                   AND NOT EXISTS (SELECT 1 FROM library_books lb WHERE lb.page_id = p.id) \
                 UNION ALL \
                 SELECT p.id, p.parent_id, p.database_id, p.title, p.icon, p.position, p.is_favorite, p.deleted_at, p.created_at, p.updated_at, t.depth + 1 \
                 FROM pages p JOIN tree t ON p.parent_id = t.id \
                 WHERE p.deleted_at IS NULL \
                   AND p.database_id IS NULL \
                   AND p.owner_section IS NULL \
                   AND NOT EXISTS (SELECT 1 FROM library_books lb WHERE lb.page_id = p.id) \
             ) \
             SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM tree ORDER BY depth, position",
        )
        .bind(root.db())
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
    ///
    /// Deliberately UNFILTERED by section, unlike `list_tree` above: a
    /// trashed Trilha etapa or Biblioteca livro (both trashed through this
    /// same `pages` row — `BibliotecaRepository::move_to_trash` calls
    /// `PageRepository::trash` directly, and nothing in Trilha's or
    /// Biblioteca's own screens offers a trash view) has no OTHER path to
    /// restore or permanently delete today. Excluding it here would not move
    /// the confusion to "another section's own trash" the way the task asked
    /// to check for — Trilha and Biblioteca have none — it would make that
    /// row unreachable except by raw SQL, trading a cosmetic mismatch (an
    /// etapa's title sitting in a list titled "Notas") for real, if rare,
    /// data loss. If Trilha/Biblioteca ever grow their own trash screen,
    /// this listing should start excluding what that screen now owns, the
    /// same two conditions as `list_tree`.
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
        .bind(id.db())
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Err(Error::NotFound(format!("página {id}")));
        }

        Ok(rows)
    }

    /// Same fractional-index-at-the-end recipe as `next_position_under`,
    /// scoped by `database_id` instead of `parent_id` — see
    /// `create_record`'s doc comment for why records need their own scope.
    async fn next_position_in_database(&self, database_id: Uuid) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT position FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY position DESC LIMIT 1",
        )
        .bind(database_id.db())
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }

    async fn next_position_under(&self, parent_id: Option<Uuid>) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL ORDER BY position DESC LIMIT 1",
        )
        .bind(parent_id.db())
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }

    async fn active_siblings(&self, parent_id: Option<Uuid>, exclude_id: Uuid) -> Result<Vec<(Uuid, String)>> {
        // Leitura escalar tipada como `DbId` (não `Uuid`, ver src/db/ids.rs), e
        // convertida de volta ao tipo público da função logo em seguida.
        let rows: Vec<(DbId, String)> = sqlx::query_as(
            "SELECT id, position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL AND id <> $2 ORDER BY position",
        )
        .bind(parent_id.db())
        .bind(exclude_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
    }

    async fn page_is_active(&self, id: Uuid) -> Result<bool> {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL)")
                .bind(id.db())
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
        .bind(ancestor.db())
        .bind(candidate.db())
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

async fn fetch_active_subtree(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<Vec<SubtreeRow>> {
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
    .bind(id.db())
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows)
}

async fn fetch_next_sibling_position(
    tx: &mut Transaction<'_, Sqlite>,
    parent_id: Option<Uuid>,
    after_position: &str,
) -> Result<Option<String>> {
    let next: Option<String> = sqlx::query_scalar(
        "SELECT position FROM pages WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL AND position > $2 ORDER BY position ASC LIMIT 1",
    )
    .bind(parent_id.db())
    .bind(after_position)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(next)
}

async fn duplicate_blocks_for_page(
    tx: &mut Transaction<'_, Sqlite>,
    old_page_id: Uuid,
    new_page_id: Uuid,
) -> Result<()> {
    let blocks = sqlx::query_as::<_, BlockCopyRow>(
        "SELECT id, parent_block_id, block_type, content, plain_text, position FROM blocks WHERE page_id = $1 AND deleted_at IS NULL",
    )
    .bind(old_page_id.db())
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
        .bind(new_id.db())
        .bind(new_page_id.db())
        .bind(new_parent.db())
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
