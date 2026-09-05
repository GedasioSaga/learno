//! I4 — the ONE write path for `database_record_values`
//! (`0009_database_record_values.sql` + `0017_database_value_invariants.sql`).
//!
//! `rg 'INSERT INTO database_record_values|UPDATE database_record_values|DELETE FROM database_record_values' src-tauri/src/`
//! must return **only** this file (`tests/db_value_invariants.rs` enforces
//! it) — the first constructor that writes here directly (CSV import is the
//! natural candidate) silently drops cascade, automation and "Editado em"
//! for that one write. Nothing else in this crate is allowed to touch this
//! table's rows.
//!
//! What lives in this transaction, in order, for every change:
//!
//! 1. **Normalização por tipo e I1** ([`normalize`]) — the Rust mirror of
//!    `PropertySpec.normalize()`/`isEmpty()` on the TypeScript side
//!    (`src/features/databases/core/property-spec.ts`). Both sides have to
//!    agree, which is exactly what
//!    `src-tauri/tests/fixtures/property_values.json` (arquitetura §10)
//!    exists to prove — this file's own `#[cfg(test)]` module reads it.
//!    Only the two concerns named in this piece's brief are mirrored here:
//!    "does this value count as empty" and "what gets written instead of
//!    the raw input". `parse`/`serialize`/`toPlainText`/rendering stay
//!    TypeScript-only; this file never needs them to decide whether a row
//!    exists.
//! 2. The write itself — `DELETE` when [`normalize`] says empty (I1: empty
//!    is the ABSENCE of the row, never a JSON empty value), otherwise an
//!    upsert.
//! 3. Three **documented, empty** extension points — [`dispatch_property_changed_automations`],
//!    [`cascade_formula_dependents`], [`enqueue_rollup_invalidation`] — for
//!    the pieces that own automation (E3), the formula engine (F7) and the
//!    rollup queue (D1). They run inside the same transaction as the write
//!    itself, which is the whole point of I4: a formula cascade or an
//!    automation effect that skipped this function would skip this
//!    transaction too, and the "Editado em" trigger, the cascade and the
//!    rollup queue would all silently disagree about what happened.
//!
//! ## I2 — never sort by `value`
//!
//! This file never orders anything (it only ever addresses one row at a
//! time by `(record_id, property_id)`), so it has no opportunity to violate
//! I2. The generated `sort_num`/`sort_text` columns it reads back
//! (`RecordValueRow`) exist for `src-tauri/src/db/query/predicate.rs`
//! (another piece) to order by instead.
//!
//! ## Divergência da arquitetura
//!
//! `docs/FASE-3-ARQUITETURA.md` §9 freezes
//! `apply_record_value_changes(state, changes) -> Result<AppliedChanges>` as
//! a **Tauri command** signature in `ipc/record_commands.rs` — a file this
//! piece (N2) is not scoped to touch. What lives here instead is the
//! repository method a future `ipc/record_commands.rs` wraps:
//! `RecordValueRepository::apply_record_value_changes`, returning the same
//! `AppliedChanges` shape. See this piece's report for the exact
//! `db/mod.rs` line the command's owner needs to add
//! (`pub mod record_values;` plus the re-exports below).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{SqlitePool, Sqlite, Transaction};
use uuid::Uuid;

use crate::error::{Error, Result};

const RECORD_VALUE_COLUMNS: &str =
    "record_id, property_id, value, sort_num::float8 AS sort_num, sort_text, updated_at";

/// One requested write. `value` is exactly what a caller (a cell editor, a
/// formula cascade, a CSV importer, the future `set_relation_targets`
/// rollup path) proposes for this `(recordId, propertyId)` pair — including
/// `null` for "clear this cell". Mirrors the `value: unknown` a TypeScript
/// `PropertySpec.normalize()` call receives; [`normalize`] decides from
/// here what actually happens.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordValueChangeInput {
    pub record_id: Uuid,
    pub property_id: Uuid,
    pub value: JsonValue,
}

/// Mirrors `RecordValue` in `src/features/databases/contract.ts` field for
/// field. `sort_num`/`sort_text` are read back through `::float8` in the
/// query rather than decoded as Postgres `NUMERIC`: the crate has no
/// `bigdecimal`/`rust_decimal` sqlx feature (rule 2 forbids adding one on a
/// hunch), and every legitimate `sort_num` value already fits `f64` — it is
/// either a `boolean` cast to `1`/`0` or a JSON number, never a value wide
/// enough for the double-precision cast to matter.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordValueRow {
    pub record_id: Uuid,
    pub property_id: Uuid,
    pub value: JsonValue,
    pub sort_num: Option<f64>,
    pub sort_text: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// The outcome of one requested change. `value: None` when [`normalize`]
