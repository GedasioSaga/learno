//! Global search (FUN-037) across page titles and block content, backed by
//! the accent-insensitive `search_vector`/trigram indexes from
//! `0004_page_search.sql`, `0006_blocks.sql` and
//! `0015_global_search_accent_insensitive.sql`.
//!
//! Deliberately its own repository rather than a method on `PageRepository`:
//! a result row is a projection built for the palette (which page, which
//! snippet, why it matched), never a full `PageRow`/block row.

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

/// How many rows the palette shows before truncating — enough to scan
/// without turning "search" into "return everything that matches".
pub const DEFAULT_RESULT_LIMIT: i64 = 20;

/// One hit in the global search palette. `rank` only orders the list the
/// backend already returned — it carries no meaning on its own and the
/// frontend never recomputes or compares it across separate searches.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SearchResultRow {
    pub page_id: Uuid,
    pub page_title: String,
    pub snippet: String,
    /// `"title"` or `"content"` — which field matched, so the palette can
    /// label the hit instead of guessing from `snippet` alone.
    pub match_kind: String,
    pub rank: f64,
}

/// Matches page titles (via tsvector rank *and* trigram substring, so "Bio"
/// finds "Biologia" even though it stems oddly) and block plain-text content
/// (tsvector only — content is prose, not something users substring-match),
/// ranked best-first with title hits favoured over content hits.
const SEARCH_SQL: &str = "\
    WITH input AS ( \
        SELECT immutable_unaccent($1) AS normalized, \
               plainto_tsquery('portuguese', immutable_unaccent($1)) AS tsq \
    ) \
    SELECT p.id AS page_id, p.title AS page_title, p.title AS snippet, 'title' AS match_kind, \
           (ts_rank(p.search_vector, input.tsq) + similarity(immutable_unaccent(p.title), input.normalized))::float8 AS rank \
    FROM pages p, input \
    WHERE p.deleted_at IS NULL \
      AND (p.search_vector @@ input.tsq OR immutable_unaccent(p.title) ILIKE '%' || input.normalized || '%') \
    UNION ALL \
    SELECT b.page_id AS page_id, p.title AS page_title, left(b.plain_text, 160) AS snippet, 'content' AS match_kind, \
           ts_rank(b.search_vector, input.tsq)::float8 AS rank \
    FROM blocks b JOIN pages p ON p.id = b.page_id, input \
    WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL AND b.search_vector @@ input.tsq \
    ORDER BY rank DESC \
    LIMIT $2\
";

pub struct SearchRepository {
    pool: PgPool,
}

impl SearchRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// FUN-037. Empty/whitespace-only input never reaches Postgres: an empty
    /// `tsquery` would just match nothing anyway (and the ILIKE fallback
    /// would become `ILIKE '%%'`, matching *everything*), so this skips the
    /// round trip instead of running a query with the wrong meaning.
    pub async fn search(&self, query: &str, limit: i64) -> Result<Vec<SearchResultRow>> {
        let normalized = normalize_query(query);
        if normalized.is_empty() {
            return Ok(Vec::new());
        }

        let rows = sqlx::query_as::<_, SearchResultRow>(SEARCH_SQL)
            .bind(normalized)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;

        Ok(rows)
    }
}

/// Pure: trims the raw palette input. Split out so the empty-input guard in
/// `search` is testable without a database.
fn normalize_query(raw: &str) -> String {
    raw.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_query_trims_surrounding_whitespace() {
        assert_eq!(normalize_query("  revisão  "), "revisão");
    }

    #[test]
    fn normalize_query_collapses_whitespace_only_input_to_empty() {
        assert_eq!(normalize_query("   "), "");
    }

    #[test]
    fn normalize_query_leaves_a_normal_word_untouched() {
        assert_eq!(normalize_query("bio"), "bio");
    }
}
