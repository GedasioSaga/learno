//! Exporting a page's block tree to a standalone Markdown file (FUN-023).
//!
//! `blocks.content` is Fase 2's editor's JSON, which does not exist yet —
//! that builder owns its exact shape. This module leans only on what is
//! already stable in `0006_blocks.sql`: `block_type` (a string tag) and
//! `plain_text` (the block's flattened text, kept in sync by whoever writes
//! it — see that migration's own comment). `content` is read only for a
//! handful of narrow, optional structural hints (heading level, code
//! language, checkbox state) with a safe default when a hint is absent, so
//! this keeps working before Fase 2 defines anything richer.
//!
//! The conversion itself (`build_block_tree`, `render_markdown`,
//! `escape_markdown_text`, `sanitize_filename`) is pure — no I/O, no
//! database — and is exactly what the tests below exercise. Only
//! `fetch_page_blocks`, the one function that actually reads Postgres, needs
//! a live database, and is covered by the `#[ignore]`d integration test in
//! `src-tauri/tests/backup_export_markdown.rs`.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::Result;

/// One row of `blocks`, as fetched for export.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ExportBlockRow {
    pub id: Uuid,
    pub parent_block_id: Option<Uuid>,
    pub block_type: String,
    pub content: serde_json::Value,
    pub plain_text: String,
    pub position: String,
}

/// A block, already nested under its children, ready to render.
#[derive(Debug, Clone, PartialEq)]
struct ExportBlockNode {
    block_type: String,
    content: serde_json::Value,
    text: String,
    children: Vec<ExportBlockNode>,
}

