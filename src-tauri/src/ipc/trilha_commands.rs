//! Comandos `#[tauri::command]` da Trilha — segue exatamente o desenho de
//! `ipc::mindmap_commands`/`ipc::cronograma_commands`: cada comando monta o
//! repositório certo a partir de `state.pool()` e delega a ele, com um par
//! `_inner` testável sem `AppHandle` — ver o comentário de `page_repository`
//! em `ipc::commands` para por que nenhum teste aqui pode passar por
//! `tauri::test::mock_builder`.

use tauri::State;
use uuid::Uuid;

use crate::db::pages::PageRow;
use crate::db::trilha::TrilhaRecemCriada;
use crate::db::{
    ConfiguracaoTrilha, Decisao, Etapa, Flecha, ImpactoDaTroca, MaterialDaEtapa, ProgressoDaEtapa, Raia, Trilha,
    TrilhaRepository, TrilhaResumo,
};
use crate::error::Result;
use crate::ipc::state::AppState;

fn trilha_repository(state: &AppState) -> Result<TrilhaRepository> {
    Ok(TrilhaRepository::new(state.pool()?))
}

/// A trilha inteira de uma view: raias, etapas (já com nível topológico e
/// desbloqueio calculados), flechas e materiais — a tela monta a cena
/// inteira a partir disto, como `get_mindmap` já faz para o mapa mental.
#[tauri::command]
pub async fn obter_trilha(state: State<'_, AppState>, view_id: Uuid) -> Result<Trilha> {
    obter_trilha_inner(&state, view_id).await
}

async fn obter_trilha_inner(state: &AppState, view_id: Uuid) -> Result<Trilha> {
    trilha_repository(state)?.obter_trilha(view_id).await
}

/// Nasce a configuração da Trilha para uma `database_views` já existente
/// (com `view_type = 'trail'`). Ver o comentário de
/// `TrilhaRepository::criar_trilha` — criar a view genérica em si não é
/// escopo deste comando.
#[tauri::command]
pub async fn criar_trilha(
    state: State<'_, AppState>,
    view_id: Uuid,
    group_property_id: Option<Uuid>,
) -> Result<ConfiguracaoTrilha> {
    criar_trilha_inner(&state, view_id, group_property_id).await
}

async fn criar_trilha_inner(state: &AppState, view_id: Uuid, group_property_id: Option<Uuid>) -> Result<ConfiguracaoTrilha> {
    trilha_repository(state)?.criar_trilha(view_id, group_property_id).await
}

/// Toda trilha do workspace, para o painel de troca — ver o comentário de
/// `TrilhaRepository::listar_trilhas`.
#[tauri::command]
pub async fn listar_trilhas(state: State<'_, AppState>) -> Result<Vec<TrilhaResumo>> {
    listar_trilhas_inner(&state).await
}

async fn listar_trilhas_inner(state: &AppState) -> Result<Vec<TrilhaResumo>> {
    trilha_repository(state)?.listar_trilhas().await
}

/// Configura depois da criação a propriedade que agrupa a trilha em raias —
/// ver o comentário de `TrilhaRepository::definir_propriedade_de_agrupamento`.
#[tauri::command]
pub async fn definir_propriedade_de_agrupamento_da_trilha(
    state: State<'_, AppState>,
    view_id: Uuid,
    group_property_id: Option<Uuid>,
) -> Result<ConfiguracaoTrilha> {
    definir_propriedade_de_agrupamento_da_trilha_inner(&state, view_id, group_property_id).await
}

async fn definir_propriedade_de_agrupamento_da_trilha_inner(
    state: &AppState,
    view_id: Uuid,
    group_property_id: Option<Uuid>,
) -> Result<ConfiguracaoTrilha> {
    trilha_repository(state)?.definir_propriedade_de_agrupamento(view_id, group_property_id).await
}

#[tauri::command]
pub async fn criar_raia(state: State<'_, AppState>, view_id: Uuid, lane_value: String) -> Result<Raia> {
    criar_raia_inner(&state, view_id, &lane_value).await
}

async fn criar_raia_inner(state: &AppState, view_id: Uuid, lane_value: &str) -> Result<Raia> {
    trilha_repository(state)?.criar_raia(view_id, lane_value).await
}

