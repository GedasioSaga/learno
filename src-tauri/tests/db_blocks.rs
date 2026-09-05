#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::blocks` against a real Postgres instance.
//!
//! `#[ignore]`d like every other `db_*.rs` file here: needs a live cluster
//! (`scripts/dev-db.ps1 start`), then `cargo test -- --ignored` with
//! `LEARNO_TEST_DATABASE_URL` set. Each test provisions its own database via
//! `support::IsolatedDatabase`. The pure decision logic (`neighbours_for`,
//! `position_between`) is covered without a database by the `#[cfg(test)]`
//! module next to it in `src/db/blocks.rs`.

mod support;

use learno_lib::db::{
    BlockChangeInput, BlockPatchInput, BlockPlacementInput, BlockRepository, NewBlockInput, PageRepository,
};
use support::IsolatedDatabase;
use uuid::Uuid;

fn placement(page_id: Uuid, parent_block_id: Option<Uuid>, after_block_id: Option<Uuid>) -> BlockPlacementInput {
    BlockPlacementInput {
        page_id,
        parent_block_id,
        after_block_id,
    }
}

fn new_paragraph(page_id: Uuid, parent_block_id: Option<Uuid>, after_block_id: Option<Uuid>, text: &str) -> NewBlockInput {
    NewBlockInput {
        id: None,
        block_type: "paragraph".into(),
        content: serde_json::json!({ "text": text }),
        plain_text: text.into(),
        placement: placement(page_id, parent_block_id, after_block_id),
    }
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn deep_chain_of_blocks_lists_in_document_order() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Página profunda").await.unwrap();

    // A chain 15 deep: each block nested inside the previous one.
    let mut parent: Option<Uuid> = None;
    let mut expected_order = Vec::new();
    for depth in 0..15 {
        let block = blocks
            .create(new_paragraph(page.id, parent, None, &format!("nível {depth}")))
            .await
            .unwrap();
        expected_order.push(block.id);
        parent = Some(block.id);
    }

    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let ids: Vec<Uuid> = tree.iter().map(|b| b.id).collect();
    assert_eq!(ids, expected_order);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn sibling_order_is_respected_within_the_same_parent() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Irmãos").await.unwrap();
    let first = blocks.create(new_paragraph(page.id, None, None, "primeiro")).await.unwrap();
    let second = blocks
        .create(new_paragraph(page.id, None, Some(first.id), "segundo"))
        .await
        .unwrap();
    let inserted_between = blocks
        .create(new_paragraph(page.id, None, Some(first.id), "entre os dois"))
        .await
        .unwrap();

    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let ids: Vec<Uuid> = tree.iter().map(|b| b.id).collect();
    assert_eq!(ids, vec![first.id, inserted_between.id, second.id]);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn moving_a_block_into_its_own_descendant_is_rejected() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Ciclo").await.unwrap();
    let parent = blocks.create(new_paragraph(page.id, None, None, "pai")).await.unwrap();
    let child = blocks
        .create(new_paragraph(page.id, Some(parent.id), None, "filho"))
        .await
        .unwrap();
    let grandchild = blocks
        .create(new_paragraph(page.id, Some(child.id), None, "neto"))
        .await
        .unwrap();

    let result = blocks.move_block(parent.id, placement(page.id, Some(grandchild.id), None)).await;
    assert!(result.is_err());

    let result_into_direct_child = blocks.move_block(parent.id, placement(page.id, Some(child.id), None)).await;
    assert!(result_into_direct_child.is_err());

    // The rejected moves must not have changed anything.
    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let parent_row = tree.iter().find(|b| b.id == parent.id).unwrap();
    assert_eq!(parent_row.parent_block_id, None);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn moving_a_block_across_pages_cascades_page_id_to_descendants() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let source_page = pages.create(None, "Origem").await.unwrap();
    let target_page = pages.create(None, "Destino").await.unwrap();

    let parent = blocks
        .create(new_paragraph(source_page.id, None, None, "pai"))
        .await
        .unwrap();
    let child = blocks
        .create(new_paragraph(source_page.id, Some(parent.id), None, "filho"))
        .await
        .unwrap();

    blocks.move_block(parent.id, placement(target_page.id, None, None)).await.unwrap();

    let moved_tree = blocks.list_page_blocks(target_page.id).await.unwrap();
    let ids: Vec<Uuid> = moved_tree.iter().map(|b| b.id).collect();
    assert!(ids.contains(&parent.id));
    assert!(ids.contains(&child.id));

    let child_row = moved_tree.iter().find(|b| b.id == child.id).unwrap();
    assert_eq!(child_row.page_id, target_page.id);

    let source_tree = blocks.list_page_blocks(source_page.id).await.unwrap();
    assert!(source_tree.is_empty());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn deleting_a_block_with_children_hides_the_whole_subtree() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Com filhos").await.unwrap();
    let parent = blocks.create(new_paragraph(page.id, None, None, "pai")).await.unwrap();
    let child = blocks
        .create(new_paragraph(page.id, Some(parent.id), None, "filho"))
        .await
        .unwrap();
    let grandchild = blocks
        .create(new_paragraph(page.id, Some(child.id), None, "neto"))
        .await
        .unwrap();
    let untouched_sibling = blocks
        .create(new_paragraph(page.id, None, Some(parent.id), "irmão intacto"))
        .await
        .unwrap();

    blocks.delete_blocks(&[parent.id]).await.unwrap();

    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let ids: Vec<Uuid> = tree.iter().map(|b| b.id).collect();
    assert!(!ids.contains(&parent.id));
    assert!(!ids.contains(&child.id));
    assert!(!ids.contains(&grandchild.id));
    assert_eq!(ids, vec![untouched_sibling.id]);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn a_batch_with_a_conflicting_change_fails_atomically() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Lote com conflito").await.unwrap();
    let survivor = blocks.create(new_paragraph(page.id, None, None, "sobrevive")).await.unwrap();
    let conflicted = blocks.create(new_paragraph(page.id, None, None, "conflito")).await.unwrap();

    // Deletes `conflicted` then, in the same batch, tries to update it —
    // the update must find nothing active and fail the whole transaction.
    let batch = vec![
        BlockChangeInput::Update {
            id: survivor.id,
            patch: BlockPatchInput {
                plain_text: Some("sobrevive editado".into()),
                ..Default::default()
            },
        },
        BlockChangeInput::Delete { id: conflicted.id },
        BlockChangeInput::Update {
            id: conflicted.id,
            patch: BlockPatchInput {
                plain_text: Some("não deveria aplicar".into()),
                ..Default::default()
            },
        },
    ];

    let result = blocks.apply_changes(batch).await;
    assert!(result.is_err());

    // Nothing from the failed batch landed — not even the first, otherwise
    // valid change.
    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let survivor_row = tree.iter().find(|b| b.id == survivor.id).unwrap();
    assert_eq!(survivor_row.plain_text, "sobrevive");
    assert!(tree.iter().any(|b| b.id == conflicted.id));

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn a_valid_batch_applies_create_update_delete_and_move_together() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Lote válido").await.unwrap();
    let to_update = blocks.create(new_paragraph(page.id, None, None, "original")).await.unwrap();
    let to_delete = blocks
        .create(new_paragraph(page.id, None, Some(to_update.id), "vai sumir"))
        .await
        .unwrap();
    let to_move = blocks
        .create(new_paragraph(page.id, None, Some(to_delete.id), "vai mover"))
        .await
        .unwrap();

    let batch = vec![
        BlockChangeInput::Create { block: new_paragraph(page.id, None, Some(to_move.id), "novo") },
        BlockChangeInput::Update {
            id: to_update.id,
            patch: BlockPatchInput { plain_text: Some("atualizado".into()), ..Default::default() },
        },
        BlockChangeInput::Delete { id: to_delete.id },
        BlockChangeInput::Move {
            id: to_move.id,
            placement: placement(page.id, None, None),
        },
    ];

    let results = blocks.apply_changes(batch).await.unwrap();
    // One row per non-delete change: create, update, move.
    assert_eq!(results.len(), 3);

    let tree = blocks.list_page_blocks(page.id).await.unwrap();
    let ids: Vec<Uuid> = tree.iter().map(|b| b.id).collect();
    assert!(!ids.contains(&to_delete.id));
    assert!(ids.contains(&to_move.id));

    let updated_row = tree.iter().find(|b| b.id == to_update.id).unwrap();
    assert_eq!(updated_row.plain_text, "atualizado");

    let moved_row = tree.iter().find(|b| b.id == to_move.id).unwrap();
    assert_eq!(moved_row.parent_block_id, None);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn create_block_rejects_a_parent_from_a_different_page() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page_a = pages.create(None, "A").await.unwrap();
    let page_b = pages.create(None, "B").await.unwrap();
    let parent_on_a = blocks.create(new_paragraph(page_a.id, None, None, "pai em A")).await.unwrap();

    let result = blocks
        .create(new_paragraph(page_b.id, Some(parent_on_a.id), None, "filho errado"))
        .await;

    assert!(result.is_err());

    db.teardown().await;
}

