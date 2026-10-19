//! Comandos `#[tauri::command]` do vocabulário novo — mesmo desenho de
//! `ipc::prazos_commands`: cada comando monta o repositório a partir de
//! `state.pool()` e delega, com um par `_inner` testável sem `AppHandle`.
//!
//! PONTE COM CARTÕES (não implementada aqui, de propósito): uma palavra
//! coletada deve virar cartão pelo formulário que já existe em
//! `src/features/cartoes/CriarCartaoDeOrigem.tsx` — este módulo não abre um
//! segundo caminho de criação de nota/cartão. O dado que falta para essa
//! ponte funcionar de verdade: `library_vocabulary` não guarda nenhuma
//! referência de volta a um cartão já criado a partir dela (nem
//! `note_id`/`card_id`, ao contrário de `library_annotations`, que já tem
//! `note_id`). Sem essa coluna, o formulário de origem consegue LER uma
//! `PalavraColetada` para pré-preencher um cartão nova, mas não tem onde
//! gravar "esta palavra já virou o cartão X" — colar o mesmo card duas vezes
//! não teria como ser detectado. Fica registrado aqui para quem desenhar essa
//! tela decidir se quer essa coluna numa migração futura.

use tauri::State;
use uuid::Uuid;

use crate::db::{NovaPalavra, PalavraColetada, VocabularioRepository};
use crate::error::Result;
use crate::ipc::state::AppState;

fn vocabulario_repository(state: &AppState) -> Result<VocabularioRepository> {
    Ok(VocabularioRepository::new(state.pool()?))
}

/// `coletar_palavra`. Termo duplicado no mesmo livro (ignorando caixa/acento)
/// é recusado — ver o comentário de `VocabularioRepository` para o porquê.
/// `sinonimos`/`antonimos` chegam como lista e são normalizados no
/// repositório (trim, sem vazio, sem duplicata, tetos).
// Cada argumento é uma chave do objeto que o `invoke` do TypeScript manda —
// a lista é o contrato IPC, então não dá para agrupar num struct sem mudar
// o formato da chamada do outro lado.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn coletar_palavra(
    state: State<'_, AppState>,
    livro_id: Uuid,
    termo: String,
    trecho_de_contexto: Option<String>,
    nota: Option<String>,
    sinonimos: Vec<String>,
    antonimos: Vec<String>,
    locator: Option<String>,
) -> Result<PalavraColetada> {
    let nova = NovaPalavra {
        term: &termo,
        context_snippet: trecho_de_contexto.as_deref(),
        note: nota.as_deref(),
        synonyms: &sinonimos,
        antonyms: &antonimos,
        locator: locator.as_deref(),
    };
    coletar_palavra_inner(&state, livro_id, nova).await
}

async fn coletar_palavra_inner(state: &AppState, livro_id: Uuid, nova: NovaPalavra<'_>) -> Result<PalavraColetada> {
    vocabulario_repository(state)?.coletar(livro_id, nova).await
}

/// `listar_palavras_do_livro`.
#[tauri::command]
pub async fn listar_palavras_do_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<Vec<PalavraColetada>> {
    listar_palavras_do_livro_inner(&state, livro_id).await
}

async fn listar_palavras_do_livro_inner(state: &AppState, livro_id: Uuid) -> Result<Vec<PalavraColetada>> {
    vocabulario_repository(state)?.listar_do_livro(livro_id).await
}

/// `listar_palavras`: a lista geral, de todos os livros, para revisar
/// vocabulário. `termo_busca` ausente ou em branco lista tudo.
#[tauri::command]
pub async fn listar_palavras(state: State<'_, AppState>, termo_busca: Option<String>) -> Result<Vec<PalavraColetada>> {
    listar_palavras_inner(&state, termo_busca.as_deref()).await
}

async fn listar_palavras_inner(state: &AppState, termo_busca: Option<&str>) -> Result<Vec<PalavraColetada>> {
    vocabulario_repository(state)?.listar(termo_busca).await
}

/// `atualizar_palavra` (antes `atualizar_nota_da_palavra`): troca nota,
/// sinônimos e antônimos de uma vez — a lista que chega é a lista inteira.
#[tauri::command]
pub async fn atualizar_palavra(
    state: State<'_, AppState>,
    id: Uuid,
    nota: Option<String>,
    sinonimos: Vec<String>,
    antonimos: Vec<String>,
) -> Result<PalavraColetada> {
    atualizar_palavra_inner(&state, id, nota.as_deref(), &sinonimos, &antonimos).await
}

async fn atualizar_palavra_inner(
    state: &AppState,
    id: Uuid,
    nota: Option<&str>,
    sinonimos: &[String],
    antonimos: &[String],
) -> Result<PalavraColetada> {
    vocabulario_repository(state)?.atualizar(id, nota, sinonimos, antonimos).await
}

/// `definir_marcacao_da_palavra`: liga/desliga a marcação da palavra no
/// texto do livro. Devolve a palavra atualizada, como `atualizar_palavra`.
#[tauri::command]
pub async fn definir_marcacao_da_palavra(state: State<'_, AppState>, id: Uuid, ativa: bool) -> Result<PalavraColetada> {
    definir_marcacao_da_palavra_inner(&state, id, ativa).await
}

async fn definir_marcacao_da_palavra_inner(state: &AppState, id: Uuid, ativa: bool) -> Result<PalavraColetada> {
    vocabulario_repository(state)?.definir_marcacao(id, ativa).await
}

/// `remover_palavra`.
#[tauri::command]
pub async fn remover_palavra(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    remover_palavra_inner(&state, id).await
}

