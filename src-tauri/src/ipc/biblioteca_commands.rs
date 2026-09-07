//! Comandos `#[tauri::command]` da Biblioteca — mesmo desenho de
//! `ipc::pomodoro_commands`/`ipc::deck_commands`: cada comando monta o
//! repositório a partir de `state.pool()` e delega, com um par `_inner`
//! testável sem `AppHandle`.
//!
//! `importar_livro`/`abrir_livro` também precisam de onde a pasta de
//! trabalho está — `media/` vive dentro dela, mesma convenção de
//! `media-storage.ts` (`MEDIA_SUBDIR`) — e por isso passam por
//! `backup_commands::require_config` em vez de só `state.pool()`.

use std::path::PathBuf;

use tauri::State;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::db::{AnotacaoRow, BibliotecaRepository, LivroAberto, LivroNaEstante, LivroRow, ProgressoDeLeitura};
use crate::error::Result;
use crate::ipc::backup_commands::require_config;
use crate::ipc::state::AppState;

fn biblioteca_repository(state: &AppState) -> Result<BibliotecaRepository> {
    Ok(BibliotecaRepository::new(state.pool()?))
}

/// `media/` dentro da pasta de trabalho — mesma subpasta que
/// `media-storage.ts` já usa para mídia de bloco, para o livro reusar o
/// mesmo armazenamento em vez de inventar um segundo.
fn media_dir(config: &AppConfig) -> PathBuf {
    config.data_dir_path().join("media")
}

/// `listar_livros`: a estante inteira, mais recém-importado primeiro.
#[tauri::command]
pub async fn listar_livros(state: State<'_, AppState>) -> Result<Vec<LivroNaEstante>> {
    listar_livros_inner(&state).await
}

async fn listar_livros_inner(state: &AppState) -> Result<Vec<LivroNaEstante>> {
    biblioteca_repository(state)?.list_shelf().await
}

/// `importar_livro`: copia `caminho_de_origem` para `media/` (deduplicado
/// por hash de conteúdo) e cria a página-registro do livro. Ver o
/// comentário de `BibliotecaRepository::import` para a ordem dos passos e a
/// decisão de reimportação idempotente.
#[tauri::command]
pub async fn importar_livro(state: State<'_, AppState>, caminho_de_origem: String) -> Result<LivroNaEstante> {
    importar_livro_inner(&state, &caminho_de_origem).await
}

/// `require_config` fica AQUI dentro, e não no `#[tauri::command]` acima, de
/// propósito: enquanto ele morava lá, o `_inner` cobria só metade do corpo do
/// comando, e nenhum teste jamais exercitava a metade que falhava de verdade
/// em produção (ver o teste de regressão
/// `configuracoes_montadas_no_boot_nao_podem_apagar_a_pasta_de_trabalho`).
async fn importar_livro_inner(state: &AppState, caminho_de_origem: &str) -> Result<LivroNaEstante> {
    let config = require_config(state)?;
    biblioteca_repository(state)?.import(&media_dir(&config), caminho_de_origem).await
}

/// `abrir_livro`: livro, progresso e o caminho absoluto do arquivo em
/// `media/` — o leitor (fora desta peça) abre o arquivo por aí. Não marca
/// nada como lido; isso é `registrar_progresso`.
#[tauri::command]
pub async fn abrir_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<LivroAberto> {
    abrir_livro_inner(&state, livro_id).await
}

async fn abrir_livro_inner(state: &AppState, livro_id: Uuid) -> Result<LivroAberto> {
    let config = require_config(state)?;
    biblioteca_repository(state)?.open(&media_dir(&config), livro_id).await
}

/// `registrar_progresso`: chamado a cada virada de página — ver o
/// comentário de `BibliotecaRepository::record_progress` para por que isto
/// nunca toca `pages` e por que `furthest` só avança aqui.
#[tauri::command]
pub async fn registrar_progresso(
    state: State<'_, AppState>,
    livro_id: Uuid,
    locator: String,
    fraction: f64,
) -> Result<ProgressoDeLeitura> {
    registrar_progresso_inner(&state, livro_id, &locator, fraction).await
}

