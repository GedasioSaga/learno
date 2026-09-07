//! Comandos `#[tauri::command]` da gamificação (Fase 1 de 2) — mesmo desenho
//! de `ipc::pomodoro_commands`/`ipc::study_commands`: cada comando monta
//! `GamificacaoRepository` a partir de `state.pool()` e delega a ele, com um
//! par `_inner` testável sem `AppHandle`.
//!
//! A lógica em si (curva de nível, seleção determinística de desafio,
//! idempotência de evento de XP) já está coberta em `db::gamificacao` e em
//! `tests/db_gamificacao.rs`; o que este arquivo prova é só a fiação.
//!
//! ## `registrar_xp_revisao_cartao`/`registrar_xp_pomodoro_concluido`/`registrar_xp_bloco_cronograma`:
//! reprocessamento, não o caminho principal
//!
//! Estes três NÃO são mais como XP é creditada no uso normal — isso agora
//! acontece sozinho, dentro da MESMA transação que grava o evento de domínio
//! (`db::cards::CardRepository::answer_card`, `db::pomodoro::PomodoroRepository::finish`;
//! ver o comentário de módulo de `db::gamificacao`). Nenhuma tela do
//! frontend chama estes três comandos hoje, e não deveria passar a chamar
//! para o fluxo normal de responder um cartão ou concluir um pomodoro — isso
//! reintroduziria exatamente o defeito que motivou tirar o crédito da UI
//! (XP dependente de alguém lembrar de pedir).
//!
//! Mantidos DE PROPÓSITO, não removidos, como caminho de
//! REPROCESSAMENTO/BACKFILL: toda linha de `review_log`/sessão de pomodoro
//! de foco gravada ANTES desta correção nunca gerou XP (o comando antigo era
//! inalcançável pela UI — ver o achado que originou esta peça), e continuará
//! sem XP até algo — um script de migração futuro, ou um botão de suporte —
//! percorrer o histórico e chamar estes comandos linha a linha. São
//! idempotentes (`UNIQUE (origin, reference_id)` no schema) e cada um
//! confere a condição real antes de creditar, então chamar de novo sobre algo
//! já creditado, ou sobre algo que não cumpre a condição, nunca credita
//! errado — seguro de expor mesmo sem uso hoje.

use chrono::{DateTime, Utc};
use tauri::State;
use uuid::Uuid;

use crate::db::{Desafio, EstadoDeNivel, GamificacaoRepository, RecordesPessoais, ResumoDeSessao, XpEventRow};
use crate::error::{Error, Result};
use crate::ipc::state::AppState;

fn gamificacao_repository(state: &AppState) -> Result<GamificacaoRepository> {
    Ok(GamificacaoRepository::new(state.pool()?))
}

/// Credita XP de uma revisão de cartão já respondida — ver
/// `GamificacaoRepository::registrar_xp_revisao_cartao` para a idempotência
/// (chamar duas vezes com o mesmo `review_log_id` não credita duas vezes).
#[tauri::command]
pub async fn registrar_xp_revisao_cartao(state: State<'_, AppState>, review_log_id: Uuid) -> Result<XpEventRow> {
    registrar_xp_revisao_cartao_inner(&state, review_log_id).await
}

async fn registrar_xp_revisao_cartao_inner(state: &AppState, review_log_id: Uuid) -> Result<XpEventRow> {
    gamificacao_repository(state)?.registrar_xp_revisao_cartao(review_log_id).await
}

/// Credita XP de um pomodoro de foco concluído.
#[tauri::command]
pub async fn registrar_xp_pomodoro_concluido(state: State<'_, AppState>, session_id: Uuid) -> Result<XpEventRow> {
    registrar_xp_pomodoro_concluido_inner(&state, session_id).await
}

async fn registrar_xp_pomodoro_concluido_inner(state: &AppState, session_id: Uuid) -> Result<XpEventRow> {
    gamificacao_repository(state)?.registrar_xp_pomodoro_concluido(session_id).await
}

/// Credita XP de um bloco do cronograma cujo tempo realizado já alcançou o
/// planejado.
#[tauri::command]
pub async fn registrar_xp_bloco_cronograma(state: State<'_, AppState>, block_id: Uuid) -> Result<XpEventRow> {
    registrar_xp_bloco_cronograma_inner(&state, block_id).await
}

async fn registrar_xp_bloco_cronograma_inner(state: &AppState, block_id: Uuid) -> Result<XpEventRow> {
    gamificacao_repository(state)?.registrar_xp_bloco_cronograma(block_id).await
}

/// Os desafios do dia local de agora — mesma lista (mesma meta) se chamado
/// de novo no mesmo dia; ver `GamificacaoRepository::desafios_hoje`.
#[tauri::command]
pub async fn desafios_hoje(state: State<'_, AppState>) -> Result<Vec<Desafio>> {
    desafios_hoje_inner(&state).await
}

async fn desafios_hoje_inner(state: &AppState) -> Result<Vec<Desafio>> {
    gamificacao_repository(state)?.desafios_hoje().await
}

/// Credita XP do desafio `tipo` de HOJE — o dia é sempre o do relógio do
/// sistema, nunca um valor vindo do IPC (ver o comentário de
/// `GamificacaoRepository::registrar_xp_desafio_diario`).
#[tauri::command]
pub async fn registrar_xp_desafio_diario(state: State<'_, AppState>, tipo: String) -> Result<XpEventRow> {
    registrar_xp_desafio_diario_inner(&state, &tipo).await
}