async fn remover_palavra_inner(state: &AppState, id: Uuid) -> Result<()> {
    vocabulario_repository(state)?.remover(id).await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::error::Error;

    fn so_termo(term: &str) -> NovaPalavra<'_> {
        NovaPalavra { term, ..NovaPalavra::default() }
    }

    fn lista(itens: &[&str]) -> Vec<String> {
        itens.iter().map(|item| (*item).to_string()).collect()
    }

    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn coletar_palavra_reports_not_connected() {
            let state = AppState::new();
            let result = coletar_palavra_inner(&state, Uuid::now_v7(), so_termo("termo")).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_palavras_do_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_palavras_do_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_palavras_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_palavras_inner(&state, None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn atualizar_palavra_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(atualizar_palavra_inner(&state, Uuid::now_v7(), None, &[], &[]).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_marcacao_da_palavra_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(definir_marcacao_da_palavra_inner(&state, Uuid::now_v7(), false).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_palavra_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_palavra_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;
        use crate::db::BibliotecaRepository;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-vocabulario-cmd-test-{rotulo}-{}", Uuid::new_v4()))
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

        /// Fiação de ponta a ponta pela camada de comando: coletar (com
        /// sinônimos e antônimos), listar por livro, listar geral com filtro,
        /// atualizar a palavra, desligar a marcação, remover.
        #[tokio::test]
        async fn the_whole_command_layer_wiring_round_trips_through_a_collected_word() {
            let (state, data_dir) = estado_com_banco("fiacao-completa").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;

            let sinonimos = lista(&[" organela ", "Organela"]);
            let coletada = coletar_palavra_inner(
                &state,
                livro_id,
                NovaPalavra {
                    term: "mitocôndria",
                    context_snippet: Some("a usina da célula"),
                    synonyms: &sinonimos,
                    locator: Some("42"),
                    ..NovaPalavra::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(coletada.term, "mitocôndria");
            assert_eq!(coletada.synonyms, lista(&["organela"]));
            assert!(coletada.antonyms.is_empty());
            assert!(coletada.highlight_in_book, "palavra nova nasce marcada");

            let do_livro = listar_palavras_do_livro_inner(&state, livro_id).await.unwrap();
            assert_eq!(do_livro.len(), 1);

            let geral = listar_palavras_inner(&state, Some("mito")).await.unwrap();
            assert_eq!(geral.len(), 1);
            assert_eq!(geral[0].id, coletada.id);

            let sem_resultado = listar_palavras_inner(&state, Some("inexistente")).await.unwrap();
            assert!(sem_resultado.is_empty());

            let atualizada = atualizar_palavra_inner(
                &state,
                coletada.id,
                Some("revisar depois"),
                &lista(&["organela", "usina"]),
                &lista(&["núcleo"]),
            )
            .await
            .unwrap();
            assert_eq!(atualizada.note.as_deref(), Some("revisar depois"));
            assert_eq!(atualizada.synonyms, lista(&["organela", "usina"]));
            assert_eq!(atualizada.antonyms, lista(&["núcleo"]));

            let desligada = definir_marcacao_da_palavra_inner(&state, coletada.id, false).await.unwrap();
            assert!(!desligada.highlight_in_book);
            let do_livro = listar_palavras_do_livro_inner(&state, livro_id).await.unwrap();
            assert!(!do_livro[0].highlight_in_book, "a marcação desligada precisa voltar na listagem");

            remover_palavra_inner(&state, coletada.id).await.unwrap();
            let apos_remover = listar_palavras_do_livro_inner(&state, livro_id).await.unwrap();
            assert!(apos_remover.is_empty());

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn coletar_palavra_rejects_a_blank_term() {
            let (state, data_dir) = estado_com_banco("termo-vazio").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;

            let result = coletar_palavra_inner(&state, livro_id, so_termo("   ")).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn coletar_palavra_rejects_an_unknown_book() {
            let (state, data_dir) = estado_com_banco("livro-inexistente").await;

            let result = coletar_palavra_inner(&state, Uuid::now_v7(), so_termo("termo")).await;
            assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

            encerra(state, data_dir).await;
        }

        /// O CASO CENTRAL, exercitado também pela camada de comando: a mesma
        /// palavra colhida duas vezes no mesmo livro, com caixa diferente, é
        /// recusada.
        #[tokio::test]
        async fn coletar_palavra_rejects_the_same_word_twice_with_different_case() {
            let (state, data_dir) = estado_com_banco("duplicado-caixa").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;

            coletar_palavra_inner(&state, livro_id, so_termo("mitocôndria")).await.unwrap();
            let segunda = coletar_palavra_inner(&state, livro_id, so_termo("Mitocôndria")).await;

            assert!(matches!(segunda, Err(Error::Database(_))), "esperava Error::Database (gatilho de duplicata), obtido {segunda:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_palavra_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("atualizar-inexistente").await;

            let result = atualizar_palavra_inner(&state, Uuid::now_v7(), Some("nota"), &[], &[]).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn atualizar_palavra_rejects_an_oversized_list() {
            let (state, data_dir) = estado_com_banco("atualizar-teto").await;
            let livro_id = livro_de_teste(&state, &data_dir, "Livro.pdf").await;
            let coletada = coletar_palavra_inner(&state, livro_id, so_termo("voraz")).await.unwrap();

            let demais: Vec<String> = (0..=50).map(|n| format!("item{n}")).collect();
            let result = atualizar_palavra_inner(&state, coletada.id, None, &[], &demais).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn definir_marcacao_da_palavra_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("marcacao-inexistente").await;

            let result = definir_marcacao_da_palavra_inner(&state, Uuid::now_v7(), true).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }

        #[tokio::test]
        async fn remover_palavra_reports_not_found_for_an_unknown_id() {
            let (state, data_dir) = estado_com_banco("remover-inexistente").await;

            let result = remover_palavra_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::NotFound(_))));

            encerra(state, data_dir).await;
        }
    }
}
