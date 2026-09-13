#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for the relation graph (arquitetura §5) —
//! `db::relations::RelationRepository`, exercised contra um banco SQLite
//! real. Nenhum teste aqui precisa de `#[ignore]`: cada um cria seu próprio
//! arquivo SQLite descartável via `support::IsolatedDatabase`, já migrado,
//! numa pasta temporária — então a suíte roda direto num `cargo test`
//! limpo, em qualquer máquina, sem cluster nenhum para subir antes. Isso
//! veio da migração para SQLite (`docs/MIGRACAO-SQLITE.md`); antes disso
//! era Postgres, com `LEARNO_TEST_DATABASE_URL` e `scripts/dev-db.ps1` como
//! pré-requisito.
//!
//! ## Divergência da arquitetura
//!
//! This piece (R2) is scoped to `src-tauri/src/db/relations/` and the
//! `0018` migration only — not `tests/`. This file exists anyway, for the
//! same reason other `tests/db_*.rs` files exist outside N2's nominal
//! scope: regra 6 of this session's own rules ("clippy não é teste —
//! execute antes de encerrar") is not satisfiable by writing code that
//! nothing runs, and this repository's own history
//! (`docs/ACHADOS-FASE-2.md`, FUN-044) is the concrete cost of skipping
//! that. No other piece owns a file named `db_relations.rs`.
//!
//! `db/mod.rs` already declares `pub mod relations;` and re-exports every
//! type this file needs (`CreateRelationInput`, `RelationRepository`,
//! `RelationTargetPage`, ...) — that wiring (arquitetura §11, N1's task) is
//! done, so this file compiles against the real `src/db/mod.rs` with no
//! disposable copy involved.
//!
//! No `database`/`database_properties` generic repository exists yet
//! either (a different Fase 3 piece owns it), so this file inserts
//! databases and plain (non-relation) records with plain SQL — exactly
//! `tests/db_timestamps.rs`'s own convention, reused so a third piece
//! reading both files sees one pattern, not two. IDs em SQL cru passam
//! pela ponte `DbId`/`IdBind` (`src/db/ids.rs`): a coluna `id` é TEXT em
//! tabela `STRICT`, e `sqlx-sqlite` codifica `Uuid` cru como BLOB — ligar
//! ou ler um `Uuid` direto contra essa coluna falha
//! (`cannot store BLOB value in TEXT column` na escrita,
//! `ParseByteLength { len: 36 }` na leitura).

mod support;

use std::collections::HashSet;

