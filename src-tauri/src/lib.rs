//! Learno — módulo raiz.
//!
//! Este arquivo é só fiação: declara os módulos, monta o `tauri::Builder` e
//! registra os comandos. Toda a lógica vive nos módulos abaixo, e cada um deles
//! é dono exclusivo dos seus arquivos:
//!
//! - `config`  — onde ficam host, porta e nome do banco, e o assistente de
//!               primeira execução que pede esses dados ao usuário.
//! - `db`      — pool do Postgres, migrações e os repositórios de página,
//!               bloco, lixeira e histórico de versão.
//! - `sidecar` — processo Python empacotado e o protocolo que fala com ele.
//! - `ipc`     — os comandos `#[tauri::command]` que o frontend chama.

pub mod config;
pub mod db;
pub mod error;
pub mod ipc;
pub mod sidecar;

pub use error::{Error, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "learno_lib=info,sqlx=warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