/// decided the row should not exist (I1) — never a JSON representation of
/// "empty". A caller asking "what is this cell now?" gets the same answer
/// `RecordRow.values` (arquitetura §8) would: the property is simply absent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRecordValue {
    pub record_id: Uuid,
    pub property_id: Uuid,
    pub value: Option<RecordValueRow>,
}

/// Mirrors the `AppliedChanges` return type `docs/FASE-3-ARQUITETURA.md` §9
/// freezes for the `apply_record_value_changes` IPC command — this
/// repository method's return value is what that command wraps verbatim.
/// One entry per requested change, in the same order they were given.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedChanges {
    pub results: Vec<AppliedRecordValue>,
}

pub struct RecordValueRepository {
    pool: SqlitePool,
}

impl RecordValueRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// I4's one write path. Every change in `changes` runs, in order,
    /// inside a single transaction: a batch of edits (a multi-cell paste, a
    /// batch edit per DBS-122) is one round trip and one all-or-nothing
    /// outcome, the same contract `BlockRepository::apply_changes`
    /// (`db/blocks.rs`) already keeps for the block tree.
    pub async fn apply_record_value_changes(&self, changes: Vec<RecordValueChangeInput>) -> Result<AppliedChanges> {
        let mut tx = self.pool.begin().await?;
        let mut results = Vec::with_capacity(changes.len());

        for change in changes {
            let property_type = fetch_property_type(&mut tx, change.property_id).await?;
            let old_row = fetch_value_row(&mut tx, change.record_id, change.property_id).await?;

            let applied = match normalize(&property_type, &change.value) {
                None => {
                    delete_value_row(&mut tx, change.record_id, change.property_id).await?;
                    AppliedRecordValue { record_id: change.record_id, property_id: change.property_id, value: None }
                }
                Some(normalized) => {
                    let row = upsert_value_row(&mut tx, change.record_id, change.property_id, &normalized).await?;
                    AppliedRecordValue { record_id: change.record_id, property_id: change.property_id, value: Some(row) }
                }
            };

            // Ganchos, nesta ordem, na MESMA transação (I4) — ver a
            // documentação de cada um para quem os preenche.
            dispatch_property_changed_automations(&mut tx, &applied, old_row.as_ref().map(|row| &row.value)).await?;
            cascade_formula_dependents(&mut tx, &applied).await?;
            enqueue_rollup_invalidation(&mut tx, &applied).await?;

            results.push(applied);
        }

        tx.commit().await?;
        Ok(AppliedChanges { results })
    }
}

/// The Rust mirror of `PropertySpec.normalize()` — but only the slice of it
/// I1 needs, not the full per-type contract (option-id validation, URL
/// scheme checks, ... stay TypeScript-only, arquitetura §6). Two rules,
/// applied in order:
///
/// 1. **Generic emptiness** (`chk_drv_never_empty`, 0017): `null`, `""`,
///    `[]` and `{}` are never written, for every property type — this is
///    what the fixture's `text_empty_string_is_no_row`,
///    `option_list_empty_array_is_no_row` and `file_list_empty_array_is_no_row`
///    cases prove.
/// 2. **The named exception, checkbox only**: `false` is dropped ONLY when
///    `property_type == "checkbox"`. Any other type carrying a boolean
///    value — today that is only a materialized `formula` result — keeps
///    `false` as a legitimate value, because the CHECK constraint itself
///    never forbids it. Conflating the two (treating every `false` as
///    empty) would make a formula evaluating to `false` vanish instead of
///    displaying — the fixture's `formula_boolean_false_is_a_legitimate_value`
///    case is what pins this down.
///
/// Returns `None` exactly when the caller should delete the row instead of
/// writing to it.
pub fn normalize(property_type: &str, raw: &JsonValue) -> Option<JsonValue> {
    if is_generically_empty(raw) {
        return None;
    }
    if property_type == "checkbox" && raw == &JsonValue::Bool(false) {
        return None;
    }
    Some(raw.clone())
}

/// Mirrors `PropertySpec.isEmpty()`. Never implement this — or call it — as
/// `!value`: that is precisely the trap I1 names (`if (!value)` eats the
/// Number `0` and the Checkbox `false`). This is the total ordering the
/// fixture's `number_zero_is_not_empty` and `checkbox_false_is_zero_rows`
/// cases pin down at once: `0` is never empty, `false` is empty only for a
/// checkbox.
pub fn is_empty(property_type: &str, raw: &JsonValue) -> bool {
    normalize(property_type, raw).is_none()
}

