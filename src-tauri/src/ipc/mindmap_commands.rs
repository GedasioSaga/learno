//! Comandos `#[tauri::command]` do mapa mental — segue exatamente o desenho
//! de `ipc::block_commands`/`ipc::deck_commands`: cada comando monta o
//! repositório certo a partir de `state.pool()` e delega a ele, com um par
//! `_inner` testável sem `AppHandle` — ver o comentário de `page_repository`
//! em `ipc::commands` para por que nenhum teste aqui pode passar por
//! `tauri::test::mock_builder`.

use tauri::State;
use uuid::Uuid;

use crate::db::{MindmapChangeInput, MindmapGraph, MindmapRepository, MindmapRow};
use crate::error::Result;
use crate::ipc::state::AppState;

fn mindmap_repository(state: &AppState) -> Result<MindmapRepository> {
    Ok(MindmapRepository::new(state.pool()?))
}

/// Todo mapa mental existente, mais recentemente editado primeiro.
#[tauri::command]
pub async fn list_mindmaps(state: State<'_, AppState>) -> Result<Vec<MindmapRow>> {
    list_mindmaps_inner(&state).await
}

async fn list_mindmaps_inner(state: &AppState) -> Result<Vec<MindmapRow>> {
    mindmap_repository(state)?.list().await
}

/// Cria um mapa mental preso a `page_id`. Ver o comentário do topo de
/// `db::mindmap` e o relatório desta peça: o contrato de IPC permite
/// `page_id: None`, mas `mindmaps.page_id` é `NOT NULL` no schema — o
/// repositório recusa `None` com uma mensagem explicando o descompasso, em
/// vez desta camada fingir que o parâmetro é sempre opcional de verdade.
#[tauri::command]
pub async fn create_mindmap(state: State<'_, AppState>, name: String, page_id: Option<Uuid>) -> Result<MindmapRow> {
    create_mindmap_inner(&state, &name, page_id).await
}

async fn create_mindmap_inner(state: &AppState, name: &str, page_id: Option<Uuid>) -> Result<MindmapRow> {
    mindmap_repository(state)?.create(name, page_id).await
}

#[tauri::command]
pub async fn rename_mindmap(state: State<'_, AppState>, mindmap_id: Uuid, name: String) -> Result<MindmapRow> {
    rename_mindmap_inner(&state, mindmap_id, &name).await
}

async fn rename_mindmap_inner(state: &AppState, mindmap_id: Uuid, name: &str) -> Result<MindmapRow> {
    mindmap_repository(state)?.rename(mindmap_id, name).await
}

/// Exclusão definitiva — não há lixeira para mapa mental, ver o comentário de
/// `MindmapRepository::delete`. Nós e arestas somem junto via
/// `ON DELETE CASCADE`.
#[tauri::command]
pub async fn delete_mindmap(state: State<'_, AppState>, mindmap_id: Uuid) -> Result<()> {
    delete_mindmap_inner(&state, mindmap_id).await
}

async fn delete_mindmap_inner(state: &AppState, mindmap_id: Uuid) -> Result<()> {
    mindmap_repository(state)?.delete(mindmap_id).await
}

/// O mapa, todos os seus nós e todas as suas arestas, de uma vez — o canvas
/// monta a cena inteira a partir disto.
#[tauri::command]
pub async fn get_mindmap(state: State<'_, AppState>, mindmap_id: Uuid) -> Result<MindmapGraph> {
    get_mindmap_inner(&state, mindmap_id).await
}

async fn get_mindmap_inner(state: &AppState, mindmap_id: Uuid) -> Result<MindmapGraph> {
    mindmap_repository(state)?.get_graph(mindmap_id).await
}

/// O endpoint de lote do canvas: aplica todas as mudanças de um gesto
/// (arrastar vários nós, por exemplo) numa única transação e devolve o grafo
/// inteiro já atualizado — ver `MindmapRepository::apply_changes`.
#[tauri::command]
pub async fn apply_mindmap_changes(
    state: State<'_, AppState>,
    mindmap_id: Uuid,
    changes: Vec<MindmapChangeInput>,
) -> Result<MindmapGraph> {
    apply_mindmap_changes_inner(&state, mindmap_id, changes).await
}

