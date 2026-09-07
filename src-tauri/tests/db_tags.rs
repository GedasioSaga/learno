#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for the `#tag` backend (`db::tags`) — extraction alone
//! is covered by unit tests inside `db/tags.rs`; this file exercises the
//! whole path through real writes and reads: `BlockRepository` writing
//! `blocks`, `db::tags::sync_block_tags` keeping `tags`/`block_tags` in
//! step, and `TagRepository` reading them back.
//!
//! Sem `#[ignore]` — cada teste abre seu próprio banco descartável via
//! `support::IsolatedDatabase`, como todo `db_*.rs` deste crate desde a
//! migração para SQLite.

mod support;

use learno_lib::db::{
    BlockPatchInput, BlockPlacementInput, BlockRepository, NewBlockInput, PageRepository, TagRepository,
};
use support::IsolatedDatabase;
use uuid::Uuid;

fn paragraph(page_id: Uuid, text: &str) -> NewBlockInput {
    NewBlockInput {
        id: None,
        block_type: "paragraph".into(),
        content: serde_json::json!({ "inline": [{ "type": "text", "text": text }] }),
        plain_text: text.into(),
        placement: BlockPlacementInput { page_id, parent_block_id: None, after_block_id: None },
    }
}

fn code_block(page_id: Uuid, text: &str) -> NewBlockInput {
    NewBlockInput { block_type: "code".into(), ..paragraph(page_id, text) }
}

#[tokio::test]
async fn a_tag_written_in_a_block_makes_its_page_show_up_under_that_tag() {
    let db = IsolatedDatabase::setup("tags-basic").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Aula 4").await.unwrap();
    blocks.create(paragraph(page.id, "hoje estudei #biologia")).await.unwrap();

    let pages_for_tag = tags.list_pages_for_tag("biologia").await.unwrap();
    assert_eq!(pages_for_tag.len(), 1);
    assert_eq!(pages_for_tag[0].id, page.id);

    let all = tags.list_all_tags().await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "biologia");
    assert_eq!(all[0].page_count, 1);

    db.teardown().await;
}

#[tokio::test]
async fn listing_a_parent_tag_reaches_pages_that_only_wrote_the_nested_child() {
    let db = IsolatedDatabase::setup("tags-nested").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    // This page never writes plain `#materia` — only the nested form.
    let page = pages.create(None, "Aula de Biologia").await.unwrap();
    blocks.create(paragraph(page.id, "#materia/biologia hoje")).await.unwrap();

    let reached = tags.list_pages_for_tag("materia").await.unwrap();
    assert_eq!(reached.len(), 1, "listar a tag pai precisa alcançar a página que só tem a tag aninhada");
    assert_eq!(reached[0].id, page.id);

    // The exact nested name still finds it too.
    let reached_exact = tags.list_pages_for_tag("materia/biologia").await.unwrap();
    assert_eq!(reached_exact.len(), 1);

    // A sibling nested tag under the same parent is NOT reached by the
    // exact child query, only by the parent one.
    let unrelated = pages.create(None, "Aula de Química").await.unwrap();
    blocks.create(paragraph(unrelated.id, "#materia/quimica hoje")).await.unwrap();

    assert_eq!(tags.list_pages_for_tag("materia/biologia").await.unwrap().len(), 1);
    assert_eq!(tags.list_pages_for_tag("materia").await.unwrap().len(), 2);

    db.teardown().await;
}

#[tokio::test]
async fn biologia_and_capitalized_biologia_are_the_same_tag_end_to_end() {
    let db = IsolatedDatabase::setup("tags-case").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let a = pages.create(None, "Página A").await.unwrap();
    let b = pages.create(None, "Página B").await.unwrap();
    blocks.create(paragraph(a.id, "#Biologia")).await.unwrap();
    blocks.create(paragraph(b.id, "#biologia")).await.unwrap();

    let all = tags.list_all_tags().await.unwrap();
    assert_eq!(all.len(), 1, "Biologia e biologia precisam colapsar numa tag só");
    assert_eq!(all[0].page_count, 2);

    // Querying with either casing finds both pages.
    assert_eq!(tags.list_pages_for_tag("Biologia").await.unwrap().len(), 2);
    assert_eq!(tags.list_pages_for_tag("biologia").await.unwrap().len(), 2);

    db.teardown().await;
}

#[tokio::test]
async fn the_same_tag_in_two_blocks_of_one_page_counts_that_page_once() {
    let db = IsolatedDatabase::setup("tags-dedupe-page").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Notas").await.unwrap();
    blocks.create(paragraph(page.id, "primeiro #revisar")).await.unwrap();
    blocks.create(paragraph(page.id, "segundo #revisar também")).await.unwrap();

    let all = tags.list_all_tags().await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].page_count, 1, "a mesma página com a tag em dois blocos conta uma vez só");

    db.teardown().await;
}