#[tauri::command]
pub async fn renomear_raia(
    state: State<'_, AppState>,
    view_id: Uuid,
    valor_atual: String,
    novo_valor: String,
) -> Result<Raia> {
    renomear_raia_inner(&state, view_id, &valor_atual, &novo_valor).await
}

async fn renomear_raia_inner(state: &AppState, view_id: Uuid, valor_atual: &str, novo_valor: &str) -> Result<Raia> {
    trilha_repository(state)?.renomear_raia(view_id, valor_atual, novo_valor).await
}

#[tauri::command]
pub async fn reordenar_raia(
    state: State<'_, AppState>,
    view_id: Uuid,
    lane_value: String,
    apos_lane_value: Option<String>,
) -> Result<Raia> {
    reordenar_raia_inner(&state, view_id, &lane_value, apos_lane_value.as_deref()).await
}

async fn reordenar_raia_inner(
    state: &AppState,
    view_id: Uuid,
    lane_value: &str,
    apos_lane_value: Option<&str>,
) -> Result<Raia> {
    trilha_repository(state)?.reordenar_raia(view_id, lane_value, apos_lane_value).await
}

#[tauri::command]
pub async fn definir_raia_recolhida(
    state: State<'_, AppState>,
    view_id: Uuid,
    lane_value: String,
    recolhida: bool,
) -> Result<Raia> {
    definir_raia_recolhida_inner(&state, view_id, &lane_value, recolhida).await
}

async fn definir_raia_recolhida_inner(state: &AppState, view_id: Uuid, lane_value: &str, recolhida: bool) -> Result<Raia> {
    trilha_repository(state)?.definir_raia_recolhida(view_id, lane_value, recolhida).await
}

/// Apaga a raia — as etapas que estavam nela NÃO somem, ficam sem raia
/// (TRL-014). Ver o comentário de `TrilhaRepository::remover_raia`.
#[tauri::command]
pub async fn remover_raia(state: State<'_, AppState>, view_id: Uuid, lane_value: String) -> Result<()> {
    remover_raia_inner(&state, view_id, &lane_value).await
}

async fn remover_raia_inner(state: &AppState, view_id: Uuid, lane_value: &str) -> Result<()> {
    trilha_repository(state)?.remover_raia(view_id, lane_value).await
}

/// Move a etapa para outra raia — grava outro valor na propriedade de
/// agrupamento (TRL-009), não mexe em `trail_lanes`.
#[tauri::command]
pub async fn mover_etapa_para_raia(
    state: State<'_, AppState>,
    step_id: Uuid,
    view_id: Uuid,
    lane_value: String,
) -> Result<()> {
    mover_etapa_para_raia_inner(&state, step_id, view_id, &lane_value).await
}

async fn mover_etapa_para_raia_inner(state: &AppState, step_id: Uuid, view_id: Uuid, lane_value: &str) -> Result<()> {
    trilha_repository(state)?.mover_etapa_para_raia(step_id, view_id, lane_value).await
}

/// Marca a etapa como `in_progress` ou `done`. Concluir uma etapa bloqueada
/// é recusado — ver o comentário de `TrilhaRepository::marcar_progresso_etapa`.
#[tauri::command]
pub async fn marcar_progresso_etapa(state: State<'_, AppState>, step_id: Uuid, state_value: String) -> Result<ProgressoDaEtapa> {
    marcar_progresso_etapa_inner(&state, step_id, &state_value).await
}

async fn marcar_progresso_etapa_inner(state: &AppState, step_id: Uuid, state_value: &str) -> Result<ProgressoDaEtapa> {
    trilha_repository(state)?.marcar_progresso_etapa(step_id, state_value).await
}

#[tauri::command]
pub async fn desmarcar_progresso_etapa(state: State<'_, AppState>, step_id: Uuid) -> Result<()> {
    desmarcar_progresso_etapa_inner(&state, step_id).await
}

async fn desmarcar_progresso_etapa_inner(state: &AppState, step_id: Uuid) -> Result<()> {
    trilha_repository(state)?.desmarcar_progresso_etapa(step_id).await
}

#[tauri::command]
pub async fn etapa_esta_desbloqueada(state: State<'_, AppState>, step_id: Uuid) -> Result<bool> {
    etapa_esta_desbloqueada_inner(&state, step_id).await
}

