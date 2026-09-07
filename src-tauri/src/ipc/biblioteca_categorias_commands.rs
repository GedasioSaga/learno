//! Comandos `#[tauri::command]` de categorias de livro — mesmo desenho de
//! `ipc::vocabulario_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com um par `_inner` testável sem `AppHandle`.
//!
//! `listar_categorias_por_livro` é o comando que alimenta o filtro da
//! estante sem uma consulta por livro — ver o comentário de
//! `db::biblioteca_categorias` para o porquê desta forma em vez de um campo
//! novo em `LivroNaEstante`.

use tauri::State;
use uuid::Uuid;

use crate::db::{Categoria, CategoriaRepository, CategoriasDoLivro};
use crate::error::Result;
use crate::ipc::state::AppState;

fn categoria_repository(state: &AppState) -> Result<CategoriaRepository> {
    Ok(CategoriaRepository::new(state.pool()?))
}

/// `criar_categoria`. Nome vazio ou duplicado entre IRMÃOS (ignorando
/// caixa/acento, D3) é recusado — ver o comentário de `CategoriaRepository`
/// para o porquê da mensagem nomear a categoria conflitante. `parent_id`
/// nulo cria uma categoria de raiz; um `parent_id` que não existe é
/// recusado com `Error::NotFound`.
#[tauri::command]
pub async fn criar_categoria(state: State<'_, AppState>, nome: String, parent_id: Option<Uuid>) -> Result<Categoria> {
    criar_categoria_inner(&state, &nome, parent_id).await
}

async fn criar_categoria_inner(state: &AppState, nome: &str, parent_id: Option<Uuid>) -> Result<Categoria> {
    categoria_repository(state)?.criar(nome, parent_id).await
}

/// `mover_categoria`. `novo_parent_id` nulo move para a raiz. Recusa mover
/// para dentro de si mesma ou de sua própria subárvore (ciclo) — ver o
/// comentário de `CategoriaRepository::is_within_subtree` para o porquê.
#[tauri::command]
pub async fn mover_categoria(
    state: State<'_, AppState>,
    id: Uuid,
    novo_parent_id: Option<Uuid>,
) -> Result<Categoria> {
    mover_categoria_inner(&state, id, novo_parent_id).await
}

async fn mover_categoria_inner(state: &AppState, id: Uuid, novo_parent_id: Option<Uuid>) -> Result<Categoria> {
    categoria_repository(state)?.mover(id, novo_parent_id).await
}

/// `listar_categorias`, em ordem de `position`.
#[tauri::command]
pub async fn listar_categorias(state: State<'_, AppState>) -> Result<Vec<Categoria>> {
    listar_categorias_inner(&state).await
}

async fn listar_categorias_inner(state: &AppState) -> Result<Vec<Categoria>> {
    categoria_repository(state)?.listar().await
}

/// `renomear_categoria`.
#[tauri::command]
pub async fn renomear_categoria(state: State<'_, AppState>, id: Uuid, nome: String) -> Result<Categoria> {
    renomear_categoria_inner(&state, id, &nome).await
}

async fn renomear_categoria_inner(state: &AppState, id: Uuid, nome: &str) -> Result<Categoria> {
    categoria_repository(state)?.renomear(id, nome).await
}

/// `remover_categoria`. As ligações com livro caem por `CASCADE` — nenhum
/// livro é apagado, ver o comentário de `CategoriaRepository::remover`.
#[tauri::command]
pub async fn remover_categoria(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    remover_categoria_inner(&state, id).await
}

async fn remover_categoria_inner(state: &AppState, id: Uuid) -> Result<()> {
    categoria_repository(state)?.remover(id).await
}

/// `definir_categorias_do_livro`. Substitui o conjunto inteiro numa
/// transação só — ver o comentário de
/// `CategoriaRepository::definir_categorias_do_livro` para a garantia de
/// tudo-ou-nada.
#[tauri::command]
pub async fn definir_categorias_do_livro(
    state: State<'_, AppState>,
    livro_id: Uuid,
    categoria_ids: Vec<Uuid>,
) -> Result<()> {
    definir_categorias_do_livro_inner(&state, livro_id, &categoria_ids).await
}