/// Fetches every active block of `page_id`, ordered so that within any
/// sibling group (same `parent_block_id`) the rows already come out in
/// display order — `build_block_tree` below relies on exactly that, not on
/// a global order across unrelated parents.
pub async fn fetch_page_blocks(pool: &SqlitePool, page_id: Uuid) -> Result<Vec<ExportBlockRow>> {
    let rows = sqlx::query_as::<_, ExportBlockRow>(
        "SELECT id, parent_block_id, block_type, content, plain_text, position \
         FROM blocks WHERE page_id = $1 AND deleted_at IS NULL ORDER BY position",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// FUN-023: the page's title plus its block tree, rendered as one Markdown
/// document.
pub fn export_page_to_markdown(title: &str, rows: &[ExportBlockRow]) -> String {
    let tree = build_block_tree(rows);
    render_markdown(title, &tree)
}

fn build_block_tree(rows: &[ExportBlockRow]) -> Vec<ExportBlockNode> {
    build_children(rows, None)
}

fn build_children(rows: &[ExportBlockRow], parent_id: Option<Uuid>) -> Vec<ExportBlockNode> {
    rows.iter()
        .filter(|row| row.parent_block_id == parent_id)
        .map(|row| ExportBlockNode {
            block_type: row.block_type.clone(),
            content: row.content.clone(),
            text: row.plain_text.clone(),
            children: build_children(rows, Some(row.id)),
        })
        .collect()
}

fn render_markdown(title: &str, blocks: &[ExportBlockNode]) -> String {
    let mut out = String::new();
    out.push_str("# ");
    out.push_str(&escape_markdown_text(title));
    out.push_str("\n\n");
    render_blocks(&mut out, blocks, 0);
    out
}

/// Two spaces per nesting level: with a `- ` marker (dash + space, two
/// characters wide), CommonMark only requires a nested list's content to be
/// indented at least to that width, so this stays valid at any depth.
const LIST_INDENT_PER_LEVEL: usize = 2;

fn render_blocks(out: &mut String, blocks: &[ExportBlockNode], depth: usize) {
    let mut numbered_counter: u32 = 0;

    for block in blocks {
        match block.block_type.as_str() {
            "heading" => {
                numbered_counter = 0;
                out.push_str(&"#".repeat(heading_level(&block.content)));
                out.push(' ');
                out.push_str(&escape_markdown_text(&block.text));
                out.push_str("\n\n");
            }
            "bulleted_list_item" => {
                numbered_counter = 0;
                push_indent(out, depth);
                out.push_str("- ");
                out.push_str(&escape_markdown_text(&block.text));
                out.push('\n');
            }
            "numbered_list_item" => {
                numbered_counter += 1;
                push_indent(out, depth);
                out.push_str(&numbered_counter.to_string());
                out.push_str(". ");
                out.push_str(&escape_markdown_text(&block.text));
                out.push('\n');
            }
            "task_item" => {
                numbered_counter = 0;
                push_indent(out, depth);
                out.push_str(if is_checked(&block.content) { "- [x] " } else { "- [ ] " });
                out.push_str(&escape_markdown_text(&block.text));
                out.push('\n');
            }
            "quote" => {
                numbered_counter = 0;
                out.push_str("> ");
                out.push_str(&escape_markdown_text(&block.text));
                out.push_str("\n\n");
            }
            "code_block" => {
                numbered_counter = 0;
                render_code_block(out, block);
            }
            "divider" => {
                numbered_counter = 0;
                out.push_str("---\n\n");
            }
            // "paragraph" and anything Fase 2 introduces later that this
            // module does not yet know about both fall back to plain text —
            // better a readable paragraph than a silently dropped block.
            _ => {
                numbered_counter = 0;
                out.push_str(&escape_markdown_text(&block.text));
                out.push_str("\n\n");
            }
        }

        if !block.children.is_empty() {
            render_blocks(out, &block.children, depth + 1);
        }
    }
}

fn render_code_block(out: &mut String, block: &ExportBlockNode) {
    let fence = fence_for(&block.text);
    out.push_str(&fence);
    out.push_str(&code_language(&block.content));
    out.push('\n');
    out.push_str(&block.text);
    if !block.text.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&fence);
    out.push_str("\n\n");
}

fn push_indent(out: &mut String, depth: usize) {
    for _ in 0..(depth * LIST_INDENT_PER_LEVEL) {
        out.push(' ');
    }
}

fn heading_level(content: &serde_json::Value) -> usize {
    let level = content.get("level").and_then(serde_json::Value::as_u64).unwrap_or(1);
    // Clamped to 1..=6 on this line, so the narrowing cast below always
    // fits `usize` on every platform this app targets.
    level.clamp(1, 6) as usize
}

fn is_checked(content: &serde_json::Value) -> bool {
    content.get("checked").and_then(serde_json::Value::as_bool).unwrap_or(false)
}

fn code_language(content: &serde_json::Value) -> String {
    content
        .get("language")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// A fenced code block's fence must be at least as long as the longest run
/// of backticks already inside the code, or that run would prematurely
/// close the fence when the file is read back.
fn fence_for(text: &str) -> String {
    let longest_run = longest_backtick_run(text);
    "`".repeat((longest_run + 1).max(3))
}

fn longest_backtick_run(text: &str) -> usize {
    let mut longest = 0;
    let mut current = 0;
    for ch in text.chars() {
        if ch == '`' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    longest
}

/// Escapes characters that would otherwise be read as Markdown syntax
/// instead of literal text, then guards against a leading character that
/// would make an ordinary paragraph misread as a heading or list item even
/// though its block type says it is plain prose.
pub fn escape_markdown_text(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '\\' | '`' | '*' | '_' | '[' | ']' | '(' | ')' | '<' | '>') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escape_leading_structural_marker(&escaped)
}

fn escape_leading_structural_marker(text: &str) -> String {
    let trimmed = text.trim_start();
    let needs_escape =
        trimmed.starts_with('#') || trimmed.starts_with("- ") || trimmed.starts_with("+ ") || starts_with_ordered_marker(trimmed);
    if !needs_escape {
        return text.to_string();
    }

    let leading_ws_len = text.len() - trimmed.len();
    let (whitespace, rest) = text.split_at(leading_ws_len);
    format!("{whitespace}\\{rest}")
}

fn starts_with_ordered_marker(text: &str) -> bool {
    let digits_end = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(0);
    digits_end > 0 && text[digits_end..].starts_with(". ")
}

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Windows caps a full path at `MAX_PATH` (260 chars) by default; capping
/// just this component well below that leaves room for whatever directory
/// the user picks in the save dialog.
const MAX_FILENAME_LENGTH: usize = 150;

/// Turns a page title into a filename Windows will actually accept: strips
/// the reserved characters, trims the trailing dots/spaces Explorer silently
/// eats anyway, dodges the reserved device names, and falls back to a
/// placeholder for a title that sanitizes down to nothing.
pub fn sanitize_filename(title: &str) -> String {
    // A title made only of forbidden characters (e.g. "///") replaces down to
    // "___" — non-empty, so checking emptiness *after* replacement would miss
    // it and hand the user a mysterious underscore-only filename. Checking
    // for a meaningful character *before* replacing catches that case too.
    let has_meaningful_char = title.chars().any(|c| !is_forbidden_or_trimmable(c));
    if !has_meaningful_char {
        return "pagina-sem-titulo".to_string();
    }

    let replaced: String = title.chars().map(replace_if_forbidden).collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']).trim();

    let mut sanitized = trimmed.to_string();
    if is_reserved_name(&sanitized) {
        sanitized.push('_');
    }

    truncate_to_char_boundary(&sanitized, MAX_FILENAME_LENGTH)
}

fn is_forbidden_or_trimmable(c: char) -> bool {
    is_windows_forbidden_char(c) || c == '.' || c == ' '
}

fn is_windows_forbidden_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
}

fn replace_if_forbidden(c: char) -> char {
    if is_windows_forbidden_char(c) {
        '_'
    } else {
        c
    }
}

fn is_reserved_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name);
    WINDOWS_RESERVED_NAMES.iter().any(|reserved| reserved.eq_ignore_ascii_case(base))
}

