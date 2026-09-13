//! Comandos `#[tauri::command]` de Finanças — mesmo desenho de
//! `ipc::prazos_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com par `_inner` testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{
    CategoriaRow, FinancasRepository, LancamentoPatchInput, LancamentoRow, LinhaDoMes, RecorrenteComVigencias,
    RecorrentePatchInput, RecorrenteRow, ResumoDoMes,
};
use crate::error::Result;
use crate::ipc::state::AppState;

fn financas_repository(state: &AppState) -> Result<FinancasRepository> {
    Ok(FinancasRepository::new(state.pool()?))
}

/// `listar_categorias_financas`.
#[tauri::command]
pub async fn listar_categorias_financas(state: State<'_, AppState>) -> Result<Vec<CategoriaRow>> {
    listar_categorias_financas_inner(&state).await
}

async fn listar_categorias_financas_inner(state: &AppState) -> Result<Vec<CategoriaRow>> {
    financas_repository(state)?.listar_categorias().await
}

/// `criar_categoria_financas`.
#[tauri::command]
pub async fn criar_categoria_financas(state: State<'_, AppState>, nome: String, tipo: String) -> Result<CategoriaRow> {
    criar_categoria_financas_inner(&state, &nome, &tipo).await
}

async fn criar_categoria_financas_inner(state: &AppState, nome: &str, tipo: &str) -> Result<CategoriaRow> {
    financas_repository(state)?.criar_categoria(nome, tipo).await
}

/// `criar_recorrente`.
#[tauri::command]
pub async fn criar_recorrente(
    state: State<'_, AppState>,
    descricao: String,
    tipo: String,
    categoria_id: Option<Uuid>,
    valor_centavos: i64,
    inicio_mes: String,
) -> Result<RecorrenteComVigencias> {
    criar_recorrente_inner(&state, &descricao, &tipo, categoria_id, valor_centavos, &inicio_mes).await
}

async fn criar_recorrente_inner(
    state: &AppState,
    descricao: &str,
    tipo: &str,
    categoria_id: Option<Uuid>,
    valor_centavos: i64,
    inicio_mes: &str,
) -> Result<RecorrenteComVigencias> {
    financas_repository(state)?.criar_recorrente(descricao, tipo, categoria_id, valor_centavos, inicio_mes).await
}

/// `listar_recorrentes`.
#[tauri::command]
pub async fn listar_recorrentes(state: State<'_, AppState>) -> Result<Vec<RecorrenteComVigencias>> {
    listar_recorrentes_inner(&state).await
}

async fn listar_recorrentes_inner(state: &AppState) -> Result<Vec<RecorrenteComVigencias>> {
    financas_repository(state)?.listar_recorrentes().await
}

/// `atualizar_recorrente`.
#[tauri::command]
pub async fn atualizar_recorrente(
    state: State<'_, AppState>,
    recorrente_id: Uuid,
    patch: RecorrentePatchInput,
) -> Result<RecorrenteRow> {
    atualizar_recorrente_inner(&state, recorrente_id, patch).await
}

async fn atualizar_recorrente_inner(
    state: &AppState,
    recorrente_id: Uuid,
    patch: RecorrentePatchInput,
) -> Result<RecorrenteRow> {
    financas_repository(state)?.atualizar_recorrente(recorrente_id, patch).await
}

/// `remover_recorrente`.
#[tauri::command]
pub async fn remover_recorrente(state: State<'_, AppState>, recorrente_id: Uuid) -> Result<()> {
    remover_recorrente_inner(&state, recorrente_id).await
}

async fn remover_recorrente_inner(state: &AppState, recorrente_id: Uuid) -> Result<()> {
    financas_repository(state)?.remover_recorrente(recorrente_id).await
}

