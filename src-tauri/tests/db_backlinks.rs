#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for FUN-044/045's backlink graph — the trigger in
//! `0016_block_page_links.sql`, exercised end to end through
//! `db::blocks::BlockRepository` (which never touches `block_page_links`
//! itself) and read back through `db::backlinks::BacklinkRepository`.
//!
//! Sem `#[ignore]`: desde a migração para SQLite (`docs/MIGRACAO-SQLITE.md`)
//! cada teste abre seu próprio arquivo de banco descartável via
//! `support::IsolatedDatabase`, então roda num `cargo test` limpo, sem
//! cluster nem variável de ambiente nenhuma.

mod support;

use learno_lib::db::{BacklinkRepository, BlockPlacementInput, BlockRepository, NewBlockInput, PageRepository};
use support::IsolatedDatabase;
use uuid::Uuid;

/// O `content` que o editor de verdade grava para um parágrafo com uma
/// @-menção dentro — não uma forma inventada aqui.
///
/// Isto importa mais do que parece: a versão anterior deste helper fabricava
/// `{ "type": "mention", "attrs": { "pageId": ... } }`, uma forma que o
/// cliente nunca produziu. Os testes deste arquivo passavam todos enquanto
/// FUN-044 estava quebrado de ponta a ponta em produção, porque o nó real
/// (`marks/mention-page`) só carregava `attrs.id` e o gatilho procura
/// `pageId`. Teste que escolhe a própria entrada não prova integração
/// nenhuma. A forma abaixo copia, campo por campo, o que
/// `core/serialize.ts`'s `docToFlatBlocks` produz — `{ inline: [...] }`,
/// nó `"mentionPage"`, os quatro attrs que o schema declara — e está
/// travada do outro lado por `mention-page.test.ts` ("o chip inserido
/// carrega pageId igual ao id"), que parte de uma digitação real de "@".
fn mention_content(target_page_id: Uuid, label: &str) -> serde_json::Value {
    serde_json::json!({
        "inline": [
            { "type": "text", "text": "veja " },
            {
                "type": "mentionPage",
                "attrs": {
                    "id": target_page_id.to_string(),
                    "pageId": target_page_id.to_string(),
                    "label": label,
                    "mentionSuggestionChar": "@"
                }
            }
        ]
    })
}

fn mention_block(page_id: Uuid, target_page_id: Uuid) -> NewBlockInput {
    NewBlockInput {
        id: None,
        block_type: "paragraph".into(),
        // A menção fica aninhada dentro de `content.inline`, não num campo de
        // topo — o que também prova que o `$.**.pageId` recursivo do gatilho
        // a alcança em profundidade.
        content: mention_content(target_page_id, "Glossário"),
        plain_text: "veja @Glossário".into(),
        placement: BlockPlacementInput { page_id, parent_block_id: None, after_block_id: None },
    }
}

/// Like [`mention_block`], but with a caller-chosen `plain_text` — for the
/// snippet tests below, which care about `BacklinkRow::source_snippet`
/// rather than the graph edge itself.
fn mention_block_with_text(page_id: Uuid, target_page_id: Uuid, plain_text: &str) -> NewBlockInput {
    NewBlockInput { plain_text: plain_text.into(), ..mention_block(page_id, target_page_id) }
}

#[tokio::test]
async fn two_pages_mentioning_the_same_target_both_show_up_as_backlinks() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let glossario = pages.create(None, "Glossário").await.unwrap();
    let aula4 = pages.create(None, "Aula 4").await.unwrap();
    let aula7 = pages.create(None, "Aula 7").await.unwrap();

    blocks.create(mention_block(aula4.id, glossario.id)).await.unwrap();
    blocks.create(mention_block(aula7.id, glossario.id)).await.unwrap();

    let result = backlinks.list_backlinks(glossario.id).await.unwrap();
    let source_pages: std::collections::HashSet<Uuid> = result.iter().map(|r| r.source_page_id).collect();

    assert_eq!(result.len(), 2);
    assert!(source_pages.contains(&aula4.id));
    assert!(source_pages.contains(&aula7.id));

    db.teardown().await;
}

#[tokio::test]
async fn renaming_the_mentioning_page_updates_the_backlink_title_live() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Dicionário").await.unwrap();
    let source = pages.create(None, "Glossário").await.unwrap();
    blocks.create(mention_block(source.id, target.id)).await.unwrap();

    // FUN-045: no block content is rewritten on rename — the title read back
    // must reflect the rename purely because `list_backlinks` joins live
    // against `pages.title`.
    pages.rename(source.id, "Termos").await.unwrap();

    let result = backlinks.list_backlinks(target.id).await.unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].source_page_title, "Termos");

    db.teardown().await;
}

