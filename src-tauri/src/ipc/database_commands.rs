//! Comandos `#[tauri::command]` do sistema de databases (`db::databases`) —
//! segue exatamente o desenho de `ipc::trilha_commands`/`ipc::mindmap_commands`:
//! cada comando monta o repositório certo a partir de `state.pool()` e delega
//! a ele, com um par `_inner` testável sem `AppHandle` — ver o comentário de
//! `page_repository` em `ipc::commands` para por que nenhum teste aqui pode
//! passar por `tauri::test::mock_builder`.
//!
//! Esta é a peça que faltava entre o repositório (`db::databases`, que já cria
//! database/propriedade/view/registro) e o frontend: sem estes 19 comandos no
//! `generate_handler!` de `lib.rs`, nenhuma tela consegue chamar nada disso —
//! mesmo defeito de "pronto e inalcançável" que este projeto já documentou
//! nove vezes, agora não repetido.
//!
//! Nenhum parâmetro aqui se chama `state` fora do `State<'_, AppState>` que o
//! Tauri injeta — nenhum verbo do repositório tem um campo de domínio chamado
//! "state" (diferente de `trilha_commands::marcar_progresso_etapa`, que
//! precisou renomear para `state_value` por causa do `state: TEXT` de
//! `trail_steps`), então a armadilha simplesmente não se aplica a este
//! arquivo.

use serde_json::Value as JsonValue;
use tauri::State;
use uuid::Uuid;

use crate::db::{
    AppliedChanges, DatabasePropertyRow, DatabaseRecord, DatabaseRepository, DatabaseRow, DatabaseViewRow, PageRow,
    RecordValueChangeInput, RecordValueRepository,
};
use crate::error::Result;
use crate::ipc::state::AppState;

fn database_repository(state: &AppState) -> Result<DatabaseRepository> {
    Ok(DatabaseRepository::new(state.pool()?))
}

fn record_value_repository(state: &AppState) -> Result<RecordValueRepository> {
    Ok(RecordValueRepository::new(state.pool()?))
}

// -- database ---------------------------------------------------------------

#[tauri::command]
pub async fn create_database(state: State<'_, AppState>, container_page_id: Uuid, name: String) -> Result<DatabaseRow> {
    create_database_inner(&state, container_page_id, &name).await
}

async fn create_database_inner(state: &AppState, container_page_id: Uuid, name: &str) -> Result<DatabaseRow> {
    database_repository(state)?.create_database(container_page_id, name).await
}

#[tauri::command]
pub async fn get_database(state: State<'_, AppState>, id: Uuid) -> Result<DatabaseRow> {
    get_database_inner(&state, id).await
}

async fn get_database_inner(state: &AppState, id: Uuid) -> Result<DatabaseRow> {
    database_repository(state)?.get_database(id).await
}

/// Todas as databases inline de uma página-container — a tela de página
/// chama isto para saber quantos blocos de database desenhar (ver o
/// comentário de `DatabaseRepository::list_databases_in_page`).
#[tauri::command]
pub async fn list_databases_in_page(state: State<'_, AppState>, container_page_id: Uuid) -> Result<Vec<DatabaseRow>> {
    list_databases_in_page_inner(&state, container_page_id).await
}

async fn list_databases_in_page_inner(state: &AppState, container_page_id: Uuid) -> Result<Vec<DatabaseRow>> {
    database_repository(state)?.list_databases_in_page(container_page_id).await
}

#[tauri::command]
pub async fn rename_database(state: State<'_, AppState>, id: Uuid, name: String) -> Result<DatabaseRow> {
    rename_database_inner(&state, id, &name).await
}

async fn rename_database_inner(state: &AppState, id: Uuid, name: &str) -> Result<DatabaseRow> {
    database_repository(state)?.rename_database(id, name).await
}

/// Apaga a database inteira — propriedade, view e registro somem junto por
/// CASCADE do próprio schema, não por lógica desta camada nem do repositório
/// (ver o comentário de `DatabaseRepository::delete_database`).
#[tauri::command]
pub async fn delete_database(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    delete_database_inner(&state, id).await
}