/// `mudar_valor_recorrente`.
#[tauri::command]
pub async fn mudar_valor_recorrente(
    state: State<'_, AppState>,
    recorrente_id: Uuid,
    valor_centavos: i64,
    mes: String,
) -> Result<RecorrenteComVigencias> {
    mudar_valor_recorrente_inner(&state, recorrente_id, valor_centavos, &mes).await
}

async fn mudar_valor_recorrente_inner(
    state: &AppState,
    recorrente_id: Uuid,
    valor_centavos: i64,
    mes: &str,
) -> Result<RecorrenteComVigencias> {
    financas_repository(state)?.mudar_valor_a_partir_de(recorrente_id, valor_centavos, mes).await
}

/// `encerrar_recorrente`.
#[tauri::command]
pub async fn encerrar_recorrente(
    state: State<'_, AppState>,
    recorrente_id: Uuid,
    ultimo_mes: String,
) -> Result<RecorrenteComVigencias> {
    encerrar_recorrente_inner(&state, recorrente_id, &ultimo_mes).await
}

async fn encerrar_recorrente_inner(
    state: &AppState,
    recorrente_id: Uuid,
    ultimo_mes: &str,
) -> Result<RecorrenteComVigencias> {
    financas_repository(state)?.encerrar_recorrente(recorrente_id, ultimo_mes).await
}

/// `criar_lancamento`.
#[tauri::command]
pub async fn criar_lancamento(
    state: State<'_, AppState>,
    data_local: String,
    descricao: String,
    tipo: String,
    categoria_id: Option<Uuid>,
    valor_centavos: i64,
) -> Result<LancamentoRow> {
    criar_lancamento_inner(&state, &data_local, &descricao, &tipo, categoria_id, valor_centavos).await
}

async fn criar_lancamento_inner(
    state: &AppState,
    data_local: &str,
    descricao: &str,
    tipo: &str,
    categoria_id: Option<Uuid>,
    valor_centavos: i64,
) -> Result<LancamentoRow> {
    financas_repository(state)?.criar_lancamento(data_local, descricao, tipo, categoria_id, valor_centavos).await
}

/// `atualizar_lancamento`.
#[tauri::command]
pub async fn atualizar_lancamento(
    state: State<'_, AppState>,
    lancamento_id: Uuid,
    patch: LancamentoPatchInput,
) -> Result<LancamentoRow> {
    atualizar_lancamento_inner(&state, lancamento_id, patch).await
}

async fn atualizar_lancamento_inner(
    state: &AppState,
    lancamento_id: Uuid,
    patch: LancamentoPatchInput,
) -> Result<LancamentoRow> {
    financas_repository(state)?.atualizar_lancamento(lancamento_id, patch).await
}

/// `remover_lancamento`.
#[tauri::command]
pub async fn remover_lancamento(state: State<'_, AppState>, lancamento_id: Uuid) -> Result<()> {
    remover_lancamento_inner(&state, lancamento_id).await
}

async fn remover_lancamento_inner(state: &AppState, lancamento_id: Uuid) -> Result<()> {
    financas_repository(state)?.remover_lancamento(lancamento_id).await
}

/// `listar_lancamentos_do_mes`.
#[tauri::command]
pub async fn listar_lancamentos_do_mes(state: State<'_, AppState>, mes: String) -> Result<Vec<LancamentoRow>> {
    listar_lancamentos_do_mes_inner(&state, &mes).await
}

async fn listar_lancamentos_do_mes_inner(state: &AppState, mes: &str) -> Result<Vec<LancamentoRow>> {
    financas_repository(state)?.listar_lancamentos_do_mes(mes).await
}

/// `confirmar_recorrente`.
#[tauri::command]
pub async fn confirmar_recorrente(
    state: State<'_, AppState>,
    recorrente_id: Uuid,
    mes: String,
    valor_centavos: Option<i64>,
    data_local: Option<String>,
) -> Result<LancamentoRow> {
    confirmar_recorrente_inner(&state, recorrente_id, &mes, valor_centavos, data_local.as_deref()).await
}