async fn registrar_progresso_inner(
    state: &AppState,
    livro_id: Uuid,
    locator: &str,
    fraction: f64,
) -> Result<ProgressoDeLeitura> {
    biblioteca_repository(state)?.record_progress(livro_id, locator, fraction).await
}

/// `remover_livro`: move a página do livro para a lixeira. NÃO apaga o
/// arquivo nem a linha — ver o comentário de
/// `BibliotecaRepository::move_to_trash`. A exclusão de verdade é
/// `excluir_livro_definitivamente`, abaixo.
#[tauri::command]
pub async fn remover_livro(state: State<'_, AppState>, livro_id: Uuid) -> Result<()> {
    remover_livro_inner(&state, livro_id).await
}

async fn remover_livro_inner(state: &AppState, livro_id: Uuid) -> Result<()> {
    biblioteca_repository(state)?.move_to_trash(livro_id).await
}

/// `excluir_livro_definitivamente`: a exclusão de verdade — apaga a linha de
/// `library_books`, o arquivo em `media/` e, em cascata, todo progresso e
/// anotação do livro. Exige que o livro já esteja na lixeira (chame
/// `remover_livro` primeiro); ver o comentário de
/// `BibliotecaRepository::delete_permanently` para a validação de caminho e
/// o porquê do fluxo em dois passos.
#[tauri::command]
pub async fn excluir_livro_definitivamente(state: State<'_, AppState>, livro_id: Uuid) -> Result<()> {
    excluir_livro_definitivamente_inner(&state, livro_id).await
}

async fn excluir_livro_definitivamente_inner(state: &AppState, livro_id: Uuid) -> Result<()> {
    let config = require_config(state)?;
    biblioteca_repository(state)?.delete_permanently(&media_dir(&config), livro_id).await
}

/// `definir_capa_do_livro`: grava (ou limpa, com `cover_file_name: None`) o
/// nome do arquivo de capa. Passa por `require_config`/`media_dir` como
/// `abrir_livro`/`excluir_livro_definitivamente` — a validação de
/// `cover_file_name` (ver `BibliotecaRepository::definir_capa_do_livro`)
/// precisa saber onde `media/` está para confirmar que o arquivo existe e
/// não escapa dela.
#[tauri::command]
pub async fn definir_capa_do_livro(
    state: State<'_, AppState>,
    livro_id: Uuid,
    cover_file_name: Option<String>,
) -> Result<()> {
    definir_capa_do_livro_inner(&state, livro_id, cover_file_name).await
}

async fn definir_capa_do_livro_inner(
    state: &AppState,
    livro_id: Uuid,
    cover_file_name: Option<String>,
) -> Result<()> {
    let config = require_config(state)?;
    biblioteca_repository(state)?.definir_capa_do_livro(&media_dir(&config), livro_id, cover_file_name).await
}

/// `definir_metadados_do_livro`: edita título e autor do livro. `None` não
/// mexe no campo; texto em branco apaga (o título volta ao derivado do
/// arquivo; o autor volta a "Autor desconhecido") — ver o comentário de
/// `BibliotecaRepository::definir_metadados_do_livro` para a semântica
/// completa dos três estados.
#[tauri::command]
pub async fn definir_metadados_do_livro(
    state: State<'_, AppState>,
    livro_id: Uuid,
    titulo: Option<String>,
    autor: Option<String>,
) -> Result<LivroRow> {
    definir_metadados_do_livro_inner(&state, livro_id, titulo, autor).await
}

async fn definir_metadados_do_livro_inner(
    state: &AppState,
    livro_id: Uuid,
    titulo: Option<String>,
    autor: Option<String>,
) -> Result<LivroRow> {
    biblioteca_repository(state)?.definir_metadados_do_livro(livro_id, titulo, autor).await
}

/// `mover_livro`: reordena a estante — `apos_livro_id` nulo move para o
/// primeiro lugar. Ver o comentário de `BibliotecaRepository::mover_livro`
/// para o índice fracionário por trás e os casos que viram `Error::Invalid`.
#[tauri::command]
pub async fn mover_livro(state: State<'_, AppState>, livro_id: Uuid, apos_livro_id: Option<Uuid>) -> Result<LivroRow> {
    mover_livro_inner(&state, livro_id, apos_livro_id).await
}

