//! `RelationRepository` — every read and write against
//! `database_relations` / `database_relation_edges`
//! (`0018_database_relations.sql`) and against the `database_properties`
//! rows with `property_type = 'relation'` that window onto them. See
//! `mod.rs` for what this piece owns and its one documented divergência.
//!
//! ## Reading: direct, reverse, and the symmetric UNION
//!
//! A relation-type property's `config` names a `relationId` and an `end`
//! (`"source" | "target" | "symmetric"` — [`RelationEnd`]). Every read/write
//! method here starts by resolving that pair
//! ([`RelationRepository::property_relation_ref`]) and then branches on
//! `end`:
//!
//! - `Source` reads forward: `database_relation_edges` rows where this
//!   record is `source_record_id`, ordered by `source_position`.
//! - `Target` reads reverse: rows where this record is `target_record_id`,
//!   ordered by `target_position` — DBS-087's reciprocal column, ordered
//!   independently of the forward side (arquitetura §5: "um índice
//!   fracionário POR EXTREMO").
//! - `Symmetric` (DBS-088) reads a `UNION ALL` of both, because the single
//!   shared column's edges are normalised (`source_record_id <
//!   target_record_id`, enforced by that table's own CHECK) so a given
//!   record can show up on EITHER side of a stored row depending on which
//!   of the two uuids happens to be smaller — the trap named in this
//!   piece's brief as the one that most breaks a directed-edge model. The
//!   app never decides which side a record is on for display purposes; the
//!   UNION always asks both and lets the `WHERE` clauses pick out the rows
//!   that actually mention the record in question.
//!
//! ## Writing: cardinality and position
//!
//! DBS-090's cardinality is enforced at exactly two points, both here:
//! [`RelationRepository::set_relation_targets`] treats more ids than the
//! limit as a caller bug and errors; [`RelationRepository::add_relation_targets`]
//! at a limit of 1 REPLACES instead (the UI's single-select write path).
//!
//! Every edge carries an independent fractional-index position per end
//! (`source_position`/`target_position`, `db::position`) so DBS-087's
//! reciprocal column can be reordered without touching the forward side's
//! order, and so DBS-088's symmetric column can append a new partner to
//! either record's own view of the list without a renumbering pass.
//!
//! ## Cascades this piece owns (arquitetura §5)
//!
//! - **Record deleted permanently** — a plain FK (`pages(id) ON DELETE
//!   CASCADE` on both `source_record_id`/`target_record_id`). Nothing to
//!   write; `tests/db_relations.rs` proves it by calling
//!   `PageRepository::permanently_delete` on a real page, never by
//!   fabricating a `DELETE FROM database_relation_edges` by hand (that
//!   would be the exact `db_backlinks.rs` false-green this piece's brief
//!   warns against).
//! - **Record trashed** — the edge row survives (`deleted_at` lives on the
//!   page, not the edge); every read query here filters
//!   `pages.deleted_at IS NULL`, so a trashed record's edges simply stop
//!   appearing until `PageRepository::restore` brings them back, with zero
//!   code path needed on either side of that transition.
//! - **One property of a two-way pair deleted** — nothing beyond deleting
//!   that one `database_properties` row: the other end is an independent
//!   row and is untouched, so the relation is a one-way relation from that
//!   point on with no further write.
//! - **The last property referencing a relation deleted** — the relation
//!   and its edges are deleted. Implemented as a Postgres trigger
//!   (`database_properties_cleanup_relation`, added to
//!   `0018_database_relations.sql` by this piece) rather than Rust,
//!   deliberately: `database_properties` has no single owning file the way
//!   `database_record_values` does (I4), so a generic "delete this
//!   property" command written by a different piece can issue a plain
//!   `DELETE FROM database_properties` with no idea it was a relation
//!   column, and the cascade still has to happen. A trigger is the one
//!   mechanism guaranteed to run no matter which code path performs that
//!   `DELETE` — the same reasoning `0016_block_page_links.sql` already
//!   documents for backlinks.
//!
//! **Not this piece:** the target database being deleted (`database_relations`
//! cascades away via its own `target_database_id` FK, and per arquitetura
//! §5 the *surviving* property should be marked `broken`, never deleted).
//! That marking is `0019_database_derived.sql`'s own documented T5,
//! explicitly assigned there to the formula/rollup piece — see `mod.rs`'s
//! divergência note for why this piece's reads stay correct without it.

use std::collections::{HashMap, HashSet};

use fractional_index::FractionalIndex;
use sqlx::{SqlitePool, Sqlite, Transaction};
use uuid::Uuid;

use crate::db::position;
use crate::error::{Error, Result};

use super::types::{
    CreateRelationInput, CreateRelationResult, RecordTargets, RelationDefinitionRow, RelationEnd, RelationTargetPage,
    RelationTargetRow,
};

