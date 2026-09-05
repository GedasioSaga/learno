//! Learno — módulo raiz.
//!
//! Este arquivo é só fiação: declara os módulos, monta o `tauri::Builder` e
//! registra os comandos. Toda a lógica vive nos módulos abaixo, e cada um deles
//! é dono exclusivo dos seus arquivos:
//!
//! - `config` — onde ficam host, porta e nome do banco, e o assistente de
//!   primeira execução que pede esses dados ao usuário.
//! - `db` — pool do Postgres, migrações e os repositórios de página,
//!   bloco, lixeira e histórico de versão.
//! - `sidecar` — processo Python empacotado e o protocolo que fala com ele.
//! - `ipc` — os comandos `#[tauri::command]` que o frontend chama.

pub mod backup;
pub mod config;
pub mod db;
pub mod error;
pub mod formula;
pub mod ipc;
pub mod rollup;
pub mod sidecar;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime};

pub use error::{Error, Result};

/// Nome do evento que o item "Alternar tema" do menu nativo emite para o
/// frontend — o estado do tema em si (claro/escuro) vive só no lado React,
/// então o backend só precisa avisar que o item foi clicado.
pub const TOGGLE_THEME_EVENT: &str = "learno://toggle-theme";

/// Monta o menu nativo da janela. Fica em português porque é a língua da
/// interface inteira; os itens sem tradução oficial (as ações padrão do SO)
/// ganham rótulo custom pelo mesmo motivo.
fn build_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file_menu = Submenu::with_id_and_items(
        handle,
        "file",
        "Arquivo",
        true,
        &[&PredefinedMenuItem::quit(handle, Some("Sair"))?],
    )?;

    let edit_menu = Submenu::with_id_and_items(
        handle,
        "edit",
        "Editar",
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some("Desfazer"))?,
            &PredefinedMenuItem::redo(handle, Some("Refazer"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("Recortar"))?,
            &PredefinedMenuItem::copy(handle, Some("Copiar"))?,
            &PredefinedMenuItem::paste(handle, Some("Colar"))?,
            &PredefinedMenuItem::select_all(handle, Some("Selecionar tudo"))?,
        ],
    )?;

    let view_menu = Submenu::with_id_and_items(
        handle,
        "view",
        "Exibir",
        true,
        &[&MenuItem::with_id(
            handle,
            "toggle-theme",
            "Alternar tema",
            true,
            None::<&str>,
        )?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        handle,
        "window",
        "Janela",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some("Minimizar"))?,
            &PredefinedMenuItem::maximize(handle, Some("Maximizar"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, Some("Fechar"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        handle,
        "help",
        "Ajuda",
        true,
        &[&PredefinedMenuItem::about(
            handle,
            Some("Sobre o Learno"),
            None,
        )?],
    )?;

    Menu::with_items(
        handle,
        &[
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "learno_lib=info,sqlx=warn".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // EDT-028: cliente HTTP do lado Rust para buscar metadado de
        // bookmark (título/descrição/favicon) sem esbarrar em CORS — ver
        // src-tauri/capabilities/default.json para o escopo de URL.
        .plugin(tauri_plugin_http::init())
        .manage(ipc::AppState::new())
        .setup(|app| {
            // PLT-004: sobe o sidecar uma vez, aqui, e guarda o handle em
            // `AppState` para `import_apkg` (e as fases seguintes) chamarem.
            // Falha de spawn não é fatal para o app inteiro — só as features
            // que dependem do sidecar ficam indisponíveis até a próxima
            // abertura, então loga e segue em vez de propagar o erro.
            let handle = app.handle().clone();
            match sidecar::SidecarProcess::spawn(&handle) {
                Ok(process) => app.state::<ipc::AppState>().set_sidecar(process),
                Err(err) => tracing::error!(%err, "sidecar não iniciou"),
            }
            Ok(())
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "toggle-theme" {
                // Erro de emit só acontece se nenhuma janela está de pé para
                // ouvir — nesse caso não há UI para atualizar mesmo, então
                // ignorar é o comportamento certo, não um erro engolido.
                let _ = app.emit(TOGGLE_THEME_EVENT, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::get_app_config,
            ipc::commands::connect_database,
            ipc::commands::get_data_dir,
            ipc::commands::save_data_dir,
            ipc::commands::test_database_connection,
            ipc::commands::import_apkg,
            ipc::commands::list_page_tree,
            ipc::commands::create_page,
            ipc::commands::rename_page,
            ipc::commands::set_page_favorite,
            ipc::commands::set_page_icon,
            ipc::commands::move_page,
            ipc::commands::duplicate_page,
            ipc::commands::trash_page,
            ipc::commands::restore_page,
            ipc::commands::permanently_delete_page,
            ipc::commands::list_trashed_pages,
            ipc::commands::get_page_breadcrumb,
            ipc::commands::list_page_versions,
            ipc::commands::restore_page_version,
            ipc::commands::create_page_version_snapshot,
            ipc::commands::search_pages,
            ipc::commands::check_database,
            ipc::block_commands::list_page_blocks,
            ipc::block_commands::create_block,
            ipc::block_commands::update_block,
            ipc::block_commands::delete_blocks,
            ipc::block_commands::move_block,
            ipc::block_commands::apply_block_changes,
            ipc::block_commands::list_backlinks,
            ipc::block_commands::list_outgoing_links,
            ipc::block_commands::create_synced_block_copy,
            ipc::block_commands::count_synced_copies,
            ipc::block_commands::unsync_block,
            ipc::block_commands::unsync_all_synced_copies,
            ipc::block_commands::delete_synced_original,
            ipc::backup_commands::autosave_write_pending,
            ipc::backup_commands::autosave_clear_pending,
            ipc::backup_commands::autosave_list_recoverable,
            ipc::backup_commands::autosave_merge_with_saved,
            ipc::backup_commands::create_backup,
            ipc::backup_commands::restore_backup,
            ipc::backup_commands::export_page_markdown,
            ipc::backup_commands::default_export_file_name,
            ipc::backup_commands::get_backup_schedule_config,
            ipc::backup_commands::save_backup_schedule_config,
            ipc::backup_commands::run_due_scheduled_backup,
            ipc::backup_commands::trigger_backup_for_risky_operation,
        ])
        .build(tauri::generate_context!());

    // Sem shutdown explícito do pool sqlx (`sqlx::SqlitePool` não precisa de um:
    // o processo inteiro cai junto), o sidecar é o único recurso externo que
    // precisa de encerramento explícito — um `CommandChild` vivo sobrevive ao
    // processo pai morrer no Windows até o handle ser fechado, então
    // `ExitRequested` mata o processo Python antes da janela fechar de vez.
    // `run` (em vez de `expect`) evita panic no caminho de falha de setup:
    // erro genuíno de plataforma (ex.: WebView2 ausente) vira mensagem de log
    // e saída com código de erro.
    match app {
        Ok(app) => app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Ok(process) = app_handle.state::<ipc::AppState>().sidecar() {
                    tauri::async_runtime::block_on(process.shutdown());
                }
            }
        }),
        Err(error) => {
            tracing::error!(%error, "falha ao inicializar o Tauri");
            std::process::exit(1);
        }
    }
}