async fn definir_categorias_do_livro_inner(state: &AppState, livro_id: Uuid, categoria_ids: &[Uuid]) -> Result<()> {
    categoria_repository(state)?.definir_categorias_do_livro(livro_id, categoria_ids).await
}

/// `listar_categorias_do_livro`, em ordem de `position`.
#[tauri::command]
pub async fn listar_categorias_do_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<Vec<Categoria>> {
    listar_categorias_do_livro_inner(&state, livro_id).await
}

async fn listar_categorias_do_livro_inner(state: &AppState, livro_id: Uuid) -> Result<Vec<Categoria>> {
    categoria_repository(state)?.listar_categorias_do_livro(livro_id).await
}

/// `listar_categorias_por_livro`: um item por livro que tem ao menos uma
/// categoria, para a estante filtrar sem uma consulta por livro.
#[tauri::command]
pub async fn listar_categorias_por_livro(state: State<'_, AppState>) -> Result<Vec<CategoriasDoLivro>> {
    listar_categorias_por_livro_inner(&state).await
}

async fn listar_categorias_por_livro_inner(state: &AppState) -> Result<Vec<CategoriasDoLivro>> {
    categoria_repository(state)?.listar_categorias_por_livro().await
}

/// `listar_livros_da_categoria` — D1: o filtro da estante por uma
/// categoria-pai precisa alcançar os livros de QUALQUER descendente dela,
/// não só dos filhos diretos. Ver o comentário de
/// `CategoriaRepository::listar_livros_da_categoria` para o porquê da
/// expansão rodar aqui (SQL recursivo) em vez de na tela.
#[tauri::command]
pub async fn listar_livros_da_categoria(state: State<'_, AppState>, categoria_id: Uuid) -> Result<Vec<Uuid>> {
    listar_livros_da_categoria_inner(&state, categoria_id).await
}

