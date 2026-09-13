//! Comandos `#[tauri::command]` do Cronograma — mesmo desenho de
//! `ipc::pomodoro_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com par `_inner` testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{
    AplicacaoDeRotina, BlocoPatchInput, BlocoPlanejado, CronogramaRepository, ItemDeRotina, ItemDeRotinaPatchInput,
    Materia, MateriaPatchInput, ModoDeAplicacaoDeRotina, Rotina, RotinaPatchInput, SemanaDeEstudo,
};
use crate::error::Result;
use crate::ipc::state::AppState;

fn cronograma_repository(state: &AppState) -> Result<CronogramaRepository> {
    Ok(CronogramaRepository::new(state.pool()?))
}

/// `semana_de_estudo`: os sete dias de `inicio_da_semana` (segunda-feira),
/// cada um com seus blocos planejados e o total realizado.
#[tauri::command]
pub async fn semana_de_estudo(state: State<'_, AppState>, inicio_da_semana: String) -> Result<SemanaDeEstudo> {
    semana_de_estudo_inner(&state, &inicio_da_semana).await
}

async fn semana_de_estudo_inner(state: &AppState, inicio_da_semana: &str) -> Result<SemanaDeEstudo> {
    cronograma_repository(state)?.semana(inicio_da_semana).await
}

/// `definir_meta_semanal`.
#[tauri::command]
pub async fn definir_meta_semanal(state: State<'_, AppState>, inicio_da_semana: String, meta_minutos: i64) -> Result<()> {
    definir_meta_semanal_inner(&state, &inicio_da_semana, meta_minutos).await
}

async fn definir_meta_semanal_inner(state: &AppState, inicio_da_semana: &str, meta_minutos: i64) -> Result<()> {
    cronograma_repository(state)?.definir_meta_semanal(inicio_da_semana, meta_minutos).await
}

