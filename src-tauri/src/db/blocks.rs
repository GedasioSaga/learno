//! Repository for the block tree a page's editor is made of — Fase 2's `blocks`
//! table (`0006_blocks.sql`). Mirrors `db::pages`'s shape (fractional sibling
//! order via `db::position`, soft delete, a `neighbours_for`/cycle-check pair)
//! because a block is the same kind of tree as a page, one level down.
//!
//! Two things a page doesn't have to deal with:
//!
//! - **Batching** (`apply_changes`): the editor's autosave produces many small
//!   changes per second while someone types, so every mutating method here
//!   also has a batch form that runs inside one transaction — one round trip
//!   to SQLite per keystroke burst, not per keystroke.
//! - **Synced blocks** (EDT-073..078): `update` never special-cases this — a
//!   plain block's `synced_source_id` is `NULL`, so "propagate the patch to
//!   `synced_source_id`'s copies too" is a no-op update touching zero rows.
//!   The one exception is `move`, which never propagates: EDT-074 only
//!   promises edited *content* stays in sync, and a block's copies are meant
//!   to live in different places on different pages.
//!
//! Backlinks (FUN-044) are deliberately not this file's job — see
//! `db::backlinks` and `0016_block_page_links.sql`'s trigger for why an edge
//! table populated by SQLite itself, not a step this repository has to
//! remember to run, is what keeps them correct no matter which code path
//! writes a block's `content` (this repository's, or `db::pages::duplicate`'s
//! raw `INSERT`).

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{SqlitePool, Sqlite, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

/// A synced original is never deleted along with its copies silently past
/// this many of them — EDT-078. Below the threshold `delete_synced_original`
/// still deletes all of them, just without demanding `confirmed: true` first;
/// a handful of copies is the normal "I use this snippet in a few places"
/// case, eleven-plus is the case Notion (and this checklist) singles out for
/// an explicit warning.
const SYNCED_DELETE_CONFIRMATION_THRESHOLD: i64 = 10;

const BLOCK_COLUMNS: &str = "id, page_id, parent_block_id, block_type, content, plain_text, synced_source_id, position, created_at, updated_at";

/// Mirrors `Block` in `src/features/editor/contract.ts` field-for-field —
/// `camelCase` on the wire is a deliberate divergence from `PageRow`'s
/// `snake_case` (compare `src/lib/ipc.ts`'s `PageRow`), because the contract
/// was written down before this repository existed and other Fase 2 pieces
/// already build against its exact shape.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub page_id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    pub parent_block_id: Option<Uuid>,
    pub block_type: String,
    pub content: JsonValue,
    pub plain_text: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub synced_source_id: Option<Uuid>,
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Mirrors `BlockPlacement`. `after_block_id: None` means "first among its
/// siblings" — the contract's own wording — rather than `SiblingPosition`'s
/// three-way `Start`/`End`/`After` enum, because the editor never needs to
/// say "put this last" independent of what else is already there: a newly
/// typed block is always placed relative to the block the cursor was in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPlacementInput {
    pub page_id: Uuid,
    pub parent_block_id: Option<Uuid>,
    pub after_block_id: Option<Uuid>,
}

/// Mirrors `NewBlock`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBlockInput {
    /// O id que o bloco já tem no documento do editor — ver `NewBlock.id` em
    /// `contract.ts`. `None` significa "gere um", que é o caminho de um
    /// importador ou de um teste; o editor sempre manda o seu, porque o nó
    /// ProseMirror ganha id no instante em que é digitado e toda edição
    /// seguinte se refere ao bloco por ele. Quando este campo não existia, o
    /// backend gerava o seu próprio id e o editor passava a mandar UPDATE de
    /// uma linha inexistente — nenhum bloco digitado chegava ao banco.
    #[serde(default)]
    pub id: Option<Uuid>,
    pub block_type: String,
    pub content: JsonValue,
    pub plain_text: String,
    pub placement: BlockPlacementInput,
}

/// Mirrors `BlockPatch` — every field optional, so a caller only names what
/// changed. `Default` backs `apply_changes`' conflict test (an empty patch is
/// a valid no-op) without every call site spelling out three `None`s.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockPatchInput {
    pub block_type: Option<String>,
    pub content: Option<JsonValue>,
    pub plain_text: Option<String>,
}

/// Mirrors `BlockChange`'s tagged union exactly — `rename_all = "camelCase"`
/// on a single-word variant name (`Create`, `Update`, ...) lowercases just
/// the first letter, landing on the same `"create"`/`"update"`/`"delete"`/
/// `"move"` tag values the TypeScript side already serializes.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BlockChangeInput {
    Create { block: NewBlockInput },
    Update { id: Uuid, patch: BlockPatchInput },
    Delete { id: Uuid },
    Move { id: Uuid, placement: BlockPlacementInput },
}

pub struct BlockRepository {
    pool: SqlitePool,
}

