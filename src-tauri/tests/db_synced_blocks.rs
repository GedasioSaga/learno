#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for EDT-073..078 (synced blocks). Cada teste provisiona
//! seu próprio arquivo SQLite descartável via `support::IsolatedDatabase` e
//! roda num `cargo test` limpo, sem preparação nenhuma — sem cluster, sem
//! variável de ambiente. Ver `docs/MIGRACAO-SQLITE.md` para o histórico da
//! migração que tornou isso possível.

mod support;

use learno_lib::db::{BlockPatchInput, BlockPlacementInput, BlockRepository, NewBlockInput, PageRepository};
use support::IsolatedDatabase;
use uuid::Uuid;

fn placement(page_id: Uuid) -> BlockPlacementInput {
    BlockPlacementInput { page_id, parent_block_id: None, after_block_id: None }
}

fn paragraph(page_id: Uuid, text: &str) -> NewBlockInput {
    NewBlockInput {
        id: None,
        block_type: "paragraph".into(),
        content: serde_json::json!({ "text": text }),
        plain_text: text.into(),
        placement: placement(page_id),
    }
}

fn text_patch(text: &str) -> BlockPatchInput {
    BlockPatchInput {
        content: Some(serde_json::json!({ "text": text })),
        plain_text: Some(text.into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn editing_a_copy_propagates_to_the_original_and_every_other_copy() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let page_c = pages.create(None, "C").await.unwrap();

    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    let copy_b = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();
    let _copy_c = blocks.create_synced_copy(original.id, placement(page_c.id)).await.unwrap();

    // EDT-074: editing one copy updates the original and the other copy.
    blocks.update(copy_b.id, text_patch("editado em B")).await.unwrap();

    let refreshed_original = blocks.list_page_blocks(page_a.id).await.unwrap();
    let refreshed_c = blocks.list_page_blocks(page_c.id).await.unwrap();
    assert_eq!(refreshed_original[0].plain_text, "editado em B");
    assert_eq!(refreshed_c[0].plain_text, "editado em B");

    // And editing the original itself propagates back out to every copy.
    blocks.update(original.id, text_patch("editado no original")).await.unwrap();
    let refreshed_b = blocks.list_page_blocks(page_b.id).await.unwrap();
    let refreshed_c_again = blocks.list_page_blocks(page_c.id).await.unwrap();
    assert_eq!(refreshed_b[0].plain_text, "editado no original");
    assert_eq!(refreshed_c_again[0].plain_text, "editado no original");

    assert_eq!(blocks.count_synced_copies(original.id).await.unwrap(), 2);

    db.teardown().await;
}

#[tokio::test]
async fn moving_a_copy_never_touches_the_others_placement() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();

    let original = blocks.create(paragraph(page_a.id, "texto")).await.unwrap();
    let copy = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();
    let sibling = blocks.create(paragraph(page_a.id, "outro bloco em A")).await.unwrap();

    // Moving the copy elsewhere on its own page must not move the original.
    blocks
        .move_block(copy.id, BlockPlacementInput { page_id: page_b.id, parent_block_id: None, after_block_id: None })
        .await
        .unwrap();

    let a_tree = blocks.list_page_blocks(page_a.id).await.unwrap();
    let ids: Vec<Uuid> = a_tree.iter().map(|b| b.id).collect();
    assert!(ids.contains(&original.id));
    assert!(ids.contains(&sibling.id));

    db.teardown().await;
}

#[tokio::test]
async fn unsyncing_one_copy_detaches_only_that_copy() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let page_c = pages.create(None, "C").await.unwrap();

    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    let copy_b = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();
    let _copy_c = blocks.create_synced_copy(original.id, placement(page_c.id)).await.unwrap();

    let unsynced = blocks.unsync_one(copy_b.id).await.unwrap();
    assert_eq!(unsynced.synced_source_id, None);
    assert_eq!(blocks.count_synced_copies(original.id).await.unwrap(), 1);

    // Editing the (still synced) original must no longer reach the
    // unsynced copy, but must still reach the remaining one.
    blocks.update(original.id, text_patch("depois do unsync")).await.unwrap();

    let b_tree = blocks.list_page_blocks(page_b.id).await.unwrap();
    let c_tree = blocks.list_page_blocks(page_c.id).await.unwrap();
    assert_eq!(b_tree[0].plain_text, "original");
    assert_eq!(c_tree[0].plain_text, "depois do unsync");

    db.teardown().await;
}