async fn listar_livros_da_categoria_inner(state: &AppState, categoria_id: Uuid) -> Result<Vec<Uuid>> {
    categoria_repository(state)?.listar_livros_da_categoria(categoria_id).await
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
        async fn criar_categoria_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(criar_categoria_inner(&state, "Ficção", None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_categorias_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_categorias_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn renomear_categoria_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(renomear_categoria_inner(&state, Uuid::now_v7(), "Nome").await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn mover_categoria_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(mover_categoria_inner(&state, Uuid::now_v7(), None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_categoria_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_categoria_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_livros_da_categoria_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_livros_da_categoria_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_categorias_do_livro_reports_not_connected() {
            let state = AppState::new();
            let result = definir_categorias_do_livro_inner(&state, Uuid::now_v7(), &[]).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_categorias_do_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_categorias_do_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_categorias_por_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_categorias_por_livro_inner(&state).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;
        use crate::db::BibliotecaRepository;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-categorias-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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

        async fn livro_de_teste(state: &AppState, data_dir: &std::path::Path, nome: &str) -> Uuid {
            let media_dir = data_dir.join("media");
            std::fs::create_dir_all(data_dir).unwrap();
            let origem = data_dir.join(nome);
            std::fs::write(&origem, format!("conteudo de {nome}").as_bytes()).unwrap();

            let biblioteca = BibliotecaRepository::new(state.pool().unwrap());
            biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro.id
        }

        /// Fiação de ponta a ponta pela camada de comando: criar, listar,
        /// renomear, definir o conjunto de um livro, listar por livro e
        /// remover.
        #[tokio::test]
        async fn the_whole_command_layer_wiring_round_trips_through_a_category() {
            let (state, data_dir) = estado_com_banco("fiacao-completa").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;

            let categoria = criar_categoria_inner(&state, "Ficção", None).await.unwrap();
            assert_eq!(categoria.name, "Ficção");

            let lista = listar_categorias_inner(&state).await.unwrap();
            assert_eq!(lista.len(), 1);

            let renomeada = renomear_categoria_inner(&state, categoria.id, "Ficção Científica").await.unwrap();
            assert_eq!(renomeada.name, "Ficção Científica");

            definir_categorias_do_livro_inner(&state, livro_id, &[categoria.id]).await.unwrap();
            let do_livro = listar_categorias_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(do_livro.len(), 1);
            assert_eq!(do_livro[0].id, categoria.id);

            let por_livro = listar_categorias_por_livro_inner(&state).await.unwrap();
            assert_eq!(por_livro.len(), 1);
            assert_eq!(por_livro[0].livro_id, livro_id);

            remover_categoria_inner(&state, categoria.id).await.unwrap();
            let apos_remover = listar_categorias_do_livro_inner(&state, livro_id).await.unwrap();
            assert!(apos_remover.is_empty());

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn criar_categoria_rejects_a_blank_name() {
            let (state, data_dir) = estado_com_banco("nome-vazio").await;

            let result = criar_categoria_inner(&state, "   ", None).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        /// O CASO CENTRAL, exercitado também pela camada de comando: nome
        /// duplicado ignorando caixa/acento é recusado, com a mensagem
        /// nomeando a categoria conflitante.
        #[tokio::test]
        async fn criar_categoria_rejects_a_duplicate_name_and_names_the_existing_category() {
            let (state, data_dir) = estado_com_banco("nome-duplicado").await;

            criar_categoria_inner(&state, "Ficção Científica", None).await.unwrap();
            let segunda = criar_categoria_inner(&state, "ficcao cientifica", None).await;

            assert!(matches!(segunda, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {segunda:?}");
            let mensagem = format!("{}", segunda.unwrap_err());
            assert!(mensagem.contains("Ficção Científica"), "obtido: {mensagem}");

            encerra(state, data_dir).await;
        }

        /// O CASO CENTRAL de `definir_categorias_do_livro`: numa lista de
        /// dois onde o SEGUNDO é inválido, o PRIMEIRO também não entra.
        #[tokio::test]
        async fn definir_categorias_do_livro_rejects_the_whole_list_when_the_second_id_is_invalid() {
            let (state, data_dir) = estado_com_banco("segundo-invalido").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;
            let valida = criar_categoria_inner(&state, "Válida", None).await.unwrap();
            let invalida = Uuid::now_v7();

            let result = definir_categorias_do_livro_inner(&state, livro_id, &[valida.id, invalida]).await;
            assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

            let apos_falha = listar_categorias_do_livro_inner(&state, livro_id).await.unwrap();
            assert!(apos_falha.is_empty(), "nem a primeira id (válida) da lista pode ter entrado");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn definir_categorias_do_livro_rejects_an_unknown_book() {
            let (state, data_dir) = estado_com_banco("livro-inexistente").await;

            let result = definir_categorias_do_livro_inner(&state, Uuid::now_v7(), &[]).await;
            assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn renomear_categoria_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("renomear-inexistente").await;

            let result = renomear_categoria_inner(&state, Uuid::now_v7(), "Nome").await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_categoria_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("remover-inexistente").await;

            let result = remover_categoria_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        /// Fiação de `mover_categoria` e `listar_livros_da_categoria` pela
        /// camada de comando: cria pai/filho, move o filho para a raiz, e o
        /// filtro por categoria alcança o livro guardado num neto.
        #[tokio::test]
        async fn mover_categoria_and_listar_livros_da_categoria_wiring_round_trips() {
            let (state, data_dir) = estado_com_banco("mover-e-filtro").await;
            let livro_no_neto = livro_de_teste(&state, &data_dir, "NoNeto.pdf").await;

            let fantasia = criar_categoria_inner(&state, "Fantasia", None).await.unwrap();
            let epico = criar_categoria_inner(&state, "Épico", Some(fantasia.id)).await.unwrap();
            let alta_fantasia = criar_categoria_inner(&state, "Alta Fantasia", Some(epico.id)).await.unwrap();
            definir_categorias_do_livro_inner(&state, livro_no_neto, &[alta_fantasia.id]).await.unwrap();

            let filtro = listar_livros_da_categoria_inner(&state, fantasia.id).await.unwrap();
            assert_eq!(filtro, vec![livro_no_neto], "o filtro pelo avô precisa alcançar o livro do neto");

            let ciclo = mover_categoria_inner(&state, fantasia.id, Some(epico.id)).await;
            assert!(matches!(ciclo, Err(Error::Invalid(_))), "mover para dentro do próprio filho é um ciclo, obtido {ciclo:?}");

            let movida = mover_categoria_inner(&state, epico.id, None).await.unwrap();
            assert_eq!(movida.parent_id, None);

            encerra(state, data_dir).await;
        }
    }
}