/// O id do cliente é o id gravado. É o que faz o autosave do editor
/// funcionar: o nó ProseMirror ganha id no instante em que é digitado e toda
/// edição seguinte se refere ao bloco por ele — se o backend gerasse o seu,
/// o segundo `apply_block_changes` mandaria UPDATE de uma linha inexistente.
/// Ver `NewBlockInput::id` e `src/features/editor/core/use-blocks-document.test.tsx`.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn create_honours_the_id_the_client_already_assigned() {
    let db = IsolatedDatabase::setup("blocks").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());

    let page = pages.create(None, "Página com id do cliente").await.unwrap();
    let client_id = Uuid::now_v7();

    let created = blocks
        .create(NewBlockInput {
            id: Some(client_id),
            block_type: "paragraph".into(),
            content: serde_json::json!({ "text": "primeira linha" }),
            plain_text: "primeira linha".into(),
            placement: placement(page.id, None, None),
        })
        .await
        .unwrap();

    assert_eq!(created.id, client_id);

    // E o ciclo completo do autosave: o UPDATE seguinte, endereçado pelo
    // mesmo id do cliente, encontra a linha.
    let updated = blocks
        .apply_changes(vec![BlockChangeInput::Update {
            id: client_id,
            patch: BlockPatchInput {
                block_type: None,
                content: Some(serde_json::json!({ "text": "primeira e segunda" })),
                plain_text: Some("primeira e segunda".into()),
            },
        }])
        .await
        .unwrap();

    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].id, client_id);
    assert_eq!(updated[0].plain_text, "primeira e segunda");
}