async fn etapa_esta_desbloqueada_inner(state: &AppState, step_id: Uuid) -> Result<bool> {
    trilha_repository(state)?.etapa_esta_desbloqueada(step_id).await
}

#[tauri::command]
pub async fn anexar_material_etapa(
    state: State<'_, AppState>,
    step_id: Uuid,
    kind: String,
    page_id: Option<Uuid>,
    deck_id: Option<Uuid>,
) -> Result<MaterialDaEtapa> {
    anexar_material_etapa_inner(&state, step_id, &kind, page_id, deck_id).await
}

async fn anexar_material_etapa_inner(
    state: &AppState,
    step_id: Uuid,
    kind: &str,
    page_id: Option<Uuid>,
    deck_id: Option<Uuid>,
) -> Result<MaterialDaEtapa> {
    trilha_repository(state)?.anexar_material_etapa(step_id, kind, page_id, deck_id).await
}

#[tauri::command]
pub async fn remover_material_etapa(state: State<'_, AppState>, material_id: Uuid) -> Result<()> {
    remover_material_etapa_inner(&state, material_id).await
}

async fn remover_material_etapa_inner(state: &AppState, material_id: Uuid) -> Result<()> {
    trilha_repository(state)?.remover_material_etapa(material_id).await
}

/// Apaga (manda para a lixeira) a etapa — reversível via `restore_page`. Ver
/// o comentário de `TrilhaRepository::remover_etapa` para as decisões de
/// cascata (flechas apagadas nas duas direções, sem religação automática;
/// progresso/materiais/decisão preservados para a restauração).
#[tauri::command]
pub async fn remover_etapa(state: State<'_, AppState>, step_id: Uuid) -> Result<PageRow> {
    remover_etapa_inner(&state, step_id).await
}

async fn remover_etapa_inner(state: &AppState, step_id: Uuid) -> Result<PageRow> {
    trilha_repository(state)?.remover_etapa(step_id).await
}

/// Cria a flecha (dependência) entre dois registros da mesma database — ver
/// o comentário de `TrilhaRepository::criar_flecha` para as regras: mesma
/// database, sem auto-referência, idempotente, ciclo permitido de propósito.
/// `path_label` (0035) rotula o caminho — só aceito saindo de uma decisão.
#[tauri::command]
pub async fn criar_flecha(
    state: State<'_, AppState>,
    blocked_id: Uuid,
    blocking_id: Uuid,
    path_label: Option<String>,
) -> Result<Flecha> {
    criar_flecha_inner(&state, blocked_id, blocking_id, path_label).await
}

async fn criar_flecha_inner(state: &AppState, blocked_id: Uuid, blocking_id: Uuid, path_label: Option<String>) -> Result<Flecha> {
    trilha_repository(state)?.criar_flecha(blocked_id, blocking_id, path_label).await
}

/// Apaga a flecha. Idempotente — ver o comentário de
/// `TrilhaRepository::apagar_flecha`.
#[tauri::command]
pub async fn apagar_flecha(state: State<'_, AppState>, blocked_id: Uuid, blocking_id: Uuid) -> Result<()> {
    apagar_flecha_inner(&state, blocked_id, blocking_id).await
}

async fn apagar_flecha_inner(state: &AppState, blocked_id: Uuid, blocking_id: Uuid) -> Result<()> {
    trilha_repository(state)?.apagar_flecha(blocked_id, blocking_id).await
}

/// Cria a database, a view Trilha e a configuração da Trilha num passo só —
/// ver o comentário de `TrilhaRepository::criar_trilha_completa` para o
/// porquê de isto não ser uma única transação SQL (compensação, não
/// rollback, e por quê).
#[tauri::command]
pub async fn criar_trilha_completa(
    state: State<'_, AppState>,
    container_page_id: Uuid,
    database_name: String,
    view_name: String,
    group_property_id: Option<Uuid>,
) -> Result<TrilhaRecemCriada> {
    criar_trilha_completa_inner(&state, container_page_id, &database_name, &view_name, group_property_id).await
}