/// Hard ceiling on `limit`/`per_record_limit`, independent of what a caller
/// asks for — never trust external input (regra 11), and the literal case
/// this piece's brief names: a Fase 4 deck with 50 000 cards on the other
/// side of one relation must never have a code path that can return all of
/// them at once.
const MAX_PAGE_SIZE: i64 = 500;

const FORWARD_MAX_POSITION_SQL: &str =
    "SELECT max(source_position) FROM database_relation_edges WHERE relation_id = $1 AND source_record_id = $2";
const REVERSE_MAX_POSITION_SQL: &str =
    "SELECT max(target_position) FROM database_relation_edges WHERE relation_id = $1 AND target_record_id = $2";
/// DBS-088: a symmetric record's "own" ordered list spans BOTH columns,
/// since it can be stored as either the smaller or the larger of a given
/// pair. Appending to it means looking at the max across both.
const SYMMETRIC_MAX_POSITION_SQL: &str = "\
    SELECT max(pos) FROM ( \
        SELECT source_position AS pos FROM database_relation_edges WHERE relation_id = $1 AND source_record_id = $2 \
        UNION ALL \
        SELECT target_position AS pos FROM database_relation_edges WHERE relation_id = $1 AND target_record_id = $2 \
    ) t";

const INSERT_EDGE_SQL: &str = "\
    INSERT INTO database_relation_edges \
        (relation_id, source_record_id, target_record_id, source_position, target_position, is_symmetric) \
    VALUES ($1, $2, $3, $4, $5, $6)";

const FORWARD_ITEMS_SQL: &str = "\
    SELECT p.id AS record_id, p.title, p.icon \
    FROM database_relation_edges e \
    JOIN pages p ON p.id = e.target_record_id \
    WHERE e.relation_id = $1 AND e.source_record_id = $2 AND p.deleted_at IS NULL \
    ORDER BY e.source_position \
    LIMIT $3 OFFSET $4";
const FORWARD_COUNT_SQL: &str = "\
    SELECT count(*) FROM database_relation_edges e \
    JOIN pages p ON p.id = e.target_record_id \
    WHERE e.relation_id = $1 AND e.source_record_id = $2 AND p.deleted_at IS NULL";

const REVERSE_ITEMS_SQL: &str = "\
    SELECT p.id AS record_id, p.title, p.icon \
    FROM database_relation_edges e \
    JOIN pages p ON p.id = e.source_record_id \
    WHERE e.relation_id = $1 AND e.target_record_id = $2 AND p.deleted_at IS NULL \
    ORDER BY e.target_position \
    LIMIT $3 OFFSET $4";
const REVERSE_COUNT_SQL: &str = "\
    SELECT count(*) FROM database_relation_edges e \
    JOIN pages p ON p.id = e.source_record_id \
    WHERE e.relation_id = $1 AND e.target_record_id = $2 AND p.deleted_at IS NULL";

const SYMMETRIC_ITEMS_SQL: &str = "\
    SELECT p.id AS record_id, p.title, p.icon FROM ( \
        SELECT e.target_record_id AS other_id, e.source_position AS ord \
        FROM database_relation_edges e WHERE e.relation_id = $1 AND e.source_record_id = $2 \
        UNION ALL \
        SELECT e.source_record_id AS other_id, e.target_position AS ord \
        FROM database_relation_edges e WHERE e.relation_id = $1 AND e.target_record_id = $2 \
    ) combined \
    JOIN pages p ON p.id = combined.other_id \
    WHERE p.deleted_at IS NULL \
    ORDER BY combined.ord \
    LIMIT $3 OFFSET $4";
const SYMMETRIC_COUNT_SQL: &str = "\
    SELECT count(*) FROM ( \
        SELECT e.target_record_id AS other_id \
        FROM database_relation_edges e WHERE e.relation_id = $1 AND e.source_record_id = $2 \
        UNION ALL \
        SELECT e.source_record_id AS other_id \
        FROM database_relation_edges e WHERE e.relation_id = $1 AND e.target_record_id = $2 \
    ) combined \
    JOIN pages p ON p.id = combined.other_id \
    WHERE p.deleted_at IS NULL";

/// Raw row for the three `*_BULK_SQL` queries — `owner_id` is the input
/// `record_id` this result row belongs to (never the caller-visible
/// `record_id`, which is the OTHER end and is aliased separately), and
/// `owner_total` rides along precomputed by a window function so one query
/// answers both "the page" and "the total" for every owner at once.
#[derive(Debug, Clone, sqlx::FromRow)]
struct BulkTargetRow {
    owner_id: Uuid,
    record_id: Uuid,
    title: String,
    icon: Option<String>,
    owner_total: i64,
}

