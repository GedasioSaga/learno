//! Comandos `#[tauri::command]` do Pomodoro — mesmo desenho de
//! `ipc::mindmap_commands`/`ipc::deck_commands`: cada comando monta o
//! repositório a partir de `state.pool()` e delega, com par `_inner`
//! testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{PomodoroRepository, PomodoroResumo, PomodoroRow};
use crate::error::Result;
use crate::ipc::state::AppState;

fn pomodoro_repository(state: &AppState) -> Result<PomodoroRepository> {
    Ok(PomodoroRepository::new(state.pool()?))
}

/// `start_pomodoro`. `kind` é validado contra a lista fixa de
/// `PomodoroRepository::start` (não deixado para o `CHECK` do banco
/// reclamar cru); `duration_seconds` vem do timer do frontend, e é hostil
/// como toda entrada de IPC — validado como maior que zero na mesma função.
/// `plan_block_id` liga o foco a um bloco do cronograma ("Focar neste bloco").
#[tauri::command]
pub async fn start_pomodoro(
    state: State<'_, AppState>,
    kind: String,
    duration_seconds: i64,
    plan_block_id: Option<Uuid>,
) -> Result<PomodoroRow> {
    start_pomodoro_inner(&state, &kind, duration_seconds, plan_block_id).await
}

async fn start_pomodoro_inner(
    state: &AppState,
    kind: &str,
    duration_seconds: i64,
    plan_block_id: Option<Uuid>,
) -> Result<PomodoroRow> {
    pomodoro_repository(state)?.start(kind, duration_seconds, plan_block_id).await
}

/// `finish_pomodoro`. Só fecha uma sessão ainda aberta — ver o comentário de
/// `PomodoroRepository::finish`.
#[tauri::command]
pub async fn finish_pomodoro(state: State<'_, AppState>, session_id: Uuid, completed: bool) -> Result<PomodoroRow> {
    finish_pomodoro_inner(&state, session_id, completed).await
}

async fn finish_pomodoro_inner(state: &AppState, session_id: Uuid, completed: bool) -> Result<PomodoroRow> {
    pomodoro_repository(state)?.finish(session_id, completed).await
}

/// `pomodoro_today`: focos completos hoje, segundos focados hoje e a
/// sequência de dias seguidos — tudo sobre o dia LOCAL, ver
/// `PomodoroRepository::today_summary`.
#[tauri::command]
pub async fn pomodoro_today(state: State<'_, AppState>) -> Result<PomodoroResumo> {
    pomodoro_today_inner(&state).await
}

async fn pomodoro_today_inner(state: &AppState) -> Result<PomodoroResumo> {
    pomodoro_repository(state)?.today_summary().await
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
        async fn start_pomodoro_reports_not_connected() {
            let state = AppState::new();
            let result = start_pomodoro_inner(&state, "focus", 1500, None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn finish_pomodoro_reports_not_connected() {
            let state = AppState::new();
            let result = finish_pomodoro_inner(&state, Uuid::now_v7(), true).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn pomodoro_today_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(pomodoro_today_inner(&state).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-pomodoro-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = pasta_temporaria(rotulo);
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        #[tokio::test]
        async fn start_then_finish_round_trips_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("start-finish").await;

            let started = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            assert!(!started.completed);
            assert!(started.ended_at.is_none());

            let finished = finish_pomodoro_inner(&state, started.id, true).await.unwrap();
            assert!(finished.completed);
            assert!(finished.ended_at.is_some());

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn an_invalid_kind_is_reported_as_invalid_not_a_raw_database_error() {
            let (state, data_dir) = estado_com_banco("kind-invalido").await;

            let result = start_pomodoro_inner(&state, "almoço", 1500, None).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// "Uma sessão iniciada e nunca finalizada não pode contar como
        /// completa nem travar a próxima" — a segunda parte, provada aqui:
        /// uma sessão aberta não impede `start_pomodoro` de criar outra.
        #[tokio::test]
        async fn an_abandoned_open_session_never_blocks_starting_a_new_one() {
            let (state, data_dir) = estado_com_banco("sessao-abandonada").await;

            let abandoned = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            let next = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();

            assert_ne!(abandoned.id, next.id);
            assert!(abandoned.ended_at.is_none(), "a sessão abandonada continua aberta, e está tudo bem");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// A primeira metade da mesma frase: uma sessão nunca finalizada não
        /// entra em `pomodoro_today` — nem no contador nem nos segundos —
        /// porque `completed` nasce `0` e só `finish` muda isso.
        #[tokio::test]
        async fn an_abandoned_open_session_does_not_count_toward_today() {
            let (state, data_dir) = estado_com_banco("sessao-nao-conta").await;

            start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            let resumo = pomodoro_today_inner(&state).await.unwrap();

            assert_eq!(resumo.focos_completos, 0);
            assert_eq!(resumo.segundos_focados, 0);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn a_completed_focus_session_counts_toward_today_and_the_streak() {
            let (state, data_dir) = estado_com_banco("conta-hoje").await;

            let session = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            finish_pomodoro_inner(&state, session.id, true).await.unwrap();

            let resumo = pomodoro_today_inner(&state).await.unwrap();
            assert_eq!(resumo.focos_completos, 1);
            assert_eq!(resumo.segundos_focados, 1500);
            assert_eq!(resumo.sequencia_dias, 1);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Um foco cancelado (`completed = false`) não conta como completo,
        /// mesmo tendo rodado o timer inteiro do lado do frontend.
        #[tokio::test]
        async fn a_cancelled_focus_session_does_not_count_as_completed() {
            let (state, data_dir) = estado_com_banco("cancelado").await;

            let session = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            finish_pomodoro_inner(&state, session.id, false).await.unwrap();

            let resumo = pomodoro_today_inner(&state).await.unwrap();
            assert_eq!(resumo.focos_completos, 0);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn finishing_the_same_session_twice_is_rejected_on_the_second_call() {
            let (state, data_dir) = estado_com_banco("finaliza-2x").await;

            let session = start_pomodoro_inner(&state, "focus", 1500, None).await.unwrap();
            finish_pomodoro_inner(&state, session.id, true).await.unwrap();

            let second = finish_pomodoro_inner(&state, session.id, true).await;
            assert!(matches!(second, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {second:?}");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn finishing_an_unknown_session_reports_not_found() {
            let (state, data_dir) = estado_com_banco("desconhecida").await;

            let result = finish_pomodoro_inner(&state, Uuid::now_v7(), true).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