/// The shape-generic half of I1 — every property type, no exception. This
/// is deliberately the same predicate `chk_drv_never_empty` enforces in SQL:
/// this function only exists so a caller finds out *before* a round trip to
/// Postgres, not instead of the CHECK.
fn is_generically_empty(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => true,
        JsonValue::String(text) => text.is_empty(),
        JsonValue::Array(items) => items.is_empty(),
        JsonValue::Object(fields) => fields.is_empty(),
        JsonValue::Bool(_) | JsonValue::Number(_) => false,
    }
}

async fn fetch_property_type(tx: &mut Transaction<'_, Sqlite>, property_id: Uuid) -> Result<String> {
    sqlx::query_scalar("SELECT property_type FROM database_properties WHERE id = $1")
        .bind(property_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("propriedade {property_id}")))
}

async fn fetch_value_row(
    tx: &mut Transaction<'_, Sqlite>,
    record_id: Uuid,
    property_id: Uuid,
) -> Result<Option<RecordValueRow>> {
    let sql = format!("SELECT {RECORD_VALUE_COLUMNS} FROM database_record_values WHERE record_id = $1 AND property_id = $2");
    let row = sqlx::query_as::<_, RecordValueRow>(&sql)
        .bind(record_id)
        .bind(property_id)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row)
}

