//! Comandos `#[tauri::command]` da fila de estudo (Fase 4, Peça 3):
//! `deck_counts`, `next_card`, `answer_card`, `deck_forecast`. Segue
//! exatamente o desenho de `ipc::commands`/`ipc::deck_commands`: cada
//! comando monta `CardRepository` a partir de `state.pool()` e delega a ele,
//! com um par `_inner` testável sem `AppHandle` — ver o comentário de
//! `page_repository` em `ipc::commands` para por que nenhum teste aqui pode
//! passar por `tauri::test::mock_builder`.
//!
//! A prova de efeito ponta a ponta (responder "good" três vezes tira um
//! cartão de `new` e o deixa em `review` com `due` no futuro; responder
//! "again" numa revisão devolve para `relearning` e incrementa `lapses`;
//! `review_log` ganha uma linha por resposta) mora em
//! `tests/db_cards.rs` — a lógica em si já está coberta ali e em
//! `db::cards`/`crate::srs`; o que falta provar aqui é só a fiação.

use tauri::State;
use uuid::Uuid;

use crate::db::{AnswerOutcome, CardRepository, CardToStudy, DeckCounts, DiaPrevisto, ReviewLogRepository, StudyStats};
use crate::error::Result;
use crate::ipc::state::AppState;

fn card_repository(state: &AppState) -> Result<CardRepository> {
    Ok(CardRepository::new(state.pool()?))
}

fn review_log_repository(state: &AppState) -> Result<ReviewLogRepository> {
    Ok(ReviewLogRepository::new(state.pool()?))
}

/// Quantos cartões de cada categoria (novos/aprendendo/revisar) estão
/// prontos para hoje, no escopo de `deck_id` (ele e seus subbaralhos ativos)
/// ou em todo baralho ativo quando `deck_id` é `None` — ver o comentário de
/// módulo de `db::cards` para a ordem/limite exatos.
#[tauri::command]
pub async fn deck_counts(state: State<'_, AppState>, deck_id: Option<Uuid>) -> Result<DeckCounts> {
    deck_counts_inner(&state, deck_id).await
}

async fn deck_counts_inner(state: &AppState, deck_id: Option<Uuid>) -> Result<DeckCounts> {
    card_repository(state)?.deck_counts(deck_id).await
}

/// O próximo cartão a estudar, ou `None` quando a fila (no escopo pedido)
/// está vazia.
#[tauri::command]
pub async fn next_card(state: State<'_, AppState>, deck_id: Option<Uuid>) -> Result<Option<CardToStudy>> {
    next_card_inner(&state, deck_id).await
}

async fn next_card_inner(state: &AppState, deck_id: Option<Uuid>) -> Result<Option<CardToStudy>> {
    card_repository(state)?.next_card(deck_id).await
}

/// Aplica a resposta (`rating: again|hard|good|easy`) ao cartão via
/// `crate::srs::agendar` e grava o novo estado junto com a linha de
/// `review_log`, na mesma transação — ver `CardRepository::answer_card`.
#[tauri::command]
pub async fn answer_card(state: State<'_, AppState>, card_id: Uuid, rating: String) -> Result<AnswerOutcome> {
    answer_card_inner(&state, card_id, &rating).await
}

async fn answer_card_inner(state: &AppState, card_id: Uuid, rating: &str) -> Result<AnswerOutcome> {
    card_repository(state)?.answer_card(card_id, rating).await
}

/// Quantos cartões vencem em cada um dos próximos `dias` dias locais, no
/// escopo de `deck_id`.
#[tauri::command]
pub async fn deck_forecast(state: State<'_, AppState>, deck_id: Option<Uuid>, dias: i64) -> Result<Vec<DiaPrevisto>> {
    deck_forecast_inner(&state, deck_id, dias).await
}

async fn deck_forecast_inner(state: &AppState, deck_id: Option<Uuid>, dias: i64) -> Result<Vec<DiaPrevisto>> {
    card_repository(state)?.deck_forecast(deck_id, dias).await
}

/// O histórico de estudo dos últimos `dias` dias locais, agregado por dia —
/// o que a tela de Estatísticas da seção Cartões desenha (mapa de calor,
/// média diária, dias estudados, sequências e retenção).
///
/// `review_log` grava uma linha por resposta desde a migração 0012, e até
/// aqui nada no aplicativo sabia lê-la: o `ReviewLogRepository` existia sem
/// nenhum comando que chegasse nele. É o oitavo caso, neste projeto, de
/// capacidade pronta e inalcançável por clique — por isso a trava
/// `src/features/navegacao/toda-tela-e-alcancavel.test.ts` existe do lado da
/// interface.
#[tauri::command]
pub async fn study_stats(state: State<'_, AppState>, deck_id: Option<Uuid>, dias: i64) -> Result<StudyStats> {
    study_stats_inner(&state, deck_id, dias).await
}

async fn study_stats_inner(state: &AppState, deck_id: Option<Uuid>, dias: i64) -> Result<StudyStats> {
    review_log_repository(state)?.stats(deck_id, dias).await
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    // Um representante por comando prova que cada um está de fato ligado a
    // `card_repository`-style "sem pool ainda" — mesmo padrão de
    // `ipc::commands::tests::page_commands_without_a_pool` e
    // `ipc::deck_commands::tests::without_a_pool`.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn deck_counts_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(deck_counts_inner(&state, None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn next_card_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(next_card_inner(&state, None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn answer_card_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(answer_card_inner(&state, Uuid::now_v7(), "good").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn deck_forecast_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(deck_forecast_inner(&state, None, 30).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn study_stats_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(study_stats_inner(&state, None, 365).await, Err(Error::Config(_))));
        }
    }
}