/// `count(*) OVER (PARTITION BY owner_id)` is computed INSIDE the `ranked`
/// CTE, before the outer `WHERE rn <= $3` filters rows — so it reflects the
/// true per-owner total, not just the page. Getting this backwards (filtering
/// first) is the easy way to reintroduce the N+1 this method exists to kill:
/// a caller who trusted a post-filter count would fall back to one extra
/// query per record to learn the real total.
const FORWARD_BULK_SQL: &str = "\
    WITH ranked AS ( \
        SELECT e.source_record_id AS owner_id, p.id AS record_id, p.title, p.icon, \
               row_number() OVER (PARTITION BY e.source_record_id ORDER BY e.source_position) AS rn, \
               count(*) OVER (PARTITION BY e.source_record_id) AS owner_total \
        FROM database_relation_edges e \
        JOIN pages p ON p.id = e.target_record_id \
        WHERE e.relation_id = $1 AND e.source_record_id = ANY($2) AND p.deleted_at IS NULL \
    ) \
    SELECT owner_id, record_id, title, icon, owner_total FROM ranked WHERE rn <= $3 ORDER BY owner_id, rn";

const REVERSE_BULK_SQL: &str = "\
    WITH ranked AS ( \
        SELECT e.target_record_id AS owner_id, p.id AS record_id, p.title, p.icon, \
               row_number() OVER (PARTITION BY e.target_record_id ORDER BY e.target_position) AS rn, \
               count(*) OVER (PARTITION BY e.target_record_id) AS owner_total \
        FROM database_relation_edges e \
        JOIN pages p ON p.id = e.source_record_id \
        WHERE e.relation_id = $1 AND e.target_record_id = ANY($2) AND p.deleted_at IS NULL \
    ) \
    SELECT owner_id, record_id, title, icon, owner_total FROM ranked WHERE rn <= $3 ORDER BY owner_id, rn";

const SYMMETRIC_BULK_SQL: &str = "\
    WITH combined AS ( \
        SELECT e.source_record_id AS owner_id, p.id AS record_id, p.title, p.icon, e.source_position AS ord \
        FROM database_relation_edges e \
        JOIN pages p ON p.id = e.target_record_id \
        WHERE e.relation_id = $1 AND e.source_record_id = ANY($2) AND p.deleted_at IS NULL \
        UNION ALL \
        SELECT e.target_record_id AS owner_id, p.id AS record_id, p.title, p.icon, e.target_position AS ord \
        FROM database_relation_edges e \
        JOIN pages p ON p.id = e.source_record_id \
        WHERE e.relation_id = $1 AND e.target_record_id = ANY($2) AND p.deleted_at IS NULL \
    ), ranked AS ( \
        SELECT owner_id, record_id, title, icon, \
               row_number() OVER (PARTITION BY owner_id ORDER BY ord) AS rn, \
               count(*) OVER (PARTITION BY owner_id) AS owner_total \
        FROM combined \
    ) \
    SELECT owner_id, record_id, title, icon, owner_total FROM ranked WHERE rn <= $3 ORDER BY owner_id, rn";

pub struct RelationRepository {
    pool: SqlitePool,
}