use learno_lib::db::{CreateRelationInput, IdBind, PageRepository, RelationRepository, RelationTargetPage};
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// O id vem do Rust, e não de um `DEFAULT gen_random_uuid()` na coluna: a
// migração para SQLite tirou o default de toda coluna de id (ver a tabela de
// equivalências em `docs/MIGRACAO-SQLITE.md`), alinhando o schema com a
// decisão que a Fase 2 já tinha tomado para blocos — quem cria a linha sabe o
// id dela antes de gravar.
async fn create_database(pool: &SqlitePool, container_page_id: Uuid, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, $3)")
        .bind(id.db())
        .bind(container_page_id.db())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_record(pool: &SqlitePool, database_id: Uuid, title: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, $3, $4)")
        .bind(id.db())
        .bind(database_id.db())
        .bind(title)
        .bind("a0")
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn relation_property_count(pool: &SqlitePool, relation_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM database_properties WHERE property_type = 'relation' AND config ->> 'relationId' = $1",
    )
    .bind(relation_id.to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn relation_row_exists(pool: &SqlitePool, relation_id: Uuid) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM database_relations WHERE id = $1)")
        .bind(relation_id.db())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn edge_count(pool: &SqlitePool, relation_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM database_relation_edges WHERE relation_id = $1")
        .bind(relation_id.db())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn property_config(pool: &SqlitePool, property_id: Uuid) -> JsonValue {
    sqlx::query_scalar("SELECT config FROM database_properties WHERE id = $1")
        .bind(property_id.db())
        .fetch_one(pool)
        .await
        .unwrap()
}

fn ids(page: &RelationTargetPage) -> Vec<Uuid> {
    page.items.iter().map(|row| row.record_id).collect()
}

/// A `(source database, target database)` pair sharing one container page
/// per database — what almost every test below needs before it can create
/// a relation.
struct TwoDatabases {
    pool: SqlitePool,
    source_db: Uuid,
    target_db: Uuid,
}

async fn setup_two_databases(db: &IsolatedDatabase, label: &str) -> TwoDatabases {
    let pages = PageRepository::new(db.pool.clone());
    let source_container = pages.create(None, &format!("{label} — origem")).await.unwrap();
    let target_container = pages.create(None, &format!("{label} — alvo")).await.unwrap();
    let source_db = create_database(&db.pool, source_container.id, "Tarefas").await;
    let target_db = create_database(&db.pool, target_container.id, "Projetos").await;
    TwoDatabases { pool: db.pool.clone(), source_db, target_db }
}

fn one_way_input(two: &TwoDatabases, name: &str) -> CreateRelationInput {
    CreateRelationInput {
        source_database_id: two.source_db,
        target_database_id: two.target_db,
        source_property_name: name.into(),
        is_symmetric: false,
        two_way: false,
        target_property_name: None,
        source_max_targets: None,
        target_max_sources: None,
    }
}

#[tokio::test]
async fn one_way_relation_only_creates_a_source_property() {
    let db = IsolatedDatabase::setup("relations_1way").await;
    let two = setup_two_databases(&db, "1way").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let b2 = create_record(&two.pool, two.target_db, "Projeto 2").await;

    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    assert!(created.target_property_id.is_none(), "one-way must not create a reciprocal property");
    assert_eq!(relation_property_count(&two.pool, created.relation.id).await, 1);

    let page = repo.set_relation_targets(a1, created.source_property_id, vec![b1, b2]).await.unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(ids(&page), vec![b1, b2]);

    let listed = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(listed.total, 2);
    assert_eq!(ids(&listed), vec![b1, b2]);

    db.teardown().await;
}

#[tokio::test]
async fn two_way_relation_is_readable_from_both_ends_and_toggling_off_keeps_the_edge() {
    let db = IsolatedDatabase::setup("relations_2way").await;
    let two = setup_two_databases(&db, "2way").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;

    let mut input = one_way_input(&two, "Projeto");
    input.two_way = true;
    input.target_property_name = Some("Tarefas".into());
    let created = repo.create_relation(input).await.unwrap();
    let target_property_id = created.target_property_id.expect("two_way=true must create the reciprocal side");

    repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();

    // DBS-087: the reciprocal side reads the SAME edge, independently
    // ordered, without the caller ever touching `database_relation_edges`.
    let reverse = repo.list_relation_targets(b1, target_property_id, 10, 0).await.unwrap();
    assert_eq!(ids(&reverse), vec![a1]);

    // Turning two-way off deletes only the reciprocal PROPERTY, never the
    // edge — arquitetura §5: "apagar UMA propriedade de mão dupla -> vira
    // mão única".
    let toggled_off = repo.set_relation_two_way(created.relation.id, false, None).await.unwrap();
    assert!(toggled_off.target_property_id.is_none());
    assert!(relation_row_exists(&two.pool, created.relation.id).await, "one property still references it");
    assert_eq!(edge_count(&two.pool, created.relation.id).await, 1, "the edge itself must survive the toggle");

    let forward_after_toggle = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(ids(&forward_after_toggle), vec![b1], "source side unaffected by the toggle");

    // Turning it back on re-creates a (new) reciprocal property that reads
    // the surviving edge straight away.
    let toggled_on = repo.set_relation_two_way(created.relation.id, true, Some("Tarefas de novo".into())).await.unwrap();
    let new_target_property_id = toggled_on.target_property_id.expect("show_on_target=true must create the property");
    let reverse_again = repo.list_relation_targets(b1, new_target_property_id, 10, 0).await.unwrap();
    assert_eq!(ids(&reverse_again), vec![a1]);

    db.teardown().await;
}

#[tokio::test]
async fn deleting_the_last_relation_property_deletes_the_relation_and_its_edges() {
    let db = IsolatedDatabase::setup("relations_cleanup").await;
    let two = setup_two_databases(&db, "cleanup").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();
    assert_eq!(edge_count(&two.pool, created.relation.id).await, 1);

    // A plain DELETE issued by code that has never heard of
    // `db::relations` — exactly the scenario the
    // `database_properties_cleanup_relation` trigger exists for (mod.rs's
    // doc comment). Not a call into `RelationRepository` on purpose.
    sqlx::query("DELETE FROM database_properties WHERE id = $1")
        .bind(created.source_property_id.db())
        .execute(&two.pool)
        .await
        .unwrap();

    assert!(!relation_row_exists(&two.pool, created.relation.id).await, "last property gone => relation gone");
    assert_eq!(edge_count(&two.pool, created.relation.id).await, 0, "and its edges with it");

    db.teardown().await;
}

#[tokio::test]
async fn symmetric_self_relation_shows_the_link_on_both_sides_regardless_of_uuid_order() {
    let db = IsolatedDatabase::setup("relations_symmetric").await;
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, "Pessoas").await.unwrap();
    let database_id = create_database(&db.pool, container.id, "Pessoas").await;
    let repo = RelationRepository::new(db.pool.clone());

    let p1 = create_record(&db.pool, database_id, "Ana").await;
    let p2 = create_record(&db.pool, database_id, "Bruno").await;
    let p3 = create_record(&db.pool, database_id, "Carla").await;

    let created = repo
        .create_relation(CreateRelationInput {
            source_database_id: database_id,
            target_database_id: database_id,
            source_property_name: "Amigos".into(),
            is_symmetric: true,
            two_way: false,
            target_property_name: None,
            source_max_targets: None,
            target_max_sources: None,
        })
        .await
        .unwrap();
    assert!(created.target_property_id.is_none(), "DBS-088: a single column serves both ends");
    let prop = created.source_property_id;

    // Uuid::now_v7() is time-ordered, so p1 < p2 < p3 by construction here —
    // linking p1 -> p2 stores p1 as canonical source, but linking p3 -> p1
    // stores p1 as canonical source AND p3 as target, exercising the
    // opposite branch of `normalize_pair` from the caller's point of view
    // (the "record_id" of the call ends up on the TARGET side of storage).
    // Both must read back identically on both ends — that agreement is the
    // whole point of this test, not just "linking works".
    repo.set_relation_targets(p1, prop, vec![p2]).await.unwrap();
    repo.add_relation_targets(p3, prop, vec![p1]).await.unwrap();

    assert_eq!(ids(&repo.list_relation_targets(p1, prop, 10, 0).await.unwrap()), vec![p2, p3]);
    assert_eq!(ids(&repo.list_relation_targets(p2, prop, 10, 0).await.unwrap()), vec![p1]);
    assert_eq!(ids(&repo.list_relation_targets(p3, prop, 10, 0).await.unwrap()), vec![p1]);

    // DBS-088's accepted side effect: no self-loop.
    let self_loop = repo.set_relation_targets(p1, prop, vec![p1]).await;
    assert!(self_loop.is_err());

    db.teardown().await;
}