/// Idempotent: deleting a `(record_id, property_id)` pair that has no row
/// (the ordinary "this cell was already empty" case) affects zero rows and
/// is not an error — the same idempotence `BlockRepository::unsync_one`
/// leans on for its own "maybe already in this state" writes.
async fn delete_value_row(tx: &mut Transaction<'_, Sqlite>, record_id: Uuid, property_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM database_record_values WHERE record_id = $1 AND property_id = $2")
        .bind(record_id)
        .bind(property_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// `ON CONFLICT ON CONSTRAINT`, naming the primary key `0017` adds, rather
/// than `ON CONFLICT (record_id, property_id)`: `0009`'s original
/// `UNIQUE (record_id, property_id)` table constraint is never dropped by
/// `0017` (the verified DDL in `docs/FASE-3-SCHEMA.sql` only drops the old
/// synthetic-`id` primary key), so the table now carries two constraints
/// covering the exact same columns. Naming the constraint removes any
/// question of which of the two Postgres would infer the conflict target
/// from.
async fn upsert_value_row(
    tx: &mut Transaction<'_, Sqlite>,
    record_id: Uuid,
    property_id: Uuid,
    value: &JsonValue,
) -> Result<RecordValueRow> {
    let sql = format!(
        "INSERT INTO database_record_values (record_id, property_id, value) VALUES ($1, $2, $3) \
         ON CONFLICT ON CONSTRAINT database_record_values_pkey DO UPDATE SET value = EXCLUDED.value \
         RETURNING {RECORD_VALUE_COLUMNS}"
    );
    let row = sqlx::query_as::<_, RecordValueRow>(&sql)
        .bind(record_id)
        .bind(property_id)
        .bind(value)
        .fetch_one(&mut **tx)
        .await?;
    Ok(row)
}

/// Extension point for E3 (DBS-121 automations). `old_value` is the value
/// this `(record_id, property_id)` held BEFORE this change — absent when
/// there was no row, i.e. the property was empty — because
/// `"propertyChangedTo"` (arquitetura §7) requires the old value to differ
/// from the target AND the new one to match it: a handler driven only by
/// `applied` could not tell "changed to x" from "already was x, rewritten",
/// and rewriting the same value would redispatch the same automation and
/// feed a loop. No body in this piece (N2) on purpose: implementing
/// dispatch here without the automation engine (E3, out of this piece's
/// scope) would invent behaviour E3 would then have to undo.
async fn dispatch_property_changed_automations(
    tx: &mut Transaction<'_, Sqlite>,
    applied: &AppliedRecordValue,
    old_value: Option<&JsonValue>,
) -> Result<()> {
    let _ = (tx, applied, old_value);
    Ok(())
}

/// Extension point for F7 (the formula engine, arquitetura §4). Runs after
/// the write lands, in the same transaction, for every property whose
/// `config.compiled.dependsOn` names the one that just changed — F7 owns
/// the topological order (its own DFS, arquitetura §4) that keeps a cascade
/// like `Total -> Desconto -> Total` from looping. Empty here for the same
/// reason as the automation hook above: this piece has no formula engine to
/// call.
async fn cascade_formula_dependents(tx: &mut Transaction<'_, Sqlite>, applied: &AppliedRecordValue) -> Result<()> {
    let _ = (tx, applied);
    Ok(())
}

/// Extension point for D1 (rollup). Most of `derived_value_queue`'s
/// population is already the job of the five triggers
/// `0019_database_derived.sql` documents (T1..T5) — this hook exists for
/// whatever only Rust can decide, such as reading a freshly-written row's
/// `stale_after` (0017) and deciding it needs to be revisited once the
/// `now()`/`today()` it depends on has actually passed. Empty here: D1 owns
/// the queue's drain order and the aggregation semantics
/// (`src/rollup/aggregate`) this hook would otherwise have to guess at.
async fn enqueue_rollup_invalidation(tx: &mut Transaction<'_, Sqlite>, applied: &AppliedRecordValue) -> Result<()> {
    let _ = (tx, applied);
    Ok(())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here —
    // same pattern as `db::blocks`'s own test module.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn checkbox_false_is_the_named_exception_that_erases() {
        assert_eq!(normalize("checkbox", &JsonValue::Bool(false)), None);
        assert!(is_empty("checkbox", &JsonValue::Bool(false)));
    }

    #[test]
    fn checkbox_true_is_kept() {
        assert_eq!(normalize("checkbox", &JsonValue::Bool(true)), Some(JsonValue::Bool(true)));
        assert!(!is_empty("checkbox", &JsonValue::Bool(true)));
    }

    /// The exception's boundary: the SAME raw value (`false`) is a
    /// legitimate, kept value for any type OTHER than checkbox — a
    /// materialized formula result being the real case in this app.
    #[test]
    fn false_is_never_dropped_outside_checkbox() {
        assert_eq!(normalize("formula", &JsonValue::Bool(false)), Some(JsonValue::Bool(false)));
        assert!(!is_empty("formula", &JsonValue::Bool(false)));
    }

    /// The trap I1 names by name: `0` must never be treated the way a bare
    /// `if (!value)` would treat it.
    #[test]
    fn number_zero_is_not_empty() {
        let zero = serde_json::json!(0);
        assert_eq!(normalize("number", &zero), Some(zero.clone()));
        assert!(!is_empty("number", &zero));
    }

    #[test]
    fn generic_emptiness_applies_to_every_property_type() {
        for property_type in ["text", "select", "multi_select", "person", "files", "date", "number"] {
            assert_eq!(normalize(property_type, &JsonValue::Null), None, "{property_type} + null");
            assert_eq!(normalize(property_type, &serde_json::json!("")), None, "{property_type} + \"\"");
            assert_eq!(normalize(property_type, &serde_json::json!([])), None, "{property_type} + []");
            assert_eq!(normalize(property_type, &serde_json::json!({})), None, "{property_type} + {{}}");
        }
    }

    #[test]
    fn a_non_empty_value_round_trips_unchanged() {
        let value = serde_json::json!({ "start": "2026-03-15" });
        assert_eq!(normalize("date", &value), Some(value));
    }

    /// Minimal shape of one `src-tauri/tests/fixtures/property_values.json`
    /// case — only the fields this pure, DB-less test needs.
    /// `db_value_invariants.rs` reads the same file for the fields that
    /// require a real Postgres (`expectedSortText`/`expectedSortNum`).
    #[derive(Debug, Deserialize)]
    struct FixtureCase {
        id: String,
        #[serde(rename = "propertyType")]
        property_type: String,
        value: JsonValue,
        #[serde(rename = "expectedIsEmpty")]
        expected_is_empty: bool,
    }

    #[derive(Debug, Deserialize)]
    struct Fixture {
        cases: Vec<FixtureCase>,
    }

    /// Arquitetura §10: "o fixture é fabricado em UM lugar e as três
    /// representações (TS, Rust, coluna gerada) são obrigadas a
    /// concordar". This is the Rust side of that agreement for `isEmpty` —
    /// `include_str!` embeds the fixture at compile time, so a case added
    /// to the JSON without a matching Rust/TS implementation fails THIS
    /// build, not a build nobody happened to run.
    #[test]
    fn normalize_agrees_with_every_fixture_case_is_empty() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../tests/fixtures/property_values.json")).unwrap();
        assert!(!fixture.cases.is_empty(), "fixture must not be empty");

        for case in &fixture.cases {
            let is_empty_result = is_empty(&case.property_type, &case.value);
            assert_eq!(
                is_empty_result, case.expected_is_empty,
                "case \"{}\" (propertyType={}): normalize/isEmpty mirror disagrees with the fixture",
                case.id, case.property_type
            );
        }
    }
}