impl BlockRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The whole active block tree of a page, flattened but in true document
    /// order (a block immediately followed by its own descendants, before any
    /// sibling's subtree) — not merely grouped by depth the way
    /// `PageRepository::list_tree` sorts pages, since sibling `position`
    /// values are only comparable within their own `(page_id,
    /// parent_block_id)` scope and a page can have many separate scopes at
    /// the same depth. `sort_path`, o caminho de posições de todo ancestral
    /// até este bloco, restaura uma ordem total única.
    ///
    /// Na versão Postgres o caminho era um ARRAY de texto, e a comparação de
    /// array trata um array mais curto que é prefixo de outro como menor —
    /// o que põe o pai imediatamente antes dos filhos dele. SQLite não tem
    /// array: o caminho vira TEXTO concatenado, e para a comparação de texto
    /// preservar a mesma ordem o separador precisa ordenar ABAIXO de qualquer
    /// caractere que possa aparecer numa posição.
    ///
    /// Por isso `char(1)` (U+0001) e não `'/'` ou `'.'`: o índice fracionário
    /// é gerado pelo crate `fractional_index` e este código não deve depender
    /// de qual alfabeto ele usa hoje. Com U+0001, que é menor que todo
    /// caractere imprimível, a propriedade vale para qualquer alfabeto que
    /// ele venha a usar.
    ///
    /// O caso que isso protege, e que uma escolha ingênua de separador
    /// quebraria em silêncio: um bloco de posição "a" com um filho, ao lado
    /// de um irmão de posição "ab". O filho tem caminho "a\x01…", o irmão tem
    /// "ab"; como \x01 < 'b', o filho vem antes do irmão — que é a ordem de
    /// documento correta. Com um separador maior que 'b', o filho apareceria
    /// DEPOIS do irmão, e o documento do usuário sairia reordenado sem erro
    /// nenhum.
    pub async fn list_page_blocks(&self, page_id: Uuid) -> Result<Vec<BlockRow>> {
        let sql = format!(
            "WITH RECURSIVE tree AS ( \
                 SELECT {BLOCK_COLUMNS}, position AS sort_path \
                 FROM blocks WHERE page_id = $1 AND parent_block_id IS NULL AND deleted_at IS NULL \
                 UNION ALL \
                 SELECT b.id, b.page_id, b.parent_block_id, b.block_type, b.content, b.plain_text, b.synced_source_id, b.position, b.created_at, b.updated_at, \
                        t.sort_path || char(1) || b.position \
                 FROM blocks b JOIN tree t ON b.parent_block_id = t.id \
                 WHERE b.deleted_at IS NULL \
             ) \
             SELECT {BLOCK_COLUMNS} FROM tree ORDER BY sort_path"
        );

        let rows = sqlx::query_as::<_, BlockRow>(&sql).bind(page_id.db()).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    /// Creates a block per `NewBlock`'s placement. A short transaction (not
    /// the two bare round trips this used to be — validate the parent, then
    /// insert) because tag extraction (`db::tags::sync_block_tags`) needs to
    /// commit atomically with the row it reads `content` from; the race this
    /// module used to accept (nothing else deletes a block out from under a
    /// concurrent insert in the handful of milliseconds between validating
    /// the parent and inserting) is unaffected either way.
    pub async fn create(&self, input: NewBlockInput) -> Result<BlockRow> {
        validate_parent(&self.pool, input.placement.page_id, input.placement.parent_block_id).await?;
        let siblings = active_siblings(&self.pool, input.placement.page_id, input.placement.parent_block_id, None).await?;
        let new_position = position_between(&siblings, input.placement.after_block_id)?;
        // `Uuid::now_v7()` só quando o chamador não trouxe id — ver `NewBlockInput::id`.
        let id = input.id.unwrap_or_else(Uuid::now_v7);

        let mut tx = self.pool.begin().await?;
        let sql = format!(
            "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, position) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {BLOCK_COLUMNS}"
        );
        let row = sqlx::query_as::<_, BlockRow>(&sql)
            .bind(id.db())
            .bind(input.placement.page_id.db())
            .bind(input.placement.parent_block_id.db())
            .bind(&input.block_type)
            .bind(&input.content)
            .bind(&input.plain_text)
            .bind(&new_position)
            .fetch_one(&mut *tx)
            .await?;
        crate::db::tags::sync_block_tags(&mut tx, row.id, &row.block_type, &row.plain_text).await?;
        tx.commit().await?;

        Ok(row)
    }

    /// EDT-074: patches `id`, and — when `id` is part of a synced group,
    /// whether as the original or as one of its copies — every other member
    /// of that group, so editing any instance updates them all. `canonical`
    /// (the original: `id` itself when `id` has no `synced_source_id`, or
    /// whatever it points to otherwise) is always patched first and every row
    /// pointing back at it second; for an ordinary block with no group at
    /// all, `canonical == id` and the second statement touches zero rows.
    pub async fn update(&self, id: Uuid, patch: BlockPatchInput) -> Result<BlockRow> {
        let mut tx = self.pool.begin().await?;

        let current = fetch_active_tx(&mut tx, id).await?;
        let canonical = current.synced_source_id.unwrap_or(current.id);

        let touched = apply_patch(&mut tx, canonical, &patch).await?;
        if touched == 0 {
            return Err(Error::NotFound(format!("bloco ativo {canonical}")));
        }
        apply_patch_to_copies(&mut tx, canonical, &patch).await?;
        resync_tags_for_canonical_and_copies(&mut tx, canonical).await?;

        let result = fetch_active_tx(&mut tx, id).await?;
        tx.commit().await?;
        Ok(result)
    }

    /// Soft-deletes every id given plus, for each, its whole live subtree —
    /// unlike `PageRepository::trash`, which leaves a trashed page's children
    /// merely unreachable (the Lixeira UI needs the parent row's own
    /// `deleted_at` to show *what* was trashed and offer to restore it; a
    /// block has no such per-row undo screen, so an orphaned live child would
    /// just be silent garbage with no way back). Refuses the whole batch
    /// before touching anything if it would delete a synced original that
    /// still has copies — EDT-078's warning path is `delete_synced_original`,
    /// not this generic one, precisely so a plain multi-select delete can
    /// never quietly take an unrelated page's synced copies down with it.
    pub async fn delete_blocks(&self, ids: &[Uuid]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let unique_ids: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();

        let mut tx = self.pool.begin().await?;
        ensure_all_active(&mut tx, &unique_ids).await?;
        let closure = descendant_closure(&mut tx, &unique_ids).await?;
        reject_synced_originals_with_copies(&mut tx, &closure).await?;

        soft_delete_ids(&mut tx, &closure).await?;

        tx.commit().await?;
        Ok(())
    }

    /// Reparents/reorders a block. Refuses to move a block into its own
    /// subtree (a cycle no tree query could ever terminate on) the same way
    /// `PageRepository::move_page` refuses it for pages. When the destination
    /// page differs from the block's current one, every live descendant's
    /// `page_id` is cascaded to match — each still points at its parent only
    /// through `parent_block_id`, so leaving a stale `page_id` behind would
    /// desync a column this repository otherwise treats as authoritative
    /// (`list_page_blocks` filters by it directly).
    pub async fn move_block(&self, id: Uuid, placement: BlockPlacementInput) -> Result<BlockRow> {
        let mut tx = self.pool.begin().await?;

        let current = fetch_active_tx(&mut tx, id).await?;

        if let Some(candidate_parent) = placement.parent_block_id {
            if candidate_parent == id || is_within_subtree(&mut tx, id, candidate_parent).await? {
                return Err(Error::Invalid(
                    "não é possível mover um bloco para dentro de sua própria subárvore".into(),
                ));
            }
        }
        validate_parent_tx(&mut tx, placement.page_id, placement.parent_block_id).await?;

        let siblings = active_siblings_tx(&mut tx, placement.page_id, placement.parent_block_id, Some(id)).await?;
        let new_position = position_between(&siblings, placement.after_block_id)?;

        let sql = format!("UPDATE blocks SET page_id = $2, parent_block_id = $3, position = $4 WHERE id = $1 RETURNING {BLOCK_COLUMNS}");
        let row = sqlx::query_as::<_, BlockRow>(&sql)
            .bind(id.db())
            .bind(placement.page_id.db())
            .bind(placement.parent_block_id.db())
            .bind(&new_position)
            .fetch_one(&mut *tx)
            .await?;

        if placement.page_id != current.page_id {
            cascade_page_id(&mut tx, id, placement.page_id).await?;
        }

        tx.commit().await?;
        Ok(row)
    }

    /// The editor's autosave batch endpoint: applies every change in the
    /// given order inside one transaction, so a burst of keystrokes is one
    /// round trip and one all-or-nothing outcome. A change that fails (e.g.
    /// an `update` naming a block a preceding `delete` in the same batch
    /// already removed) aborts the transaction before any of the batch's
    /// writes land — nothing is committed instead of the batch stopping
    /// partway through.
    ///
    /// Returns one row per non-`delete` change, in the same order they were
    /// given — a `delete` produces no row to hand back, so the result can be
    /// shorter than `changes`.
    pub async fn apply_changes(&self, changes: Vec<BlockChangeInput>) -> Result<Vec<BlockRow>> {
        let mut tx = self.pool.begin().await?;
        let mut results = Vec::with_capacity(changes.len());

        for change in changes {
            match change {
                BlockChangeInput::Create { block } => {
                    let row = create_in_tx(&mut tx, block).await?;
                    results.push(row);
                }
                BlockChangeInput::Update { id, patch } => {
                    let current = fetch_active_tx(&mut tx, id).await?;
                    let canonical = current.synced_source_id.unwrap_or(current.id);
                    let touched = apply_patch(&mut tx, canonical, &patch).await?;
                    if touched == 0 {
                        return Err(Error::NotFound(format!("bloco ativo {canonical}")));
                    }
                    apply_patch_to_copies(&mut tx, canonical, &patch).await?;
                    resync_tags_for_canonical_and_copies(&mut tx, canonical).await?;
                    results.push(fetch_active_tx(&mut tx, id).await?);
                }
                BlockChangeInput::Delete { id } => {
                    ensure_all_active(&mut tx, std::slice::from_ref(&id)).await?;
                    let closure = descendant_closure(&mut tx, std::slice::from_ref(&id)).await?;
                    reject_synced_originals_with_copies(&mut tx, &closure).await?;
                    soft_delete_ids(&mut tx, &closure).await?;
                }
                BlockChangeInput::Move { id, placement } => {
                    let current = fetch_active_tx(&mut tx, id).await?;
                    if let Some(candidate_parent) = placement.parent_block_id {
                        if candidate_parent == id || is_within_subtree(&mut tx, id, candidate_parent).await? {
                            return Err(Error::Invalid(
                                "não é possível mover um bloco para dentro de sua própria subárvore".into(),
                            ));
                        }
                    }
                    validate_parent_tx(&mut tx, placement.page_id, placement.parent_block_id).await?;
                    let siblings = active_siblings_tx(&mut tx, placement.page_id, placement.parent_block_id, Some(id)).await?;
                    let new_position = position_between(&siblings, placement.after_block_id)?;

                    let sql = format!("UPDATE blocks SET page_id = $2, parent_block_id = $3, position = $4 WHERE id = $1 RETURNING {BLOCK_COLUMNS}");
                    let row = sqlx::query_as::<_, BlockRow>(&sql)
                        .bind(id.db())
                        .bind(placement.page_id.db())
                        .bind(placement.parent_block_id.db())
                        .bind(&new_position)
                        .fetch_one(&mut *tx)
                        .await?;

                    if placement.page_id != current.page_id {
                        cascade_page_id(&mut tx, id, placement.page_id).await?;
                    }
                    results.push(row);
                }
            }
        }

        tx.commit().await?;
        Ok(results)
    }

    /// EDT-073's "paste this synced block elsewhere": creates a new block at
    /// `placement` carrying `source_id`'s current content and pointing its
    /// `synced_source_id` at whatever `source_id` itself ultimately resolves
    /// to (pasting a copy of a copy still points at the one true original —
    /// there is never a chain of copies-of-copies to walk on a later edit).
    pub async fn create_synced_copy(&self, source_id: Uuid, placement: BlockPlacementInput) -> Result<BlockRow> {
        let source = fetch_active_pool(&self.pool, source_id).await?;
        let canonical_id = source.synced_source_id.unwrap_or(source.id);
        let canonical = if canonical_id == source.id {
            source
        } else {
            fetch_active_pool(&self.pool, canonical_id).await?
        };

        validate_parent(&self.pool, placement.page_id, placement.parent_block_id).await?;
        let siblings = active_siblings(&self.pool, placement.page_id, placement.parent_block_id, None).await?;
        let new_position = position_between(&siblings, placement.after_block_id)?;
        let id = Uuid::now_v7();

        let mut tx = self.pool.begin().await?;
        let sql = format!(
            "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, synced_source_id, position) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {BLOCK_COLUMNS}"
        );
        let row = sqlx::query_as::<_, BlockRow>(&sql)
            .bind(id.db())
            .bind(placement.page_id.db())
            .bind(placement.parent_block_id.db())
            .bind(&canonical.block_type)
            .bind(&canonical.content)
            .bind(&canonical.plain_text)
            .bind(canonical_id.db())
            .bind(&new_position)
            .fetch_one(&mut *tx)
            .await?;
        // The pasted copy starts out with the same content (and thus the
        // same tags) as its source — EDT-073 — so this new block's own
        // block_id needs its own block_tags rows too, not just the
        // original's.
        crate::db::tags::sync_block_tags(&mut tx, row.id, &row.block_type, &row.plain_text).await?;
        tx.commit().await?;

        Ok(row)
    }

    /// How many live copies point at `id` (resolved to its canonical original
    /// first, so asking about a copy answers about the whole group) — what
    /// the frontend checks before showing EDT-078's confirmation.
    pub async fn count_synced_copies(&self, id: Uuid) -> Result<i64> {
        let row = fetch_active_pool(&self.pool, id).await?;
        let canonical = row.synced_source_id.unwrap_or(row.id);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks WHERE synced_source_id = $1 AND deleted_at IS NULL")
            .bind(canonical.db())
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    /// EDT-076: detaches exactly this one copy, leaving its current content
    /// as its own from now on and every other member of the group untouched.
    pub async fn unsync_one(&self, id: Uuid) -> Result<BlockRow> {
        let sql = format!(
            "UPDATE blocks SET synced_source_id = NULL \
             WHERE id = $1 AND deleted_at IS NULL AND synced_source_id IS NOT NULL RETURNING {BLOCK_COLUMNS}"
        );
        let row = sqlx::query_as::<_, BlockRow>(&sql).bind(id.db()).fetch_optional(&self.pool).await?;

        match row {
            Some(row) => Ok(row),
            None => {
                // Distinguishes "no such active block" from "it exists but
                // was never a copy" instead of one flat error either way.
                fetch_active_pool(&self.pool, id).await?;
                Err(Error::Invalid("bloco não é uma cópia sincronizada".into()))
            }
        }
    }

    /// EDT-077: detaches every copy of the original named by `id`. Rejects a
    /// copy passed in its place — "unsync all" is the original's action on
    /// its whole group, not a copy's action on its siblings.
    pub async fn unsync_all(&self, id: Uuid) -> Result<Vec<BlockRow>> {
        let original = fetch_active_pool(&self.pool, id).await?;
        if original.synced_source_id.is_some() {
            return Err(Error::Invalid(
                "use o bloco original para desconectar todas as cópias de uma vez".into(),
            ));
        }

        let sql = format!(
            "UPDATE blocks SET synced_source_id = NULL WHERE synced_source_id = $1 AND deleted_at IS NULL RETURNING {BLOCK_COLUMNS}"
        );
        let rows = sqlx::query_as::<_, BlockRow>(&sql).bind(id.db()).fetch_all(&self.pool).await?;
        Ok(rows)
    }

    /// EDT-078: deletes a synced original and, unlike the generic
    /// `delete_blocks` (which refuses outright), its copies along with it —
    /// "apagadas, não só desvinculadas". Past
    /// [`SYNCED_DELETE_CONFIRMATION_THRESHOLD`] copies this refuses unless
    /// `confirmed` is `true`, so the caller must have shown the warning and
    /// gotten an explicit yes first rather than this layer trusting a caller
    /// that skipped it.
    pub async fn delete_synced_original(&self, id: Uuid, confirmed: bool) -> Result<()> {
        let original = fetch_active_pool(&self.pool, id).await?;
        if original.synced_source_id.is_some() {
            return Err(Error::Invalid(
                "bloco informado é uma cópia, não o original; para apagar só esta cópia use delete_blocks".into(),
            ));
        }

        let copy_count: i64 = sqlx::query_scalar("SELECT count(*) FROM blocks WHERE synced_source_id = $1 AND deleted_at IS NULL")
            .bind(id.db())
            .fetch_one(&self.pool)
            .await?;

        if copy_count > SYNCED_DELETE_CONFIRMATION_THRESHOLD && !confirmed {
            return Err(Error::Invalid(format!(
                "o bloco original tem {copy_count} cópias vinculadas; confirme a exclusão para apagar todas junto com o original"
            )));
        }

        sqlx::query(// `$1` aparece duas vezes de propósito: SQLite trata `$1` como parâmetro
        // NOMEADO, então as duas ocorrências são o mesmo parâmetro e consomem um
        // único `bind` — verificado, não suposto. É o único lugar do projeto que
        // reusa um placeholder.
        "UPDATE blocks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')          WHERE (id = $1 OR synced_source_id = $1) AND deleted_at IS NULL")
            .bind(id.db())
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

/// Pure: given the ordered active siblings a block will land among (as
/// `(id, position)`, the block being placed already excluded) and the
/// `afterBlockId` the placement named, finds the two neighbour position
/// strings the new position must sit strictly between. Same shape as
/// `db::pages::neighbours_for`, simplified to `BlockPlacement`'s two-way
/// "first" (`None`) / "after this sibling" (`Some`) instead of three cases,
/// since a block placement never says "last" on its own.
fn neighbours_for(siblings: &[(Uuid, String)], after_block_id: Option<Uuid>) -> Result<(Option<&str>, Option<&str>)> {
    match after_block_id {
        None => Ok((None, siblings.first().map(|(_, p)| p.as_str()))),
        Some(after_id) => {
            let index = siblings
                .iter()
                .position(|(id, _)| *id == after_id)
                .ok_or_else(|| Error::Invalid("bloco de referência não é irmão ativo no destino".into()))?;
            let before = siblings[index].1.as_str();
            let after = siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after))
        }
    }
}

fn position_between(siblings: &[(Uuid, String)], after_block_id: Option<Uuid>) -> Result<String> {
    let (before_raw, after_raw) = neighbours_for(siblings, after_block_id)?;
    let before = before_raw.map(position::parse).transpose()?;
    let after = after_raw.map(position::parse).transpose()?;
    position::between(before.as_ref(), after.as_ref())
}

async fn active_siblings(
    pool: &SqlitePool,
    page_id: Uuid,
    parent_block_id: Option<Uuid>,
    exclude_id: Option<Uuid>,
) -> Result<Vec<(Uuid, String)>> {
    // Leitura escalar de par (id, position): DbId no lugar de Uuid, convertido
    // de volta ao devolver — ver src/db/ids.rs.
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM blocks \
         WHERE page_id = $1 AND parent_block_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND id IS DISTINCT FROM $3 \
         ORDER BY position",
    )
    .bind(page_id.db())
    .bind(parent_block_id.db())
    .bind(exclude_id.db())
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

async fn active_siblings_tx(
    tx: &mut Transaction<'_, Sqlite>,
    page_id: Uuid,
    parent_block_id: Option<Uuid>,
    exclude_id: Option<Uuid>,
) -> Result<Vec<(Uuid, String)>> {
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM blocks \
         WHERE page_id = $1 AND parent_block_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND id IS DISTINCT FROM $3 \
         ORDER BY position",
    )
    .bind(page_id.db())
    .bind(parent_block_id.db())
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

/// A placement's `parent_block_id`, when given, must name a block that is
/// both active and already on the same page — a parent from another page
/// would leave the child's `page_id` and `parent_block_id` disagreeing about
/// which page it lives on.
async fn validate_parent(pool: &SqlitePool, page_id: Uuid, parent_block_id: Option<Uuid>) -> Result<()> {
    let Some(parent_id) = parent_block_id else {
        return Ok(());
    };
    let parent_page: Option<DbId> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = $1 AND deleted_at IS NULL")
        .bind(parent_id.db())
        .fetch_optional(pool)
        .await?;
    let parent_page = parent_page.map(Uuid::from);
    match parent_page {
        Some(found) if found == page_id => Ok(()),
        Some(_) => Err(Error::Invalid("bloco pai pertence a outra página".into())),
        None => Err(Error::NotFound(format!("bloco pai ativo {parent_id}"))),
    }
}

async fn validate_parent_tx(tx: &mut Transaction<'_, Sqlite>, page_id: Uuid, parent_block_id: Option<Uuid>) -> Result<()> {
    let Some(parent_id) = parent_block_id else {
        return Ok(());
    };
    let parent_page: Option<DbId> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = $1 AND deleted_at IS NULL")
        .bind(parent_id.db())
        .fetch_optional(&mut **tx)
        .await?;
    let parent_page = parent_page.map(Uuid::from);
    match parent_page {
        Some(found) if found == page_id => Ok(()),
        Some(_) => Err(Error::Invalid("bloco pai pertence a outra página".into())),
        None => Err(Error::NotFound(format!("bloco pai ativo {parent_id}"))),
    }
}

async fn fetch_active_pool(pool: &SqlitePool, id: Uuid) -> Result<BlockRow> {
    let sql = format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE id = $1 AND deleted_at IS NULL");
    sqlx::query_as::<_, BlockRow>(&sql)
        .bind(id.db())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("bloco ativo {id}")))
}