#[tokio::test]
async fn a_code_block_never_contributes_a_tag() {
    let db = IsolatedDatabase::setup("tags-code-block").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Snippet").await.unwrap();
    blocks.create(code_block(page.id, "# #biologia is a python comment")).await.unwrap();

    assert!(tags.list_all_tags().await.unwrap().is_empty());
    assert!(tags.list_pages_for_tag("biologia").await.unwrap().is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn editing_the_tag_text_out_of_a_block_removes_the_page_from_that_tag() {
    let db = IsolatedDatabase::setup("tags-edit-out").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Aula 4").await.unwrap();
    let block = blocks.create(paragraph(page.id, "hoje estudei #biologia")).await.unwrap();

    assert_eq!(tags.list_pages_for_tag("biologia").await.unwrap().len(), 1);

    blocks
        .update(
            block.id,
            BlockPatchInput {
                content: Some(serde_json::json!({ "inline": [{ "type": "text", "text": "hoje estudei" }] })),
                plain_text: Some("hoje estudei".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert!(tags.list_pages_for_tag("biologia").await.unwrap().is_empty());
    assert!(tags.list_all_tags().await.unwrap().is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn deleting_the_tagged_block_removes_the_page_from_that_tag() {
    let db = IsolatedDatabase::setup("tags-delete-block").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Aula 4").await.unwrap();
    let block = blocks.create(paragraph(page.id, "#biologia")).await.unwrap();

    blocks.delete_blocks(&[block.id]).await.unwrap();

    assert!(tags.list_pages_for_tag("biologia").await.unwrap().is_empty());

    db.teardown().await;
}

#[tokio::test]
async fn a_tagged_block_moved_to_another_page_moves_its_tag_with_it() {
    let db = IsolatedDatabase::setup("tags-move").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let origin = pages.create(None, "Origem").await.unwrap();
    let destination = pages.create(None, "Destino").await.unwrap();
    let block = blocks.create(paragraph(origin.id, "#mudou")).await.unwrap();

    assert_eq!(tags.list_pages_for_tag("mudou").await.unwrap()[0].id, origin.id);

    blocks
        .move_block(block.id, BlockPlacementInput { page_id: destination.id, parent_block_id: None, after_block_id: None })
        .await
        .unwrap();

    let after = tags.list_pages_for_tag("mudou").await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, destination.id, "a tag precisa acompanhar o bloco para a nova página, não ficar na antiga");

    db.teardown().await;
}

#[tokio::test]
async fn duplicating_a_page_carries_its_tags_to_the_copy() {
    let db = IsolatedDatabase::setup("tags-duplicate").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let original = pages.create(None, "Original").await.unwrap();
    blocks.create(paragraph(original.id, "#duplicavel")).await.unwrap();

    let copy = pages.duplicate(original.id).await.unwrap();

    let pages_for_tag = tags.list_pages_for_tag("duplicavel").await.unwrap();
    let ids: std::collections::HashSet<Uuid> = pages_for_tag.iter().map(|r| r.id).collect();
    assert_eq!(pages_for_tag.len(), 2, "o original e a cópia duplicada precisam ter a tag");
    assert!(ids.contains(&original.id));
    assert!(ids.contains(&copy.id));

    db.teardown().await;
}

#[tokio::test]
async fn a_synced_copy_gets_its_own_tag_rows_from_the_shared_content() {
    let db = IsolatedDatabase::setup("tags-synced").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let original_page = pages.create(None, "Original").await.unwrap();
    let other_page = pages.create(None, "Outra página").await.unwrap();
    let original = blocks.create(paragraph(original_page.id, "#compartilhado")).await.unwrap();

    blocks
        .create_synced_copy(
            original.id,
            BlockPlacementInput { page_id: other_page.id, parent_block_id: None, after_block_id: None },
        )
        .await
        .unwrap();

    let pages_for_tag = tags.list_pages_for_tag("compartilhado").await.unwrap();
    let ids: std::collections::HashSet<Uuid> = pages_for_tag.iter().map(|r| r.id).collect();
    assert_eq!(pages_for_tag.len(), 2);
    assert!(ids.contains(&original_page.id));
    assert!(ids.contains(&other_page.id));

    // Editing through the original propagates the new tag to the copy's
    // page too (EDT-074's "editing any instance updates them all").
    blocks
        .update(
            original.id,
            BlockPatchInput {
                content: Some(serde_json::json!({ "inline": [{ "type": "text", "text": "#compartilhado #novo" }] })),
                plain_text: Some("#compartilhado #novo".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let pages_for_new_tag = tags.list_pages_for_tag("novo").await.unwrap();
    let new_ids: std::collections::HashSet<Uuid> = pages_for_new_tag.iter().map(|r| r.id).collect();
    assert_eq!(pages_for_new_tag.len(), 2, "a edição no original precisa refletir a tag nova na página da cópia também");
    assert!(new_ids.contains(&original_page.id));
    assert!(new_ids.contains(&other_page.id));

    db.teardown().await;
}

#[tokio::test]
async fn a_trashed_page_drops_out_of_its_tags() {
    let db = IsolatedDatabase::setup("tags-trash").await;
    let pages = PageRepository::new(db.pool.clone());
    let blocks = BlockRepository::new(db.pool.clone());
    let tags = TagRepository::new(db.pool.clone());

    let page = pages.create(None, "Vai pra lixeira").await.unwrap();
    blocks.create(paragraph(page.id, "#temporario")).await.unwrap();
    assert_eq!(tags.list_pages_for_tag("temporario").await.unwrap().len(), 1);

    pages.trash(page.id).await.unwrap();

    assert!(tags.list_pages_for_tag("temporario").await.unwrap().is_empty());
    assert!(tags.list_all_tags().await.unwrap().is_empty());

    db.teardown().await;
}

/// The migration test the brief asks for explicitly: the newest migration
/// (which, once this feature lands, is `0041_tags.sql`) needs to run clean
/// not only against an empty database (every other test above already
/// proves that — `IsolatedDatabase::setup` runs the FULL migration set
/// against a fresh file) but against one that already has real `pages` and
/// `blocks` rows written under the schema from every migration BEFORE it.
///
/// Simulates exactly that upgrade: applies every embedded migration except
/// the last one directly (`sqlx::raw_sql`, which — unlike a plain
/// multi-statement `sqlx::query` — is built to run a whole migration file's
/// worth of statements, `CREATE TRIGGER ... BEGIN ... END;` bodies
/// included, in one call), writes a page and a block through that
/// pre-tags schema, then applies the last migration on top and checks that
/// existing data survived and the new tables are immediately usable.
///
/// Deliberately does not hardcode which migration is "the tags one" by
/// name or number — "the newest migration must not break a database that
/// already has pages and blocks" is a standing property, not a one-off fact
/// about `0041`, and cargo-migrate the next feature area drops in this
/// slot without this test needing an update.
#[tokio::test]
async fn the_newest_migration_runs_clean_on_a_database_that_already_has_pages_and_blocks() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    static ALL_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!();

    let path = std::env::temp_dir().join(format!("learno-tags-migration-{}.sqlite", Uuid::new_v4().simple()));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true).foreign_keys(true))
        .await
        .unwrap();

    let all: Vec<_> = ALL_MIGRATIONS.iter().collect();
    let (last, earlier) = all.split_last().expect("esperava pelo menos uma migração embutida");

    for migration in earlier {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }

    let page_id = "77777777-7777-7777-7777-777777777777";
    let block_id = "88888888-8888-8888-8888-888888888888";
    let now = "2026-09-07T10:00:00.000Z";
    sqlx::query("INSERT INTO pages (id, title, position, created_at, updated_at) VALUES (?, 'Pré-existente', 'a0', ?, ?)")
        .bind(page_id)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, plain_text, position, created_at, updated_at) \
         VALUES (?, ?, NULL, 'paragraph', '{}', 'texto sem tag', 'a0', ?, ?)",
    )
    .bind(block_id)
    .bind(page_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // The migration under test, on top of a database that already has the
    // rows above.
    sqlx::raw_sql(&last.sql).execute(&pool).await.unwrap();

    let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = ?").bind(page_id).fetch_one(&pool).await.unwrap();
    assert_eq!(title, "Pré-existente", "dado que já existia antes da migração precisa sobreviver intacto");

    let block_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?").bind(block_id).fetch_one(&pool).await.unwrap();
    assert_eq!(block_count, 1);

    // The new tables are immediately usable.
    let tag_id = Uuid::new_v4().hyphenated().to_string();
    sqlx::query("INSERT INTO tags (id, name) VALUES (?, 'prova')").bind(&tag_id).execute(&pool).await.unwrap();
    let bt_id = Uuid::new_v4().hyphenated().to_string();
    sqlx::query("INSERT INTO block_tags (id, block_id, tag_id) VALUES (?, ?, ?)")
        .bind(&bt_id)
        .bind(block_id)
        .bind(&tag_id)
        .execute(&pool)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tags").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);

    pool.close().await;
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}
