//! Comandos `#[tauri::command]` das páginas de anotação do livro — mesmo
//! desenho de `ipc::resumo_capitulo_commands`: cada comando monta o
//! repositório a partir de `state.pool()` e delega, com um par `_inner`
//! testável sem `AppHandle`.

use tauri::State;
use uuid::Uuid;

use crate::db::{PaginaDeLivro, PaginaDeLivroRepository};
use crate::error::Result;
use crate::ipc::state::AppState;

fn pagina_de_livro_repository(state: &AppState) -> Result<PaginaDeLivroRepository> {
    Ok(PaginaDeLivroRepository::new(state.pool()?))
}

/// `criar_pagina_de_livro`: nasce no fim da lista do livro, com conteúdo
/// vazio — o usuário escreve depois.
#[tauri::command]
pub async fn criar_pagina_de_livro(state: State<'_, AppState>, livro_id: Uuid, titulo: String) -> Result<PaginaDeLivro> {
    criar_pagina_de_livro_inner(&state, livro_id, &titulo).await
}

async fn criar_pagina_de_livro_inner(state: &AppState, livro_id: Uuid, titulo: &str) -> Result<PaginaDeLivro> {
    pagina_de_livro_repository(state)?.criar(livro_id, titulo).await
}

/// `listar_paginas_do_livro`, na ordem do usuário.
#[tauri::command]
pub async fn listar_paginas_do_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<Vec<PaginaDeLivro>> {
    listar_paginas_do_livro_inner(&state, livro_id).await
}

async fn listar_paginas_do_livro_inner(state: &AppState, livro_id: Uuid) -> Result<Vec<PaginaDeLivro>> {
    pagina_de_livro_repository(state)?.listar_do_livro(livro_id).await
}

/// `renomear_pagina_de_livro`.
#[tauri::command]
pub async fn renomear_pagina_de_livro(state: State<'_, AppState>, id: Uuid, titulo: String) -> Result<PaginaDeLivro> {
    renomear_pagina_de_livro_inner(&state, id, &titulo).await
}

async fn renomear_pagina_de_livro_inner(state: &AppState, id: Uuid, titulo: &str) -> Result<PaginaDeLivro> {
    pagina_de_livro_repository(state)?.renomear(id, titulo).await
}

/// `escrever_conteudo_da_pagina`: sobrescreve o texto inteiro.
#[tauri::command]
pub async fn escrever_conteudo_da_pagina(state: State<'_, AppState>, id: Uuid, conteudo: String) -> Result<PaginaDeLivro> {
    escrever_conteudo_da_pagina_inner(&state, id, &conteudo).await
}

async fn escrever_conteudo_da_pagina_inner(state: &AppState, id: Uuid, conteudo: &str) -> Result<PaginaDeLivro> {
    pagina_de_livro_repository(state)?.escrever_conteudo(id, conteudo).await
}

/// `mover_pagina_de_livro`: `aposPaginaId = None` significa "primeira do
/// livro" — ver `PaginaDeLivroRepository::mover` para o porquê de não haver
/// parâmetro de livro de destino.
#[tauri::command]
pub async fn mover_pagina_de_livro(
    state: State<'_, AppState>,
    pagina_id: Uuid,
    apos_pagina_id: Option<Uuid>,
) -> Result<PaginaDeLivro> {
    mover_pagina_de_livro_inner(&state, pagina_id, apos_pagina_id).await
}

async fn mover_pagina_de_livro_inner(state: &AppState, pagina_id: Uuid, apos_pagina_id: Option<Uuid>) -> Result<PaginaDeLivro> {
    pagina_de_livro_repository(state)?.mover(pagina_id, apos_pagina_id).await
}

/// `remover_pagina_de_livro`.
#[tauri::command]
pub async fn remover_pagina_de_livro(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    remover_pagina_de_livro_inner(&state, id).await
}

async fn remover_pagina_de_livro_inner(state: &AppState, id: Uuid) -> Result<()> {
    pagina_de_livro_repository(state)?.remover(id).await
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
        async fn criar_pagina_de_livro_reports_not_connected() {
            let state = AppState::new();
            let result = criar_pagina_de_livro_inner(&state, Uuid::now_v7(), "Título").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_paginas_do_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_paginas_do_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_pagina_de_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_pagina_de_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;
        use crate::db::BibliotecaRepository;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-pagina-de-livro-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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

        /// Fiação de ponta a ponta pela camada de comando: criar, listar,
        /// renomear, escrever conteúdo, mover, remover.
        #[tokio::test]
        async fn the_whole_command_layer_wiring_round_trips_through_a_book_page() {
            let (state, data_dir) = estado_com_banco("fiacao-completa").await;
            let livro_id = livro_de_teste(&state, &data_dir).await;

            let criada = criar_pagina_de_livro_inner(&state, livro_id, "Rascunho").await.unwrap();
            assert_eq!(criada.content, "");

            let lista = listar_paginas_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(lista.len(), 1);
            assert_eq!(lista[0].id, criada.id);

            let renomeada = renomear_pagina_de_livro_inner(&state, criada.id, "Título final").await.unwrap();
            assert_eq!(renomeada.title, "Título final");

            let escrita = escrever_conteudo_da_pagina_inner(&state, criada.id, "Minhas notas.").await.unwrap();
            assert_eq!(escrita.content, "Minhas notas.");

            let segunda = criar_pagina_de_livro_inner(&state, livro_id, "Segunda página").await.unwrap();
            let movida = mover_pagina_de_livro_inner(&state, segunda.id, None).await.unwrap();
            let lista_movida = listar_paginas_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(lista_movida[0].id, movida.id);

            remover_pagina_de_livro_inner(&state, criada.id).await.unwrap();
            let lista_final = listar_paginas_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(lista_final.len(), 1);

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_pagina_de_livro_rejects_a_blank_title() {
            let (state, data_dir) = estado_com_banco("titulo-vazio").await;
            let livro_id = livro_de_teste(&state, &data_dir).await;

            let result = criar_pagina_de_livro_inner(&state, livro_id, "   ").await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_pagina_de_livro_rejects_an_unknown_book() {
            let (state, data_dir) = estado_com_banco("livro-inexistente").await;

            let result = criar_pagina_de_livro_inner(&state, Uuid::now_v7(), "Título qualquer").await;
            assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_pagina_de_livro_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("remover-inexistente").await;

            let result = remover_pagina_de_livro_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }
    }
}