async fn fetch_active_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<BlockRow> {
    let sql = format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE id = $1 AND deleted_at IS NULL");
    sqlx::query_as::<_, BlockRow>(&sql)
        .bind(id.db())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("bloco ativo {id}")))
}

/// Every id in `ids` must currently be an active block, or the whole caller
/// (a bulk delete, a batch change) fails before it changes anything instead
/// of silently skipping the ones that don't qualify.
async fn ensure_all_active(tx: &mut Transaction<'_, Sqlite>, ids: &[Uuid]) -> Result<()> {
    // `= ANY($1)` do Postgres vira `IN (?, ?, ?)`: SQLite não tem array, então
    // a lista é um placeholder por elemento. Ver `db::sql`.
    let sql = format!(
        "SELECT count(*) FROM blocks WHERE id IN ({}) AND deleted_at IS NULL",
        crate::db::sql::in_placeholders(ids.len())
    );
    let mut query = sqlx::query_scalar::<_, i64>(&sql);
    for id in ids {
        query = query.bind(id.db());
    }
    let count: i64 = query.fetch_one(&mut **tx).await?;
    // Widening, not narrowing: `ids.len()` is an in-memory Vec built from one
    // IPC call's payload, so it fits `i64` with enormous room to spare (an
    // actual `usize` that large would have already failed to allocate long
    // before reaching here) — comparing on the `i64` side avoids narrowing
    // `count` down to `usize` instead.
    if count != ids.len() as i64 {
        return Err(Error::NotFound("um ou mais blocos não existem ou já foram excluídos".into()));
    }
    Ok(())
}