impl RelationRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// DBS-086/088: creates the vínculo (`database_relations`) plus its
    /// first `database_properties` window (the source side, or the single
    /// symmetric column). Two-way (DBS-087) additionally creates the target
    /// side's property in the same transaction.
    pub async fn create_relation(&self, input: CreateRelationInput) -> Result<CreateRelationResult> {
        if input.is_symmetric && input.source_database_id != input.target_database_id {
            return Err(Error::Invalid(
                "relação simétrica (DBS-088) exige que a base de origem seja a mesma da base alvo".into(),
            ));
        }
        validate_cardinality(input.source_max_targets)?;
        validate_cardinality(input.target_max_sources)?;
        if input.is_symmetric && input.source_max_targets != input.target_max_sources {
            return Err(Error::Invalid(
                "relação simétrica (DBS-088) tem uma única cardinalidade: os dois limites devem ser iguais".into(),
            ));
        }

        let mut tx = self.pool.begin().await?;

        let relation = sqlx::query_as::<_, RelationDefinitionRow>(
            "INSERT INTO database_relations \
                 (source_database_id, target_database_id, is_symmetric, source_max_targets, target_max_sources) \
             VALUES ($1, $2, $3, $4, $5) \
             RETURNING id, source_database_id, target_database_id, is_symmetric, \
                       source_max_targets, target_max_sources, created_at, updated_at",
        )
        .bind(input.source_database_id)
        .bind(input.target_database_id)
        .bind(input.is_symmetric)
        .bind(input.source_max_targets)
        .bind(input.target_max_sources)
        .fetch_one(&mut *tx)
        .await?;

        let source_end = if input.is_symmetric { RelationEnd::Symmetric } else { RelationEnd::Source };
        let source_property_id = insert_relation_property(
            &mut tx,
            input.source_database_id,
            &input.source_property_name,
            relation.id,
            source_end,
        )
        .await?;

        let target_property_id = if !input.is_symmetric && input.two_way {
            let name = input.target_property_name.ok_or_else(|| {
                Error::Invalid("nome da propriedade recíproca é obrigatório quando a relação é de mão dupla (DBS-087)".into())
            })?;
            let id =
                insert_relation_property(&mut tx, input.target_database_id, &name, relation.id, RelationEnd::Target)
                    .await?;
            Some(id)
        } else {
            None
        };

        tx.commit().await?;
        Ok(CreateRelationResult { relation, source_property_id, target_property_id })
    }

    /// DBS-086/087: toggles whether the target database also shows a
    /// reciprocal column. Symmetric relations (DBS-088) have no separate
    /// reciprocal side to toggle — `Error::Invalid` names why rather than
    /// silently doing nothing.
    pub async fn set_relation_two_way(
        &self,
        relation_id: Uuid,
        show_on_target: bool,
        reciprocal_name: Option<String>,
    ) -> Result<CreateRelationResult> {
        let relation = self.relation_row(relation_id).await?;
        if relation.is_symmetric {
            return Err(Error::Invalid(
                "relação simétrica (DBS-088) não tem lado recíproco separado para alternar".into(),
            ));
        }

        let source_property_id = self
            .find_property(relation_id, RelationEnd::Source)
            .await?
            .ok_or_else(|| Error::Invalid(format!("relação {relation_id} não tem propriedade de origem — dado corrompido")))?;
        let existing_target = self.find_property(relation_id, RelationEnd::Target).await?;

        let mut tx = self.pool.begin().await?;

        let target_property_id = if show_on_target {
            match existing_target {
                Some(id) => {
                    if let Some(name) = &reciprocal_name {
                        sqlx::query("UPDATE database_properties SET name = $2 WHERE id = $1")
                            .bind(id)
                            .bind(name)
                            .execute(&mut *tx)
                            .await?;
                    }
                    Some(id)
                }
                None => {
                    let name = reciprocal_name.ok_or_else(|| {
                        Error::Invalid("nome da propriedade recíproca é obrigatório ao ativar mão dupla (DBS-087)".into())
                    })?;
                    let id = insert_relation_property(
                        &mut tx,
                        relation.target_database_id,
                        &name,
                        relation.id,
                        RelationEnd::Target,
                    )
                    .await?;
                    Some(id)
                }
            }
        } else {
            if let Some(id) = existing_target {
                // Fires `database_properties_cleanup_relation`
                // (`0018_database_relations.sql`) — harmless here, since the
                // source property still exists and keeps the relation alive
                // as one-way. The trigger only deletes the relation when
                // THIS delete leaves zero referencing properties.
                delete_property_row(&mut tx, id).await?;
            }
            None
        };

        tx.commit().await?;
        Ok(CreateRelationResult { relation, source_property_id, target_property_id })
    }

    /// DBS-090. Enforced only at write time ([`set_relation_targets`],
    /// [`add_relation_targets`]) — narrowing an existing over-limit set is
    /// deliberately NOT retroactive here; the next write to that side is
    /// what brings it back under the limit.
    ///
    /// [`set_relation_targets`]: Self::set_relation_targets
    /// [`add_relation_targets`]: Self::add_relation_targets
    pub async fn set_relation_cardinality(
        &self,
        relation_id: Uuid,
        source_max_targets: Option<i32>,
        target_max_sources: Option<i32>,
    ) -> Result<RelationDefinitionRow> {
        validate_cardinality(source_max_targets)?;
        validate_cardinality(target_max_sources)?;

        let relation = self.relation_row(relation_id).await?;
        if relation.is_symmetric && source_max_targets != target_max_sources {
            return Err(Error::Invalid(
                "relação simétrica (DBS-088) tem uma única cardinalidade: os dois limites devem ser iguais".into(),
            ));
        }

        sqlx::query_as::<_, RelationDefinitionRow>(
            "UPDATE database_relations SET source_max_targets = $2, target_max_sources = $3 WHERE id = $1 \
             RETURNING id, source_database_id, target_database_id, is_symmetric, \
                       source_max_targets, target_max_sources, created_at, updated_at",
        )
        .bind(relation_id)
        .bind(source_max_targets)
        .bind(target_max_sources)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Paginated by obligation (arquitetura §9) — `total` is the filtered
    /// count, computed separately from `items`, never inferred from
    /// `items.len()`. `limit`/`offset` are clamped, never trusted (regra
    /// 11): a caller cannot request more than [`MAX_PAGE_SIZE`] no matter
    /// what it passes.
    pub async fn list_relation_targets(
        &self,
        record_id: Uuid,
        property_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<RelationTargetPage> {
        let (relation_id, end) = self.property_relation_ref(property_id).await?;
        let (limit, offset) = clamp_page(limit, offset);

        let (items_sql, count_sql) = match end {
            RelationEnd::Source => (FORWARD_ITEMS_SQL, FORWARD_COUNT_SQL),
            RelationEnd::Target => (REVERSE_ITEMS_SQL, REVERSE_COUNT_SQL),
            RelationEnd::Symmetric => (SYMMETRIC_ITEMS_SQL, SYMMETRIC_COUNT_SQL),
        };

        let items = sqlx::query_as::<_, RelationTargetRow>(items_sql)
            .bind(relation_id)
            .bind(record_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await?;

        let total: i64 =
            sqlx::query_scalar(count_sql).bind(relation_id).bind(record_id).fetch_one(&self.pool).await?;

        Ok(RelationTargetPage { items, total })
    }

    /// The N+1-proof form of [`list_relation_targets`](Self::list_relation_targets):
    /// every `record_id` in `record_ids` answered by exactly ONE SQL round
    /// trip (a window function computes each owner's page AND its total
    /// together — see [`FORWARD_BULK_SQL`]'s doc comment for why the total
    /// has to be computed before the page is filtered out of it), never one
    /// query per visible row. A `record_id` with zero targets still gets an
    /// entry (`items: []`, `total: 0`) — the output always has exactly
    /// `record_ids.len()` entries, in the same order.
    pub async fn list_relation_targets_bulk(
        &self,
        record_ids: Vec<Uuid>,
        property_id: Uuid,
        per_record_limit: i64,
    ) -> Result<Vec<RecordTargets>> {
        if record_ids.is_empty() {
            return Ok(Vec::new());
        }

        let (relation_id, end) = self.property_relation_ref(property_id).await?;
        let per_record_limit = per_record_limit.clamp(1, MAX_PAGE_SIZE);

        let sql = match end {
            RelationEnd::Source => FORWARD_BULK_SQL,
            RelationEnd::Target => REVERSE_BULK_SQL,
            RelationEnd::Symmetric => SYMMETRIC_BULK_SQL,
        };

        let rows = sqlx::query_as::<_, BulkTargetRow>(sql)
            .bind(relation_id)
            .bind(&record_ids)
            .bind(per_record_limit)
            .fetch_all(&self.pool)
            .await?;

        let mut by_owner: HashMap<Uuid, (Vec<RelationTargetRow>, i64)> = HashMap::new();
        for row in rows {
            let entry = by_owner.entry(row.owner_id).or_insert_with(|| (Vec::new(), row.owner_total));
            entry.0.push(RelationTargetRow { record_id: row.record_id, title: row.title, icon: row.icon });
        }

        Ok(record_ids
            .iter()
            .map(|id| {
                let (items, total) = by_owner.get(id).cloned().unwrap_or_default();
                RecordTargets { record_id: *id, items, total }
            })
            .collect())
    }

    /// Replaces the WHOLE set of targets on `record_id`'s side of this
    /// property. More ids than DBS-090's cardinality allows is a caller
    /// bug, and errors rather than silently truncating — the doc comment
    /// this piece's brief points at (arquitetura §5) is explicit that this
    /// is the one write path allowed to error on cardinality, as opposed to
    /// [`add_relation_targets`](Self::add_relation_targets)'s replace-at-1.
    pub async fn set_relation_targets(
        &self,
        record_id: Uuid,
        property_id: Uuid,
        target_ids: Vec<Uuid>,
    ) -> Result<RelationTargetPage> {
        let (relation_id, end) = self.property_relation_ref(property_id).await?;
        let relation = self.relation_row(relation_id).await?;
        let dedup_ids = dedupe_preserving_order(target_ids);
        reject_self_reference(end, record_id, &dedup_ids)?;

        if let Some(max) = my_max(&relation, end) {
            let max = usize::try_from(max).unwrap_or(0);
            if dedup_ids.len() > max {
                return Err(Error::Invalid(format!(
                    "cardinalidade excedida: esta propriedade aceita no máximo {max} registro(s) (DBS-090)"
                )));
            }
        }

        let mut tx = self.pool.begin().await?;
        delete_my_side(&mut tx, relation_id, record_id, end).await?;

        let mut previous_own: Option<FractionalIndex> = None;
        for target_id in &dedup_ids {
            insert_one(&mut tx, relation_id, end, record_id, *target_id, &mut previous_own).await?;
        }

        tx.commit().await?;
        self.list_relation_targets(record_id, property_id, MAX_PAGE_SIZE, 0).await
    }

    /// Adds targets without disturbing the ones already there — except at
    /// cardinality 1 (DBS-090), where "add" IS the single-select picker's
    /// write path and REPLACES whatever was selected before instead of
    /// erroring or silently doing nothing. Already-present ids are ignored
    /// (idempotent), never duplicated or treated as an error.
    pub async fn add_relation_targets(
        &self,
        record_id: Uuid,
        property_id: Uuid,
        target_ids: Vec<Uuid>,
    ) -> Result<RelationTargetPage> {
        let dedup_ids = dedupe_preserving_order(target_ids);
        if dedup_ids.is_empty() {
            return self.list_relation_targets(record_id, property_id, MAX_PAGE_SIZE, 0).await;
        }

        let (relation_id, end) = self.property_relation_ref(property_id).await?;
        let relation = self.relation_row(relation_id).await?;

        if my_max(&relation, end) == Some(1) {
            let replacement = dedup_ids.last().copied().into_iter().collect();
            return self.set_relation_targets(record_id, property_id, replacement).await;
        }

        reject_self_reference(end, record_id, &dedup_ids)?;

        let mut tx = self.pool.begin().await?;

        let existing = existing_side_ids(&mut tx, relation_id, record_id, end).await?;
        let new_ids: Vec<Uuid> = dedup_ids.into_iter().filter(|id| !existing.contains(id)).collect();

        if let Some(max) = my_max(&relation, end) {
            let max = usize::try_from(max).unwrap_or(0);
            if existing.len() + new_ids.len() > max {
                return Err(Error::Invalid(format!(
                    "cardinalidade excedida: esta propriedade aceita no máximo {max} registro(s) (DBS-090)"
                )));
            }
        }

        let mut previous_own = existing_own_max_index(&mut tx, relation_id, record_id, end).await?;
        for target_id in &new_ids {
            insert_one(&mut tx, relation_id, end, record_id, *target_id, &mut previous_own).await?;
        }

        tx.commit().await?;
        self.list_relation_targets(record_id, property_id, MAX_PAGE_SIZE, 0).await
    }

    /// Removes the given targets from `record_id`'s side, if present.
    /// Removing an id that was never linked is a no-op, not an error.
    pub async fn remove_relation_targets(
        &self,
        record_id: Uuid,
        property_id: Uuid,
        target_ids: Vec<Uuid>,
    ) -> Result<RelationTargetPage> {
        let dedup_ids = dedupe_preserving_order(target_ids);
        if dedup_ids.is_empty() {
            return self.list_relation_targets(record_id, property_id, MAX_PAGE_SIZE, 0).await;
        }
        let (relation_id, end) = self.property_relation_ref(property_id).await?;

        let sql = match end {
            RelationEnd::Source => {
                "DELETE FROM database_relation_edges \
                 WHERE relation_id = $1 AND source_record_id = $2 AND target_record_id = ANY($3)"
            }
            RelationEnd::Target => {
                "DELETE FROM database_relation_edges \
                 WHERE relation_id = $1 AND target_record_id = $2 AND source_record_id = ANY($3)"
            }
            // DBS-088: `record_id` may be stored as either end of a
            // normalised edge depending on which uuid is smaller, so both
            // directions have to be tried — exactly one ever matches a
            // given pair, since a symmetric edge is never stored twice.
            RelationEnd::Symmetric => {
                "DELETE FROM database_relation_edges \
                 WHERE relation_id = $1 AND ( \
                     (source_record_id = $2 AND target_record_id = ANY($3)) \
                     OR (target_record_id = $2 AND source_record_id = ANY($3)) \
                 )"
            }
        };

        sqlx::query(sql).bind(relation_id).bind(record_id).bind(&dedup_ids).execute(&self.pool).await?;

        self.list_relation_targets(record_id, property_id, MAX_PAGE_SIZE, 0).await
    }

    async fn property_relation_ref(&self, property_id: Uuid) -> Result<(Uuid, RelationEnd)> {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT config ->> 'relationId', config ->> 'end' FROM database_properties \
             WHERE id = $1 AND property_type = 'relation'",
        )
        .bind(property_id)
        .fetch_optional(&self.pool)
        .await?;

        let (relation_id_raw, end_raw) =
            row.ok_or_else(|| Error::NotFound(format!("propriedade de relação {property_id}")))?;

        let relation_id = relation_id_raw
            .and_then(|raw| Uuid::parse_str(&raw).ok())
            .ok_or_else(|| Error::Invalid(format!("propriedade {property_id}: config.relationId ausente ou inválido")))?;
        let end = end_raw
            .as_deref()
            .and_then(RelationEnd::parse)
            .ok_or_else(|| Error::Invalid(format!("propriedade {property_id}: config.end ausente ou inválido")))?;

        Ok((relation_id, end))
    }

    async fn relation_row(&self, relation_id: Uuid) -> Result<RelationDefinitionRow> {
        sqlx::query_as::<_, RelationDefinitionRow>(
            "SELECT id, source_database_id, target_database_id, is_symmetric, \
                    source_max_targets, target_max_sources, created_at, updated_at \
             FROM database_relations WHERE id = $1",
        )
        .bind(relation_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("relação {relation_id}")))
    }

    async fn find_property(&self, relation_id: Uuid, end: RelationEnd) -> Result<Option<Uuid>> {
        sqlx::query_scalar(
            "SELECT id FROM database_properties \
             WHERE property_type = 'relation' AND config ->> 'relationId' = $1 AND config ->> 'end' = $2",
        )
        .bind(relation_id.to_string())
        .bind(end.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(Error::from)
    }
}

fn validate_cardinality(max: Option<i32>) -> Result<()> {
    match max {
        Some(value) if value <= 0 => {
            Err(Error::Invalid("cardinalidade deve ser positiva ou ausente para N:N (DBS-090)".into()))
        }
        _ => Ok(()),
    }
}

fn my_max(relation: &RelationDefinitionRow, end: RelationEnd) -> Option<i32> {
    match end {
        RelationEnd::Source => relation.source_max_targets,
        RelationEnd::Target => relation.target_max_sources,
        // DBS-088: a symmetric relation has a SINGLE cardinality by
        // construction (`create_relation`/`set_relation_cardinality` both
        // refuse to let the two fields disagree), so either one reads it.
        RelationEnd::Symmetric => relation.source_max_targets,
    }
}

fn clamp_page(limit: i64, offset: i64) -> (i64, i64) {
    (limit.clamp(1, MAX_PAGE_SIZE), offset.max(0))
}

fn dedupe_preserving_order(ids: Vec<Uuid>) -> Vec<Uuid> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

/// DBS-088: a symmetric relation's edges forbid a self-loop (the CHECK
/// `symmetric_is_normalised` requires `source_record_id < target_record_id`,
/// impossible when they are equal) — checked here too so the caller gets a
/// named error instead of a raw constraint violation.
fn reject_self_reference(end: RelationEnd, record_id: Uuid, target_ids: &[Uuid]) -> Result<()> {
    if end == RelationEnd::Symmetric && target_ids.contains(&record_id) {
        return Err(Error::Invalid(
            "um registro não pode se relacionar consigo mesmo numa relação simétrica (DBS-088)".into(),
        ));
    }
    Ok(())
}

/// Orders `(a, b)` as `(source, target)` for a symmetric edge — the
/// canonical form `0018_database_relations.sql`'s CHECK requires. Relies on
/// `Uuid`'s `Ord` agreeing with Postgres's own `uuid <` (both compare the
/// same 16 raw bytes in the same order); `tests/db_relations.rs` exercises
/// both creation orders of a pair to prove that agreement holds in
/// practice, not just in theory.
fn normalize_pair(a: Uuid, b: Uuid) -> (Uuid, Uuid) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

async fn next_property_position(tx: &mut Transaction<'_, Sqlite>, database_id: Uuid) -> Result<String> {
    let last: Option<String> =
        sqlx::query_scalar("SELECT position FROM database_properties WHERE database_id = $1 ORDER BY position DESC LIMIT 1")
            .bind(database_id)
            .fetch_optional(&mut **tx)
            .await?;
    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

async fn insert_relation_property(
    tx: &mut Transaction<'_, Sqlite>,
    database_id: Uuid,
    name: &str,
    relation_id: Uuid,
    end: RelationEnd,
) -> Result<Uuid> {
    let position = next_property_position(tx, database_id).await?;
    let config = serde_json::json!({ "relationId": relation_id, "end": end.as_str() });
    sqlx::query_scalar(
        "INSERT INTO database_properties (database_id, name, property_type, config, position) \
         VALUES ($1, $2, 'relation', $3, $4) RETURNING id",
    )
    .bind(database_id)
    .bind(name)
    .bind(&config)
    .bind(&position)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}

async fn delete_property_row(tx: &mut Transaction<'_, Sqlite>, property_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM database_properties WHERE id = $1").bind(property_id).execute(&mut **tx).await?;
    Ok(())
}

async fn delete_my_side(
    tx: &mut Transaction<'_, Sqlite>,
    relation_id: Uuid,
    record_id: Uuid,
    end: RelationEnd,
) -> Result<()> {
    let sql = match end {
        RelationEnd::Source => "DELETE FROM database_relation_edges WHERE relation_id = $1 AND source_record_id = $2",
        RelationEnd::Target => "DELETE FROM database_relation_edges WHERE relation_id = $1 AND target_record_id = $2",
        RelationEnd::Symmetric => {
            "DELETE FROM database_relation_edges WHERE relation_id = $1 AND (source_record_id = $2 OR target_record_id = $2)"
        }
    };
    sqlx::query(sql).bind(relation_id).bind(record_id).execute(&mut **tx).await?;
    Ok(())
}

async fn next_position(
    tx: &mut Transaction<'_, Sqlite>,
    sql: &str,
    relation_id: Uuid,
    record_id: Uuid,
) -> Result<String> {
    let max: Option<String> = sqlx::query_scalar(sql).bind(relation_id).bind(record_id).fetch_one(&mut **tx).await?;
    let parsed = max.as_deref().map(position::parse).transpose()?;
    position::between(parsed.as_ref(), None)
}

/// The ids currently on `record_id`'s side of this property — for
/// [`RelationRepository::add_relation_targets`] to know which of the
/// requested ids are already linked (and so must be skipped, keeping "add"
/// idempotent) versus genuinely new.
async fn existing_side_ids(
    tx: &mut Transaction<'_, Sqlite>,
    relation_id: Uuid,
    record_id: Uuid,
    end: RelationEnd,
) -> Result<HashSet<Uuid>> {
    let rows: Vec<Uuid> = match end {
        RelationEnd::Source => {
            sqlx::query_scalar("SELECT target_record_id FROM database_relation_edges WHERE relation_id = $1 AND source_record_id = $2")
                .bind(relation_id)
                .bind(record_id)
                .fetch_all(&mut **tx)
                .await?
        }
        RelationEnd::Target => {
            sqlx::query_scalar("SELECT source_record_id FROM database_relation_edges WHERE relation_id = $1 AND target_record_id = $2")
                .bind(relation_id)
                .bind(record_id)
                .fetch_all(&mut **tx)
                .await?
        }
        RelationEnd::Symmetric => sqlx::query_scalar(
            "SELECT CASE WHEN source_record_id = $2 THEN target_record_id ELSE source_record_id END \
             FROM database_relation_edges WHERE relation_id = $1 AND (source_record_id = $2 OR target_record_id = $2)",
        )
        .bind(relation_id)
        .bind(record_id)
        .fetch_all(&mut **tx)
        .await?,
    };
    Ok(rows.into_iter().collect())
}

/// `record_id`'s current max position on its own side, to resume the
/// append chain in [`RelationRepository::add_relation_targets`] without
/// resetting it the way [`RelationRepository::set_relation_targets`]'s
/// wholesale delete-then-reinsert does.
async fn existing_own_max_index(
    tx: &mut Transaction<'_, Sqlite>,
    relation_id: Uuid,
    record_id: Uuid,
    end: RelationEnd,
) -> Result<Option<FractionalIndex>> {
    let sql = match end {
        RelationEnd::Source => FORWARD_MAX_POSITION_SQL,
        RelationEnd::Target => REVERSE_MAX_POSITION_SQL,
        RelationEnd::Symmetric => SYMMETRIC_MAX_POSITION_SQL,
    };
    let max: Option<String> = sqlx::query_scalar(sql).bind(relation_id).bind(record_id).fetch_one(&mut **tx).await?;
    max.as_deref().map(position::parse).transpose()
}

async fn insert_edge(
    tx: &mut Transaction<'_, Sqlite>,
    relation_id: Uuid,
    source_record_id: Uuid,
    target_record_id: Uuid,
    source_position: &str,
    target_position: &str,
    is_symmetric: bool,
) -> Result<()> {
    sqlx::query(INSERT_EDGE_SQL)
        .bind(relation_id)
        .bind(source_record_id)
        .bind(target_record_id)
        .bind(source_position)
        .bind(target_position)
        .bind(is_symmetric)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Inserts one new edge between `record_id` and `target_id`, advancing
/// `previous_own` (`record_id`'s own append-chain cursor, shared across
/// calls within the same loop so consecutive inserts from the same side
/// never re-query the database for a position that this same transaction
/// already decided) and computing the OTHER side's position fresh from the
/// database, since that side's existing list is unaffected by this call and
/// may already hold edges from other records.
async fn insert_one(
    tx: &mut Transaction<'_, Sqlite>,
    relation_id: Uuid,
    end: RelationEnd,
    record_id: Uuid,
    target_id: Uuid,
    previous_own: &mut Option<FractionalIndex>,
) -> Result<()> {
    let own_position = position::between(previous_own.as_ref(), None)?;
    *previous_own = Some(position::parse(&own_position)?);

    match end {
        RelationEnd::Source => {
            let target_position = next_position(tx, REVERSE_MAX_POSITION_SQL, relation_id, target_id).await?;
            insert_edge(tx, relation_id, record_id, target_id, &own_position, &target_position, false).await
        }
        RelationEnd::Target => {
            let source_position = next_position(tx, FORWARD_MAX_POSITION_SQL, relation_id, target_id).await?;
            insert_edge(tx, relation_id, target_id, record_id, &source_position, &own_position, false).await
        }
        RelationEnd::Symmetric => {
            let (lo, hi) = normalize_pair(record_id, target_id);
            let other_position = next_position(tx, SYMMETRIC_MAX_POSITION_SQL, relation_id, target_id).await?;
            let (source_position, target_position) =
                if lo == record_id { (own_position.as_str(), other_position.as_str()) } else { (other_position.as_str(), own_position.as_str()) };
            insert_edge(tx, relation_id, lo, hi, source_position, target_position, true).await
        }
    }
}