/// `criar_bloco`. `startLocalTime`/`pomodoroCycles` são opcionais — ver
/// `CronogramaRepository::criar_bloco` para o porquê de terem passado a
/// entrar direto no `INSERT` (remove o remendo de dois passos que
/// `criar_bloco` + `atualizar_bloco` exigia do chamador).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn criar_bloco(
    state: State<'_, AppState>,
    dia: String,
    atividade: String,
    minutos_planejados: i64,
    start_local_time: Option<String>,
    pomodoro_cycles: Option<i64>,
    titulo: Option<String>,
    deck_id: Option<Uuid>,
    page_id: Option<Uuid>,
    subject_id: Option<Uuid>,
) -> Result<BlocoPlanejado> {
    criar_bloco_inner(
        &state,
        &dia,
        &atividade,
        minutos_planejados,
        start_local_time,
        pomodoro_cycles,
        titulo,
        deck_id,
        page_id,
        subject_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn criar_bloco_inner(
    state: &AppState,
    dia: &str,
    atividade: &str,
    minutos_planejados: i64,
    start_local_time: Option<String>,
    pomodoro_cycles: Option<i64>,
    titulo: Option<String>,
    deck_id: Option<Uuid>,
    page_id: Option<Uuid>,
    subject_id: Option<Uuid>,
) -> Result<BlocoPlanejado> {
    cronograma_repository(state)?
        .criar_bloco(dia, atividade, minutos_planejados, start_local_time, pomodoro_cycles, titulo, deck_id, page_id, subject_id)
        .await
}

/// `mover_bloco`.
#[tauri::command]
pub async fn mover_bloco(
    state: State<'_, AppState>,
    bloco_id: Uuid,
    novo_dia: String,
    apos_bloco_id: Option<Uuid>,
) -> Result<BlocoPlanejado> {
    mover_bloco_inner(&state, bloco_id, &novo_dia, apos_bloco_id).await
}

async fn mover_bloco_inner(
    state: &AppState,
    bloco_id: Uuid,
    novo_dia: &str,
    apos_bloco_id: Option<Uuid>,
) -> Result<BlocoPlanejado> {
    cronograma_repository(state)?.mover_bloco(bloco_id, novo_dia, apos_bloco_id).await
}

/// `atualizar_bloco`.
#[tauri::command]
pub async fn atualizar_bloco(state: State<'_, AppState>, bloco_id: Uuid, patch: BlocoPatchInput) -> Result<BlocoPlanejado> {
    atualizar_bloco_inner(&state, bloco_id, patch).await
}

async fn atualizar_bloco_inner(state: &AppState, bloco_id: Uuid, patch: BlocoPatchInput) -> Result<BlocoPlanejado> {
    cronograma_repository(state)?.atualizar_bloco(bloco_id, patch).await
}

/// `remover_bloco`.
#[tauri::command]
pub async fn remover_bloco(state: State<'_, AppState>, bloco_id: Uuid) -> Result<()> {
    remover_bloco_inner(&state, bloco_id).await
}

async fn remover_bloco_inner(state: &AppState, bloco_id: Uuid) -> Result<()> {
    cronograma_repository(state)?.remover_bloco(bloco_id).await
}

/// `criar_materia`.
#[tauri::command]
pub async fn criar_materia(state: State<'_, AppState>, nome: String, cor: Option<String>) -> Result<Materia> {
    criar_materia_inner(&state, &nome, cor).await
}

async fn criar_materia_inner(state: &AppState, nome: &str, cor: Option<String>) -> Result<Materia> {
    cronograma_repository(state)?.criar_materia(nome, cor).await
}

/// `listar_materias`.
#[tauri::command]
pub async fn listar_materias(state: State<'_, AppState>) -> Result<Vec<Materia>> {
    listar_materias_inner(&state).await
}

async fn listar_materias_inner(state: &AppState) -> Result<Vec<Materia>> {
    cronograma_repository(state)?.listar_materias().await
}

/// `atualizar_materia`.
#[tauri::command]
pub async fn atualizar_materia(state: State<'_, AppState>, materia_id: Uuid, patch: MateriaPatchInput) -> Result<Materia> {
    atualizar_materia_inner(&state, materia_id, patch).await
}

async fn atualizar_materia_inner(state: &AppState, materia_id: Uuid, patch: MateriaPatchInput) -> Result<Materia> {
    cronograma_repository(state)?.atualizar_materia(materia_id, patch).await
}

/// `remover_materia`.
#[tauri::command]
pub async fn remover_materia(state: State<'_, AppState>, materia_id: Uuid) -> Result<()> {
    remover_materia_inner(&state, materia_id).await
}

async fn remover_materia_inner(state: &AppState, materia_id: Uuid) -> Result<()> {
    cronograma_repository(state)?.remover_materia(materia_id).await
}

/// `copiar_semana`: duplica os blocos planejados de uma semana para outra —
/// a "semana modelo" do pedido. Ver `CronogramaRepository::copiar_semana`
/// para o que ela NÃO faz (não é idempotente, não copia a meta semanal).
#[tauri::command]
pub async fn copiar_semana(
    state: State<'_, AppState>,
    semana_origem_inicio: String,
    semana_destino_inicio: String,
) -> Result<Vec<BlocoPlanejado>> {
    copiar_semana_inner(&state, &semana_origem_inicio, &semana_destino_inicio).await
}

async fn copiar_semana_inner(
    state: &AppState,
    semana_origem_inicio: &str,
    semana_destino_inicio: &str,
) -> Result<Vec<BlocoPlanejado>> {
    cronograma_repository(state)?.copiar_semana(semana_origem_inicio, semana_destino_inicio).await
}

/// `criar_rotina`: o molde de um dia ("Dia de semana"). Ver
/// `CronogramaRepository::criar_rotina`.
#[tauri::command]
pub async fn criar_rotina(state: State<'_, AppState>, nome: String, default_weekdays: Option<String>) -> Result<Rotina> {
    criar_rotina_inner(&state, &nome, default_weekdays).await
}

async fn criar_rotina_inner(state: &AppState, nome: &str, default_weekdays: Option<String>) -> Result<Rotina> {
    cronograma_repository(state)?.criar_rotina(nome, default_weekdays).await
}

/// `listar_rotinas`.
#[tauri::command]
pub async fn listar_rotinas(state: State<'_, AppState>) -> Result<Vec<Rotina>> {
    listar_rotinas_inner(&state).await
}

async fn listar_rotinas_inner(state: &AppState) -> Result<Vec<Rotina>> {
    cronograma_repository(state)?.listar_rotinas().await
}

/// `atualizar_rotina`.
#[tauri::command]
pub async fn atualizar_rotina(state: State<'_, AppState>, rotina_id: Uuid, patch: RotinaPatchInput) -> Result<Rotina> {
    atualizar_rotina_inner(&state, rotina_id, patch).await
}

async fn atualizar_rotina_inner(state: &AppState, rotina_id: Uuid, patch: RotinaPatchInput) -> Result<Rotina> {
    cronograma_repository(state)?.atualizar_rotina(rotina_id, patch).await
}

/// `remover_rotina`: apaga a rotina e seus itens (`ON DELETE CASCADE`).
/// Nunca toca em `study_plan_blocks` — ver `CronogramaRepository::remover_rotina`.
#[tauri::command]
pub async fn remover_rotina(state: State<'_, AppState>, rotina_id: Uuid) -> Result<()> {
    remover_rotina_inner(&state, rotina_id).await
}

async fn remover_rotina_inner(state: &AppState, rotina_id: Uuid) -> Result<()> {
    cronograma_repository(state)?.remover_rotina(rotina_id).await
}

/// `criar_item_de_rotina`: uma linha do molde ("05:00, 2h, Estudo profundo").
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn criar_item_de_rotina(
    state: State<'_, AppState>,
    rotina_id: Uuid,
    start_local_time: String,
    minutos_planejados: i64,
    atividade: String,
    pomodoro_cycles: Option<i64>,
    titulo: Option<String>,
    subject_id: Option<Uuid>,
) -> Result<ItemDeRotina> {
    criar_item_de_rotina_inner(
        &state,
        rotina_id,
        &start_local_time,
        minutos_planejados,
        &atividade,
        pomodoro_cycles,
        titulo,
        subject_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn criar_item_de_rotina_inner(
    state: &AppState,
    rotina_id: Uuid,
    start_local_time: &str,
    minutos_planejados: i64,
    atividade: &str,
    pomodoro_cycles: Option<i64>,
    titulo: Option<String>,
    subject_id: Option<Uuid>,
) -> Result<ItemDeRotina> {
    cronograma_repository(state)?
        .criar_item_de_rotina(rotina_id, start_local_time, minutos_planejados, atividade, pomodoro_cycles, titulo, subject_id)
        .await
}

/// `listar_itens_de_rotina`.
#[tauri::command]
pub async fn listar_itens_de_rotina(state: State<'_, AppState>, rotina_id: Uuid) -> Result<Vec<ItemDeRotina>> {
    listar_itens_de_rotina_inner(&state, rotina_id).await
}

async fn listar_itens_de_rotina_inner(state: &AppState, rotina_id: Uuid) -> Result<Vec<ItemDeRotina>> {
    cronograma_repository(state)?.listar_itens_de_rotina(rotina_id).await
}

/// `atualizar_item_de_rotina`.
#[tauri::command]
pub async fn atualizar_item_de_rotina(
    state: State<'_, AppState>,
    item_id: Uuid,
    patch: ItemDeRotinaPatchInput,
) -> Result<ItemDeRotina> {
    atualizar_item_de_rotina_inner(&state, item_id, patch).await
}

async fn atualizar_item_de_rotina_inner(state: &AppState, item_id: Uuid, patch: ItemDeRotinaPatchInput) -> Result<ItemDeRotina> {
    cronograma_repository(state)?.atualizar_item_de_rotina(item_id, patch).await
}

/// `remover_item_de_rotina`.
#[tauri::command]
pub async fn remover_item_de_rotina(state: State<'_, AppState>, item_id: Uuid) -> Result<()> {
    remover_item_de_rotina_inner(&state, item_id).await
}

async fn remover_item_de_rotina_inner(state: &AppState, item_id: Uuid) -> Result<()> {
    cronograma_repository(state)?.remover_item_de_rotina(item_id).await
}

/// `aplicar_rotina`: materializa a rotina num dia real. Ver
/// `CronogramaRepository::aplicar_rotina` para a transação, a idempotência
/// e o porquê da assinatura já caber as fatias 2 e 3.
#[tauri::command]
pub async fn aplicar_rotina(
    state: State<'_, AppState>,
    rotina_id: Uuid,
    data_inicio: String,
    data_fim: String,
    modo: ModoDeAplicacaoDeRotina,
    hoje_local: String,
) -> Result<AplicacaoDeRotina> {
    aplicar_rotina_inner(&state, rotina_id, &data_inicio, &data_fim, modo, &hoje_local).await
}

async fn aplicar_rotina_inner(
    state: &AppState,
    rotina_id: Uuid,
    data_inicio: &str,
    data_fim: &str,
    modo: ModoDeAplicacaoDeRotina,
    hoje_local: &str,
) -> Result<AplicacaoDeRotina> {
    cronograma_repository(state)?.aplicar_rotina(rotina_id, data_inicio, data_fim, modo, hoje_local).await
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
        async fn semana_de_estudo_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(semana_de_estudo_inner(&state, "2026-08-31").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_meta_semanal_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(definir_meta_semanal_inner(&state, "2026-08-31", 480).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn criar_bloco_reports_not_connected() {
            let state = AppState::new();
            let result = criar_bloco_inner(&state, "2026-08-31", "reading", 30, None, None, None, None, None, None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn mover_bloco_reports_not_connected() {
            let state = AppState::new();
            let result = mover_bloco_inner(&state, Uuid::now_v7(), "2026-08-31", None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn atualizar_bloco_reports_not_connected() {
            let state = AppState::new();
            let result = atualizar_bloco_inner(&state, Uuid::now_v7(), BlocoPatchInput::default()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_bloco_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_bloco_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn criar_materia_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(criar_materia_inner(&state, "Química", None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_materias_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_materias_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn atualizar_materia_reports_not_connected() {
            let state = AppState::new();
            let result = atualizar_materia_inner(&state, Uuid::now_v7(), MateriaPatchInput::default()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_materia_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_materia_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn copiar_semana_reports_not_connected() {
            let state = AppState::new();
            let result = copiar_semana_inner(&state, "2026-08-31", "2026-09-07").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-cronograma-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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
        async fn criar_bloco_then_semana_de_estudo_returns_it_on_the_right_day() {
            let (state, data_dir) = estado_com_banco("criar-entao-semana").await;

            // 2026-08-31 é segunda-feira.
            let bloco =
                criar_bloco_inner(&state, "2026-09-01", "reading", 30, None, None, Some("Capítulo 3".into()), None, None, None)
                    .await
                    .unwrap();
            assert_eq!(bloco.title, "Capítulo 3");
            assert_eq!(bloco.planned_minutes, 30);
            assert!(bloco.start_local_time.is_none());
            assert!(bloco.pomodoro_cycles.is_none());

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert_eq!(semana.dias.len(), 7);
            let terca = semana.dias.iter().find(|d| d.data == "2026-09-01").unwrap();
            assert_eq!(terca.blocos.len(), 1);
            assert_eq!(terca.blocos[0].id, bloco.id);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_bloco_with_no_title_defaults_to_empty_string() {
            let (state, data_dir) = estado_com_banco("titulo-vazio").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 15, None, None, None, None, None, None).await.unwrap();
            assert_eq!(bloco.title, "");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_bloco_rejects_an_invalid_activity() {
            let (state, data_dir) = estado_com_banco("atividade-invalida").await;

            let result = criar_bloco_inner(&state, "2026-08-31", "almoço", 30, None, None, None, None, None, None).await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_bloco_rejects_zero_planned_minutes() {
            let (state, data_dir) = estado_com_banco("zero-minutos").await;

            let result = criar_bloco_inner(&state, "2026-08-31", "reading", 0, None, None, None, None, None, None).await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn definir_meta_semanal_then_semana_de_estudo_reports_it_and_a_later_week_inherits_it() {
            let (state, data_dir) = estado_com_banco("meta-herdada").await;

            definir_meta_semanal_inner(&state, "2026-08-31", 480).await.unwrap();

            let semana1 = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert_eq!(semana1.meta_minutos, 480);

            // Semana seguinte, sem meta própria: herda a última definida.
            let semana2 = semana_de_estudo_inner(&state, "2026-09-07").await.unwrap();
            assert_eq!(semana2.meta_minutos, 480);

            // Redefinir a mesma semana é UPDATE, não uma segunda linha.
            definir_meta_semanal_inner(&state, "2026-08-31", 600).await.unwrap();
            let semana1_atualizada = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert_eq!(semana1_atualizada.meta_minutos, 600);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn semana_de_estudo_defaults_meta_to_zero_when_none_was_ever_set() {
            let (state, data_dir) = estado_com_banco("sem-meta").await;

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert_eq!(semana.meta_minutos, 0);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn semana_de_estudo_rejects_a_start_date_that_is_not_a_monday() {
            let (state, data_dir) = estado_com_banco("nao-segunda").await;

            let result = semana_de_estudo_inner(&state, "2026-09-01").await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn mover_bloco_reorders_within_the_same_day_after_a_given_sibling() {
            let (state, data_dir) = estado_com_banco("reordena-mesmo-dia").await;

            let a = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, Some("A".into()), None, None, None).await.unwrap();
            let b = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, Some("B".into()), None, None, None).await.unwrap();
            // Nasce: A, B (A criado primeiro, ambos no fim do dia).
            assert!(a.position < b.position);

            // Move A para depois de B.
            let moved = mover_bloco_inner(&state, a.id, "2026-08-31", Some(b.id)).await.unwrap();
            assert!(moved.position > b.position);

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            let segunda = &semana.dias[0];
            let ids: Vec<Uuid> = segunda.blocos.iter().map(|bloco| bloco.id).collect();
            assert_eq!(ids, vec![b.id, a.id]);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn mover_bloco_moves_to_a_different_day() {
            let (state, data_dir) = estado_com_banco("muda-de-dia").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, None, None, None, None).await.unwrap();
            let moved = mover_bloco_inner(&state, bloco.id, "2026-09-02", None).await.unwrap();
            assert_eq!(moved.local_date, "2026-09-02");

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert!(semana.dias[0].blocos.is_empty(), "segunda não tem mais o bloco");
            assert_eq!(semana.dias[2].blocos.len(), 1, "quarta (offset 2) recebeu o bloco");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn mover_bloco_rejects_an_after_id_that_is_not_a_sibling_in_the_destination_day() {
            let (state, data_dir) = estado_com_banco("apos-invalido").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, None, None, None, None).await.unwrap();
            let estranho = Uuid::now_v7();

            let result = mover_bloco_inner(&state, bloco.id, "2026-09-02", Some(estranho)).await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn mover_bloco_of_an_unknown_id_reports_not_found() {
            let (state, data_dir) = estado_com_banco("mover-desconhecido").await;

            let result = mover_bloco_inner(&state, Uuid::now_v7(), "2026-08-31", None).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_bloco_patches_only_the_given_fields_leaving_the_rest_untouched() {
            let (state, data_dir) = estado_com_banco("patch-parcial").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "pomodoro", 50, None, None, Some("Foco".into()), None, None, None)
                .await
                .unwrap();

            let patch = BlocoPatchInput { start_local_time: Some("19:00".into()), pomodoro_cycles: Some(2), ..Default::default() };
            let updated = atualizar_bloco_inner(&state, bloco.id, patch).await.unwrap();

            assert_eq!(updated.start_local_time, Some("19:00".into()));
            assert_eq!(updated.pomodoro_cycles, Some(2));
            // Não pedidos no patch: continuam como estavam.
            assert_eq!(updated.title, "Foco");
            assert_eq!(updated.planned_minutes, 50);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_bloco_rejects_an_invalid_activity_without_touching_the_row() {
            let (state, data_dir) = estado_com_banco("patch-atividade-invalida").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, None, None, None, None).await.unwrap();
            let patch = BlocoPatchInput { activity: Some("almoço".into()), ..Default::default() };

            let result = atualizar_bloco_inner(&state, bloco.id, patch).await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_bloco_of_an_unknown_id_reports_not_found() {
            let (state, data_dir) = estado_com_banco("patch-desconhecido").await;

            let result = atualizar_bloco_inner(&state, Uuid::now_v7(), BlocoPatchInput::default()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_bloco_deletes_and_a_second_removal_reports_not_found() {
            let (state, data_dir) = estado_com_banco("remover").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 10, None, None, None, None, None, None).await.unwrap();
            remover_bloco_inner(&state, bloco.id).await.unwrap();

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert!(semana.dias[0].blocos.is_empty());

            let second = remover_bloco_inner(&state, bloco.id).await;
            assert!(matches!(second, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        /// O caso central desta peça: uma sessão de pomodoro concluída às 23h
        /// de terça em São Paulo (UTC-3) — `started_at` em UTC cai já na
        /// quarta (00h30) — precisa ser creditada a TERÇA na faixa semanal,
        /// porque `local_date` é o que a query usa, nunca `started_at`
        /// truncado. A sessão é inserida direto por SQL (não por
        /// `PomodoroRepository::start`, que grava `local_date` a partir do
        /// relógio real da máquina de teste) para fixar o instante e o
        /// offset e provar exatamente a virada, sem depender do fuso de quem
        /// roda o teste.
        #[tokio::test]
        async fn semana_de_estudo_credits_a_late_night_session_to_its_local_date_not_the_utc_date() {
            let (state, data_dir) = estado_com_banco("virada-de-dia").await;
            let pool = state.pool().unwrap();

            sqlx::query(
                "INSERT INTO pomodoro_sessions \
                     (id, kind, started_at, ended_at, duration_seconds, completed, local_date, utc_offset_minutes) \
                 VALUES ($1, 'focus', '2026-09-02T02:00:00.000Z', '2026-09-02T02:25:00.000Z', 1500, 1, '2026-09-01', -180)",
            )
            .bind(Uuid::now_v7().to_string())
            .execute(&pool)
            .await
            .unwrap();

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            let terca = semana.dias.iter().find(|d| d.data == "2026-09-01").unwrap();
            let quarta = semana.dias.iter().find(|d| d.data == "2026-09-02").unwrap();

            assert_eq!(terca.minutos_realizados, 25, "os 1500s da sessão pertencem à terça (dia local)");
            assert_eq!(quarta.minutos_realizados, 0, "não à quarta, que é o dia UTC de started_at");

            encerra(state, data_dir).await;
        }

        /// O "6,5 / 8" da maquete: o realizado do dia soma timer (sessão de
        /// pomodoro) E lançamento manual (`study_time_entries`), sem que
        /// nenhum dos dois precise saber do outro — é a view
        /// `study_day_totals` que faz essa soma, uma vez só.
        #[tokio::test]
        async fn semana_de_estudo_sums_pomodoro_minutes_and_manual_entries_for_the_same_day() {
            let (state, data_dir) = estado_com_banco("soma-duas-fontes").await;
            let pool = state.pool().unwrap();

            sqlx::query(
                "INSERT INTO pomodoro_sessions \
                     (id, kind, started_at, ended_at, duration_seconds, completed, local_date, utc_offset_minutes) \
                 VALUES ($1, 'focus', '2026-08-31T12:00:00.000Z', '2026-08-31T12:25:00.000Z', 1500, 1, '2026-08-31', -180)",
            )
            .bind(Uuid::now_v7().to_string())
            .execute(&pool)
            .await
            .unwrap();

            sqlx::query("INSERT INTO study_time_entries (id, local_date, minutes, activity) VALUES ($1, '2026-08-31', 20, 'review')")
                .bind(Uuid::now_v7().to_string())
                .execute(&pool)
                .await
                .unwrap();

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            // 1500s = 25 min de pomodoro + 20 min manuais.
            assert_eq!(semana.dias[0].minutos_realizados, 45);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_materia_then_listar_materias_returns_it_sorted_by_name() {
            let (state, data_dir) = estado_com_banco("materia-criar-listar").await;

            // Nomes sem acento no primeiro caractere de propósito: SQLite
            // `NOCASE` só dobra maiúscula/minúscula ASCII — um acento
            // (`Álgebra`) muda o byte líder e a ordem deixaria de ser a
            // alfabética "de olho" que este teste quer provar.
            criar_materia_inner(&state, "Química", Some("terracotta".into())).await.unwrap();
            criar_materia_inner(&state, "biologia", None).await.unwrap();

            let materias = listar_materias_inner(&state).await.unwrap();
            let nomes: Vec<&str> = materias.iter().map(|m| m.name.as_str()).collect();
            // Ordem alfabética (COLLATE NOCASE), não a de criação.
            assert_eq!(nomes, vec!["biologia", "Química"]);
            assert_eq!(materias.iter().find(|m| m.name == "Química").unwrap().color, "terracotta");
            // Sem `cor` explícita: cai na cor padrão, sempre uma chave válida.
            assert_eq!(materias.iter().find(|m| m.name == "biologia").unwrap().color, "amber");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_materia_rejects_an_empty_name_and_an_invalid_color() {
            let (state, data_dir) = estado_com_banco("materia-invalida").await;

            let vazio = criar_materia_inner(&state, "   ", None).await;
            assert!(matches!(vazio, Err(Error::Invalid(_))));

            let cor_ruim = criar_materia_inner(&state, "Biologia", Some("magenta-neon".into())).await;
            assert!(matches!(cor_ruim, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_materia_renames_and_recolors_it() {
            let (state, data_dir) = estado_com_banco("materia-renomear").await;

            let materia = criar_materia_inner(&state, "Fisica", Some("azul".into())).await.unwrap();
            let patch = MateriaPatchInput { name: Some("Física".into()), color: Some("roxo".into()) };
            let atualizada = atualizar_materia_inner(&state, materia.id, patch).await.unwrap();

            assert_eq!(atualizada.name, "Física");
            assert_eq!(atualizada.color, "roxo");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_materia_then_a_block_referencing_it_keeps_its_frozen_title_and_loses_the_link() {
            let (state, data_dir) = estado_com_banco("materia-remover").await;

            let materia = criar_materia_inner(&state, "Química", Some("terracotta".into())).await.unwrap();
            let bloco = criar_bloco_inner(
                &state,
                "2026-08-31",
                "other",
                30,
                None,
                None,
                Some("Química".into()),
                None,
                None,
                Some(materia.id),
            )
            .await
            .unwrap();
            assert_eq!(bloco.subject_id, Some(materia.id));

            remover_materia_inner(&state, materia.id).await.unwrap();

            let semana = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            let atualizado = &semana.dias[0].blocos[0];
            assert_eq!(atualizado.subject_id, None, "ON DELETE SET NULL solta o vínculo");
            assert_eq!(atualizado.title, "Química", "o título congelado sobrevive à matéria apagada");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_bloco_without_a_start_time_has_no_derived_end_time() {
            let (state, data_dir) = estado_com_banco("fim-sem-inicio").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "reading", 30, None, None, None, None, None, None).await.unwrap();

            assert!(bloco.end_local_time.is_none());
            assert!(!bloco.crosses_midnight);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_bloco_setting_a_start_time_derives_the_end_time() {
            let (state, data_dir) = estado_com_banco("fim-derivado").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 60, None, None, None, None, None, None).await.unwrap();
            let patch = BlocoPatchInput { start_local_time: Some("08:00".into()), ..Default::default() };
            let atualizado = atualizar_bloco_inner(&state, bloco.id, patch).await.unwrap();

            assert_eq!(atualizado.end_local_time, Some("09:00".into()));
            assert!(!atualizado.crosses_midnight);

            encerra(state, data_dir).await;
        }

        /// O caso de borda do item 1 do comentário de módulo: um bloco que
        /// atravessa a meia-noite (23:45 + 30 min) termina, em relógio de
        /// parede, às 00:15 — e a flag avisa a virada.
        #[tokio::test]
        async fn atualizar_bloco_start_time_crossing_midnight_sets_the_flag() {
            let (state, data_dir) = estado_com_banco("fim-atravessa-meia-noite").await;

            let bloco = criar_bloco_inner(&state, "2026-08-31", "other", 30, None, None, None, None, None, None).await.unwrap();
            let patch = BlocoPatchInput { start_local_time: Some("23:45".into()), ..Default::default() };
            let atualizado = atualizar_bloco_inner(&state, bloco.id, patch).await.unwrap();

            assert_eq!(atualizado.end_local_time, Some("00:15".into()));
            assert!(atualizado.crosses_midnight);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn copiar_semana_copies_blocks_shifted_by_the_week_offset_and_leaves_the_source_untouched() {
            let (state, data_dir) = estado_com_banco("copiar-semana").await;

            // Segunda (offset 0) e quarta (offset 2) da semana de origem.
            let segunda = criar_bloco_inner(&state, "2026-08-31", "other", 30, None, None, Some("Segunda".into()), None, None, None)
                .await
                .unwrap();
            let patch_segunda = BlocoPatchInput { start_local_time: Some("08:00".into()), ..Default::default() };
            atualizar_bloco_inner(&state, segunda.id, patch_segunda).await.unwrap();
            criar_bloco_inner(&state, "2026-09-02", "other", 45, None, None, Some("Quarta".into()), None, None, None).await.unwrap();

            let copiados = copiar_semana_inner(&state, "2026-08-31", "2026-09-07").await.unwrap();
            assert_eq!(copiados.len(), 2, "os dois blocos da semana de origem foram copiados");

            let semana_destino = semana_de_estudo_inner(&state, "2026-09-07").await.unwrap();
            // offset 0 -> 2026-09-07 (a nova segunda); offset 2 -> 2026-09-09.
            let nova_segunda = semana_destino.dias.iter().find(|d| d.data == "2026-09-07").unwrap();
            let nova_quarta = semana_destino.dias.iter().find(|d| d.data == "2026-09-09").unwrap();
            assert_eq!(nova_segunda.blocos.len(), 1);
            assert_eq!(nova_segunda.blocos[0].title, "Segunda");
            // Campos copiados junto, inclusive o horário — e o fim continua
            // sendo derivado corretamente na cópia, não copiado como texto.
            assert_eq!(nova_segunda.blocos[0].start_local_time, Some("08:00".into()));
            assert_eq!(nova_segunda.blocos[0].end_local_time, Some("08:30".into()));
            assert_eq!(nova_quarta.blocos.len(), 1);
            assert_eq!(nova_quarta.blocos[0].title, "Quarta");
            // Ids novos: a cópia não reaproveita o id do original.
            assert_ne!(nova_segunda.blocos[0].id, segunda.id);

            // A semana de origem continua exatamente como estava.
            let semana_origem = semana_de_estudo_inner(&state, "2026-08-31").await.unwrap();
            assert_eq!(semana_origem.dias[0].blocos.len(), 1);
            assert_eq!(semana_origem.dias[2].blocos.len(), 1);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn copiar_semana_rejects_copying_a_week_onto_itself() {
            let (state, data_dir) = estado_com_banco("copiar-mesma-semana").await;

            let result = copiar_semana_inner(&state, "2026-08-31", "2026-08-31").await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn copiar_semana_rejects_a_non_monday_start() {
            let (state, data_dir) = estado_com_banco("copiar-nao-segunda").await;

            let result = copiar_semana_inner(&state, "2026-08-31", "2026-09-08").await;
            assert!(matches!(result, Err(Error::Invalid(_))));

            encerra(state, data_dir).await;
        }
    }
}