/// `ids` plus every live descendant of each, reachable through
/// `parent_block_id` at any depth.
async fn descendant_closure(tx: &mut Transaction<'_, Sqlite>, ids: &[Uuid]) -> Result<Vec<Uuid>> {
    let sql = format!(
        "WITH RECURSIVE d AS ( \
             SELECT id FROM blocks WHERE id IN ({}) AND deleted_at IS NULL \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN d ON b.parent_block_id = d.id WHERE b.deleted_at IS NULL \
         ) SELECT id FROM d",
        crate::db::sql::in_placeholders(ids.len())
    );
    let mut query = sqlx::query_as::<_, (DbId,)>(&sql);
    for id in ids {
        query = query.bind(id.db());
    }
    let rows = query.fetch_all(&mut **tx).await?;
    Ok(rows.into_iter().map(|(id,)| Uuid::from(id)).collect())
}

/// Exclusão lógica de um conjunto de ids, fatiada para caber no teto de
/// parâmetros de uma consulta SQLite.
///
/// Existe porque o mesmo `UPDATE` aparecia em dois lugares e porque a lista
/// aqui é uma *subárvore* (`descendant_closure`), não a lista que o usuário
/// mandou: apagar um bloco com muitos descendentes gera facilmente mais ids
/// do que cabe num statement. No Postgres isso era invisível — um array é um
/// parâmetro só, de qualquer tamanho.
async fn soft_delete_ids(tx: &mut Transaction<'_, Sqlite>, ids: &[Uuid]) -> Result<()> {
    for pedaco in ids.chunks(crate::db::sql::MAX_BIND_PARAMS) {
        let sql = format!(
            "UPDATE blocks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE id IN ({}) AND deleted_at IS NULL",
            crate::db::sql::in_placeholders(pedaco.len())
        );
        let mut query = sqlx::query(&sql);
        for id in pedaco {
            query = query.bind(id.db());
        }
        query.execute(&mut **tx).await?;
    }
    Ok(())
}