fn truncate_to_char_boundary(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let mut end = max_len;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// `<sanitized title>.md`, the default file name offered in the save
/// dialog.
pub fn default_export_file_name(title: &str) -> String {
    format!("{}.md", sanitize_filename(title))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use serde_json::json;

    fn block(id: Uuid, parent: Option<Uuid>, block_type: &str, content: serde_json::Value, text: &str, position: &str) -> ExportBlockRow {
        ExportBlockRow {
            id,
            parent_block_id: parent,
            block_type: block_type.to_string(),
            content,
            plain_text: text.to_string(),
            position: position.to_string(),
        }
    }

    #[test]
    fn fun_023_heading_paragraph_and_list_produce_hash_and_dash_markers() {
        let heading = Uuid::now_v7();
        let rows = vec![
            block(heading, None, "heading", json!({"level": 1}), "Notas", "10"),
            block(Uuid::now_v7(), None, "paragraph", json!({}), "Um parágrafo qualquer.", "20"),
            block(Uuid::now_v7(), None, "bulleted_list_item", json!({}), "Primeiro item", "30"),
        ];

        let markdown = export_page_to_markdown("Notas", &rows);

        assert!(markdown.starts_with("# Notas\n\n"));
        assert!(markdown.contains("# Notas"));
        assert!(markdown.contains("Um parágrafo qualquer."));
        assert!(markdown.contains("- Primeiro item"));
    }

    #[test]
    fn nested_list_items_indent_by_two_spaces_per_level_arbitrarily_deep() {
        // Five levels deep, each item nested one under the previous.
        let mut rows = Vec::new();
        let mut parent = None;
        for depth in 0..5 {
            let id = Uuid::now_v7();
            rows.push(block(id, parent, "bulleted_list_item", json!({}), &format!("nível {depth}"), "10"));
            parent = Some(id);
        }

        let markdown = export_page_to_markdown("Lista", &rows);

        for depth in 0..5 {
            let expected_indent = " ".repeat(depth * LIST_INDENT_PER_LEVEL);
            let expected_line = format!("{expected_indent}- nível {depth}");
            assert!(
                markdown.contains(&expected_line),
                "esperava a linha {expected_line:?} em:\n{markdown}"
            );
        }
    }

    #[test]
    fn numbered_list_restarts_the_counter_for_each_new_contiguous_run() {
        let rows = vec![
            block(Uuid::now_v7(), None, "numbered_list_item", json!({}), "primeiro", "10"),
            block(Uuid::now_v7(), None, "numbered_list_item", json!({}), "segundo", "20"),
            block(Uuid::now_v7(), None, "paragraph", json!({}), "interrompe", "30"),
            block(Uuid::now_v7(), None, "numbered_list_item", json!({}), "reinicia", "40"),
        ];

        let markdown = export_page_to_markdown("Lista numerada", &rows);

        assert!(markdown.contains("1. primeiro"));
        assert!(markdown.contains("2. segundo"));
        assert!(markdown.contains("1. reinicia"));
    }

    #[test]
    fn a_code_block_containing_a_backtick_run_gets_a_longer_fence() {
        let rows = vec![block(
            Uuid::now_v7(),
            None,
            "code_block",
            json!({"language": "rust"}),
            "let s = \"```\";",
            "10",
        )];

        let markdown = export_page_to_markdown("Código", &rows);

        assert!(markdown.contains("````rust\n"));
        assert!(!markdown.contains("```\nlet"));
    }

    #[test]
    fn a_code_block_with_no_backticks_gets_the_minimum_three_backtick_fence() {
        let rows = vec![block(Uuid::now_v7(), None, "code_block", json!({"language": "python"}), "print(1)", "10")];

        let markdown = export_page_to_markdown("Código", &rows);

        assert!(markdown.contains("```python\nprint(1)\n```"));
    }

    #[test]
    fn special_markdown_characters_in_text_are_escaped() {
        let rows = vec![block(
            Uuid::now_v7(),
            None,
            "paragraph",
            json!({}),
            "Preço * [link](x) <tag> `code` _em_ \\barra",
            "10",
        )];

        let markdown = export_page_to_markdown("Notas", &rows);

        assert!(markdown.contains(r"Preço \* \[link\]\(x\) \<tag\> \`code\` \_em\_ \\barra"));
    }

    #[test]
    fn a_paragraph_whose_text_literally_starts_with_a_list_marker_is_escaped() {
        let rows = vec![block(Uuid::now_v7(), None, "paragraph", json!({}), "- não é uma lista de verdade", "10")];

        let markdown = export_page_to_markdown("Notas", &rows);

        assert!(markdown.contains("\\- não é uma lista de verdade"));
    }

    #[test]
    fn a_task_item_renders_a_github_style_checkbox() {
        let rows = vec![
            block(Uuid::now_v7(), None, "task_item", json!({"checked": true}), "Feito", "10"),
            block(Uuid::now_v7(), None, "task_item", json!({"checked": false}), "Pendente", "20"),
        ];

        let markdown = export_page_to_markdown("Tarefas", &rows);

        assert!(markdown.contains("- [x] Feito"));
        assert!(markdown.contains("- [ ] Pendente"));
    }

    #[test]
    fn sanitize_filename_replaces_every_windows_forbidden_character() {
        let sanitized = sanitize_filename("Aula: 1/2 <final>? \"revisão\" | teste*");
        for forbidden in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            assert!(!sanitized.contains(forbidden), "{sanitized:?} ainda contém {forbidden:?}");
        }
    }

    #[test]
    fn sanitize_filename_guards_a_reserved_device_name() {
        assert_ne!(sanitize_filename("CON"), "CON");
        assert_ne!(sanitize_filename("con"), "con");
        assert_eq!(sanitize_filename("Constituição"), "Constituição");
    }

    #[test]
    fn sanitize_filename_trims_trailing_dots_and_spaces() {
        assert_eq!(sanitize_filename("Relatório.  "), "Relatório");
    }

    #[test]
    fn sanitize_filename_falls_back_when_nothing_survives_sanitization() {
        assert_eq!(sanitize_filename("   "), "pagina-sem-titulo");
        assert_eq!(sanitize_filename("///"), "pagina-sem-titulo");
    }

    #[test]
    fn sanitize_filename_truncates_a_very_long_title_without_panicking_on_a_multibyte_boundary() {
        // Repeated 3-byte characters positioned so a naive byte-index
        // truncation would land mid-character right at the cutoff.
        let long_title: String = "度".repeat(200);
        let sanitized = sanitize_filename(&long_title);

        assert!(sanitized.len() <= MAX_FILENAME_LENGTH);
        assert!(long_title.starts_with(&sanitized));
    }

    #[test]
    fn default_export_file_name_appends_the_md_extension() {
        assert_eq!(default_export_file_name("Aula 1"), "Aula 1.md");
    }

    #[test]
    fn build_block_tree_nests_children_under_their_parent_and_keeps_sibling_order() {
        // Order here matches what `fetch_page_blocks`'s `ORDER BY position`
        // would hand back — `build_block_tree` trusts that order rather than
        // re-sorting, per its doc comment.
        let parent = Uuid::now_v7();
        let child_a = Uuid::now_v7();
        let child_b = Uuid::now_v7();
        let rows = vec![
            block(parent, None, "paragraph", json!({}), "pai", "10"),
            block(child_a, Some(parent), "paragraph", json!({}), "filho a", "10"),
            block(child_b, Some(parent), "paragraph", json!({}), "filho b", "20"),
        ];

        let tree = build_block_tree(&rows);

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[0].children[0].text, "filho a");
        assert_eq!(tree[0].children[1].text, "filho b");
    }

    #[test]
    fn an_empty_page_exports_to_just_its_title() {
        let markdown = export_page_to_markdown("Página Vazia", &[]);
        assert_eq!(markdown, "# Página Vazia\n\n");
    }
}