#[tokio::test]
async fn cardinality_one_rejects_extra_targets_on_set_but_add_replaces() {
    let db = IsolatedDatabase::setup("relations_card1").await;
    let two = setup_two_databases(&db, "card1").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let b2 = create_record(&two.pool, two.target_db, "Projeto 2").await;

    let mut input = one_way_input(&two, "Projeto");
    input.source_max_targets = Some(1);
    let created = repo.create_relation(input).await.unwrap();

    // DBS-090: too many ids on `set_relation_targets` is a caller bug.
    let rejected = repo.set_relation_targets(a1, created.source_property_id, vec![b1, b2]).await;
    assert!(rejected.is_err());

    let set_one = repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();
    assert_eq!(ids(&set_one), vec![b1]);

    // DBS-090: at cardinality 1, `add` is the single-select picker's write
    // path and REPLACES rather than erroring or piling up.
    let replaced = repo.add_relation_targets(a1, created.source_property_id, vec![b2]).await.unwrap();
    assert_eq!(ids(&replaced), vec![b2]);

    db.teardown().await;
}

#[tokio::test]
async fn list_relation_targets_paginates_with_a_total_independent_of_the_page() {
    let db = IsolatedDatabase::setup("relations_page").await;
    let two = setup_two_databases(&db, "page").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let targets: Vec<Uuid> = create_n_targets(&two.pool, two.target_db, 3).await;
    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, targets.clone()).await.unwrap();

    let first_page = repo.list_relation_targets(a1, created.source_property_id, 2, 0).await.unwrap();
    assert_eq!(first_page.items.len(), 2);
    assert_eq!(first_page.total, 3, "total must reflect every target, not just this page");

    let second_page = repo.list_relation_targets(a1, created.source_property_id, 2, 2).await.unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert_eq!(second_page.total, 3);

    db.teardown().await;
}

async fn create_n_targets(pool: &SqlitePool, database_id: Uuid, count: usize) -> Vec<Uuid> {
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(create_record(pool, database_id, &format!("Projeto {i}")).await);
    }
    out
}

