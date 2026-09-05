//! Comandos `#[tauri::command]` que o frontend chama, e o estado compartilhado
//! entre eles.
//!
//! `db` já expõe os repositórios de página, histórico de versão e busca —
//! cada comando aqui monta o repositório certo a partir de `state.pool()` e
//! delega a ele; `import_apkg` segue o mesmo desenho com `state.sidecar()`
//! e `sidecar::SidecarProcess::call`.

// `pub(crate)` (não `mod` privado): `tauri::generate_handler!` em `lib.rs`
// referencia os comandos pelo caminho completo `ipc::commands::…` — a macro
// `#[tauri::command]` gera, ao lado de cada função, uma `macro_rules!` irmã
// que o `generate_handler!` também precisa enxergar, e isso só funciona pelo
// caminho original, não por um `pub use` que só reexporta a função.
pub(crate) mod backup_commands;
pub(crate) mod block_commands;
pub(crate) mod commands;
mod state;

pub use backup_commands::{
    autosave_clear_pending, autosave_list_recoverable, autosave_merge_with_saved,
    autosave_write_pending, create_backup, default_export_file_name, export_page_markdown,
    get_backup_schedule_config, restore_backup, run_due_scheduled_backup,
    save_backup_schedule_config, trigger_backup_for_risky_operation,
};
pub use block_commands::{
    apply_block_changes, count_synced_copies, create_block, create_synced_block_copy,
    delete_blocks, delete_synced_original, list_backlinks, list_outgoing_links,
    list_page_blocks, move_block, unsync_all_synced_copies, unsync_block, update_block,
};
pub use commands::{
    check_database, connect_database, create_page, create_page_version_snapshot, duplicate_page,
    get_app_config, get_data_dir, get_page_breadcrumb, import_apkg, list_page_tree,
    list_page_versions, list_trashed_pages, move_page, permanently_delete_page, rename_page,
    restore_page, restore_page_version, save_data_dir, search_pages, set_page_favorite,
    set_page_icon, test_database_connection, trash_page, ApkgImportResult,
};
pub use state::AppState;
