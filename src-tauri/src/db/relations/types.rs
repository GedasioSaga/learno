//! Wire types for the relation graph (`repository.rs`). Split out of that
//! file only for readability — every type here exists because
//! `RelationRepository` returns or accepts it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A `database_relations` row (`0018_database_relations.sql`) — the vínculo
/// itself, independent of how many `database_properties` windows currently
/// show it. `is_symmetric` is DBS-088 (only ever true when
/// `source_database_id == target_database_id`, enforced by that table's own
/// CHECK); the two cardinality fields are DBS-090, `None` meaning N:N.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationDefinitionRow {
    pub id: Uuid,
    pub source_database_id: Uuid,
    pub target_database_id: Uuid,
    pub is_symmetric: bool,
    pub source_max_targets: Option<i32>,
    pub target_max_sources: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Which end of a relation a `database_properties` row is a window onto —
/// arquitetura §5's `config.end ∈ {"source","target","symmetric"}`, given a
/// closed Rust shape instead of a bare string so `repository.rs`'s `match`
/// is exhaustive and a typo in stored JSON is caught at the read boundary
/// ([`RelationEnd::parse`]) instead of silently mis-routing a query.
///
/// Not part of this module's public contract (`mod.rs` does not re-export
/// it): every writer of `config.end` is this same file, so nothing outside
/// `db::relations` ever needs to name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RelationEnd {
    Source,
    Target,
    Symmetric,
}

impl RelationEnd {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            RelationEnd::Source => "source",
            RelationEnd::Target => "target",
            RelationEnd::Symmetric => "symmetric",
        }
    }

    pub(super) fn parse(raw: &str) -> Option<Self> {
        match raw {
            "source" => Some(RelationEnd::Source),
            "target" => Some(RelationEnd::Target),
            "symmetric" => Some(RelationEnd::Symmetric),
            _ => None,
        }
    }
}

/// Input to [`crate::db::relations::RelationRepository::create_relation`].
/// Own type (arquitetura §9 freezes the Rust *command* signature,
/// `create_relation(state, input) -> Result<CreateRelationResult>`, but not
/// `CreateRelationInput`'s shape) — see `mod.rs`'s divergência note for the
/// exact re-export line whoever writes `ipc/relation_commands.rs` needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRelationInput {
    pub source_database_id: Uuid,
    pub target_database_id: Uuid,
    pub source_property_name: String,
    /// DBS-088. Requires `source_database_id == target_database_id` (the
    /// same CHECK `0018_database_relations.sql` enforces at the DB layer —
    /// this is only the friendlier error). `true` makes `two_way` and
    /// `target_property_name` meaningless: a symmetric relation has exactly
    /// ONE property, read from both ends by `repository.rs`'s UNION
    /// queries, never a second column.
    pub is_symmetric: bool,
    /// Ignored when `is_symmetric` is `true`.
    pub two_way: bool,
    /// Required when `two_way && !is_symmetric`; ignored otherwise.
    pub target_property_name: Option<String>,
    pub source_max_targets: Option<i32>,
    pub target_max_sources: Option<i32>,
}

/// Result of [`create_relation`](crate::db::relations::RelationRepository::create_relation)
/// and [`set_relation_two_way`](crate::db::relations::RelationRepository::set_relation_two_way)
/// — both answer "what does the relation look like now, and which property
/// ids does the caller select on".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRelationResult {
    pub relation: RelationDefinitionRow,
    pub source_property_id: Uuid,
    /// `None` for a symmetric relation (DBS-088: one property serves both
    /// ends) or a one-way relation that has never been made two-way.
    pub target_property_id: Option<Uuid>,
}

/// One record on the "other side" of a relation cell — enough for the cell
/// to render a chip (title, icon) and for the caller to address it
/// (`record_id`) in a follow-up `set_relation_targets`/etc. call.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTargetRow {
    pub record_id: Uuid,
    pub title: String,
    pub icon: Option<String>,
}

/// [`list_relation_targets`](crate::db::relations::RelationRepository::list_relation_targets)'s
/// obligatory pagination (arquitetura §9: a Fase 4 deck with 50 000 cards on
/// the other side of one relation must never have a code path that returns
/// them all at once). `total` is the filtered count, independent of
/// `items.len()` — never derive one from the other.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTargetPage {
    pub items: Vec<RelationTargetRow>,
    pub total: i64,
}

/// One requested `record_id`'s slice of
/// [`list_relation_targets_bulk`](crate::db::relations::RelationRepository::list_relation_targets_bulk)'s
/// result — the N+1-proof form of [`RelationTargetPage`]: one entry per
/// input `record_id`, all fetched in the single round trip that method's
/// own doc comment exists to guarantee.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTargets {
    pub record_id: Uuid,
    pub items: Vec<RelationTargetRow>,
    pub total: i64,
}