async fn criar_trilha_completa_inner(
    state: &AppState,
    container_page_id: Uuid,
    database_name: &str,
    view_name: &str,
    group_property_id: Option<Uuid>,
) -> Result<TrilhaRecemCriada> {
    trilha_repository(state)?.criar_trilha_completa(container_page_id, database_name, view_name, group_property_id).await
}

/// Cria a etapa (registro) e já a coloca na raia — ver o comentário de
/// `TrilhaRepository::criar_etapa`. `laneValue = ""` é "sem raia" (TRL-014).
#[tauri::command]
pub async fn criar_etapa(state: State<'_, AppState>, view_id: Uuid, title: String, lane_value: String) -> Result<Etapa> {
    criar_etapa_inner(&state, view_id, &title, &lane_value).await
}

async fn criar_etapa_inner(state: &AppState, view_id: Uuid, title: &str, lane_value: &str) -> Result<Etapa> {
    trilha_repository(state)?.criar_etapa(view_id, title, lane_value).await
}

/// Marca a etapa como decisão — ver o comentário de
/// `TrilhaRepository::marcar_etapa_como_decisao`.
#[tauri::command]
pub async fn marcar_etapa_como_decisao(state: State<'_, AppState>, step_id: Uuid) -> Result<Decisao> {
    marcar_etapa_como_decisao_inner(&state, step_id).await
}

async fn marcar_etapa_como_decisao_inner(state: &AppState, step_id: Uuid) -> Result<Decisao> {
    trilha_repository(state)?.marcar_etapa_como_decisao(step_id).await
}

/// Desfaz a marcação de decisão — recusa com caminhos ainda saindo dela, ver
/// o comentário de `TrilhaRepository::desmarcar_etapa_como_decisao`.
#[tauri::command]
pub async fn desmarcar_etapa_como_decisao(state: State<'_, AppState>, step_id: Uuid) -> Result<()> {
    desmarcar_etapa_como_decisao_inner(&state, step_id).await
}

async fn desmarcar_etapa_como_decisao_inner(state: &AppState, step_id: Uuid) -> Result<()> {
    trilha_repository(state)?.desmarcar_etapa_como_decisao(step_id).await
}

/// Escolhe (`Some`) ou zera (`None`) o caminho de uma decisão — ver o
/// comentário de `TrilhaRepository::escolher_caminho`.
#[tauri::command]
pub async fn escolher_caminho(state: State<'_, AppState>, decision_id: Uuid, path_label: Option<String>) -> Result<Decisao> {
    escolher_caminho_inner(&state, decision_id, path_label).await
}

async fn escolher_caminho_inner(state: &AppState, decision_id: Uuid, path_label: Option<String>) -> Result<Decisao> {
    trilha_repository(state)?.escolher_caminho(decision_id, path_label).await
}

/// Renomeia (ou dissolve, com `novoRotulo = null`) um caminho — ver o
/// comentário de `TrilhaRepository::renomear_caminho`. Devolve quantas
/// flechas mudaram.
#[tauri::command]
pub async fn renomear_caminho(
    state: State<'_, AppState>,
    decision_id: Uuid,
    rotulo_atual: String,
    novo_rotulo: Option<String>,
) -> Result<u64> {
    renomear_caminho_inner(&state, decision_id, &rotulo_atual, novo_rotulo).await
}

async fn renomear_caminho_inner(
    state: &AppState,
    decision_id: Uuid,
    rotulo_atual: &str,
    novo_rotulo: Option<String>,
) -> Result<u64> {
    trilha_repository(state)?.renomear_caminho(decision_id, rotulo_atual, novo_rotulo).await
}

/// Prévia (leitura pura) do impacto de trocar a escolha de uma decisão — ver
/// o comentário de `TrilhaRepository::prever_troca_de_caminho`.
#[tauri::command]
pub async fn prever_troca_de_caminho(
    state: State<'_, AppState>,
    decision_id: Uuid,
    novo_rotulo: Option<String>,
) -> Result<ImpactoDaTroca> {
    prever_troca_de_caminho_inner(&state, decision_id, novo_rotulo).await
}

