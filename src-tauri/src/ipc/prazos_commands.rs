//! Comandos `#[tauri::command]` dos Prazos — mesmo desenho de
//! `ipc::cronograma_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com par `_inner` testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{PrazoPatchInput, PrazoRepository, PrazoRow, PrazosListados};
use crate::error::Result;
use crate::ipc::state::AppState;

fn prazo_repository(state: &AppState) -> Result<PrazoRepository> {
    Ok(PrazoRepository::new(state.pool()?))
}

/// `criar_prazo`.
#[tauri::command]
pub async fn criar_prazo(
    state: State<'_, AppState>,
    title: String,
    due_local_date: String,
    deck_id: Option<Uuid>,
    page_id: Option<Uuid>,
) -> Result<PrazoRow> {
    criar_prazo_inner(&state, &title, &due_local_date, deck_id, page_id).await
}

async fn criar_prazo_inner(
    state: &AppState,
    title: &str,
    due_local_date: &str,
    deck_id: Option<Uuid>,
    page_id: Option<Uuid>,
) -> Result<PrazoRow> {
    prazo_repository(state)?.criar(title, due_local_date, deck_id, page_id).await
}

/// `obter_prazo`.
#[tauri::command]
pub async fn obter_prazo(state: State<'_, AppState>, prazo_id: Uuid) -> Result<PrazoRow> {
    obter_prazo_inner(&state, prazo_id).await
}

async fn obter_prazo_inner(state: &AppState, prazo_id: Uuid) -> Result<PrazoRow> {
    prazo_repository(state)?.obter(prazo_id).await
}

/// `atualizar_prazo`.
#[tauri::command]
pub async fn atualizar_prazo(state: State<'_, AppState>, prazo_id: Uuid, patch: PrazoPatchInput) -> Result<PrazoRow> {
    atualizar_prazo_inner(&state, prazo_id, patch).await
}

async fn atualizar_prazo_inner(state: &AppState, prazo_id: Uuid, patch: PrazoPatchInput) -> Result<PrazoRow> {
    prazo_repository(state)?.atualizar(prazo_id, patch).await
}

/// `remover_prazo`.
#[tauri::command]
pub async fn remover_prazo(state: State<'_, AppState>, prazo_id: Uuid) -> Result<()> {
    remover_prazo_inner(&state, prazo_id).await
}

async fn remover_prazo_inner(state: &AppState, prazo_id: Uuid) -> Result<()> {
    prazo_repository(state)?.remover(prazo_id).await
}

/// `listar_prazos`.
#[tauri::command]
pub async fn listar_prazos(state: State<'_, AppState>) -> Result<PrazosListados> {
    listar_prazos_inner(&state).await
}

async fn listar_prazos_inner(state: &AppState) -> Result<PrazosListados> {
    prazo_repository(state)?.listar().await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn criar_prazo_reports_not_connected() {
            let state = AppState::new();
            let result = criar_prazo_inner(&state, "Prova de Biologia", "2026-09-20", None, None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn obter_prazo_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(obter_prazo_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn atualizar_prazo_reports_not_connected() {
            let state = AppState::new();
            let result = atualizar_prazo_inner(&state, Uuid::now_v7(), PrazoPatchInput::default()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_prazo_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_prazo_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_prazos_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_prazos_inner(&state).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-prazos-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = pasta_temporaria(rotulo);
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        async fn encerra(state: AppState, data_dir: PathBuf) {
            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn criar_prazo_then_obter_prazo_round_trips() {
            let (state, data_dir) = estado_com_banco("criar-obter").await;

            let criado = criar_prazo_inner(&state, "Prova de Biologia", "2026-09-20", None, None).await.unwrap();
            assert_eq!(criado.title, "Prova de Biologia");
            assert_eq!(criado.due_local_date, "2026-09-20");
            assert_eq!(criado.status, "ativo");

            let lido = obter_prazo_inner(&state, criado.id).await.unwrap();
            assert_eq!(lido, criado);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_prazo_rejects_an_empty_title() {
            let (state, data_dir) = estado_com_banco("titulo-vazio").await;

            let result = criar_prazo_inner(&state, "   ", "2026-09-20", None, None).await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_prazo_patches_only_the_given_fields() {
            let (state, data_dir) = estado_com_banco("patch-parcial").await;

            let criado = criar_prazo_inner(&state, "Prova de Biologia", "2026-09-20", None, None).await.unwrap();
            let patch = PrazoPatchInput { status: Some("concluido".into()), ..Default::default() };
            let atualizado = atualizar_prazo_inner(&state, criado.id, patch).await.unwrap();

            assert_eq!(atualizado.status, "concluido");
            assert_eq!(atualizado.title, "Prova de Biologia", "não pedido no patch, continua igual");
            assert_eq!(atualizado.due_local_date, "2026-09-20", "não pedido no patch, continua igual");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_prazo_deletes_and_a_second_removal_reports_not_found() {
            let (state, data_dir) = estado_com_banco("remover").await;

            let criado = criar_prazo_inner(&state, "Descartável", "2026-09-20", None, None).await.unwrap();
            remover_prazo_inner(&state, criado.id).await.unwrap();

            let segunda = remover_prazo_inner(&state, criado.id).await;
            assert!(matches!(segunda, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn listar_prazos_on_an_empty_database_returns_empty_lists_without_panicking() {
            let (state, data_dir) = estado_com_banco("vazio").await;

            let lista = listar_prazos_inner(&state).await.unwrap();
            assert!(lista.vencidos.is_empty());
            assert!(lista.futuros.is_empty());

            encerra(state, data_dir).await;
        }
    }
}
