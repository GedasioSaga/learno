//! Read side of FUN-044's backlink graph. The graph itself
//! (`block_page_links`) is a table Postgres keeps in sync via the trigger in
//! `0016_block_page_links.sql`, not something this repository derives or
//! writes — see that migration's comment for why a trigger, not a step
//! `db::blocks::BlockRepository` has to remember to run, is what keeps it
//! correct no matter which code path touches a block's `content`.
//!
//! Consultable in both directions per this session's brief: [`list_backlinks`]
//! answers "who links here", [`list_outgoing_links`] answers "what does this
//! page link to" — the same edge table, queried from either end.
//!
//! [`list_backlinks`]: BacklinkRepository::list_backlinks
//! [`list_outgoing_links`]: BacklinkRepository::list_outgoing_links

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::Result;

/// Max length, in **characters** (not bytes — the text is Portuguese, and a
/// byte cut can split a multi-byte codepoint like "ç" in half), of the
/// snippet [`list_backlinks`] returns per row. Cut server-side so every
/// caller (today just the "Backlinks" footer, FUN-044) gets the same
/// contract instead of each reimplementing truncation over the full block
/// text.
///
/// [`list_backlinks`]: BacklinkRepository::list_backlinks
const SNIPPET_MAX_CHARS: usize = 140;

/// One page that links or mentions the page being asked about, plus the
/// block that does it. `source_page_title` rides along so the "Backlinks"
/// section (FUN-044) can render without a second round trip per row — it is
/// read live from `pages.title` on every query, which is also *why* FUN-045
/// (renaming propagates everywhere) needs no extra work on this table's
/// side: nothing here ever caches a title next to the edge. `source_snippet`
/// is the same idea applied to the mention's context: a truncated read of
/// the source block's `plain_text` (`0006_blocks.sql`), cut fresh on every
/// query rather than cached, so an edit to the mentioning block's text shows
/// up here the same way a page rename shows up in `source_page_title`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRow {
    pub source_block_id: Uuid,
    pub source_page_id: Uuid,
    pub source_page_title: String,
    pub source_snippet: String,
    pub target_page_id: Uuid,
}

/// What the query actually fetches — `source_plain_text` is the block's full
/// text, truncated into `BacklinkRow::source_snippet` after the round trip
/// rather than in SQL, because word-boundary-aware, character-counted
/// truncation is easier to get right (and to unit-test in isolation, see
/// [`truncate_snippet`]) as Rust than as a `substring`/`regexp` expression.
#[derive(Debug, Clone, sqlx::FromRow)]
struct BacklinkRowRaw {
    source_block_id: Uuid,
    source_page_id: Uuid,
    source_page_title: String,
    source_plain_text: String,
    target_page_id: Uuid,
}

impl From<BacklinkRowRaw> for BacklinkRow {
    fn from(raw: BacklinkRowRaw) -> Self {
        Self {
            source_block_id: raw.source_block_id,
            source_page_id: raw.source_page_id,
            source_page_title: raw.source_page_title,
            source_snippet: truncate_snippet(&raw.source_plain_text, SNIPPET_MAX_CHARS),
            target_page_id: raw.target_page_id,
        }
    }
}

/// Trims `text` and, if it is longer than `max_chars` **characters**, cuts it
/// down to that limit and appends a single `…`. Counts by `char`, never by
/// byte (`str::len`/byte slicing would risk landing mid-codepoint on
/// accented text), and prefers cutting at the last whitespace at or before
/// the limit over slicing mid-word — but only when that whitespace is at
/// least halfway into the budget, so a snippet with no early space (or one
/// long unbroken first word) still uses most of its allowance instead of
/// collapsing to a sliver.
fn truncate_snippet(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return trimmed.to_string();
    }

    let mut cut = max_chars;
    if let Some(last_space) = chars[..max_chars].iter().rposition(|c| c.is_whitespace()) {
        if last_space >= max_chars / 2 {
            cut = last_space;
        }
    }

    let mut snippet: String = chars[..cut].iter().collect();
    snippet.truncate(snippet.trim_end().len());
    snippet.push('…');
    snippet
}

/// The mirror of [`BacklinkRow`] for the outgoing direction: one row per
/// block on the queried page that links or mentions some other page.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingLinkRow {
    pub source_block_id: Uuid,
    pub target_page_id: Uuid,
    pub target_page_title: String,
}

pub struct BacklinkRepository {
    pool: SqlitePool,
}

impl BacklinkRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// FUN-044: every live block, on any live page, that references
    /// `target_page_id` — ordered by the linking page's title so the section
    /// reads as a stable list rather than insertion order.
    pub async fn list_backlinks(&self, target_page_id: Uuid) -> Result<Vec<BacklinkRow>> {
        // The join to `blocks` is safe without its own `deleted_at IS NULL`
        // filter: the trigger in `0016_block_page_links.sql` already deletes
        // a block's `block_page_links` rows the moment `deleted_at` is set,
        // so a row reaching this query always points at a live block.
        let rows = sqlx::query_as::<_, BacklinkRowRaw>(
            "SELECT l.source_block_id, l.source_page_id, p.title AS source_page_title, \
                    b.plain_text AS source_plain_text, l.target_page_id \
             FROM block_page_links l \
             JOIN pages p ON p.id = l.source_page_id \
             JOIN blocks b ON b.id = l.source_block_id \
             WHERE l.target_page_id = $1 AND p.deleted_at IS NULL \
             ORDER BY p.title, l.source_block_id",
        )
        .bind(target_page_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(BacklinkRow::from).collect())
    }

    /// The other direction: every page `source_page_id` itself references.
    pub async fn list_outgoing_links(&self, source_page_id: Uuid) -> Result<Vec<OutgoingLinkRow>> {
        let rows = sqlx::query_as::<_, OutgoingLinkRow>(
            "SELECT l.source_block_id, l.target_page_id, p.title AS target_page_title \
             FROM block_page_links l \
             JOIN pages p ON p.id = l.target_page_id \
             WHERE l.source_page_id = $1 AND p.deleted_at IS NULL \
             ORDER BY p.title, l.source_block_id",
        )
        .bind(source_page_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}