async fn prever_troca_de_caminho_inner(state: &AppState, decision_id: Uuid, novo_rotulo: Option<String>) -> Result<ImpactoDaTroca> {
    trilha_repository(state)?.prever_troca_de_caminho(decision_id, novo_rotulo).await
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa isenção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    // Um representante por comando prova que cada um está de fato ligado a
    // `trilha_repository` — mesmo padrão de `ipc::mindmap_commands::tests`.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn obter_trilha_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(obter_trilha_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn criar_trilha_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(criar_trilha_inner(&state, Uuid::now_v7(), None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn criar_raia_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(criar_raia_inner(&state, Uuid::now_v7(), "T.I.").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_trilhas_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_trilhas_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_propriedade_de_agrupamento_da_trilha_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                definir_propriedade_de_agrupamento_da_trilha_inner(&state, Uuid::now_v7(), None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn marcar_progresso_etapa_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                marcar_progresso_etapa_inner(&state, Uuid::now_v7(), "done").await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn etapa_esta_desbloqueada_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(etapa_esta_desbloqueada_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn criar_flecha_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                criar_flecha_inner(&state, Uuid::now_v7(), Uuid::now_v7(), None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn criar_trilha_completa_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                criar_trilha_completa_inner(&state, Uuid::now_v7(), "Estudos", "Trilha", None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn criar_etapa_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(criar_etapa_inner(&state, Uuid::now_v7(), "Databricks", "").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_etapa_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_etapa_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_raia_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_raia_inner(&state, Uuid::now_v7(), "T.I.").await, Err(Error::Config(_))));
        }
    }

    // Um teste de ponta a ponta contra banco de verdade — a lógica de
    // negócio já está coberta em `db::trilha`/`tests/db_trilha.rs`; o que
    // falta provar aqui é só a fiação desta camada.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::ids::IdBind;
        use crate::db::pool::connect_and_migrate;

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = std::env::temp_dir().join(format!("learno-trilha-cmd-test-{rotulo}-{}", Uuid::new_v4()));
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        async fn cria_database_com_view_trilha(state: &AppState) -> Uuid {
            let pool = state.pool().unwrap();
            let container = Uuid::now_v7();
            sqlx::query("INSERT INTO pages (id, title, position) VALUES (?, 'Container', 'a0')")
                .bind(container.db())
                .execute(&pool)
                .await
                .unwrap();
            let database_id = Uuid::now_v7();
            sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES (?, ?, 'Estudos')")
                .bind(database_id.db())
                .bind(container.db())
                .execute(&pool)
                .await
                .unwrap();
            let view_id = Uuid::now_v7();
            sqlx::query("INSERT INTO database_views (id, database_id, name, view_type, position) VALUES (?, ?, 'Trilha', 'trail', 'a0')")
                .bind(view_id.db())
                .bind(database_id.db())
                .execute(&pool)
                .await
                .unwrap();
            view_id
        }

        #[tokio::test]
        async fn criar_trilha_e_obter_trilha_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("cria-obtem").await;
            let view_id = cria_database_com_view_trilha(&state).await;

            criar_trilha_inner(&state, view_id, None).await.unwrap();
            let trilha = obter_trilha_inner(&state, view_id).await.unwrap();

            assert!(trilha.raias.is_empty());
            assert!(trilha.etapas.is_empty());

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn criar_raia_aparece_na_leitura_seguinte() {
            let (state, data_dir) = estado_com_banco("cria-raia").await;
            let view_id = cria_database_com_view_trilha(&state).await;
            criar_trilha_inner(&state, view_id, None).await.unwrap();

            let raia = criar_raia_inner(&state, view_id, "T.I.").await.unwrap();
            assert_eq!(raia.lane_value, "T.I.");

            let trilha = obter_trilha_inner(&state, view_id).await.unwrap();
            assert!(trilha.raias.iter().any(|r| r.lane_value == "T.I."));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn listar_trilhas_encontra_a_trilha_recem_criada() {
            let (state, data_dir) = estado_com_banco("listar").await;
            let pool = state.pool().unwrap();
            let container = Uuid::now_v7();
            sqlx::query("INSERT INTO pages (id, title, position) VALUES (?, 'Container', 'a0')")
                .bind(container.db())
                .execute(&pool)
                .await
                .unwrap();

            let criada = criar_trilha_completa_inner(&state, container, "Estudos de T.I.", "Trilha", None).await.unwrap();
            let view_id = criada.trilha.configuracao.view_id;

            let trilhas = listar_trilhas_inner(&state).await.unwrap();
            let encontrada = trilhas.iter().find(|resumo| resumo.view_id == view_id).unwrap();
            assert_eq!(encontrada.nome, "Estudos de T.I.");
            assert_eq!(encontrada.container_page_id, container);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Prova a trava que o item 3 do pedido pede para abrir: uma trilha
        /// nascida sem `groupPropertyId` (o único caminho que a UI oferecia)
        /// ganha uma propriedade de agrupamento depois, e só a partir daí
        /// `criar_raia` nomeada passa a fazer sentido (a raia em si não exige
        /// a propriedade — só `renomear_raia`/`mover_etapa_para_raia` exigem,
        /// ver os comentários deles).
        #[tokio::test]
        async fn definir_propriedade_de_agrupamento_destrava_raia_nomeada_numa_trilha_que_nasceu_sem() {
            let (state, data_dir) = estado_com_banco("definir-agrupamento").await;
            let view_id = cria_database_com_view_trilha(&state).await;
            let pool = state.pool().unwrap();
            let database_id: crate::db::ids::DbId =
                sqlx::query_scalar("SELECT database_id FROM database_views WHERE id = ?")
                    .bind(view_id.db())
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let database_id: Uuid = database_id.into();

            criar_trilha_inner(&state, view_id, None).await.unwrap();
            let trilha_sem_agrupamento = obter_trilha_inner(&state, view_id).await.unwrap();
            assert!(trilha_sem_agrupamento.configuracao.group_property_id.is_none());

            let property_id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO database_properties (id, database_id, name, property_type, position) \
                 VALUES (?, ?, 'Raia', 'select', 'a0')",
            )
            .bind(property_id.db())
            .bind(database_id.db())
            .execute(&pool)
            .await
            .unwrap();

            let configuracao =
                definir_propriedade_de_agrupamento_da_trilha_inner(&state, view_id, Some(property_id)).await.unwrap();
            assert_eq!(configuracao.group_property_id, Some(property_id));

            let etapa = criar_etapa_inner(&state, view_id, "Databricks", "").await.unwrap();
            mover_etapa_para_raia_inner(&state, etapa.id, view_id, "T.I.").await.unwrap();
            let raia = criar_raia_inner(&state, view_id, "T.I.").await.unwrap();
            assert_eq!(raia.lane_value, "T.I.");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Prova a fiação de `criar_trilha_completa`/`criar_etapa`/`criar_flecha`
        /// juntos, de ponta a ponta pela camada de comando: a database e a
        /// view nascem por `criar_trilha_completa` (sem `cria_database_com_view_trilha`
        /// — é exatamente o caminho que esse fixture manual existia para
        /// substituir), duas etapas nascem por `criar_etapa`, uma flecha as
        /// liga por `criar_flecha`, e a leitura seguinte de `obter_trilha`
        /// mostra a flecha e o nível topológico da etapa bloqueada.
        #[tokio::test]
        async fn criar_trilha_completa_criar_etapa_e_criar_flecha_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("completa-etapa-flecha").await;
            let pool = state.pool().unwrap();
            let container = Uuid::now_v7();
            sqlx::query("INSERT INTO pages (id, title, position) VALUES (?, 'Container', 'a0')")
                .bind(container.db())
                .execute(&pool)
                .await
                .unwrap();

            let criada = criar_trilha_completa_inner(&state, container, "Estudos", "Trilha", None).await.unwrap();
            let view_id = criada.trilha.configuracao.view_id;

            let databricks = criar_etapa_inner(&state, view_id, "Databricks", "").await.unwrap();
            let azure = criar_etapa_inner(&state, view_id, "Azure", "").await.unwrap();
            criar_flecha_inner(&state, azure.id, databricks.id, None).await.unwrap();

            let trilha = obter_trilha_inner(&state, view_id).await.unwrap();
            assert_eq!(trilha.etapas.len(), 2);
            assert_eq!(trilha.flechas.len(), 1);
            assert_eq!(trilha.flechas[0].blocked_id, azure.id);
            assert_eq!(trilha.flechas[0].blocking_id, databricks.id);
            assert_eq!(trilha.etapas.iter().find(|e| e.id == azure.id).unwrap().level, 1);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