async fn delete_database_inner(state: &AppState, id: Uuid) -> Result<()> {
    database_repository(state)?.delete_database(id).await
}

// -- propriedade --------------------------------------------------------------

/// Recusa `relation`/`rollup` (repassado do repositório como `Error::Invalid`
/// — ver `DatabaseRepository::create_property`).
#[tauri::command]
pub async fn create_property(
    state: State<'_, AppState>,
    database_id: Uuid,
    name: String,
    property_type: String,
    config: Option<JsonValue>,
) -> Result<DatabasePropertyRow> {
    create_property_inner(&state, database_id, &name, &property_type, config).await
}

async fn create_property_inner(
    state: &AppState,
    database_id: Uuid,
    name: &str,
    property_type: &str,
    config: Option<JsonValue>,
) -> Result<DatabasePropertyRow> {
    database_repository(state)?.create_property(database_id, name, property_type, config).await
}

#[tauri::command]
pub async fn list_properties(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<DatabasePropertyRow>> {
    list_properties_inner(&state, database_id).await
}

async fn list_properties_inner(state: &AppState, database_id: Uuid) -> Result<Vec<DatabasePropertyRow>> {
    database_repository(state)?.list_properties(database_id).await
}

#[tauri::command]
pub async fn rename_property(state: State<'_, AppState>, id: Uuid, name: String) -> Result<DatabasePropertyRow> {
    rename_property_inner(&state, id, &name).await
}

async fn rename_property_inner(state: &AppState, id: Uuid, name: &str) -> Result<DatabasePropertyRow> {
    database_repository(state)?.rename_property(id, name).await
}

/// Recusado quando o tipo ATUAL ou o NOVO é `relation`/`rollup` — ver o
/// comentário de `DatabaseRepository::change_property_type`.
#[tauri::command]
pub async fn change_property_type(state: State<'_, AppState>, id: Uuid, new_type: String) -> Result<DatabasePropertyRow> {
    change_property_type_inner(&state, id, &new_type).await
}

async fn change_property_type_inner(state: &AppState, id: Uuid, new_type: &str) -> Result<DatabasePropertyRow> {
    database_repository(state)?.change_property_type(id, new_type).await
}

/// O comando que faltava: `create_property` aceita `config` na criação, mas
/// até aqui não havia nenhum caminho para mudá-lo depois — uma propriedade
/// Fórmula criada com uma expressão ficava com aquela expressão para
/// sempre. Recusado quando `config` não é objeto JSON ou quando o tipo ATUAL
/// da propriedade é `relation`/`rollup` — ver o comentário de
/// `DatabaseRepository::set_property_config` para as três decisões (config
/// não-objeto, propriedade estrutural, e o `config` órfão que
/// `change_property_type` já deixava antes deste comando existir).
#[tauri::command]
pub async fn set_property_config(state: State<'_, AppState>, id: Uuid, config: JsonValue) -> Result<DatabasePropertyRow> {
    set_property_config_inner(&state, id, config).await
}

async fn set_property_config_inner(state: &AppState, id: Uuid, config: JsonValue) -> Result<DatabasePropertyRow> {
    database_repository(state)?.set_property_config(id, config).await
}

#[tauri::command]
pub async fn reorder_property(
    state: State<'_, AppState>,
    database_id: Uuid,
    id: Uuid,
    after_property_id: Option<Uuid>,
) -> Result<DatabasePropertyRow> {
    reorder_property_inner(&state, database_id, id, after_property_id).await
}

async fn reorder_property_inner(
    state: &AppState,
    database_id: Uuid,
    id: Uuid,
    after_property_id: Option<Uuid>,
) -> Result<DatabasePropertyRow> {
    database_repository(state)?.reorder_property(database_id, id, after_property_id).await
}

/// Apaga a propriedade. Valor, dependência de rollup e o `group_property_id`
/// de uma Trilha somem/viram `NULL` por CASCADE/SET NULL do próprio schema —
/// ver o comentário de `DatabaseRepository::delete_property`.
#[tauri::command]
pub async fn delete_property(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    delete_property_inner(&state, id).await
}

async fn delete_property_inner(state: &AppState, id: Uuid) -> Result<()> {
    database_repository(state)?.delete_property(id).await
}

// -- view -----------------------------------------------------------------

#[tauri::command]
pub async fn create_view(
    state: State<'_, AppState>,
    database_id: Uuid,
    name: String,
    view_type: String,
    config: Option<JsonValue>,
) -> Result<DatabaseViewRow> {
    create_view_inner(&state, database_id, &name, &view_type, config).await
}

async fn create_view_inner(
    state: &AppState,
    database_id: Uuid,
    name: &str,
    view_type: &str,
    config: Option<JsonValue>,
) -> Result<DatabaseViewRow> {
    database_repository(state)?.create_view(database_id, name, view_type, config).await
}

#[tauri::command]
pub async fn list_views(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<DatabaseViewRow>> {
    list_views_inner(&state, database_id).await
}

async fn list_views_inner(state: &AppState, database_id: Uuid) -> Result<Vec<DatabaseViewRow>> {
    database_repository(state)?.list_views(database_id).await
}

#[tauri::command]
pub async fn rename_view(state: State<'_, AppState>, id: Uuid, name: String) -> Result<DatabaseViewRow> {
    rename_view_inner(&state, id, &name).await
}

async fn rename_view_inner(state: &AppState, id: Uuid, name: &str) -> Result<DatabaseViewRow> {
    database_repository(state)?.rename_view(id, name).await
}

/// Substitui `config` inteiro — quem chama já leu o valor atual (via
/// `list_views`) e manda de volta o objeto inteiro com o campo que mudou; não
/// há merge parcial (ver o comentário de `DatabaseRepository::set_view_config`).
#[tauri::command]
pub async fn set_view_config(state: State<'_, AppState>, id: Uuid, config: JsonValue) -> Result<DatabaseViewRow> {
    set_view_config_inner(&state, id, config).await
}

async fn set_view_config_inner(state: &AppState, id: Uuid, config: JsonValue) -> Result<DatabaseViewRow> {
    database_repository(state)?.set_view_config(id, config).await
}

#[tauri::command]
pub async fn reorder_view(
    state: State<'_, AppState>,
    database_id: Uuid,
    id: Uuid,
    after_view_id: Option<Uuid>,
) -> Result<DatabaseViewRow> {
    reorder_view_inner(&state, database_id, id, after_view_id).await
}

async fn reorder_view_inner(
    state: &AppState,
    database_id: Uuid,
    id: Uuid,
    after_view_id: Option<Uuid>,
) -> Result<DatabaseViewRow> {
    database_repository(state)?.reorder_view(database_id, id, after_view_id).await
}

/// Apaga a view. Uma view Trilha leva a raia junto por CASCADE — ver o
/// comentário de `DatabaseRepository::delete_view`.
#[tauri::command]
pub async fn delete_view(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    delete_view_inner(&state, id).await
}

async fn delete_view_inner(state: &AppState, id: Uuid) -> Result<()> {
    database_repository(state)?.delete_view(id).await
}

// -- registro ---------------------------------------------------------

#[tauri::command]
pub async fn create_record(state: State<'_, AppState>, database_id: Uuid, title: String) -> Result<PageRow> {
    create_record_inner(&state, database_id, &title).await
}

async fn create_record_inner(state: &AppState, database_id: Uuid, title: &str) -> Result<PageRow> {
    database_repository(state)?.create_record(database_id, title).await
}

/// Todo registro ativo de uma database, com os valores que cada um tem hoje —
/// a tela de tabela/quadro/lista/calendário/trilha monta a cena inteira a
/// partir disto, como `get_mindmap` já faz para o mapa mental.
#[tauri::command]
pub async fn list_records(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<DatabaseRecord>> {
    list_records_inner(&state, database_id).await
}

async fn list_records_inner(state: &AppState, database_id: Uuid) -> Result<Vec<DatabaseRecord>> {
    database_repository(state)?.list_records(database_id).await
}

// -- valor de célula --------------------------------------------------------

/// O comando que faltava: até aqui uma tabela de database só sabia LER valor
/// de célula (`list_records`), nunca escrever. Delega inteiramente a
/// `RecordValueRepository::apply_record_value_changes` (I4,
/// `db/record_values.rs`) — o ÚNICO caminho autorizado a tocar
/// `database_record_values`, provado por varredura estática em
/// `tests/db_value_invariants.rs`. Recebe um LOTE, não uma célula por vez:
/// colar uma linha ou limpar uma seleção produz várias mudanças juntas, e o
/// repositório já resolve o lote inteiro numa única transação — expor uma
/// célula por chamada jogaria fora essa atomicidade.
#[tauri::command]
pub async fn apply_record_value_changes(
    state: State<'_, AppState>,
    changes: Vec<RecordValueChangeInput>,
) -> Result<AppliedChanges> {
    apply_record_value_changes_inner(&state, changes).await
}

async fn apply_record_value_changes_inner(state: &AppState, changes: Vec<RecordValueChangeInput>) -> Result<AppliedChanges> {
    record_value_repository(state)?.apply_record_value_changes(changes).await
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa isenção, então ela é escrita aqui — mesmo
    // padrão de `ipc::trilha_commands`/`ipc::mindmap_commands`.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    // Um teste por comando — não uma amostra — prova que cada um dos 19 está
    // de fato ligado a `database_repository`. `ipc::trilha_commands`/
    // `ipc::mindmap_commands` testam só um representante por lá; aqui são 19
    // comandos novos de uma vez, então a rede de segurança cobre todos.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn create_database_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(create_database_inner(&state, Uuid::now_v7(), "x").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn get_database_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(get_database_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_databases_in_page_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_databases_in_page_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn rename_database_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(rename_database_inner(&state, Uuid::now_v7(), "x").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn delete_database_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(delete_database_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_property_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                create_property_inner(&state, Uuid::now_v7(), "x", "text", None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn list_properties_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_properties_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn rename_property_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(rename_property_inner(&state, Uuid::now_v7(), "x").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn change_property_type_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                change_property_type_inner(&state, Uuid::now_v7(), "number").await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn set_property_config_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                set_property_config_inner(&state, Uuid::now_v7(), serde_json::json!({})).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn reorder_property_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                reorder_property_inner(&state, Uuid::now_v7(), Uuid::now_v7(), None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn delete_property_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(delete_property_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_view_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                create_view_inner(&state, Uuid::now_v7(), "x", "table", None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn list_views_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_views_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn rename_view_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(rename_view_inner(&state, Uuid::now_v7(), "x").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn set_view_config_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                set_view_config_inner(&state, Uuid::now_v7(), serde_json::json!({})).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn reorder_view_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(
                reorder_view_inner(&state, Uuid::now_v7(), Uuid::now_v7(), None).await,
                Err(Error::Config(_))
            ));
        }

        #[tokio::test]
        async fn delete_view_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(delete_view_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_record_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(create_record_inner(&state, Uuid::now_v7(), "x").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_records_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_records_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn apply_record_value_changes_reports_not_connected() {
            let state = AppState::new();
            let changes = vec![RecordValueChangeInput {
                record_id: Uuid::now_v7(),
                property_id: Uuid::now_v7(),
                value: serde_json::json!("x"),
            }];
            assert!(matches!(apply_record_value_changes_inner(&state, changes).await, Err(Error::Config(_))));
        }
    }

    // Testes de ponta a ponta contra banco de verdade — a lógica de negócio
    // já está coberta em `db::databases`/`tests/db_databases.rs`; o que falta
    // provar aqui é só a fiação desta camada, mesmo padrão do módulo
    // `com_banco` em `ipc::trilha_commands`/`ipc::mindmap_commands`.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::ids::IdBind;
        use crate::db::pool::connect_and_migrate;
        use crate::db::{CreateRelationInput, RelationRepository};

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = std::env::temp_dir().join(format!("learno-database-cmd-test-{rotulo}-{}", Uuid::new_v4()));
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        async fn cria_pagina_container(state: &AppState, titulo: &str) -> Uuid {
            let pool = state.pool().unwrap();
            let id = Uuid::now_v7();
            sqlx::query("INSERT INTO pages (id, title, position) VALUES (?, ?, 'a0')")
                .bind(id.db())
                .bind(titulo)
                .execute(&pool)
                .await
                .unwrap();
            id
        }

        #[tokio::test]
        async fn create_database_and_list_databases_in_page_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("cria-lista-db").await;
            let container = cria_pagina_container(&state, "Container").await;

            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let all = list_databases_in_page_inner(&state, container).await.unwrap();
            assert!(all.iter().any(|d| d.id == database.id));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn create_property_create_view_and_create_record_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("cria-tudo").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();

            let property = create_property_inner(&state, database.id, "Status", "status", None).await.unwrap();
            let view = create_view_inner(&state, database.id, "Tabela", "table", None).await.unwrap();
            let record = create_record_inner(&state, database.id, "Aula 1").await.unwrap();

            let properties = list_properties_inner(&state, database.id).await.unwrap();
            assert!(properties.iter().any(|p| p.id == property.id));

            let views = list_views_inner(&state, database.id).await.unwrap();
            assert!(views.iter().any(|v| v.id == view.id));

            let records = list_records_inner(&state, database.id).await.unwrap();
            assert!(records.iter().any(|r| r.page.id == record.id));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Borda pedida pela regra 6: tipo inválido tem que ser recusado já
        /// na fronteira do comando, não só dentro do repositório — prova que
        /// o `Error::Invalid` do repositório atravessa o `?` desta camada
        /// sem virar outra coisa, e que nada foi criado.
        #[tokio::test]
        async fn create_property_with_an_invalid_type_is_rejected_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("tipo-invalido").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();

            let result = create_property_inner(&state, database.id, "Vídeo", "video", None).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            let properties = list_properties_inner(&state, database.id).await.unwrap();
            assert!(properties.is_empty(), "nada devia ter sido criado");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Database vazia (zero propriedade/view/registro) é lista vazia via
        /// o comando, não erro — mesmo estado válido que
        /// `DatabaseRepository::list_records` documenta.
        #[tokio::test]
        async fn an_empty_database_lists_as_empty_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("vazia").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Vazia").await.unwrap();

            assert!(list_properties_inner(&state, database.id).await.unwrap().is_empty());
            assert!(list_views_inner(&state, database.id).await.unwrap().is_empty());
            assert!(list_records_inner(&state, database.id).await.unwrap().is_empty());

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Lê o valor gravado direto da tabela — não da struct que o comando
        /// devolve, que sozinha não provaria persistência nenhuma — para
        /// confirmar que `apply_record_value_changes` (o comando novo desta
        /// tarefa) grava de verdade através de `database_repository`/
        /// `record_value_repository` até `database_record_values`.
        #[tokio::test]
        async fn apply_record_value_changes_writes_a_value_that_reads_back_from_the_table() {
            let (state, data_dir) = estado_com_banco("valor-grava-le").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let property = create_property_inner(&state, database.id, "Nota", "text", None).await.unwrap();
            let record = create_record_inner(&state, database.id, "Aula 1").await.unwrap();

            let applied = apply_record_value_changes_inner(
                &state,
                vec![RecordValueChangeInput {
                    record_id: record.id,
                    property_id: property.id,
                    value: serde_json::json!("Anotação da Fase 3"),
                }],
            )
            .await
            .unwrap();

            assert_eq!(
                applied.results[0].value.as_ref().unwrap().value,
                serde_json::json!("Anotação da Fase 3")
            );

            let pool = state.pool().unwrap();
            let value: JsonValue = sqlx::query_scalar(
                "SELECT value FROM database_record_values WHERE record_id = ? AND property_id = ?",
            )
            .bind(record.id.db())
            .bind(property.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                value,
                serde_json::json!("Anotação da Fase 3"),
                "o valor tem que estar gravado de verdade em database_record_values, não só na resposta do comando"
            );

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// I1 pelo comando: gravar um valor genericamente vazio (`""`) não
        /// deixa uma linha com valor vazio — a linha SOME, exatamente a
        /// invariante que `db_value_invariants.rs` prova direto no
        /// repositório e que este teste prova de novo na fronteira do IPC.
        #[tokio::test]
        async fn apply_record_value_changes_writing_empty_deletes_the_row_i1() {
            let (state, data_dir) = estado_com_banco("valor-i1").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let property = create_property_inner(&state, database.id, "Nota", "text", None).await.unwrap();
            let record = create_record_inner(&state, database.id, "Aula 1").await.unwrap();

            apply_record_value_changes_inner(
                &state,
                vec![RecordValueChangeInput {
                    record_id: record.id,
                    property_id: property.id,
                    value: serde_json::json!("valor temporário"),
                }],
            )
            .await
            .unwrap();

            let applied = apply_record_value_changes_inner(
                &state,
                vec![RecordValueChangeInput { record_id: record.id, property_id: property.id, value: serde_json::json!("") }],
            )
            .await
            .unwrap();
            assert!(applied.results[0].value.is_none(), "escrever vazio deve reportar a linha como ausente");

            let pool = state.pool().unwrap();
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM database_record_values WHERE record_id = ? AND property_id = ?",
            )
            .bind(record.id.db())
            .bind(property.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 0, "I1: vazio é a AUSÊNCIA da linha, não uma linha com valor vazio");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Lote com mais de uma mudança aplicado atomicamente: duas
        /// propriedades diferentes do mesmo registro, numa única chamada —
        /// as duas têm que estar gravadas ao final, provando que o comando
        /// não perde a atomicidade que `apply_record_value_changes` já
        /// garante numa única transação (uma edição real de tabela, como
        /// colar uma linha, produz várias mudanças juntas).
        #[tokio::test]
        async fn apply_record_value_changes_applies_a_multi_change_batch_atomically() {
            let (state, data_dir) = estado_com_banco("valor-lote").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let nota = create_property_inner(&state, database.id, "Nota", "text", None).await.unwrap();
            let concluido = create_property_inner(&state, database.id, "Concluído", "checkbox", None).await.unwrap();
            let record = create_record_inner(&state, database.id, "Aula 1").await.unwrap();

            let applied = apply_record_value_changes_inner(
                &state,
                vec![
                    RecordValueChangeInput { record_id: record.id, property_id: nota.id, value: serde_json::json!("Ok") },
                    RecordValueChangeInput { record_id: record.id, property_id: concluido.id, value: serde_json::json!(true) },
                ],
            )
            .await
            .unwrap();

            assert_eq!(applied.results.len(), 2, "o lote inteiro tem que ser reportado, uma entrada por mudança");
            assert_eq!(applied.results[0].value.as_ref().unwrap().value, serde_json::json!("Ok"));
            assert_eq!(applied.results[1].value.as_ref().unwrap().value, serde_json::json!(true));

            let pool = state.pool().unwrap();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM database_record_values WHERE record_id = ?")
                .bind(record.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 2, "as duas mudanças do lote têm que estar gravadas juntas");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// O caso que motivou o comando: uma propriedade Fórmula criada com
        /// uma expressão consegue trocar de expressão depois — lido DIRETO
        /// da tabela, não da struct que o comando devolve (que sozinha não
        /// provaria persistência nenhuma, mesmo raciocínio do teste de
        /// `apply_record_value_changes` acima).
        #[tokio::test]
        async fn set_property_config_round_trips_a_formula_expression() {
            let (state, data_dir) = estado_com_banco("config-formula-round-trip").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let property = create_property_inner(
                &state,
                database.id,
                "Nota final",
                "formula",
                Some(serde_json::json!({ "expression": "prop(\"Nota\") * 2" })),
            )
            .await
            .unwrap();

            let nova_config = serde_json::json!({ "expression": "prop(\"Nota\") * 3" });
            let atualizada = set_property_config_inner(&state, property.id, nova_config.clone()).await.unwrap();
            assert_eq!(atualizada.config, nova_config, "a struct devolvida já deve refletir o novo config");

            let pool = state.pool().unwrap();
            let gravado: JsonValue = sqlx::query_scalar("SELECT config FROM database_properties WHERE id = ?")
                .bind(property.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(gravado, nova_config, "o config novo tem que estar gravado de verdade em database_properties");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Decisão 1 do relato: `config` que não é objeto JSON é recusado —
        /// entrada nova vinda da UI, diferente do fallback silencioso que
        /// `parse_opcoes_de_deck` (`db::cards`) aplica a dado já gravado.
        /// Prova os dois lados: o objeto passa, o não-objeto é recusado e
        /// nada muda no banco.
        #[tokio::test]
        async fn set_property_config_rejects_a_non_object_config_but_accepts_an_object() {
            let (state, data_dir) = estado_com_banco("config-nao-objeto").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();
            let property = create_property_inner(&state, database.id, "Status", "status", None).await.unwrap();

            for config_invalido in [serde_json::json!("oops"), serde_json::json!(42), serde_json::json!(null), serde_json::json!([1, 2])] {
                let result = set_property_config_inner(&state, property.id, config_invalido.clone()).await;
                assert!(matches!(result, Err(Error::Invalid(_))), "{config_invalido:?} deveria ser recusado, obtido {result:?}");
            }

            let pool = state.pool().unwrap();
            let gravado: JsonValue = sqlx::query_scalar("SELECT config FROM database_properties WHERE id = ?")
                .bind(property.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(gravado, serde_json::json!({}), "nenhuma das rejeições deveria ter tocado o config original");

            let config_valido = serde_json::json!({ "options": [] });
            let atualizada = set_property_config_inner(&state, property.id, config_valido.clone()).await.unwrap();
            assert_eq!(atualizada.config, config_valido, "objeto JSON tem que ser aceito");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Decisão 3 do relato: propriedade `relation` (a única forma de
        /// obter uma sem passar por `create_property`, que já recusa criar
        /// o tipo direto) não pode ter o config trocado por este comando
        /// genérico — o dono é `RelationRepository`.
        #[tokio::test]
        async fn set_property_config_rejects_a_structural_relation_property() {
            let (state, data_dir) = estado_com_banco("config-relation-recusada").await;
            let container = cria_pagina_container(&state, "Container").await;
            let database = create_database_inner(&state, container, "Estudos").await.unwrap();

            let pool = state.pool().unwrap();
            let relation = RelationRepository::new(pool.clone())
                .create_relation(CreateRelationInput {
                    source_database_id: database.id,
                    target_database_id: database.id,
                    source_property_name: "Relação".into(),
                    is_symmetric: true,
                    two_way: false,
                    target_property_name: None,
                    source_max_targets: None,
                    target_max_sources: None,
                })
                .await
                .unwrap();

            let result = set_property_config_inner(&state, relation.source_property_id, serde_json::json!({})).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Gravar num id que não existe devolve `Error::NotFound`, não um
        /// sucesso silencioso — a armadilha deste repositório é `Uuid` cru
        /// devolver zero linha em silêncio; aqui o id É de verdade um `Uuid`
        /// que nunca foi inserido, então o `NotFound` é o comportamento
        /// certo, não um sintoma da armadilha.
        #[tokio::test]
        async fn set_property_config_against_a_nonexistent_id_is_not_found() {
            let (state, data_dir) = estado_com_banco("config-id-inexistente").await;

            let result = set_property_config_inner(&state, Uuid::now_v7(), serde_json::json!({})).await;
            assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