#[tokio::test]
async fn list_relation_targets_bulk_answers_every_record_including_ones_with_no_targets() {
    let db = IsolatedDatabase::setup("relations_bulk").await;
    let two = setup_two_databases(&db, "bulk").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let a2 = create_record(&two.pool, two.source_db, "Tarefa 2").await;
    let a3 = create_record(&two.pool, two.source_db, "Tarefa 3 (sem projeto)").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let b2 = create_record(&two.pool, two.target_db, "Projeto 2").await;

    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, vec![b1, b2]).await.unwrap();
    repo.set_relation_targets(a2, created.source_property_id, vec![b1]).await.unwrap();

    let bulk = repo
        .list_relation_targets_bulk(vec![a1, a2, a3], created.source_property_id, 10)
        .await
        .unwrap();
    assert_eq!(bulk.len(), 3, "one entry per requested record_id, always");

    let entry_a1 = bulk.iter().find(|e| e.record_id == a1).unwrap();
    assert_eq!(entry_a1.total, 2);
    assert_eq!(entry_a1.items.iter().map(|r| r.record_id).collect::<HashSet<_>>(), HashSet::from([b1, b2]));

    let entry_a2 = bulk.iter().find(|e| e.record_id == a2).unwrap();
    assert_eq!(entry_a2.total, 1);

    let entry_a3 = bulk.iter().find(|e| e.record_id == a3).unwrap();
    assert_eq!(entry_a3.total, 0);
    assert!(entry_a3.items.is_empty());

    // The N+1-proof part: capping `per_record_limit` below a1's real count
    // still reports the true total, not the truncated page's length.
    let capped = repo.list_relation_targets_bulk(vec![a1], created.source_property_id, 1).await.unwrap();
    assert_eq!(capped[0].items.len(), 1);
    assert_eq!(capped[0].total, 2);

    db.teardown().await;
}

#[tokio::test]
async fn trashing_a_target_hides_the_edge_and_restoring_brings_it_back() {
    let db = IsolatedDatabase::setup("relations_trash").await;
    let two = setup_two_databases(&db, "trash").await;
    let repo = RelationRepository::new(two.pool.clone());
    let pages = PageRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();

    pages.trash(b1).await.unwrap();
    let while_trashed = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(while_trashed.total, 0, "a trashed target must disappear from the view");
    assert_eq!(edge_count(&two.pool, created.relation.id).await, 1, "but the edge row itself must survive");

    pages.restore(b1).await.unwrap();
    let after_restore = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(ids(&after_restore), vec![b1], "restoring brings it back with no extra write");

    db.teardown().await;
}

#[tokio::test]
async fn permanently_deleting_a_target_page_removes_the_edge_via_fk_cascade() {
    let db = IsolatedDatabase::setup("relations_permdel").await;
    let two = setup_two_databases(&db, "permdel").await;
    let repo = RelationRepository::new(two.pool.clone());
    let pages = PageRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();
    assert_eq!(edge_count(&two.pool, created.relation.id).await, 1);

    // The real code path (`PageRepository::permanently_delete`), never a
    // hand-fabricated `DELETE FROM database_relation_edges` — the exact
    // false-green this piece's brief calls out by name
    // (`db_backlinks.rs`/FUN-044, `docs/ACHADOS-FASE-2.md`).
    pages.trash(b1).await.unwrap();
    pages.permanently_delete(b1).await.unwrap();

    assert_eq!(edge_count(&two.pool, created.relation.id).await, 0, "FK CASCADE must remove the edge");
    let after = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(after.total, 0);

    db.teardown().await;
}

#[tokio::test]
async fn deleting_the_target_database_reads_back_as_an_empty_page_not_an_error() {
    let db = IsolatedDatabase::setup("relations_dbdel").await;
    let two = setup_two_databases(&db, "dbdel").await;
    let repo = RelationRepository::new(two.pool.clone());

    let a1 = create_record(&two.pool, two.source_db, "Tarefa 1").await;
    let b1 = create_record(&two.pool, two.target_db, "Projeto 1").await;
    let created = repo.create_relation(one_way_input(&two, "Projeto")).await.unwrap();
    repo.set_relation_targets(a1, created.source_property_id, vec![b1]).await.unwrap();

    // arquitetura §5: deleting the TARGET database must leave the
    // surviving source property readable (never erroring), even though
    // nothing in this piece's scope marks it `broken` (that is
    // `0019_database_derived.sql`'s own T5 — see mod.rs's divergência
    // note). The relation and its edges cascade away on their own.
    sqlx::query("DELETE FROM databases WHERE id = $1").bind(two.target_db.db()).execute(&two.pool).await.unwrap();

    assert!(!relation_row_exists(&two.pool, created.relation.id).await);
    let after = repo.list_relation_targets(a1, created.source_property_id, 10, 0).await.unwrap();
    assert_eq!(after.total, 0);
    assert!(after.items.is_empty());

    // The property row itself (in the surviving source database) is left
    // exactly as this piece created it — nothing here rewrites `config`.
    let config = property_config(&two.pool, created.source_property_id).await;
    assert_eq!(config["relationId"], JsonValue::String(created.relation.id.to_string()));

    db.teardown().await;
}
