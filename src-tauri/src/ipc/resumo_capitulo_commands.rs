//! Comandos `#[tauri::command]` do resumo por capítulo — mesmo desenho de
//! `ipc::prazos_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com um par `_inner` testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{ResumoCapituloRepository, ResumoDeCapitulo};
use crate::error::Result;
use crate::ipc::state::AppState;

fn resumo_capitulo_repository(state: &AppState) -> Result<ResumoCapituloRepository> {
    Ok(ResumoCapituloRepository::new(state.pool()?))
}

/// `salvar_resumo_de_capitulo`: upsert por `(livro_id, chapter_locator)` — ver
/// o comentário de `ResumoCapituloRepository::salvar` para o porquê de
/// salvar de novo no mesmo capítulo SUBSTITUIR, nunca duplicar.
#[tauri::command]
pub async fn salvar_resumo_de_capitulo(
    state: State<'_, AppState>,
    livro_id: Uuid,
    chapter_locator: String,
    chapter_title: Option<String>,
    resumo: String,
) -> Result<ResumoDeCapitulo> {
    salvar_resumo_de_capitulo_inner(&state, livro_id, &chapter_locator, chapter_title.as_deref(), &resumo).await
}

async fn salvar_resumo_de_capitulo_inner(
    state: &AppState,
    livro_id: Uuid,
    chapter_locator: &str,
    chapter_title: Option<&str>,
    resumo: &str,
) -> Result<ResumoDeCapitulo> {
    resumo_capitulo_repository(state)?.salvar(livro_id, chapter_locator, chapter_title, resumo).await
}

/// `listar_resumos_do_livro`: em ordem de mais recém-atualizado primeiro.
#[tauri::command]
pub async fn listar_resumos_do_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<Vec<ResumoDeCapitulo>> {
    listar_resumos_do_livro_inner(&state, livro_id).await
}

async fn listar_resumos_do_livro_inner(state: &AppState, livro_id: Uuid) -> Result<Vec<ResumoDeCapitulo>> {
    resumo_capitulo_repository(state)?.listar_do_livro(livro_id).await
}

/// `remover_resumo_de_capitulo`.
#[tauri::command]
pub async fn remover_resumo_de_capitulo(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    remover_resumo_de_capitulo_inner(&state, id).await
}

async fn remover_resumo_de_capitulo_inner(state: &AppState, id: Uuid) -> Result<()> {
    resumo_capitulo_repository(state)?.remover(id).await
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
        async fn salvar_resumo_de_capitulo_reports_not_connected() {
            let state = AppState::new();
            let result = salvar_resumo_de_capitulo_inner(&state, Uuid::now_v7(), "1", None, "Resumo.").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_resumos_do_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_resumos_do_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_resumo_de_capitulo_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_resumo_de_capitulo_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;
        use crate::db::BibliotecaRepository;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-resumo-capitulo-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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

        async fn livro_de_teste(state: &AppState, data_dir: &std::path::Path) -> Uuid {
            let media_dir = data_dir.join("media");
            std::fs::create_dir_all(data_dir).unwrap();
            let origem = data_dir.join("Livro de Teste.pdf");
            std::fs::write(&origem, b"conteudo de teste").unwrap();

            let biblioteca = BibliotecaRepository::new(state.pool().unwrap());
            biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro.id
        }

        /// Fiação de ponta a ponta pela camada de comando: salvar, listar,
        /// substituir salvando de novo, remover.
        #[tokio::test]
        async fn the_whole_command_layer_wiring_round_trips_through_a_chapter_summary() {
            let (state, data_dir) = estado_com_banco("fiacao-completa").await;
            let livro_id = livro_de_teste(&state, &data_dir).await;

            let criado =
                salvar_resumo_de_capitulo_inner(&state, livro_id, "text/cap01.xhtml", Some("Capítulo 1"), "Rascunho.")
                    .await
                    .unwrap();
            assert_eq!(criado.chapter_title.as_deref(), Some("Capítulo 1"));

            let lista = listar_resumos_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(lista.len(), 1);
            assert_eq!(lista[0].id, criado.id);

            // Salvar de novo no MESMO capítulo substitui, não duplica.
            let substituido =
                salvar_resumo_de_capitulo_inner(&state, livro_id, "text/cap01.xhtml", Some("Capítulo Um"), "Versão final.")
                    .await
                    .unwrap();
            assert_eq!(substituido.id, criado.id);
            let lista_depois = listar_resumos_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(lista_depois.len(), 1, "não pode ter criado uma segunda linha");
            assert_eq!(lista_depois[0].summary, "Versão final.");

            remover_resumo_de_capitulo_inner(&state, criado.id).await.unwrap();
            let lista_final = listar_resumos_do_livro_inner(&state, livro_id).await.unwrap();
            assert!(lista_final.is_empty());

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn salvar_resumo_de_capitulo_rejects_a_blank_summary() {
            let (state, data_dir) = estado_com_banco("resumo-vazio").await;
            let livro_id = livro_de_teste(&state, &data_dir).await;

            let result = salvar_resumo_de_capitulo_inner(&state, livro_id, "1", None, "   ").await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn salvar_resumo_de_capitulo_rejects_an_unknown_book() {
            let (state, data_dir) = estado_com_banco("livro-inexistente").await;

            let result = salvar_resumo_de_capitulo_inner(&state, Uuid::now_v7(), "1", None, "Resumo qualquer.").await;
            assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_resumo_de_capitulo_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("remover-inexistente").await;

            let result = remover_resumo_de_capitulo_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }
    }
}