async fn mover_livro_inner(state: &AppState, livro_id: Uuid, apos_livro_id: Option<Uuid>) -> Result<LivroRow> {
    biblioteca_repository(state)?.mover_livro(livro_id, apos_livro_id).await
}

/// `listar_anotacoes`: em ordem de leitura.
#[tauri::command]
pub async fn listar_anotacoes(state: State<'_, AppState>, livro_id: Uuid) -> Result<Vec<AnotacaoRow>> {
    listar_anotacoes_inner(&state, livro_id).await
}

async fn listar_anotacoes_inner(state: &AppState, livro_id: Uuid) -> Result<Vec<AnotacaoRow>> {
    biblioteca_repository(state)?.list_annotations(livro_id).await
}

/// `criar_anotacao`: marcador, destaque ou anotação presa a um trecho do
/// livro.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn criar_anotacao(
    state: State<'_, AppState>,
    livro_id: Uuid,
    kind: String,
    locator_start: String,
    locator_end: Option<String>,
    fraction: f64,
    excerpt: String,
    note: Option<String>,
    color: Option<String>,
) -> Result<AnotacaoRow> {
    criar_anotacao_inner(&state, livro_id, &kind, &locator_start, locator_end.as_deref(), fraction, &excerpt, note.as_deref(), color.as_deref())
        .await
}

