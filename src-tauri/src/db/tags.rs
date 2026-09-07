//! `#tag`s in a page's prose — the backend half of the Obsidian-style
//! `#assim`/`#a/b/c` primitive pages didn't have at all before this (see
//! `docs/BAR-tags.md`'s brief; cards' half-built `notes.tags` JSON column is
//! a separate, still-unconnected world this module does not touch).
//!
//! **Where a tag lives.** Three shapes were on the table: (1) derive tags
//! from `blocks.content`/`plain_text` on every read, the way nothing in this
//! codebase currently does for anything indexed; (2) an index table kept in
//! sync by a SQL trigger, the way `0016_block_page_links.sql` keeps the
//! backlink graph and `0004_page_search.sql`/`blocks_fts` keep search; (3) a
//! denormalized column on `pages`.
//!
//! (3) is out for the reason the brief already names: it duplicates the
//! source of truth (a block's text) for no win, since nothing here needs a
//! single scalar the way `pages.title` is a single scalar.
//!
//! (2) is the established pattern, but a SQL trigger can't actually do this
//! job. `block_page_links`'s trigger recognizes a mention by an *exact JSON
//! key* (`key = 'pageId'`) — a comparison SQLite does natively. Recognizing
//! `#materia/biologia` inside a prose string needs Unicode-aware
//! classification (is this codepoint a letter, an accent, an emoji, or a
//! sentence-ending period?) and case folding for identity (`#Biologia` ==
//! `#biologia`) — none of which SQLite's expression language has, and
//! there's no portable way to register a custom scalar function through
//! `sqlx`'s SQLite driver the way `rusqlite::Connection::create_scalar_function`
//! would let a trigger call out to Rust. So extraction has to happen in Rust
//! ([`extract_tags`]), and "kept in sync by the write path" means "every
//! write path calls [`sync_block_tags`]", not "a trigger calls it".
//!
//! That reintroduces exactly the risk `0016_block_page_links.sql`'s own
//! comment warns about for backlinks — "N call sites remembering is N places
//! that can drift" — with no trigger to make it moot. Every current write
//! path is wired by hand instead: `db::blocks::BlockRepository`'s
//! `create`/`create_in_tx`/the patch-and-mirror-to-copies path in
//! `update`/`apply_changes`/`create_synced_copy`, and
//! `db::pages::duplicate`'s raw `INSERT` (the same one the backlinks trigger
//! comment calls out as the case a trigger protects against and application
//! code has to remember). A future write path that inserts or updates
//! `blocks` directly without going through one of those will silently skip
//! tag extraction — flagged here once, deliberately, instead of re-litigated
//! at every call site.
//!
//! **Where a block's tags are stored**: `block_tags` (`0041_tags.sql`) carries only
//! `(block_id, tag_id)` — no denormalized `page_id`, unlike
//! `block_page_links`'s `source_page_id`. A block's page is read live via a
//! join to `blocks.page_id` on every query instead, which is what makes
//! `BlockRepository::move_block` need zero tag-specific code: moving a block
//! to another page already changes what `blocks.page_id` says, and every
//! tag query joins through that column, so the block's tags simply move
//! with it. Denormalizing `page_id` here would have reintroduced the exact
//! staleness `move_block`'s cascade to descendants exists to prevent.
//!
//! **Nested tags** (`#materia/biologia`): stored as the literal string
//! typed, `/` included — there is no separate row for the implied parent
//! `materia`. "Listing `#materia` reaches what's under it" is answered at
//! query time, in [`TagRepository::list_pages_for_tag`]: a tag row matches a
//! query for `t` when its name is exactly `t` or starts with `t/`. Deciding
//! this in the index (materializing a row for every ancestor prefix,
//! `#a/b/c` also writing rows for `#a` and `#a/b`) was the alternative;
//! query-time was chosen because it needs no extra rows or upkeep, and
//! because [`TagRepository::list_all_tags`] is simpler for it: a tag that
//! was never typed on its own (only ever as a prefix, e.g. only
//! `#materia/biologia` ever appears) legitimately does not show up as its
//! own list entry — there is nothing to click that isn't already implied by
//! the child's own name, and the next piece (a UI tree) can still build the
//! `materia` branch by splitting names on `/`.
//!
//! **Case**: identity is case-insensitive — Obsidian's own rule
//! (https://obsidian.md/help/tags: "Tags are case-insensitive, meaning Tag
//! and tag are considered the same tag"). [`extract_tags`] lower-cases every
//! segment before it becomes a tag name, so `#Biologia` and `#biologia`
//! collapse into the one row `tags.name = 'biologia'` and share its page
//! count. Nothing here retains the as-typed casing for later display —
//! there is no consumer for it yet (the mark in the editor and the tag panel
//! are the next piece per the brief), and inventing a "which casing wins"
//! rule for a value nothing reads would be speculative.
//!
//! **`#tag` inside a code block**: does not count —
//! [`extract_tags`] returns nothing when `block_type == "code"`. A `#` in a
//! code block is code (a shell comment, a Python decorator sigil, a
//! Markdown heading pasted as a snippet), the same way Markdown itself never
//! treats a fenced code block's contents as prose to be parsed for syntax.
//! This is a *block-type* check only — an inline `` `#tag` `` code *span*
//! sitting inside an ordinary paragraph is not distinguished from plain text
//! here, because telling the two apart needs per-run mark data from the
//! block's `content` JSON (which run carries a `code` mark) rather than the
//! flattened `plain_text` this module reads, and doing that is out of this
//! round's scope — noted once here rather than left to look like an
//! oversight.