#[tokio::test]
async fn editing_the_link_out_of_a_block_removes_the_backlink() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Alvo").await.unwrap();
    let source = pages.create(None, "Fonte").await.unwrap();
    let block = blocks.create(mention_block(source.id, target.id)).await.unwrap();

    assert_eq!(backlinks.list_backlinks(target.id).await.unwrap().len(), 1);

    blocks
        .update(
            block.id,
            learno_lib::db::BlockPatchInput {
                // Mesmo formato de `mention_content`, sem menção nenhuma
                // dentro — o que o editor grava quando o usuário apaga o chip.
                content: Some(serde_json::json!({ "inline": [] })),
                plain_text: Some(String::new()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(backlinks.list_backlinks(target.id).await.unwrap().len(), 0);

    db.teardown().await;
}

#[tokio::test]
async fn deleting_the_mentioning_block_removes_the_backlink() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Alvo").await.unwrap();
    let source = pages.create(None, "Fonte").await.unwrap();
    let block = blocks.create(mention_block(source.id, target.id)).await.unwrap();

    blocks.delete_blocks(&[block.id]).await.unwrap();

    assert_eq!(backlinks.list_backlinks(target.id).await.unwrap().len(), 0);

    db.teardown().await;
}

#[tokio::test]
async fn outgoing_links_answer_the_other_direction() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let source = pages.create(None, "Índice").await.unwrap();
    let target_a = pages.create(None, "Capítulo 1").await.unwrap();
    let target_b = pages.create(None, "Capítulo 2").await.unwrap();
    blocks.create(mention_block(source.id, target_a.id)).await.unwrap();
    blocks.create(mention_block(source.id, target_b.id)).await.unwrap();

    let outgoing = backlinks.list_outgoing_links(source.id).await.unwrap();
    let targets: std::collections::HashSet<Uuid> = outgoing.iter().map(|r| r.target_page_id).collect();

    assert_eq!(outgoing.len(), 2);
    assert!(targets.contains(&target_a.id));
    assert!(targets.contains(&target_b.id));

    db.teardown().await;
}

#[tokio::test]
async fn a_page_mentioning_itself_is_not_listed_as_its_own_backlink() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let page = pages.create(None, "Autorreferente").await.unwrap();
    blocks.create(mention_block(page.id, page.id)).await.unwrap();

    assert_eq!(backlinks.list_backlinks(page.id).await.unwrap().len(), 0);

    db.teardown().await;
}

#[tokio::test]
async fn backlink_row_carries_a_snippet_of_the_mentioning_block() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Glossário").await.unwrap();
    let source = pages.create(None, "Aula 4").await.unwrap();
    blocks
        .create(mention_block_with_text(source.id, target.id, "Ver o @Glossário para os termos usados nesta aula"))
        .await
        .unwrap();

    let result = backlinks.list_backlinks(target.id).await.unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].source_snippet, "Ver o @Glossário para os termos usados nesta aula");

    db.teardown().await;
}

#[tokio::test]
async fn a_long_block_is_cut_at_the_snippet_limit_on_a_word_boundary() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Alvo").await.unwrap();
    let source = pages.create(None, "Fonte").await.unwrap();
    // 17 repetitions of the 8-char unit "palavra " (7-letter word + space) is
    // 136 characters, past the 140-char `SNIPPET_MAX_CHARS` limit once the
    // "@menção" prefix from `mention_block_with_text`'s content is counted —
    // long enough to force a cut, short enough that the cut point (and the
    // word boundary just before it) can be worked out by hand instead of
    // reimplementing the truncation logic in the test itself.
    let long_text = "palavra ".repeat(30);
    blocks.create(mention_block_with_text(source.id, target.id, &long_text)).await.unwrap();

    let result = backlinks.list_backlinks(target.id).await.unwrap();
    assert_eq!(result.len(), 1);
    let snippet = &result[0].source_snippet;

    // Cut on a word boundary, never mid-word: what a naive `text[..140]` byte
    // slice would have produced ends inside a "palavra", so equality here
    // rules that implementation out.
    let expected = format!("{}palavra…", "palavra ".repeat(16));
    assert_eq!(snippet, &expected);
    assert!(snippet.chars().count() <= 141, "snippet must respect the 140-char limit plus the ellipsis");
    assert!(snippet.ends_with('…'));

    db.teardown().await;
}

#[tokio::test]
async fn accented_text_survives_the_cut_without_splitting_a_character() {
    let db = IsolatedDatabase::setup("backlinks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let backlinks = BacklinkRepository::new(db.pool.clone());

    let target = pages.create(None, "Alvo").await.unwrap();
    let source = pages.create(None, "Fonte").await.unwrap();
    // Every word here carries an accented character encoded as 2 UTF-8 bytes
    // ("çã", "é", "ã", "í"...), repeated well past the 140-char limit so the
    // cut necessarily lands inside this run — a byte-indexed slice (`&s[..140]`)
    // would panic here the moment it landed mid-codepoint; a char-indexed one
    // must not.
    let long_text = "informação política não é fácil de entender rapidamente ".repeat(4);
    blocks.create(mention_block_with_text(source.id, target.id, &long_text)).await.unwrap();

    let result = backlinks.list_backlinks(target.id).await.unwrap();
    assert_eq!(result.len(), 1);
    let snippet = &result[0].source_snippet;

    assert!(snippet.ends_with('…'));
    let char_count_without_ellipsis = snippet.chars().count() - 1;
    assert!(char_count_without_ellipsis <= 140);

    // The snippet body, character for character, must be an exact prefix of
    // the trimmed original — proving the cut preserved every accented
    // character whole instead of corrupting one at the boundary.
    let body: String = snippet.chars().take(char_count_without_ellipsis).collect();
    let expected_prefix: String = long_text.trim().chars().take(char_count_without_ellipsis).collect();
    assert_eq!(body, expected_prefix);
    // The prefix itself must still carry accented characters — otherwise the
    // equality above would trivially hold for an accent-free body too.
    assert!(expected_prefix.chars().any(|c| "çãéáíóõ".contains(c)));

    db.teardown().await;
}