async fn registrar_xp_desafio_diario_inner(state: &AppState, tipo: &str) -> Result<XpEventRow> {
    gamificacao_repository(state)?.registrar_xp_desafio_diario(tipo).await
}

/// `xp_total()`: soma de `xp_events`, nunca um contador à parte.
#[tauri::command]
pub async fn xp_total(state: State<'_, AppState>) -> Result<i64> {
    xp_total_inner(&state).await
}

async fn xp_total_inner(state: &AppState) -> Result<i64> {
    gamificacao_repository(state)?.xp_total().await
}

/// `nivel_atual()`: nível, XP dentro dele e progresso para o próximo.
#[tauri::command]
pub async fn nivel_atual(state: State<'_, AppState>) -> Result<EstadoDeNivel> {
    nivel_atual_inner(&state).await
}

async fn nivel_atual_inner(state: &AppState) -> Result<EstadoDeNivel> {
    gamificacao_repository(state)?.nivel_atual().await
}

/// `recordes_pessoais()`: melhor dia, maior sequência, melhor semana — nunca
/// um ranking contra ninguém (ver o comentário de módulo de
/// `db::gamificacao`).
#[tauri::command]
pub async fn recordes_pessoais(state: State<'_, AppState>) -> Result<RecordesPessoais> {
    recordes_pessoais_inner(&state).await
}

async fn recordes_pessoais_inner(state: &AppState) -> Result<RecordesPessoais> {
    gamificacao_repository(state)?.recordes_pessoais().await
}

/// `resumo_de_sessao(inicio, fim)`: cartões, tempo e XP de um intervalo, e
/// quantos cartões vencem amanhã. `inicio`/`fim` chegam como texto ISO 8601
/// (RFC 3339) — mesma convenção de `ipc::cronograma_commands::semana_de_estudo`
/// (data como `String`, não um tipo de data desserializado pelo Tauri) — e
/// são parseados aqui, não confiados ao chamador: entrada de IPC é hostil, e
/// um texto corrompido vira `Error::Invalid` legível em vez de um erro de
/// desserialização opaco na borda do comando.
#[tauri::command]
pub async fn resumo_de_sessao(state: State<'_, AppState>, inicio: String, fim: String) -> Result<ResumoDeSessao> {
    resumo_de_sessao_inner(&state, &inicio, &fim).await
}

async fn resumo_de_sessao_inner(state: &AppState, inicio: &str, fim: &str) -> Result<ResumoDeSessao> {
    let inicio = parse_instante(inicio, "início")?;
    let fim = parse_instante(fim, "fim")?;
    gamificacao_repository(state)?.resumo_de_sessao(inicio, fim).await
}

fn parse_instante(texto: &str, rotulo: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(texto)
        .map(|instante| instante.with_timezone(&Utc))
        .map_err(|err| Error::Invalid(format!("{rotulo} de resumo_de_sessao inválido {texto:?}: {err}")))
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    // Um representante por comando prova que cada um está de fato ligado a
    // `gamificacao_repository`-style "sem pool ainda" — mesmo padrão de
    // `ipc::pomodoro_commands::tests::without_a_pool`.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn registrar_xp_revisao_cartao_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(registrar_xp_revisao_cartao_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn registrar_xp_pomodoro_concluido_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(registrar_xp_pomodoro_concluido_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn registrar_xp_bloco_cronograma_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(registrar_xp_bloco_cronograma_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn desafios_hoje_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(desafios_hoje_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn registrar_xp_desafio_diario_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(registrar_xp_desafio_diario_inner(&state, "revisar_cartoes").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn xp_total_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(xp_total_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn nivel_atual_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(nivel_atual_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn recordes_pessoais_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(recordes_pessoais_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn resumo_de_sessao_reports_not_connected() {
            let state = AppState::new();
            let inicio = Utc::now().to_rfc3339();
            let fim = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
            assert!(matches!(resumo_de_sessao_inner(&state, &inicio, &fim).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn resumo_de_sessao_com_texto_corrompido_e_invalid_antes_mesmo_de_tocar_o_pool() {
            let state = AppState::new();
            // Nem chega a checar o pool: o parse falha primeiro, e o erro é
            // `Invalid`, não `Config` — prova que a validação de entrada
            // hostil acontece antes de qualquer coisa.
            let result = resumo_de_sessao_inner(&state, "não-é-uma-data", "2026-09-05T00:00:00Z").await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");
        }
    }

    /// Prova mínima com banco real: a fiação IPC -> repositório entrega um
    /// resultado coerente com banco vazio, sem depender de nenhuma tabela
    /// preenchida. A cobertura funda (idempotência, curva de nível, desafios,
    /// bordas de fuso) mora em `tests/db_gamificacao.rs`.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-gamificacao-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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
        async fn xp_total_e_zero_e_nivel_e_1_num_banco_recem_migrado() {
            let (state, data_dir) = estado_com_banco("xp-vazio").await;

            assert_eq!(xp_total_inner(&state).await.unwrap(), 0);
            assert_eq!(nivel_atual_inner(&state).await.unwrap().nivel, 1);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn desafios_hoje_devolve_tres_categorias_com_banco_vazio() {
            let (state, data_dir) = estado_com_banco("desafios-vazio").await;

            let desafios = desafios_hoje_inner(&state).await.unwrap();
            assert_eq!(desafios.len(), 3);
            assert!(desafios.iter().all(|d| d.progresso == 0 && !d.concluido && !d.xp_creditado));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn registrar_xp_revisao_cartao_com_id_desconhecido_e_not_found() {
            let (state, data_dir) = estado_com_banco("revisao-desconhecida").await;

            let result = registrar_xp_revisao_cartao_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