use std::collections::BTreeSet;

use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::error::Result;

/// One row of [`TagRepository::list_all_tags`]: a tag exactly as typed
/// (lower-cased, `/`-nested as written) and how many live pages carry it —
/// an EXACT match on `name`, not rolled up with its descendants. (Rolling a
/// nested tag's count up into its ancestor's would need a decision this
/// task doesn't have a forcing use case for yet; `list_pages_for_tag` is
/// where "reach what's under this tag" is actually needed, and does do the
/// roll-up.)
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummaryRow {
    pub name: String,
    pub page_count: i64,
}

/// One row of [`TagRepository::list_pages_for_tag`].
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPageRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub title: String,
}

pub struct TagRepository {
    pool: SqlitePool,
}

impl TagRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Every tag with at least one live page under it (a page with a
    /// trashed block, or one wholly trashed itself, drops out through the
    /// `deleted_at IS NULL` joins — never an explicit cleanup step), sorted
    /// by name so nested tags naturally cluster (`materia`, then
    /// `materia/biologia`, then `materia/quimica`).
    pub async fn list_all_tags(&self) -> Result<Vec<TagSummaryRow>> {
        let rows = sqlx::query_as::<_, TagSummaryRow>(
            "SELECT t.name AS name, COUNT(DISTINCT b.page_id) AS page_count \
             FROM tags t \
             JOIN block_tags bt ON bt.tag_id = t.id \
             JOIN blocks b ON b.id = bt.block_id AND b.deleted_at IS NULL \
             JOIN pages p ON p.id = b.page_id AND p.deleted_at IS NULL \
             GROUP BY t.id, t.name \
             ORDER BY t.name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Every live page carrying tag `name` (case-insensitively — `name` is
    /// lower-cased here the same way [`extract_tags`] lower-cases what it
    /// finds, so a caller passing `"Biologia"` still matches pages tagged
    /// `#biologia`) **or a nested tag under it** — asking for `"materia"`
    /// reaches pages that only ever wrote `#materia/biologia`, per this
    /// module's brief. The prefix check is plain string comparison
    /// (`substr(name, 1, length($1)+1) = $1 || '/'`), not `LIKE`, on
    /// purpose: a tag name can itself contain `_`, which `LIKE` treats as a
    /// single-character wildcard, and escaping that correctly is more
    /// surface area than just not using `LIKE` at all. `$1` is SQLite's
    /// named-parameter form, reused across all three appearances from one
    /// `.bind` — the same trick `BlockRepository::delete_synced_original`
    /// already relies on.
    pub async fn list_pages_for_tag(&self, name: &str) -> Result<Vec<TagPageRow>> {
        let needle = name.to_lowercase();
        let rows = sqlx::query_as::<_, TagPageRow>(
            "SELECT DISTINCT p.id AS id, p.title AS title \
             FROM tags t \
             JOIN block_tags bt ON bt.tag_id = t.id \
             JOIN blocks b ON b.id = bt.block_id AND b.deleted_at IS NULL \
             JOIN pages p ON p.id = b.page_id AND p.deleted_at IS NULL \
             WHERE t.name = $1 OR substr(t.name, 1, length($1) + 1) = $1 || '/' \
             ORDER BY p.title",
        )
        .bind(needle)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

/// Re-derives every `#tag` in `block_id`'s current text and makes
/// `block_tags` agree with it: delete-then-reinsert (never a diff), the same
/// choice `0016_block_page_links.sql`'s trigger makes and for the same
/// reason — `plain_text` changes on every keystroke via autosave, a block
/// rarely carries more than a handful of tags, and "recompute the whole set"
/// is a pass that is obviously correct instead of a diff that could drift
/// from the extraction rule over time.
///
/// Takes the transaction the caller is already inside (every call site here
/// is mid-write on `blocks` or a duplicated copy of it) rather than a pool,
/// so a block's row and its tag rows commit or roll back together.
pub(crate) async fn sync_block_tags(
    tx: &mut Transaction<'_, Sqlite>,
    block_id: Uuid,
    block_type: &str,
    plain_text: &str,
) -> Result<()> {
    let names = extract_tags(plain_text, block_type);

    sqlx::query("DELETE FROM block_tags WHERE block_id = $1")
        .bind(block_id.db())
        .execute(&mut **tx)
        .await?;

    for name in names {
        // Get-or-create in one round trip: a tag already named `name` keeps
        // its `id` (the `DO UPDATE` is a no-op write that exists only so
        // `RETURNING id` has a row to return on the conflict path too —
        // SQLite's `RETURNING` doesn't fire on a plain `DO NOTHING`).
        let tag_id: DbId = sqlx::query_scalar(
            "INSERT INTO tags (id, name) VALUES ($1, $2) \
             ON CONFLICT (name) DO UPDATE SET name = excluded.name \
             RETURNING id",
        )
        .bind(Uuid::now_v7().db())
        .bind(&name)
        .fetch_one(&mut **tx)
        .await?;

        sqlx::query("INSERT INTO block_tags (id, block_id, tag_id) VALUES ($1, $2, $3)")
            .bind(Uuid::now_v7().db())
            .bind(block_id.db())
            .bind(tag_id)
            .execute(&mut **tx)
            .await?;
    }

    Ok(())
}

/// A character that ends a tag body, and — other than `/` itself, handled
/// separately — also disqualifies whatever sits right after `#` from
/// starting one. Deliberately an *exclusion* list (whitespace, `#` itself,
/// and common sentence/clause punctuation) rather than an *inclusion* list
/// of "allowed" Unicode categories: an inclusion list would have to
/// enumerate every script and symbol block a tag body may contain to
/// support accented Portuguese (`#matemática`) and emoji (`#📚`) alike, and
/// would still miss whatever it didn't think of. Excluding the small set of
/// characters that should obviously end a tag lets everything else —
/// letters in any script, digits, emoji, `_`, `-` — through without needing
/// a name for it.
fn is_tag_boundary(c: char) -> bool {
    if c.is_whitespace() {
        return true;
    }
    matches!(
        c,
        '#' | '.'
            | ','
            | ';'
            | ':'
            | '!'
            | '?'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '"'
            | '\''
            | '`'
            | '*'
            | '~'
            | '<'
            | '>'
            | '|'
            | '\\'
            | '@'
    )
}

/// Extracts every `#tag` (Obsidian-style, `#a/b/c` nesting included) written
/// in `plain_text` — lower-cased for case-insensitive identity and
/// de-duplicated, so the same tag typed twice in one block, or typed with
/// different casing, is one name in the result. Pure and total: any input —
/// `#` alone, `#/`, `##`, a huge string, an emoji, an accented word — comes
/// back as a normal (possibly empty) `Vec`, never a panic.
///
/// `block_type == "code"` short-circuits to empty; see this module's doc
/// comment for why, and for the inline-code-span case this function does
/// NOT handle.
///
/// A `#` starts a tag only when:
/// - nothing "word-like" sits immediately before it (so `a#b` in prose, or
///   a URL's `#anchor` fragment, is never mistaken for a tag — the
///   character before, if any, must be [`is_tag_boundary`]), and
/// - the very next character is neither a boundary character nor `/` (so
///   `#`, `# `, `#/`, and `##` all produce nothing — in `##foo` the second
///   `#` also fails to start a tag, since the character right before it is
///   the first `#`, which is itself a boundary character).
///
/// From a valid start, the body runs until the next [`is_tag_boundary`]
/// character or the end of the text; `/` is deliberately never a boundary
/// mid-body (that's what makes nesting possible), and [`normalize_tag`]
/// drops any empty segment a leading/trailing/doubled `/` would otherwise
/// produce before lower-casing what's left.
pub fn extract_tags(plain_text: &str, block_type: &str) -> Vec<String> {
    if block_type == "code" {
        return Vec::new();
    }

    let chars: Vec<char> = plain_text.chars().collect();
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] != '#' {
            i += 1;
            continue;
        }

        // `is_tag_boundary` responde "o que TERMINA uma tag". Aqui a pergunta
        // é outra — "o que pode vir ANTES de uma tag" — e para `#` as duas
        // respostas divergem: `#` termina uma tag (`#bio#logia` para no
        // segundo `#`), mas não pode abrir a seguinte.
        //
        // Sem essa distinção, `##biologia` virava a tag `biologia`: o
        // primeiro `#` era corretamente recusado (o corpo começaria com `#`),
        // e aí o SEGUNDO `#` era aceito, porque o `#` à esquerda dele contava
        // como fronteira válida. É o comportamento do Obsidian que vale aqui:
        // `#` abre tag só no início do texto ou depois de espaço/pontuação
        // que não seja outro `#`.
        let preceded_ok = match i.checked_sub(1) {
            None => true,
            Some(prev) => chars[prev] != '#' && is_tag_boundary(chars[prev]),
        };
        if !preceded_ok {
            i += 1;
            continue;
        }

        let body_start = i + 1;
        let Some(&first_body_char) = chars.get(body_start) else {
            // Trailing `#` with nothing after it — `plain_text` ends right
            // there.
            break;
        };
        if is_tag_boundary(first_body_char) || first_body_char == '/' {
            i += 1;
            continue;
        }

        let mut j = body_start;
        while j < chars.len() && !is_tag_boundary(chars[j]) {
            j += 1;
        }

        let raw_body: String = chars[body_start..j].iter().collect();
        if let Some(name) = normalize_tag(&raw_body) {
            found.insert(name);
        }
        i = j;
    }

    found.into_iter().collect()
}

/// Splits `raw` on `/`, drops every empty segment (what a leading, trailing,
/// or doubled `/` would otherwise leave behind — `#a//b` becomes `a/b`, not
/// `a//b` or a crash on an empty path element), lower-cases each surviving
/// segment, and rejoins with `/`. `None` only when nothing survives at all
/// (`raw` made entirely of `/`, which [`extract_tags`]'s start-character
/// check already prevents from reaching here with today's caller, but this
/// function stays total on its own rather than leaning on that).
fn normalize_tag(raw: &str) -> Option<String> {
    let segments: Vec<String> = raw.split('/').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn extracts_a_simple_tag() {
        assert_eq!(extract_tags("estudando #biologia hoje", "paragraph"), vec!["biologia".to_string()]);
    }

    #[test]
    fn nested_tag_keeps_its_full_path() {
        assert_eq!(extract_tags("#materia/biologia", "paragraph"), vec!["materia/biologia".to_string()]);
    }

    #[test]
    fn a_lone_hash_is_not_a_tag() {
        assert!(extract_tags("preço: #", "paragraph").is_empty());
    }

    #[test]
    fn hash_slash_is_not_a_tag() {
        assert!(extract_tags("caminho #/materia", "paragraph").is_empty());
    }

    #[test]
    fn double_hash_is_not_a_tag() {
        assert!(extract_tags("##biologia", "paragraph").is_empty());
    }

    #[test]
    fn hash_followed_by_space_is_not_a_tag() {
        assert!(extract_tags("# biologia", "paragraph").is_empty());
    }

    #[test]
    fn accented_tag_is_extracted_and_lowercased() {
        assert_eq!(extract_tags("prova de #Matemática amanhã", "paragraph"), vec!["matemática".to_string()]);
    }

    #[test]
    fn emoji_tag_does_not_panic_and_is_extracted() {
        assert_eq!(extract_tags("resumo #📚 pronto", "paragraph"), vec!["📚".to_string()]);
    }

    #[test]
    fn a_huge_tag_does_not_panic() {
        let huge = "a".repeat(50_000);
        let text = format!("#{huge}");
        assert_eq!(extract_tags(&text, "paragraph"), vec![huge]);
    }

    #[test]
    fn the_same_tag_twice_in_one_block_counts_once() {
        assert_eq!(extract_tags("#biologia e de novo #biologia", "paragraph"), vec!["biologia".to_string()]);
    }

    #[test]
    fn biologia_and_capitalized_biologia_are_the_same_tag() {
        // Obsidian: "Tags are case-insensitive, meaning Tag and tag are
        // considered the same tag." — https://obsidian.md/help/tags
        assert_eq!(extract_tags("#Biologia e #biologia", "paragraph"), vec!["biologia".to_string()]);
    }

    #[test]
    fn a_code_block_never_yields_tags() {
        assert!(extract_tags("#!/usr/bin/env python\n# #biologia is a comment", "code").is_empty());
    }

    #[test]
    fn a_tag_right_after_a_word_character_is_not_recognized() {
        // "a#b" in prose (or a URL's #anchor fragment) is not a tag — the
        // character right before `#` must itself be a boundary.
        assert!(extract_tags("pagina#ancora", "paragraph").is_empty());
    }

    #[test]
    fn empty_text_yields_no_tags() {
        assert!(extract_tags("", "paragraph").is_empty());
    }
}