async fn apply_mindmap_changes_inner(
    state: &AppState,
    mindmap_id: Uuid,
    changes: Vec<MindmapChangeInput>,
) -> Result<MindmapGraph> {
    mindmap_repository(state)?.apply_changes(mindmap_id, changes).await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::db::mindmap::{
        MindmapNodePatchInput, MindmapNodePositionInput, NewMindmapEdgeInput, NewMindmapNodeInput,
    };
    use crate::error::Error;

    // Um representante por comando prova que cada um está de fato ligado a
    // `mindmap_repository` — mesmo padrão de
    // `ipc::deck_commands::tests::without_a_pool`.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn list_mindmaps_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_mindmaps_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_mindmap_reports_not_connected() {
            let state = AppState::new();
            let result = create_mindmap_inner(&state, "x", Some(Uuid::now_v7())).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn get_mindmap_reports_not_connected() {
            let state = AppState::new();
            let result = get_mindmap_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn apply_mindmap_changes_reports_not_connected() {
            let state = AppState::new();
            let result = apply_mindmap_changes_inner(&state, Uuid::now_v7(), vec![]).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }
    }

    // Testes de ponta a ponta contra banco de verdade — mesmo padrão do
    // módulo `com_banco` em `ipc::deck_commands`. A lógica de negócio já está
    // coberta em `db::mindmap`; o que falta provar aqui é só a fiação.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;
        use crate::db::ids::IdBind;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-mindmap-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = pasta_temporaria(rotulo);
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        async fn cria_pagina(state: &AppState, titulo: &str) -> Uuid {
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
        async fn create_mindmap_and_list_mindmaps_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("cria-lista").await;
            let page_id = cria_pagina(&state, "Biologia").await;

            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();
            let all = list_mindmaps_inner(&state).await.unwrap();
            assert!(all.iter().any(|m| m.id == mindmap.id));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Mapa mental sem página é o caso NORMAL, não o caso de erro.
        ///
        /// Este teste afirmava o contrário até `0025_mapa_mental_avulso.sql`:
        /// que `pageId` nulo tinha que virar `Error::Invalid`. Ele passava, e
        /// o que ele guardava era o defeito — `mindmaps.page_id` era
        /// `NOT NULL`, o repositório recusava, e o clique em "+ Novo mapa" da
        /// barra lateral (que não tem página nenhuma para oferecer) morria em
        /// silêncio. Um teste verde afirmando a recusa fazia o defeito
        /// parecer decisão de projeto.
        ///
        /// Mapa mental é seção própria do app, no nível de Notas e Cartões.
        /// A página é vínculo opcional — mapa dentro de uma categoria.
        #[tokio::test]
        async fn create_mindmap_without_a_page_id_creates_a_standalone_map() {
            let (state, data_dir) = estado_com_banco("sem-pagina").await;

            let mindmap = create_mindmap_inner(&state, "Órfão", None).await.unwrap();
            assert_eq!(mindmap.page_id, None, "mapa avulso não pode inventar uma página");
            assert_eq!(mindmap.name, "Órfão");

            let all = list_mindmaps_inner(&state).await.unwrap();
            assert!(all.iter().any(|m| m.id == mindmap.id), "o mapa avulso precisa aparecer na listagem");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn apply_changes_creates_nodes_and_edges_in_one_batch_and_returns_the_full_graph() {
            let (state, data_dir) = estado_com_banco("lote").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();

            let node_a = Uuid::now_v7();
            let node_b = Uuid::now_v7();
            let changes = vec![
                MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_a),
                        label: "Núcleo".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                },
                MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_b),
                        label: "Mitocôndria".into(),
                        position_x: 10.0,
                        position_y: 20.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                },
                MindmapChangeInput::CreateEdge {
                    edge: NewMindmapEdgeInput {
                        id: None,
                        source_node_id: node_a,
                        target_node_id: node_b,
                        label: None,
                        style: None,
                    },
                },
            ];

            let graph = apply_mindmap_changes_inner(&state, mindmap.id, changes).await.unwrap();
            assert_eq!(graph.nodes.len(), 2);
            assert_eq!(graph.edges.len(), 1);

            let fetched = get_mindmap_inner(&state, mindmap.id).await.unwrap();
            assert_eq!(fetched.nodes.len(), 2);
            assert_eq!(fetched.edges.len(), 1);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// O achado central desta peça: uma aresta não pode ligar nós de
        /// mapas mentais diferentes, mesmo os dois existindo de verdade.
        #[tokio::test]
        async fn creating_an_edge_across_two_different_mindmaps_is_rejected() {
            let (state, data_dir) = estado_com_banco("aresta-cruzada").await;
            let page_id = cria_pagina(&state, "Biologia").await;

            let mapa_1 = create_mindmap_inner(&state, "Mapa 1", Some(page_id)).await.unwrap();
            let mapa_2 = create_mindmap_inner(&state, "Mapa 2", Some(page_id)).await.unwrap();

            let node_no_mapa_1 = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mapa_1.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_no_mapa_1),
                        label: "A".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            let node_no_mapa_2 = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mapa_2.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_no_mapa_2),
                        label: "B".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            // Tenta ligar um nó do mapa 1 a um nó do mapa 2, através do lote
            // do mapa 1 — tem que ser recusado, e nada do lote pode ter sido
            // gravado (a transação inteira desfeita).
            let result = apply_mindmap_changes_inner(
                &state,
                mapa_1.id,
                vec![MindmapChangeInput::CreateEdge {
                    edge: NewMindmapEdgeInput {
                        id: None,
                        source_node_id: node_no_mapa_1,
                        target_node_id: node_no_mapa_2,
                        label: None,
                        style: None,
                    },
                }],
            )
            .await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            let graph = get_mindmap_inner(&state, mapa_1.id).await.unwrap();
            assert!(graph.edges.is_empty(), "nenhuma aresta corrompida pode ter sido gravada");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// A FK `ON DELETE CASCADE` de `mindmap_edges` para `mindmap_nodes`
        /// (0013_mindmap.sql) já apaga as arestas de um nó quando o nó some —
        /// este teste prova isso por EFEITO, sem este repositório escrever um
        /// `DELETE FROM mindmap_edges` redundante.
        #[tokio::test]
        async fn deleting_a_node_removes_the_edges_touching_it_via_the_migrations_own_fk_cascade() {
            let (state, data_dir) = estado_com_banco("cascata-no").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();

            let node_a = Uuid::now_v7();
            let node_b = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![
                    MindmapChangeInput::CreateNode {
                        node: NewMindmapNodeInput {
                            id: Some(node_a),
                            label: "A".into(),
                            position_x: 0.0,
                            position_y: 0.0,
                            color: None,
                            shape: None,
                            icon: None,
                            image: None,
                            collapsed: false,
                            page_ref_id: None,
                        },
                    },
                    MindmapChangeInput::CreateNode {
                        node: NewMindmapNodeInput {
                            id: Some(node_b),
                            label: "B".into(),
                            position_x: 0.0,
                            position_y: 0.0,
                            color: None,
                            shape: None,
                            icon: None,
                            image: None,
                            collapsed: false,
                            page_ref_id: None,
                        },
                    },
                    MindmapChangeInput::CreateEdge {
                        edge: NewMindmapEdgeInput {
                            id: None,
                            source_node_id: node_a,
                            target_node_id: node_b,
                            label: None,
                            style: None,
                        },
                    },
                ],
            )
            .await
            .unwrap();

            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::DeleteNode { id: node_a }],
            )
            .await
            .unwrap();

            assert_eq!(graph.nodes.len(), 1);
            assert!(graph.edges.is_empty(), "a aresta que tocava o nó apagado devia ter sumido junto, via FK");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn move_node_updates_only_the_position() {
            let (state, data_dir) = estado_com_banco("move").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();

            let node_id = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_id),
                        label: "A".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::MoveNode {
                    id: node_id,
                    position: MindmapNodePositionInput { position_x: 123.5, position_y: -40.0 },
                }],
            )
            .await
            .unwrap();

            let moved = graph.nodes.iter().find(|n| n.id == node_id).unwrap();
            assert_eq!(moved.position_x, 123.5);
            assert_eq!(moved.position_y, -40.0);
            assert_eq!(moved.label, "A", "mover não pode alterar o rótulo");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn update_node_patch_leaves_omitted_fields_untouched() {
            let (state, data_dir) = estado_com_banco("patch").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();

            let node_id = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_id),
                        label: "Original".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: Some("#ff0000".into()),
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode {
                    id: node_id,
                    patch: MindmapNodePatchInput { label: Some("Renomeado".into()), ..Default::default() },
                }],
            )
            .await
            .unwrap();

            let patched = graph.nodes.iter().find(|n| n.id == node_id).unwrap();
            assert_eq!(patched.label, "Renomeado");
            assert_eq!(patched.color.as_deref(), Some("#ff0000"), "cor não mencionada no patch precisa sobreviver");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// O achado central de `MindmapNodePatchInput::image`: um patch que
        /// não menciona `image` PRESERVA o valor atual (mesmo COALESCE de
        /// todo o resto do patch), mas um patch que manda `image: null` de
        /// propósito LIMPA a coluna — o `CASE WHEN` de `update_node_tx`
        /// existe exatamente para esse segundo caso, que um COALESCE sozinho
        /// nunca conseguiria (COALESCE nunca sobrescreve com NULL).
        #[tokio::test]
        async fn update_node_can_set_replace_and_clear_the_image_while_other_patches_leave_it_untouched() {
            let (state, data_dir) = estado_com_banco("imagem").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();

            let node_id = Uuid::now_v7();
            apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: Some(node_id),
                        label: "Núcleo".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            // 1. Nasce sem imagem.
            let sem_imagem = get_mindmap_inner(&state, mindmap.id).await.unwrap();
            assert_eq!(sem_imagem.nodes[0].image, None);

            // 2. Um patch que não toca em `image` (campo ausente do JSON,
            // via `..Default::default()`) não pode inventar uma imagem nem
            // apagar uma que não existe.
            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode {
                    id: node_id,
                    patch: MindmapNodePatchInput { label: Some("Núcleo (renomeado)".into()), ..Default::default() },
                }],
            )
            .await
            .unwrap();
            assert_eq!(graph.nodes[0].image, None, "patch sem `image` não pode inventar uma imagem");

            // 3. `image: Some(Some(..))` grava o arquivo.
            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode {
                    id: node_id,
                    patch: MindmapNodePatchInput { image: Some(Some("abc123.png".into())), ..Default::default() },
                }],
            )
            .await
            .unwrap();
            assert_eq!(graph.nodes[0].image.as_deref(), Some("abc123.png"));
            assert_eq!(graph.nodes[0].label, "Núcleo (renomeado)", "trocar a imagem não pode mexer no rótulo");

            // 4. Trocar por outro arquivo substitui, não acumula.
            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode {
                    id: node_id,
                    patch: MindmapNodePatchInput { image: Some(Some("def456.png".into())), ..Default::default() },
                }],
            )
            .await
            .unwrap();
            assert_eq!(graph.nodes[0].image.as_deref(), Some("def456.png"));

            // 5. `image: Some(None)` (campo `null` explícito no JSON) LIMPA —
            // o caso que um `Option<String>` simples com COALESCE não
            // conseguiria expressar.
            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode { id: node_id, patch: MindmapNodePatchInput { image: Some(None), ..Default::default() } }],
            )
            .await
            .unwrap();
            assert_eq!(graph.nodes[0].image, None, "`image: null` precisa remover a imagem");

            // 6. Depois de limpa, um patch que não toca em `image` de novo
            // não pode trazê-la de volta.
            let graph = apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::UpdateNode {
                    id: node_id,
                    patch: MindmapNodePatchInput { color: Some("amber".into()), ..Default::default() },
                }],
            )
            .await
            .unwrap();
            assert_eq!(graph.nodes[0].image, None, "imagem já removida precisa continuar removida");

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Um patch com `image: null` desserializado a partir de JSON de
        /// verdade (não construído à mão em Rust) — a prova de que
        /// `deserialize_some` realmente distingue "campo ausente" de "campo
        /// `null`" no formato que o `invoke` do Tauri de fato manda pela
        /// fronteira JS→Rust, não só no construtor Rust usado acima.
        #[test]
        fn patch_json_without_image_field_is_none_and_json_null_is_some_none() {
            let sem_campo: MindmapNodePatchInput = serde_json::from_str(r#"{"label":"x"}"#).unwrap();
            assert_eq!(sem_campo.image, None, "campo ausente no JSON precisa virar `None` (sem mudança)");

            let com_null: MindmapNodePatchInput = serde_json::from_str(r#"{"image":null}"#).unwrap();
            assert_eq!(com_null.image, Some(None), "`image: null` no JSON precisa virar `Some(None)` (limpar)");

            let com_valor: MindmapNodePatchInput = serde_json::from_str(r#"{"image":"abc.png"}"#).unwrap();
            assert_eq!(com_valor.image, Some(Some("abc.png".to_string())));
        }

        #[tokio::test]
        async fn delete_mindmap_removes_it_and_its_nodes() {
            let (state, data_dir) = estado_com_banco("apaga-mapa").await;
            let page_id = cria_pagina(&state, "Biologia").await;
            let mindmap = create_mindmap_inner(&state, "Célula", Some(page_id)).await.unwrap();
            apply_mindmap_changes_inner(
                &state,
                mindmap.id,
                vec![MindmapChangeInput::CreateNode {
                    node: NewMindmapNodeInput {
                        id: None,
                        label: "A".into(),
                        position_x: 0.0,
                        position_y: 0.0,
                        color: None,
                        shape: None,
                        icon: None,
                        image: None,
                        collapsed: false,
                        page_ref_id: None,
                    },
                }],
            )
            .await
            .unwrap();

            delete_mindmap_inner(&state, mindmap.id).await.unwrap();

            let pool = state.pool().unwrap();
            let remaining_nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mindmap_nodes WHERE mindmap_id = ?")
                .bind(mindmap.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(remaining_nodes, 0, "nós órfãos deveriam ter sumido junto com o mapa, via FK");

            assert!(matches!(get_mindmap_inner(&state, mindmap.id).await, Err(Error::NotFound(_))));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