#[allow(clippy::too_many_arguments)]
async fn criar_anotacao_inner(
    state: &AppState,
    livro_id: Uuid,
    kind: &str,
    locator_start: &str,
    locator_end: Option<&str>,
    fraction: f64,
    excerpt: &str,
    note: Option<&str>,
    color: Option<&str>,
) -> Result<AnotacaoRow> {
    biblioteca_repository(state)?
        .create_annotation(livro_id, kind, locator_start, locator_end, fraction, excerpt, note, color)
        .await
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
        async fn listar_livros_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_livros_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn registrar_progresso_reports_not_connected() {
            let state = AppState::new();
            let result = registrar_progresso_inner(&state, Uuid::now_v7(), "1", 0.5).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn remover_livro_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(remover_livro_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn listar_anotacoes_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(listar_anotacoes_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_capa_do_livro_reports_not_connected() {
            let state = AppState::new();
            let result = definir_capa_do_livro_inner(&state, Uuid::now_v7(), Some("capa.png".into())).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn definir_metadados_do_livro_reports_not_connected() {
            let state = AppState::new();
            let result = definir_metadados_do_livro_inner(&state, Uuid::now_v7(), Some("Título".into()), None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn mover_livro_reports_not_connected() {
            let state = AppState::new();
            let result = mover_livro_inner(&state, Uuid::now_v7(), None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }
    }

    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::{Path, PathBuf};

        use super::*;
        use crate::ipc::commands::{get_app_config_inner, open_workspace_and_wire_state};

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-biblioteca-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        /// Monta o estado do jeito que o app monta: por
        /// `open_workspace_and_wire_state`, que é o que `open_workspace` — a
        /// primeira coisa que `App.tsx` chama ao subir — delega.
        ///
        /// A versão anterior deste helper chamava `connect_and_migrate` e
        /// `set_pool` à mão e fabricava o `AppConfig` no próprio teste. Isso
        /// deixava a suíte inteira verde contra um `AppState` que o app nunca
        /// tem: um em que o cache de configuração é um dado do teste em vez de
        /// um efeito de abrir a pasta de trabalho. Todo comando que chama
        /// `require_config` estava quebrado em produção com estes testes
        /// passando — ver o teste de regressão no fim deste módulo.
        async fn estado_como_o_app(rotulo: &str) -> (AppState, PathBuf, PathBuf) {
            let data_dir = pasta_temporaria(rotulo);
            let backup_dir = pasta_temporaria(&format!("{rotulo}-backup"));
            let state = AppState::new();
            open_workspace_and_wire_state(&state, &data_dir, &backup_dir).await.unwrap();
            (state, data_dir, backup_dir)
        }

        async fn limpa(state: AppState, data_dir: &Path, backup_dir: &Path) {
            if let Some(pool) = state.take_pool() {
                pool.close().await;
            }
            let _ = std::fs::remove_dir_all(data_dir);
            let _ = std::fs::remove_dir_all(backup_dir);
        }

        fn escreve_arquivo_fonte(data_dir: &Path, nome: &str, conteudo: &[u8]) -> PathBuf {
            std::fs::create_dir_all(data_dir).unwrap();
            let caminho = data_dir.join(nome);
            std::fs::write(&caminho, conteudo).unwrap();
            caminho
        }

        /// Prova a fiação de ponta a ponta: importar, abrir, registrar
        /// progresso, anotar e remover, tudo através da camada de comando —
        /// a lógica de negócio já está coberta em `db::biblioteca`.
        #[tokio::test]
        async fn the_whole_command_layer_wiring_round_trips_through_a_real_book() {
            let (state, data_dir, backup_dir) = estado_como_o_app("fiacao-completa").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Fiação Completa.pdf", b"conteudo de teste da fiacao");

            let importado = importar_livro_inner(&state, &origem.to_string_lossy()).await.unwrap();
            assert_eq!(importado.titulo, "Fiação Completa");

            let estante = listar_livros_inner(&state).await.unwrap();
            assert!(estante.iter().any(|entrada| entrada.livro.id == importado.livro.id));

            let aberto = abrir_livro_inner(&state, importado.livro.id).await.unwrap();
            assert!(aberto.caminho_absoluto.ends_with(&importado.livro.file_name));

            let progresso = registrar_progresso_inner(&state, importado.livro.id, "12", 0.3).await.unwrap();
            assert_eq!(progresso.current_fraction, 0.3);

            let anotacao = criar_anotacao_inner(
                &state,
                importado.livro.id,
                "note",
                "12",
                None,
                0.3,
                "trecho anotado",
                Some("comentário"),
                None,
            )
            .await
            .unwrap();
            let anotacoes = listar_anotacoes_inner(&state, importado.livro.id).await.unwrap();
            assert_eq!(anotacoes.len(), 1);
            assert_eq!(anotacoes[0].id, anotacao.id);

            remover_livro_inner(&state, importado.livro.id).await.unwrap();
            let estante_depois = listar_livros_inner(&state).await.unwrap();
            assert!(estante_depois.is_empty());

            // A camada de comando também fecha o segundo caminho: exclusão
            // definitiva, agora que o livro já está na lixeira.
            let caminho_arquivo = data_dir.join("media").join(&importado.livro.file_name);
            assert!(caminho_arquivo.is_file(), "pré-condição: o arquivo ainda existe antes da exclusão definitiva");
            excluir_livro_definitivamente_inner(&state, importado.livro.id).await.unwrap();
            assert!(!caminho_arquivo.exists(), "o arquivo precisa ter sido apagado pela exclusão definitiva");

            limpa(state, &data_dir, &backup_dir).await;
        }

        #[tokio::test]
        async fn excluir_livro_definitivamente_rejects_a_book_still_active_on_the_shelf() {
            let (state, data_dir, backup_dir) = estado_como_o_app("excluir-definitivo-sem-lixeira").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Ativo.pdf", b"conteudo ativo");

            let importado = importar_livro_inner(&state, &origem.to_string_lossy()).await.unwrap();

            // Sem passar por `remover_livro_inner` primeiro.
            let result = excluir_livro_definitivamente_inner(&state, importado.livro.id).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            limpa(state, &data_dir, &backup_dir).await;
        }

        #[tokio::test]
        async fn importar_livro_rejects_a_source_path_outside_the_accepted_extensions() {
            let (state, data_dir, backup_dir) = estado_como_o_app("importar-formato-invalido").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Não Suportado.mobi", b"conteudo");

            let result = importar_livro_inner(&state, &origem.to_string_lossy()).await;
            assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

            limpa(state, &data_dir, &backup_dir).await;
        }

        /// Fiação de ponta a ponta de `definir_metadados_do_livro`: define
        /// título/autor pela camada de comando, e a estante (`listar_livros`)
        /// mostra a correção — a lógica de negócio (semântica de
        /// não-mude/apague) já está coberta em `db::biblioteca`.
        #[tokio::test]
        async fn definir_metadados_do_livro_wiring_round_trips_through_the_shelf() {
            let (state, data_dir, backup_dir) = estado_como_o_app("metadados-fiacao").await;
            let origem = escreve_arquivo_fonte(&data_dir, "The-Titan_s-Curse.pdf", b"conteudo do titan");
            let importado = importar_livro_inner(&state, &origem.to_string_lossy()).await.unwrap();

            let atualizado = definir_metadados_do_livro_inner(
                &state,
                importado.livro.id,
                Some("A Maldição do Titã".into()),
                Some("Rick Riordan".into()),
            )
            .await
            .unwrap();
            assert_eq!(atualizado.metadata_title.as_deref(), Some("A Maldição do Titã"));
            assert_eq!(atualizado.metadata_author.as_deref(), Some("Rick Riordan"));

            let estante = listar_livros_inner(&state).await.unwrap();
            let entrada = estante.iter().find(|e| e.livro.id == importado.livro.id).unwrap();
            assert_eq!(entrada.titulo, "A Maldição do Titã", "a estante precisa mostrar o título corrigido");
            assert_eq!(entrada.autor.as_deref(), Some("Rick Riordan"));

            limpa(state, &data_dir, &backup_dir).await;
        }

        /// Fiação de ponta a ponta de `mover_livro`: dois "Percy Jackson" (o
        /// caso do pedido) reordenados pela camada de comando, lidos de volta
        /// na ordem exata pela estante.
        #[tokio::test]
        async fn mover_livro_wiring_reorders_the_shelf() {
            let (state, data_dir, backup_dir) = estado_como_o_app("mover-fiacao").await;
            let primeiro = escreve_arquivo_fonte(&data_dir, "Percy Jackson 1.pdf", b"o ladrao de raios");
            let segundo = escreve_arquivo_fonte(&data_dir, "Percy Jackson 2.pdf", b"o mar de monstros");

            // Importados fora de ordem (2 antes do 1) — o cenário real do
            // pedido: o usuário arrastou os arquivos na ordem errada.
            let livro2 = importar_livro_inner(&state, &segundo.to_string_lossy()).await.unwrap().livro;
            let livro1 = importar_livro_inner(&state, &primeiro.to_string_lossy()).await.unwrap().livro;

            // Importar entra no FIM da fila (`Self::next_position`), não no
            // início — a estante mostra o mar de monstros ANTES do ladrão de
            // raios, a ordem errada da série.
            let antes = listar_livros_inner(&state).await.unwrap();
            assert_eq!(antes[0].livro.id, livro2.id);
            assert_eq!(antes[1].livro.id, livro1.id);

            // O usuário arrasta o livro 1 (o primeiro da série) para o INÍCIO.
            mover_livro_inner(&state, livro1.id, None).await.unwrap();

            let depois = listar_livros_inner(&state).await.unwrap();
            assert_eq!(depois[0].livro.id, livro1.id, "o ladrão de raios precisa vir primeiro");
            assert_eq!(depois[1].livro.id, livro2.id, "o mar de monstros precisa vir depois");

            limpa(state, &data_dir, &backup_dir).await;
        }

        /// A REGRESSÃO. Reproduz a sequência exata que o app executa ao subir,
        /// numa instalação que nunca escolheu pasta de trabalho — que é toda
        /// instalação padrão, já que o assistente de primeira execução foi
        /// apagado na migração para SQLite e só `save_data_dir` grava
        /// `DATA_DIR_STORE_KEY`:
        ///
        /// 1. `App.tsx` chama `openWorkspace()` → o cache de configuração
        ///    passa a valer a pasta padrão do sistema operacional;
        /// 2. `Workspace` monta e, junto com ele, `<SettingsScreen />` —
        ///    renderizado incondicionalmente dentro do `<dialog>` FECHADO de
        ///    `App.tsx`, então o `useEffect` de `DataFolderSection` roda no
        ///    boot, sem clique nenhum, e chama `get_app_config`;
        /// 3. o usuário clica em "+ Importar livro…".
        ///
        /// O passo 2 é o assassino: o store não tem pasta gravada, então
        /// `get_app_config` recebia `None` e escrevia esse `None` por cima do
        /// cache que o passo 1 tinha acabado de preencher. Daí em diante todo
        /// comando que passa por `require_config` respondia "nenhuma conexão
        /// configurada" — a captura de tela do usuário — pelo resto da sessão.
        ///
        /// Nada aqui é sobre a Biblioteca em particular: `importar_livro` só
        /// é a primeira vítima que alguém clicou.
        #[tokio::test]
        async fn configuracoes_montadas_no_boot_nao_podem_apagar_a_pasta_de_trabalho() {
            let (state, data_dir, backup_dir) = estado_como_o_app("cache-apagado-no-boot").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Sobrevivente.pdf", b"conteudo que precisa importar");

            // Passo 2: a tela de Configurações monta escondida e lê a config.
            // `None` = "o usuário nunca escolheu pasta", o caso padrão.
            let visto_pela_ui = get_app_config_inner(&state, None);
            assert_eq!(visto_pela_ui, None, "a UI precisa continuar vendo 'nunca escolheu uma pasta'");

            // Passo 3: o clique que falhava.
            let resultado = importar_livro_inner(&state, &origem.to_string_lossy()).await;
            assert!(
                resultado.is_ok(),
                "importar depois de a tela de Configurações montar precisa funcionar, obtido {resultado:?}"
            );

            limpa(state, &data_dir, &backup_dir).await;
        }

        /// Mesma regressão, para o segundo chamador de `require_config`:
        /// `abrir_livro` também precisa continuar funcionando depois que a
        /// tela de Configurações monta no boot. Ver o comentário do teste
        /// acima para a sequência completa que reproduz o bug.
        #[tokio::test]
        async fn abrir_livro_funciona_depois_que_a_tela_de_configuracoes_monta_no_boot() {
            let (state, data_dir, backup_dir) = estado_como_o_app("cache-apagado-no-boot-abrir").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Para Abrir.pdf", b"conteudo para abrir");
            let importado = importar_livro_inner(&state, &origem.to_string_lossy()).await.unwrap();

            // Passo 2: a tela de Configurações monta escondida e lê a config.
            let visto_pela_ui = get_app_config_inner(&state, None);
            assert_eq!(visto_pela_ui, None, "a UI precisa continuar vendo 'nunca escolheu uma pasta'");

            // Passo 3: o clique que abre o livro.
            let resultado = abrir_livro_inner(&state, importado.livro.id).await;
            assert!(
                !matches!(resultado, Err(Error::Config(_))),
                "abrir_livro depois de a tela de Configurações montar precisa funcionar (ou falhar por outro \
                 motivo, nunca por config ausente), obtido {resultado:?}"
            );

            limpa(state, &data_dir, &backup_dir).await;
        }

        /// Mesma regressão, para o terceiro chamador de `require_config` —
        /// `remover_livro_inner` (só move a página para a lixeira) não
        /// depende de config e roda antes de simular o boot; só a exclusão
        /// definitiva, abaixo, precisa da pasta de trabalho.
        #[tokio::test]
        async fn excluir_livro_definitivamente_funciona_depois_que_a_tela_de_configuracoes_monta_no_boot() {
            let (state, data_dir, backup_dir) = estado_como_o_app("cache-apagado-no-boot-excluir").await;
            let origem = escreve_arquivo_fonte(&data_dir, "Para Excluir.pdf", b"conteudo para excluir");
            let importado = importar_livro_inner(&state, &origem.to_string_lossy()).await.unwrap();
            remover_livro_inner(&state, importado.livro.id).await.unwrap();

            // Passo 2: a tela de Configurações monta escondida e lê a config.
            let visto_pela_ui = get_app_config_inner(&state, None);
            assert_eq!(visto_pela_ui, None, "a UI precisa continuar vendo 'nunca escolheu uma pasta'");

            // Passo 3: o clique que apaga de vez — o mais grave dos quatro
            // chamadores de `require_config`, porque sobrescreve o arquivo do
            // banco (a outra metade desta regressão é
            // `backup_commands::restore_backup`).
            let resultado = excluir_livro_definitivamente_inner(&state, importado.livro.id).await;
            assert!(
                !matches!(resultado, Err(Error::Config(_))),
                "excluir_livro_definitivamente depois de a tela de Configurações montar precisa funcionar (ou \
                 falhar por outro motivo, nunca por config ausente), obtido {resultado:?}"
            );

            limpa(state, &data_dir, &backup_dir).await;
        }
    }
}
