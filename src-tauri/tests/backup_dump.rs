#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Teste de integração do PLT-011: a ida e volta completa — fazer backup de
//! um banco com conteúdo e restaurá-lo por cima de outro, confirmando que o
//! conteúdo volta.
//!
//! Não é mais `#[ignore]`, e essa é a mudança que a migração para SQLite
//! trouxe a este arquivo: a versão Postgres exigia um cluster de pé
//! (`scripts/dev-db.ps1`), os binários `pg_dump`/`pg_restore` no PATH e a
//! variável `LEARNO_TEST_DATABASE_URL` — três pré-condições que na prática
//! faziam este teste nunca rodar. Agora um banco é um arquivo em pasta
//! temporária e um backup é uma instrução SQL, então isto roda num
//! `cargo test` limpo em qualquer máquina.
//!
//! O que dá para provar sem banco nenhum — o formato do nome do arquivo, a
//! recusa de um arquivo que não é banco do Learno, a cópia de segurança que
//! a restauração deixa para trás — já é teste comum dentro de
//! `src-tauri/src/backup/dump.rs`. O que só este arquivo prova é a
//! travessia inteira pela API pública do crate.

mod support;

use learno_lib::backup::{run_backup, run_restore};
use learno_lib::db::{connect_and_migrate, PageRepository};
use support::{EmptyDatabase, IsolatedDatabase};

#[tokio::test]
async fn plt_011_a_backup_restored_into_an_empty_database_recovers_all_content() {
    let source = IsolatedDatabase::setup("backup_dump_source").await;
    let marker_title = format!("PLT-011 marker {}", uuid::Uuid::new_v4());
    PageRepository::new(source.pool.clone()).create(None, &marker_title).await.unwrap();

    let output_dir = std::env::temp_dir().join(format!("learno-plt011-{}", uuid::Uuid::new_v4()));
    let dump_path = run_backup(&source.pool, &output_dir).await.unwrap();
    assert!(dump_path.is_file());

    // O alvo é um caminho onde ainda não existe banco nenhum: é o caso
    // "restaurar numa instalação limpa", que é o critério de aceitação do
    // PLT-011.
    let restore_target = EmptyDatabase::create("backup_dump_restore");
    run_restore(&restore_target.path, &dump_path).await.unwrap();

    let restore_pool = connect_and_migrate(&restore_target.path).await.unwrap();
    let restored = PageRepository::new(restore_pool.clone()).list_tree(None).await.unwrap();
    assert!(restored.iter().any(|page| page.title == marker_title));

    restore_pool.close().await;
    let _ = std::fs::remove_dir_all(&output_dir);
    source.teardown().await;
    restore_target.teardown();
}
