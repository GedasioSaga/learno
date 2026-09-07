//! Fase 3's relation graph (arquitetura §5) — the ONE exception to
//! decision (c) on `database_record_values` being the home for every
//! property's value. A relation-type `database_properties` row is a WINDOW
//! onto one end of an edge that lives in its own table
//! (`database_relation_edges`), never a row in `database_record_values`.
//! See `repository.rs`'s doc comment for the four measured reasons (also in
//! `0018_database_relations.sql`'s own comments) and for every query this
//! piece runs.
//!
//! ## What this piece (R2) owns
//!
//! - `database_relations` / `database_relation_edges`
//!   (`0018_database_relations.sql`), including the
//!   `database_properties_cleanup_relation` trigger this piece ADDED to
//!   that migration — see its comment for why a SQLite trigger, not
//!   application code, is what keeps "deleting the last relation property
//!   deletes the relation" true no matter which code path issues the
//!   `DELETE`.
//! - Every `database_properties` row with `property_type = 'relation'`:
//!   creating them ([`RelationRepository::create_relation`],
//!   [`RelationRepository::set_relation_two_way`]) and reading their config
//!   back (`property_relation_ref`, `find_property`). No other file in this
//!   crate writes that `property_type` — unlike `database_record_values`
//!   (I4), nothing enforces this by test or by a single-writer table, so it
//!   is a convention this piece is naming rather than a guarantee it can
//!   check.
//! - DBS-086/087 (one-way/two-way toggle), DBS-088 (the symmetric
//!   self-relation's single shared column, normalised by the edge table's
//!   own CHECK so the app never has to remember which side of a pair is
//!   canonical), DBS-090 (cardinality — `set_relation_targets` over the
//!   limit is a caller bug and errors; `add_relation_targets` at limit 1
//!   REPLACES, the UI's single-select write path).
//!
//! ## Divergência da arquitetura
//!
//! §9 freezes `ipc/relation_commands.rs`'s Tauri **command** signatures — a
//! file this piece is not scoped to touch
//! (`src-tauri/src/db/relations/` and the `0018` migration only). What
//! lives here is the repository every one of those commands thin-wraps,
//! under the matching name: drop the `state: State<'_, AppState>` first
//! argument and call into `RelationRepository` (wherever it ends up living
//! on `AppState`) —
//!
//! | §9 command | This piece's method |
//! |---|---|
//! | `create_relation` | [`RelationRepository::create_relation`] |
//! | `set_relation_two_way` | [`RelationRepository::set_relation_two_way`] |
//! | `set_relation_cardinality` | [`RelationRepository::set_relation_cardinality`] |
//! | `list_relation_targets` | [`RelationRepository::list_relation_targets`] |
//! | `list_relation_targets_bulk` | [`RelationRepository::list_relation_targets_bulk`] |
//! | `set_relation_targets` | [`RelationRepository::set_relation_targets`] |
//! | `add_relation_targets` | [`RelationRepository::add_relation_targets`] |
//! | `remove_relation_targets` | [`RelationRepository::remove_relation_targets`] |
//!
//! `CreateRelationInput`/`CreateRelationResult`/`RelationDefinitionRow`/
//! `RelationTargetPage`/`RelationTargetRow`/`RecordTargets` are this
//! piece's own types: §9 names the Rust command signatures but never
//! defines their payload shapes for relations, so this module is the
//! source of truth for them.
//!
//! `predicate.rs` (peça Q1, "construtor de predicado") filters by relation
//! with the `EXISTS` fragment named in this piece's own report — never a
//! jsonb-contains check, since a relation has no `database_record_values`
//! row to contain anything.
//!
//! O registro final em `db/mod.rs` (arquitetura §11, tarefa de N1) **já foi
//! feito**: `pub mod relations;` mais a reexportação de `CreateRelationInput`,
//! `CreateRelationResult`, `RecordTargets`, `RelationDefinitionRow`,
//! `RelationRepository`, `RelationTargetPage` e `RelationTargetRow`.
//!
//! Este parágrafo já foi um bloco de código com a instrução para quem fosse
//! fazer esse registro. Ele quebrava `cargo test`: mesmo marcado ```ignore``,
//! o rustdoc tentava compilá-lo e falhava com "cannot declare a file module
//! inside a block", porque `pub mod relations;` num doctest é uma declaração
//! de módulo dentro de um bloco. Instrução para humano vira prosa, não bloco
//! de código — um bloco é compilado, e um bloco que não é código de verdade
//! quebra o portão sem ter nada a ver com o produto.
//!
//! **Not this piece:** T5 (`0019_database_derived.sql`'s own comment:
//! "AFTER DELETE ON database_properties / database_relations -> marca
//! `config` das sobreviventes com `broken`") — explicitly assigned there to
//! the formula/rollup piece, not to N2 and, by the same file's reasoning,
//! not to this one either. This piece's read paths
//! ([`RelationRepository::list_relation_targets`]/`_bulk`) do not need it
//! to behave correctly: deleting the target database cascades away
//! `database_relations` (its own `target_database_id` FK) and, with it,
//! every `database_relation_edges` row for that relation, so a property
//! left pointing at a since-deleted `relationId` simply finds zero edges
//! and reads back as an EMPTY page (`total: 0`), never an error. The
//! `broken` flag T5 owes is a UI affordance distinguishing that from an
//! ordinary empty relation, not a correctness requirement for this piece's
//! queries.

mod repository;
mod types;

pub use repository::RelationRepository;
pub use types::{
    CreateRelationInput, CreateRelationResult, RecordTargets, RelationDefinitionRow, RelationTargetPage,
    RelationTargetRow,
};