/// True when `candidate` is `ancestor` itself or lies anywhere in its live
/// subtree — the same "would this reparent create a cycle" check
/// `PageRepository::is_within_subtree` runs for pages, one level down.
async fn is_within_subtree(tx: &mut Transaction<'_, Sqlite>, ancestor: Uuid, candidate: Uuid) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "WITH RECURSIVE descendants AS ( \
             SELECT id FROM blocks WHERE id = $1 \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN descendants d ON b.parent_block_id = d.id \
         ) \
         SELECT EXISTS (SELECT 1 FROM descendants WHERE id = $2)",
    )
    .bind(ancestor.db())
    .bind(candidate.db())
    .fetch_one(&mut **tx)
    .await?;
    Ok(exists)
}

/// Refuses the operation if any block in `closure` is a synced original that
/// still has live copies — see `BlockRepository::delete_blocks`'s doc for why
/// that path exists (`delete_synced_original`) instead of this one silently
/// orphaning copies elsewhere on the workspace.
async fn reject_synced_originals_with_copies(tx: &mut Transaction<'_, Sqlite>, closure: &[Uuid]) -> Result<()> {
    let sql = format!(
        "SELECT EXISTS ( \
             SELECT 1 FROM blocks o WHERE o.id IN ({}) AND o.deleted_at IS NULL \
               AND EXISTS (SELECT 1 FROM blocks c WHERE c.synced_source_id = o.id AND c.deleted_at IS NULL) \
         )",
        crate::db::sql::in_placeholders(closure.len())
    );
    let mut query = sqlx::query_scalar::<_, bool>(&sql);
    for id in closure {
        query = query.bind(id.db());
    }
    let has_offender: bool = query.fetch_one(&mut **tx).await?;

    if has_offender {
        return Err(Error::Invalid(
            "não é possível excluir um bloco sincronizado original que ainda tem cópias vinculadas; use delete_synced_original".into(),
        ));
    }
    Ok(())
}

