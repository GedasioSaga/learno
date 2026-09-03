#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::pages` against a real Postgres instance.
//!
//! Every test here is `#[ignore]`: it needs a live Postgres cluster
//! listening, which `cargo test` never starts on its own. Run
//! `scripts/dev-db.ps1 start` (or `reset` for a clean one) first, then
//! `cargo test -- --ignored` with `LEARNO_TEST_DATABASE_URL` set — see
//! `docs/rust-tests.md`. Each test provisions its own private database via
//! `support::IsolatedDatabase` rather than sharing one, so the suite doesn't
//! depend on what earlier runs happened to leave behind. The pure decision
//! logic these repositories lean on (`neighbours_for`,
//! `resolve_restore_parent`, `duplicate_title`, and everything in
//! `db::position`) is covered without a database by the `#[cfg(test)]`
//! modules next to that code in `src/db/`.

mod support;

use learno_lib::db::{PageRepository, SiblingPosition};
use support::IsolatedDatabase;

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_001_arbitrary_depth_chain_keeps_correct_parent_ids() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let a = repo.create(None, "A").await.unwrap();
    let b = repo.create(Some(a.id), "B").await.unwrap();
    let c = repo.create(Some(b.id), "C").await.unwrap();

    assert_eq!(b.parent_id, Some(a.id));
    assert_eq!(c.parent_id, Some(b.id));

    let breadcrumb = repo.breadcrumb(c.id).await.unwrap();
    let titles: Vec<&str> = breadcrumb.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, vec!["A", "B", "C"]);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_004_reordering_two_siblings_swaps_their_displayed_order() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let aula1 = repo.create(None, "Aula 1").await.unwrap();
    let aula2 = repo.create(None, "Aula 2").await.unwrap();

    repo.move_page(aula2.id, None, SiblingPosition::Start).await.unwrap();

    let tree = repo.list_tree(None).await.unwrap();
    let ids: Vec<_> = tree
        .into_iter()
        .filter(|p| p.id == aula1.id || p.id == aula2.id)
        .map(|p| p.id)
        .collect();
    assert_eq!(ids, vec![aula2.id, aula1.id]);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_020_duplicate_copies_children_without_touching_the_original() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let module = repo.create(None, "Módulo 1").await.unwrap();
    repo.create(Some(module.id), "Aula A").await.unwrap();
    repo.create(Some(module.id), "Aula B").await.unwrap();

    let copy = repo.duplicate(module.id).await.unwrap();
    assert_eq!(copy.title, "Módulo 1 (cópia)");
    assert_ne!(copy.id, module.id);

    let original_children = repo.list_tree(Some(module.id)).await.unwrap();
    let copy_children = repo.list_tree(Some(copy.id)).await.unwrap();
    assert_eq!(original_children.len(), 2);
    assert_eq!(copy_children.len(), 2);

    let original_ids: std::collections::HashSet<_> = original_children.iter().map(|p| p.id).collect();
    let copy_ids: std::collections::HashSet<_> = copy_children.iter().map(|p| p.id).collect();
    assert!(original_ids.is_disjoint(&copy_ids));

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_027_trash_hides_a_page_from_the_active_tree_but_keeps_the_row() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Rascunho Antigo").await.unwrap();
    let trashed = repo.trash(page.id).await.unwrap();
    assert!(trashed.deleted_at.is_some());

    let tree = repo.list_tree(None).await.unwrap();
    assert!(!tree.iter().any(|p| p.id == page.id));

    let fetched = repo.get(page.id).await.unwrap();
    assert!(fetched.deleted_at.is_some());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_029_restore_returns_the_page_to_its_original_parent() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let parent = repo.create(None, "Projetos").await.unwrap();
    let child = repo.create(Some(parent.id), "Rascunho Antigo").await.unwrap();
    repo.trash(child.id).await.unwrap();

    let restored = repo.restore(child.id).await.unwrap();
    assert_eq!(restored.parent_id, Some(parent.id));
    assert!(restored.deleted_at.is_none());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_030_restore_falls_back_to_root_when_the_original_parent_is_gone() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let parent = repo.create(None, "Aula X pai").await.unwrap();
    let child = repo.create(Some(parent.id), "Aula X").await.unwrap();
    repo.trash(child.id).await.unwrap();
    repo.trash(parent.id).await.unwrap();
    repo.permanently_delete(parent.id).await.unwrap();

    let restored = repo.restore(child.id).await.unwrap();
    assert_eq!(restored.parent_id, None);

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn fun_031_permanently_deleting_a_trashed_page_removes_the_row() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Teste").await.unwrap();
    repo.trash(page.id).await.unwrap();
    repo.permanently_delete(page.id).await.unwrap();

    let result = repo.get(page.id).await;
    assert!(result.is_err());

    db.teardown().await;
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn permanently_deleting_an_active_page_is_rejected() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Ainda ativa").await.unwrap();
    let result = repo.permanently_delete(page.id).await;

    assert!(result.is_err());

    db.teardown().await;
}