async fn confirmar_recorrente_inner(
    state: &AppState,
    recorrente_id: Uuid,
    mes: &str,
    valor_centavos: Option<i64>,
    data_local: Option<&str>,
) -> Result<LancamentoRow> {
    financas_repository(state)?.confirmar_recorrente(recorrente_id, mes, valor_centavos, data_local).await
}

/// `resumo_financeiro_do_mes`.
#[tauri::command]
pub async fn resumo_financeiro_do_mes(state: State<'_, AppState>, mes: String) -> Result<ResumoDoMes> {
    resumo_financeiro_do_mes_inner(&state, &mes).await
}

async fn resumo_financeiro_do_mes_inner(state: &AppState, mes: &str) -> Result<ResumoDoMes> {
    financas_repository(state)?.resumo_do_mes(mes).await
}

/// `visao_financeira_por_meses`. `quantidade` é `i64` (não `u32`) para que um
/// valor fora de 1..=36 vindo do JS vire `Error::Invalid` legível em vez de
/// falha de desserialização.
#[tauri::command]
pub async fn visao_financeira_por_meses(
    state: State<'_, AppState>,
    inicio_mes: String,
    quantidade: i64,
) -> Result<Vec<LinhaDoMes>> {
    visao_financeira_por_meses_inner(&state, &inicio_mes, quantidade).await
}

async fn visao_financeira_por_meses_inner(state: &AppState, inicio_mes: &str, quantidade: i64) -> Result<Vec<LinhaDoMes>> {
    financas_repository(state)?.visao_por_meses(inicio_mes, quantidade).await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    /// Sem pool, todo comando devolve `Error::Config` em vez de pânico —
    /// mesmo contrato de `prazos_commands`.
    #[tokio::test]
    async fn comandos_de_financas_sem_pool_reportam_nao_conectado() {
        let state = AppState::new();
        let id = Uuid::now_v7();

        assert!(matches!(listar_categorias_financas_inner(&state).await, Err(Error::Config(_))));
        assert!(matches!(criar_categoria_financas_inner(&state, "Pets", "saida").await, Err(Error::Config(_))));
        assert!(matches!(
            criar_recorrente_inner(&state, "Aluguel", "saida", None, 100, "2026-09").await,
            Err(Error::Config(_))
        ));
        assert!(matches!(listar_recorrentes_inner(&state).await, Err(Error::Config(_))));
        assert!(matches!(
            atualizar_recorrente_inner(&state, id, RecorrentePatchInput::default()).await,
            Err(Error::Config(_))
        ));
        assert!(matches!(remover_recorrente_inner(&state, id).await, Err(Error::Config(_))));
        assert!(matches!(mudar_valor_recorrente_inner(&state, id, 100, "2026-09").await, Err(Error::Config(_))));
        assert!(matches!(encerrar_recorrente_inner(&state, id, "2026-09").await, Err(Error::Config(_))));
        assert!(matches!(
            criar_lancamento_inner(&state, "2026-09-01", "Mercado", "saida", None, 100).await,
            Err(Error::Config(_))
        ));
        assert!(matches!(
            atualizar_lancamento_inner(&state, id, LancamentoPatchInput::default()).await,
            Err(Error::Config(_))
        ));
        assert!(matches!(remover_lancamento_inner(&state, id).await, Err(Error::Config(_))));
        assert!(matches!(listar_lancamentos_do_mes_inner(&state, "2026-09").await, Err(Error::Config(_))));
        assert!(matches!(confirmar_recorrente_inner(&state, id, "2026-09", None, None).await, Err(Error::Config(_))));
        assert!(matches!(resumo_financeiro_do_mes_inner(&state, "2026-09").await, Err(Error::Config(_))));
        assert!(matches!(visao_financeira_por_meses_inner(&state, "2026-09", 3).await, Err(Error::Config(_))));
    }
}