/// Propagates a moved block's page to every live descendant, since a
/// descendant only ever names its parent (`parent_block_id`), never its own
/// page — its `page_id` column would otherwise silently disagree with the
/// page it actually renders on.
async fn cascade_page_id(tx: &mut Transaction<'_, Sqlite>, moved_block_id: Uuid, new_page_id: Uuid) -> Result<()> {
    sqlx::query(
        "WITH RECURSIVE d AS ( \
             SELECT id FROM blocks WHERE parent_block_id = $1 AND deleted_at IS NULL \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN d ON b.parent_block_id = d.id WHERE b.deleted_at IS NULL \
         ) \
         UPDATE blocks SET page_id = $2 WHERE id IN (SELECT id FROM d)",
    )
    .bind(moved_block_id.db())
    .bind(new_page_id.db())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Applies `patch`'s given fields to exactly one row (`COALESCE` keeps an
/// omitted field at its current value) and reports how many rows matched, so
/// callers can tell "patched" from "no such active block" without a second
/// query.
async fn apply_patch(tx: &mut Transaction<'_, Sqlite>, id: Uuid, patch: &BlockPatchInput) -> Result<u64> {
    let result = sqlx::query(
        "UPDATE blocks SET block_type = COALESCE($2, block_type), content = COALESCE($3, content), plain_text = COALESCE($4, plain_text) \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id.db())
    .bind(&patch.block_type)
    .bind(&patch.content)
    .bind(&patch.plain_text)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// The other half of EDT-074: the same patch, mirrored onto every block whose
/// `synced_source_id` points at `canonical_id`. Zero matching rows (the
/// ordinary, non-synced case) is success, not an error.
async fn apply_patch_to_copies(tx: &mut Transaction<'_, Sqlite>, canonical_id: Uuid, patch: &BlockPatchInput) -> Result<()> {
    sqlx::query(
        "UPDATE blocks SET block_type = COALESCE($2, block_type), content = COALESCE($3, content), plain_text = COALESCE($4, plain_text) \
         WHERE synced_source_id = $1 AND deleted_at IS NULL",
    )
    .bind(canonical_id.db())
    .bind(&patch.block_type)
    .bind(&patch.content)
    .bind(&patch.plain_text)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// After a patch lands on `canonical_id` and is mirrored onto its synced
/// copies (`apply_patch_to_copies`), the tag index needs the same fan-out:
/// canonical first, then every live copy, each re-scanned from its own
/// current `block_type`/`plain_text` — not copied from canonical's tag set,
/// because a copy can (rarely, but legally) have drifted to a different
/// `block_type` via a patch that only touched `content`/`plain_text` on one
/// instance before this function existed, and re-reading each row's own
/// columns is no more expensive than trusting they still match.
async fn resync_tags_for_canonical_and_copies(tx: &mut Transaction<'_, Sqlite>, canonical_id: Uuid) -> Result<()> {
    let canonical = fetch_active_tx(tx, canonical_id).await?;
    crate::db::tags::sync_block_tags(tx, canonical.id, &canonical.block_type, &canonical.plain_text).await?;

    let sql = format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE synced_source_id = $1 AND deleted_at IS NULL");
    let copies = sqlx::query_as::<_, BlockRow>(&sql).bind(canonical_id.db()).fetch_all(&mut **tx).await?;
    for copy in copies {
        crate::db::tags::sync_block_tags(tx, copy.id, &copy.block_type, &copy.plain_text).await?;
    }
    Ok(())
}

async fn create_in_tx(tx: &mut Transaction<'_, Sqlite>, input: NewBlockInput) -> Result<BlockRow> {
    validate_parent_tx(tx, input.placement.page_id, input.placement.parent_block_id).await?;
    let siblings = active_siblings_tx(tx, input.placement.page_id, input.placement.parent_block_id, None).await?;
    let new_position = position_between(&siblings, input.placement.after_block_id)?;
    // `Uuid::now_v7()` só quando o chamador não trouxe id — ver `NewBlockInput::id`.
    let id = input.id.unwrap_or_else(Uuid::now_v7);

    let sql = format!(
        "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, position) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {BLOCK_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BlockRow>(&sql)
        .bind(id.db())
        .bind(input.placement.page_id.db())
        .bind(input.placement.parent_block_id.db())
        .bind(&input.block_type)
        .bind(&input.content)
        .bind(&input.plain_text)
        .bind(&new_position)
        .fetch_one(&mut **tx)
        .await?;
    crate::db::tags::sync_block_tags(tx, row.id, &row.block_type, &row.plain_text).await?;

    Ok(row)
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
    fn neighbours_for_none_is_open_below_the_current_first() {
        let a = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        let (before, after) = neighbours_for(&siblings, None).unwrap();

        assert_eq!(before, None);
        assert_eq!(after, Some("10"));
    }

    #[test]
    fn neighbours_for_after_sits_between_the_named_sibling_and_the_next() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let siblings = vec![sibling(a, "10"), sibling(b, "20")];

        let (before, after) = neighbours_for(&siblings, Some(a)).unwrap();

        assert_eq!(before, Some("10"));
        assert_eq!(after, Some("20"));
    }

    #[test]
    fn neighbours_for_after_an_unknown_sibling_is_rejected() {
        let a = Uuid::now_v7();
        let stranger = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        assert!(neighbours_for(&siblings, Some(stranger)).is_err());
    }

    #[test]
    fn neighbours_for_none_on_an_empty_list_has_no_bounds() {
        let siblings: Vec<(Uuid, String)> = Vec::new();

        assert_eq!(neighbours_for(&siblings, None).unwrap(), (None, None));
    }

    #[test]
    fn position_between_produces_a_value_strictly_inside_the_gap() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let low = position::first();
        let high = position::between(Some(&position::parse(&low).unwrap()), None).unwrap();
        let siblings = vec![sibling(a, &low), sibling(b, &high)];

        let placed = position_between(&siblings, Some(a)).unwrap();

        assert!(placed > low);
        assert!(placed < high);
    }
}