#[tokio::test]
async fn unsync_one_rejects_a_block_that_is_not_a_copy() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Página").await.unwrap();
    let plain = blocks.create(paragraph(page.id, "sem sincronia")).await.unwrap();

    assert!(blocks.unsync_one(plain.id).await.is_err());

    db.teardown().await;
}

#[tokio::test]
async fn unsync_all_detaches_every_copy_at_once() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let page_c = pages.create(None, "C").await.unwrap();

    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();
    blocks.create_synced_copy(original.id, placement(page_c.id)).await.unwrap();

    let detached = blocks.unsync_all(original.id).await.unwrap();
    assert_eq!(detached.len(), 2);
    assert_eq!(blocks.count_synced_copies(original.id).await.unwrap(), 0);

    // Editing the (now solitary) original reaches nobody else.
    blocks.update(original.id, text_patch("independente agora")).await.unwrap();
    let b_tree = blocks.list_page_blocks(page_b.id).await.unwrap();
    assert_eq!(b_tree[0].plain_text, "original");

    db.teardown().await;
}

#[tokio::test]
async fn unsync_all_rejects_a_copy_passed_in_place_of_the_original() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    let copy = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();

    assert!(blocks.unsync_all(copy.id).await.is_err());

    db.teardown().await;
}

#[tokio::test]
async fn deleting_a_synced_original_through_the_generic_path_is_rejected() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();

    let result = blocks.delete_blocks(&[original.id]).await;
    assert!(result.is_err());

    // Nothing was deleted by the rejected attempt.
    let tree = blocks.list_page_blocks(page_a.id).await.unwrap();
    assert!(!tree.is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn delete_synced_original_with_few_copies_cascades_without_confirmation() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    let copy = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();

    blocks.delete_synced_original(original.id, false).await.unwrap();

    assert!(blocks.list_page_blocks(page_a.id).await.unwrap().is_empty());
    assert!(blocks.list_page_blocks(page_b.id).await.unwrap().is_empty());
    let _ = copy;

    db.teardown().await;
}

#[tokio::test]
async fn delete_synced_original_with_many_copies_requires_confirmation() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let origin_page = pages.create(None, "Origem").await.unwrap();
    let original = blocks.create(paragraph(origin_page.id, "original")).await.unwrap();

    // 11 copies — the checklist's own example (EDT-078: ">10 cópias").
    for i in 0..11 {
        let page = pages.create(None, &format!("Cópia {i}")).await.unwrap();
        blocks.create_synced_copy(original.id, placement(page.id)).await.unwrap();
    }

    let refused = blocks.delete_synced_original(original.id, false).await;
    assert!(refused.is_err());
    assert_eq!(blocks.count_synced_copies(original.id).await.unwrap(), 11);

    blocks.delete_synced_original(original.id, true).await.unwrap();
    assert!(blocks.list_page_blocks(origin_page.id).await.unwrap().is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn delete_synced_original_rejects_a_copy_passed_in_its_place() {
    let db = IsolatedDatabase::setup("synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let original = blocks.create(paragraph(page_a.id, "original")).await.unwrap();
    let copy = blocks.create_synced_copy(original.id, placement(page_b.id)).await.unwrap();

    assert!(blocks.delete_synced_original(copy.id, true).await.is_err());

    db.teardown().await;
}
