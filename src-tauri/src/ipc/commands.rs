//! Os comandos que `invoke()` chama do frontend.
//!
//! Cada um devolve o `Result` de `crate::error` — nunca inventa outro tipo de
//! erro — para que o frontend sempre receba `{ kind, message }` e nunca uma
//! exceção não tratada.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

use crate::anki::{importar_pacote, RelatorioDeImportacao};
use crate::backup::{trigger_risky_operation_backup, ScheduleConfig};
use crate::config::{self, AppConfig};
use crate::db::{
    IntegrityReport, IntegrityRepository, PageRepository, PageRow, PageVersionRepository,
    PageVersionRow, SearchRepository, SearchResultRow, SiblingPosition, SnapshotReason,
    DEFAULT_RESULT_LIMIT,
};
use crate::error::{Error, Result};
use crate::ipc::backup_commands;
use crate::ipc::state::AppState;

/// Lê a pasta de trabalho salva, se o usuário já escolheu uma. `None`
/// significa "nunca escolheu" — e, desde a migração para SQLite, isso não é
/// mais o sinal para mostrar um assistente: é o sinal para usar o padrão do
/// sistema operacional, que é o que [`open_workspace`] faz sozinho.
#[tauri::command]
pub async fn get_app_config(app: AppHandle, state: State<'_, AppState>) -> Result<Option<AppConfig>> {
    Ok(get_app_config_inner(&state, stored_data_dir(&app)?))
}

/// O núcleo testável de [`get_app_config`], separado do comando pelo mesmo
/// motivo de `open_workspace_and_wire_state`: um `AppHandle` de verdade não é
/// construível fora de um app Tauri de pé neste toolchain, então a leitura do
/// store fica no comando e o que se faz com o resultado dela fica aqui.
///
/// `stored` é o que o `tauri-plugin-store` guardou — `None` quando o usuário
/// nunca escolheu pasta nenhuma, que é o caso comum desde que o assistente de
/// primeira execução deixou de existir.
/// NÃO escreve no cache de configuração, e é isso que conserta o bug de
/// "nenhuma conexão configurada" ao importar um livro. A versão anterior
/// fazia `state.set_cached_config(loaded)` aqui, e os dois lados dessa linha
/// falavam de coisas diferentes:
///
/// - o cache guarda **qual pasta de trabalho está aberta agora** — escrito
///   por `open_workspace_and_wire_state`, que é o único lugar que de fato
///   abre uma;
/// - `loaded` é **qual pasta o usuário escolheu à mão**, e `None` (nunca
///   escolheu, use o padrão do SO) é o valor mais comum que ele tem, não um
///   caso de erro.
///
/// Gravar o segundo no primeiro apagava a pasta aberta toda vez que a tela de
/// Configurações montava — e ela monta no boot, escondida dentro do `<dialog>`
/// fechado de `App.tsx`. Quem abre a pasta escreve o cache; quem só lê a
/// preferência do usuário, lê.
///
/// O `_state` continua na assinatura de propósito: é o que deixa o teste de
/// regressão (`ipc::biblioteca_commands`) chamar esta função com o estado do
/// app e provar que ela não mexe nele. Sem o parâmetro, reintroduzir a escrita
/// aqui voltaria a ser indetectável por teste.
pub(crate) fn get_app_config_inner(_state: &AppState, stored: Option<String>) -> Option<AppConfig> {
    stored.map(AppConfig::new)
}

/// Onde `open_workspace` guarda a salvaguarda pré-migração do PLT-020 —
/// deliberadamente separado de `ipc::backup_commands::backup_root_dir`
/// ("backups"), que é o backup manual/agendado voltado ao usuário. Ver o
/// comentário de `connect_migrate_with_rollback` em `db::pool` sobre por que
/// os dois nunca devem compartilhar diretório.
fn pre_migration_backup_dir(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Config(format!("diretório de dados do app: {e}")))?;
    Ok(base.join("pre-migration-backups"))
}

/// A pasta de trabalho gravada no store, se houver.
fn stored_data_dir(app: &AppHandle) -> Result<Option<String>> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    Ok(store.get(config::DATA_DIR_STORE_KEY).and_then(|value| serde_json::from_value::<String>(value).ok()))
}

/// Grava a pasta de trabalho no store.
fn store_data_dir(app: &AppHandle, data_dir: &str) -> Result<()> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    store.set(config::DATA_DIR_STORE_KEY, serde_json::to_value(data_dir)?);
    store.save().map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;
    Ok(())
}

/// Lê o tema salvo. `None` quando o usuário nunca escolheu — o frontend
/// decide o que isso significa (hoje: abrir no tema padrão do produto).
///
/// O Rust deliberadamente não conhece a lista de temas: quem sabe pintar cada
/// um é `src/lib/themes.ts`, e duplicar o catálogo aqui criaria duas fontes da
/// verdade em duas linguagens. Ver `config::validate_theme_id`.
#[tauri::command]
pub async fn get_theme(app: AppHandle) -> Result<Option<String>> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    Ok(store.get(config::THEME_STORE_KEY).and_then(|value| serde_json::from_value::<String>(value).ok()))
}

/// Persiste o tema escolhido.
#[tauri::command]
pub async fn save_theme(app: AppHandle, theme: String) -> Result<()> {
    config::validate_theme_id(&theme)?;

    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    store.set(config::THEME_STORE_KEY, serde_json::to_value(&theme)?);
    store.save().map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;
    Ok(())
}

/// O núcleo testável de [`open_workspace`]: dada a pasta de trabalho e o
/// `backup_dir` já resolvidos, conecta, migra e escreve o pool resultante em
/// `state`. Fica separado do comando porque os dois caminhos normalmente vêm
/// de `AppHandle::path()`, e um `AppHandle` de verdade não é construível
/// fora de um app Tauri de pé neste toolchain (mesmo motivo do comentário em
/// `page_repository`, abaixo) — os testes chamam esta função diretamente com
/// diretórios temporários no lugar.
///
/// Usa `connect_migrate_with_rollback` (PLT-020), não o `connect_and_migrate`
/// puro: uma migração quebrada contra um banco já estabelecido é desfeita em
/// vez de deixar o schema parado no meio de um upgrade.
pub(crate) async fn open_workspace_and_wire_state(
    state: &AppState,
    data_dir: &Path,
    backup_dir: &Path,
) -> Result<AppConfig> {
    let app_config = AppConfig::new(data_dir.to_string_lossy().into_owned());
    app_config.validate()?;

    // Uma abertura por vez, e a segunda não reabre nada: ver
    // `AppState::lock_workspace_open`. Sem isto, as duas chamadas que o
    // `React.StrictMode` dispara em desenvolvimento rodam a migração em
    // paralelo contra o mesmo arquivo.
    let _guard = state.lock_workspace_open().await;
    if state.pool().is_ok() && state.cached_config().as_ref() == Some(&app_config) {
        return Ok(app_config);
    }

    let pool = crate::db::connect_migrate_with_rollback(&app_config.database_path(), backup_dir).await?;

    state.set_pool(pool);
    state.set_cached_config(app_config.clone());
    Ok(app_config)
}

/// Abre o banco e o deixa disponível para todo o resto do app. É a primeira
/// coisa que o frontend chama ao subir.
///
/// A grande diferença em relação ao `connect_database` que este comando
/// substituiu: não existe entrada nenhuma, e portanto não existe assistente
/// de primeira execução. Sem host, porta, usuário e senha, a única pergunta
/// que sobrou ("em que pasta?") tem uma resposta padrão boa — a pasta de
/// dados do app no sistema operacional — então a primeira execução numa
/// máquina qualquer só abre e funciona. Trocar de pasta continua possível,
/// por [`save_data_dir`], mas virou configuração, não pré-requisito.
///
/// Idempotente de propósito: chamar de novo reabre o pool contra a mesma
/// pasta. O frontend não precisa saber se já chamou antes.
#[tauri::command]
pub async fn open_workspace(app: AppHandle, state: State<'_, AppState>) -> Result<AppConfig> {
    let data_dir = match stored_data_dir(&app)? {
        Some(chosen) => PathBuf::from(chosen),
        None => app.path().app_data_dir().map_err(|e| Error::Config(format!("diretório de dados do app: {e}")))?,
    };

    let backup_dir = pre_migration_backup_dir(&app)?;
    open_workspace_and_wire_state(&state, &data_dir, &backup_dir).await
}

/// Auto-update: desliga o sidecar Python antes de o instalador rodar. No
/// Windows o plugin updater encerra o processo com `exit(0)` sem passar por
/// `RunEvent::ExitRequested`, então o `shutdown` de `lib.rs` não roda e o
/// `learno-sidecar.exe` ficaria vivo, travando o arquivo que o NSIS precisa
/// sobrescrever. O frontend chama isto entre `download()` e `install()`.
#[tauri::command]
pub async fn encerrar_sidecar_para_atualizar(state: State<'_, AppState>) -> Result<()> {
    if let Ok(process) = state.sidecar() {
        process.shutdown().await;
    }
    Ok(())
}

/// PLT-016: lê a pasta de dados escolhida, se alguma foi salva. `None`
/// significa "usar o padrão do SO via `app_data_dir()`".
#[tauri::command]
pub async fn get_data_dir(app: AppHandle) -> Result<Option<String>> {
    stored_data_dir(&app)
}

/// PLT-016: troca a pasta de trabalho e reabre o banco lá, devolvendo a
/// configuração que passou a valer.
///
/// Leva o banco junto quando a pasta nova ainda não tem um: mudar de pasta
/// significa mudar de lugar, não recomeçar do zero — um usuário que apontasse
/// o app para o pendrive e encontrasse o app vazio concluiria, com razão, que
/// perdeu tudo. O arquivo antigo continua onde estava (nada é apagado), então
/// desfazer é escolher a pasta anterior de volta.
///
/// Se a pasta nova JÁ tem um banco do Learno, ele é adotado como está — é o
/// caso de reapontar para uma pasta sincronizada em outra máquina, e
/// sobrescrevê-lo com a cópia local seria destruir dado do usuário.
#[tauri::command]
pub async fn save_data_dir(app: AppHandle, state: State<'_, AppState>, data_dir: String) -> Result<AppConfig> {
    config::validate_data_dir(&data_dir)?;

    let destino = PathBuf::from(data_dir.trim());
    let banco_destino = config::database_path_in(&destino);
    let pasta_anterior = state.cached_config().map(|atual| atual.data_dir_path());
    let banco_atual = pasta_anterior.as_ref().map(|pasta| config::database_path_in(pasta));

    // Fecha antes de copiar: o arquivo de origem não pode estar recebendo
    // escrita enquanto vira uma cópia, e o pool novo vai apontar para outro
    // lugar de qualquer forma.
    if let Some(pool) = state.take_pool() {
        pool.close().await;
    }

    if !banco_destino.exists() {
        if let Some(origem) = banco_atual.filter(|caminho| caminho.is_file() && caminho != &banco_destino) {
            std::fs::create_dir_all(&destino)?;
            std::fs::copy(&origem, &banco_destino)?;
        }
    }

    let backup_dir = pre_migration_backup_dir(&app)?;
    let resultado = open_workspace_and_wire_state(&state, &destino, &backup_dir).await;

    let app_config = match resultado {
        Ok(config) => config,
        Err(erro) => {
            // A pasta nova não abriu (disco removido, permissão negada, banco
            // corrompido lá dentro). O pool já está fechado, e deixar assim
            // travaria a sessão inteira: cada clique responderia "banco de
            // dados ainda não conectado" até o usuário reabrir o app. Volta
            // para a pasta anterior, que estava funcionando um instante atrás,
            // e devolve o erro original — o que falhou foi a troca, não o app.
            if let Some(anterior) = pasta_anterior {
                let _ = open_workspace_and_wire_state(&state, &anterior, &backup_dir).await;
            }
            return Err(erro);
        }
    };

    // Só persiste depois que a pasta nova de fato abriu: uma escolha que
    // falhou nunca pode virar a pasta que o app tenta abrir no próximo boot.
    store_data_dir(&app, &app_config.data_dir)?;

    Ok(app_config)
}

/// Importa um `.apkg` ou `.colpkg` do Anki: notas, cartões com o agendamento
/// e o histórico de revisões, numa transação só. Ler e gravar é de
/// [`crate::anki::importar_pacote`]; este comando só valida a entrada e faz a
/// cópia de segurança antes.
///
/// PLT-013: importar é um dos dois gatilhos de operação de risco que já têm
/// código real por trás (o outro é `check_database` abaixo). Este comando
/// resolve `backup_dir`/`manifest_path`/`schedule_config` aqui (a única camada
/// com um `AppHandle` de verdade) e entrega prontos a `import_apkg_inner`, que
/// fica testável sem `AppHandle` — mesmo desenho de
/// `open_workspace`/`open_workspace_and_wire_state` acima.
#[tauri::command]
pub async fn import_apkg(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<RelatorioDeImportacao> {
    let schedule_config = backup_commands::get_backup_schedule_config(app.clone()).await?;
    let backup_dir = backup_commands::backup_root_dir(&app)?;
    let manifest_path = backup_commands::schedule_manifest_path(&app)?;
    import_apkg_inner(&state, path, &backup_dir, &manifest_path, &schedule_config).await
}

/// The testable core of [`import_apkg`]. `backup_dir`/`manifest_path`/
/// `schedule_config` arrive already resolved (never an `AppHandle`) for the
/// same reason `open_workspace_and_wire_state` takes `backup_dir` instead
/// of resolving it itself — see that function's doc comment.
///
/// Order matters: the empty-path check runs first (so a call with nothing to
/// import never touches the database or the filesystem at all), and the
/// backup runs *before* the package is even opened, never after. A backup that failed
/// silently would be worse than no backup (the user would act believing a
/// safety net exists), so `?` here means a failed backup aborts the import
/// outright; [`dump::run_backup`](crate::backup::dump::run_backup)'s own
/// error messages already say why (disco cheio, permissão negada) and reach
/// the user unchanged through `Result`'s normal IPC path — nothing here
/// needs to invent a second explanation.
async fn import_apkg_inner(
    state: &AppState,
    path: String,
    backup_dir: &Path,
    manifest_path: &Path,
    schedule_config: &ScheduleConfig,
) -> Result<RelatorioDeImportacao> {
    if path.trim().is_empty() {
        return Err(Error::Invalid("caminho do arquivo .apkg está vazio".into()));
    }

    let pool = state.pool()?;
    trigger_risky_operation_backup(&pool, backup_dir, manifest_path, schedule_config, "import_apkg").await?;

    importar_pacote(&pool, Path::new(&path)).await
}

/// Every page command needs the same repository built from the same pool —
/// factored out so a missing pool (`AppState::pool`'s `Error::Config`, before
/// `connect_database` ever ran) surfaces identically from all of them instead
/// of each command writing its own `state.pool()?` line.
///
/// Takes `&AppState`, not `State<'_, AppState>`: see the doc comment on
/// `autosave_merge_with_saved_inner` in `ipc::backup_commands` for why every
/// page command below is a thin `#[tauri::command]` wrapper around an
/// `_inner` that takes this same `&AppState` — `tauri::test::mock_builder`
/// crashes `cargo test` outright on this toolchain
/// (`STATUS_ENTRYPOINT_NOT_FOUND`), so no test here may construct a
/// `State<'_, AppState>` via it.
fn page_repository(state: &AppState) -> Result<PageRepository> {
    Ok(PageRepository::new(state.pool()?))
}

/// FUN-001: the whole active page tree (every page, at any depth), flat and
/// ordered so the sidebar can group by `parent_id` and sort by `position`
/// itself instead of re-fetching per level.
#[tauri::command]
pub async fn list_page_tree(state: State<'_, AppState>) -> Result<Vec<PageRow>> {
    list_page_tree_inner(&state).await
}

async fn list_page_tree_inner(state: &AppState) -> Result<Vec<PageRow>> {
    page_repository(state)?.list_tree(None).await
}

/// FUN-002: creates a page as the last child of `parent_id` (root page when
/// `None`). `title` defaults to empty — the sidebar creates the row first,
/// then focuses an inline rename field, matching "página nasce em branco
/// com foco no título" rather than prompting for a title up front.
///
/// `owner_section` is new and optional (`None` by default, from the JS side
/// simply omitting the key — Tauri resolves a missing `Option<T>` argument
/// to `None`): every existing caller keeps creating a real Notes page
/// unmodified. A section that creates a page for its own bookkeeping (today,
/// the Trilha container `features/trilha/store.ts` builds before calling
/// `criarTrilhaCompleta`) passes its tag here so the page is marked at birth
/// and `PageRepository::list_tree` excludes it (see that function's comment,
/// condition 3) — see the `CHECK` in `0034_dono_da_pagina.sql` for the
/// closed list of valid tags.
#[tauri::command]
pub async fn create_page(
    state: State<'_, AppState>,
    parent_id: Option<Uuid>,
    title: Option<String>,
    owner_section: Option<String>,
) -> Result<PageRow> {
    create_page_inner(&state, parent_id, title, owner_section).await
}

async fn create_page_inner(
    state: &AppState,
    parent_id: Option<Uuid>,
    title: Option<String>,
    owner_section: Option<String>,
) -> Result<PageRow> {
    let repo = page_repository(state)?;
    let title = title.as_deref().unwrap_or("");
    match owner_section.as_deref() {
        Some(owner) => repo.create_with_owner(parent_id, title, owner).await,
        None => repo.create(parent_id, title).await,
    }
}

/// Renames a page — used by the sidebar's inline rename (double-click / F2 /
/// after FUN-002 creates a blank page) and nowhere else, so there is no
/// separate FUN id for it.
#[tauri::command]
pub async fn rename_page(state: State<'_, AppState>, id: Uuid, title: String) -> Result<PageRow> {
    rename_page_inner(&state, id, &title).await
}

async fn rename_page_inner(state: &AppState, id: Uuid, title: &str) -> Result<PageRow> {
    page_repository(state)?.rename(id, title).await
}

/// FUN-008/FUN-009: the star toggle. One command for both directions — the
/// frontend already knows the current state from the tree it rendered.
#[tauri::command]
pub async fn set_page_favorite(
    state: State<'_, AppState>,
    id: Uuid,
    is_favorite: bool,
) -> Result<PageRow> {
    set_page_favorite_inner(&state, id, is_favorite).await
}

async fn set_page_favorite_inner(state: &AppState, id: Uuid, is_favorite: bool) -> Result<PageRow> {
    page_repository(state)?.set_favorite(id, is_favorite).await
}

/// FUN-011: sets (or clears, with `icon: None`) the page's emoji icon.
#[tauri::command]
pub async fn set_page_icon(
    state: State<'_, AppState>,
    id: Uuid,
    icon: Option<String>,
) -> Result<PageRow> {
    set_page_icon_inner(&state, id, icon.as_deref()).await
}

async fn set_page_icon_inner(state: &AppState, id: Uuid, icon: Option<&str>) -> Result<PageRow> {
    page_repository(state)?.set_icon(id, icon).await
}

/// FUN-004 (drag-reorder among siblings), FUN-005/FUN-006 (drag to
/// nest/un-nest), FUN-022 ("Mover para" via busca): all four are "place this
/// page among `new_parent_id`'s children, at `target`" — the repository
/// layer already rejects moving a page into its own subtree.
#[tauri::command]
pub async fn move_page(
    state: State<'_, AppState>,
    id: Uuid,
    new_parent_id: Option<Uuid>,
    target: SiblingPosition,
) -> Result<PageRow> {
    move_page_inner(&state, id, new_parent_id, target).await
}

async fn move_page_inner(
    state: &AppState,
    id: Uuid,
    new_parent_id: Option<Uuid>,
    target: SiblingPosition,
) -> Result<PageRow> {
    page_repository(state)?.move_page(id, new_parent_id, target).await
}

/// FUN-020: duplicates a page and, recursively, its active descendants.
/// Returns only the new top-level copy — the frontend re-fetches the tree
/// afterwards to pick up the new descendants, which is simpler than this
/// command also serializing the whole new subtree for what is an
/// infrequent action.
#[tauri::command]
pub async fn duplicate_page(state: State<'_, AppState>, id: Uuid) -> Result<PageRow> {
    duplicate_page_inner(&state, id).await
}

async fn duplicate_page_inner(state: &AppState, id: Uuid) -> Result<PageRow> {
    page_repository(state)?.duplicate(id).await
}

/// FUN-027: soft-deletes a page — the row stays in `pages` with `deleted_at`
/// set, so FUN-029/030 can bring it back later.
#[tauri::command]
pub async fn trash_page(state: State<'_, AppState>, id: Uuid) -> Result<PageRow> {
    trash_page_inner(&state, id).await
}

async fn trash_page_inner(state: &AppState, id: Uuid) -> Result<PageRow> {
    page_repository(state)?.trash(id).await
}

/// FUN-029/FUN-030: un-trashes a page. Falls back to the root when its
/// original parent is gone or itself still trashed — see
/// `PageRepository::restore`.
#[tauri::command]
pub async fn restore_page(state: State<'_, AppState>, id: Uuid) -> Result<PageRow> {
    restore_page_inner(&state, id).await
}

async fn restore_page_inner(state: &AppState, id: Uuid) -> Result<PageRow> {
    page_repository(state)?.restore(id).await
}

/// FUN-031: irreversibly removes a page that is already in the trash.
#[tauri::command]
pub async fn permanently_delete_page(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    permanently_delete_page_inner(&state, id).await
}

async fn permanently_delete_page_inner(state: &AppState, id: Uuid) -> Result<()> {
    page_repository(state)?.permanently_delete(id).await
}

/// Backs the Lixeira screen: every trashed page, most recently deleted
/// first (FUN-027/029/030/031 all describe a page as "visível na Lixeira" —
/// this is what makes that literally true instead of only true in the
/// repository's own tests).
#[tauri::command]
pub async fn list_trashed_pages(state: State<'_, AppState>) -> Result<Vec<PageRow>> {
    list_trashed_pages_inner(&state).await
}

async fn list_trashed_pages_inner(state: &AppState) -> Result<Vec<PageRow>> {
    page_repository(state)?.list_trash().await
}

/// FUN-019: the page itself plus every ancestor, root-first, for the
/// breadcrumb trail.
#[tauri::command]
pub async fn get_page_breadcrumb(state: State<'_, AppState>, id: Uuid) -> Result<Vec<PageRow>> {
    get_page_breadcrumb_inner(&state, id).await
}

async fn get_page_breadcrumb_inner(state: &AppState, id: Uuid) -> Result<Vec<PageRow>> {
    page_repository(state)?.breadcrumb(id).await
}

/// FUN-035/036 share the same "no pool yet" branch as `page_repository`
/// above, for the same reason: one place reports it instead of every command
/// re-deriving it.
fn page_version_repository(state: &AppState) -> Result<PageVersionRepository> {
    Ok(PageVersionRepository::new(state.pool()?))
}

/// FUN-035: a page's snapshot history, newest first.
#[tauri::command]
pub async fn list_page_versions(
    state: State<'_, AppState>,
    page_id: Uuid,
) -> Result<Vec<PageVersionRow>> {
    list_page_versions_inner(&state, page_id).await
}

async fn list_page_versions_inner(state: &AppState, page_id: Uuid) -> Result<Vec<PageVersionRow>> {
    page_version_repository(state)?.list(page_id).await
}

/// FUN-036: makes `version_id` the page's current title/content. The
/// repository itself records the restore as a new snapshot, so nothing
/// already in the history — including the version just restored — is lost.
#[tauri::command]
pub async fn restore_page_version(
    state: State<'_, AppState>,
    page_id: Uuid,
    version_id: Uuid,
) -> Result<PageVersionRow> {
    restore_page_version_inner(&state, page_id, version_id).await
}

async fn restore_page_version_inner(
    state: &AppState,
    page_id: Uuid,
    version_id: Uuid,
) -> Result<PageVersionRow> {
    page_version_repository(state)?.restore(page_id, version_id).await
}

/// FUN-034: freezes the page's current title/content as an autosave
/// snapshot, on the periodic timer the frontend runs while a page is open
/// (see `PageWorkspace`). Always forces `SnapshotReason::Autosave` rather
/// than taking the reason as a parameter — "manual" has no caller yet, and
/// "restore" is only ever produced by `restore_page_version` itself, so
/// letting an arbitrary caller pick the reason here would let it forge a
/// history entry that looks like a restoration that never happened.
#[tauri::command]
pub async fn create_page_version_snapshot(
    state: State<'_, AppState>,
    page_id: Uuid,
    title: String,
    content: serde_json::Value,
) -> Result<PageVersionRow> {
    create_page_version_snapshot_inner(&state, page_id, &title, content).await
}

async fn create_page_version_snapshot_inner(
    state: &AppState,
    page_id: Uuid,
    title: &str,
    content: serde_json::Value,
) -> Result<PageVersionRow> {
    page_version_repository(state)?
        .snapshot(page_id, title, content, SnapshotReason::Autosave)
        .await
}

/// FUN-037: global search palette, ranked page-title hits above block-content
/// hits. `query` is whatever the user has typed so far — an empty/blank
/// string is a normal, frequent input (the palette just opened), not an
/// error, so it short-circuits to an empty list before even asking for a
/// pool, the same way `SearchRepository::search` short-circuits before
/// asking SQLite.
#[tauri::command]
pub async fn search_pages(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResultRow>> {
    search_pages_inner(&state, &query).await
}

async fn search_pages_inner(state: &AppState, query: &str) -> Result<Vec<SearchResultRow>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    SearchRepository::new(state.pool()?)
        .search(query, DEFAULT_RESULT_LIMIT)
        .await
}

/// PLT-014: "Check Database" — runs `IntegrityRepository::check_and_repair`
/// against the connected database and hands the report to the UI. Before
/// this command existed, `IntegrityRepository` was only ever constructed by
/// its own `#[cfg(test)]` module (`db::integrity`'s `plt_014_*` tests) —
/// correct and tested, but with no `#[tauri::command]` in `lib.rs`'s
/// `generate_handler!` list for any button to call, so no user action could
/// ever reach it. This is that missing wire, mirroring every other
/// repository command's `state.pool()` → repository → delegate shape.
///
/// PLT-013: the repair half of `check_and_repair` deletes rows (orphaned
/// cards) — exactly the kind of change PLT-013's risky-operation trigger
/// exists for. Same split as `import_apkg` right above: this wrapper is the
/// only place with a real `AppHandle`, so it resolves `backup_dir`/
/// `manifest_path`/`schedule_config` and hands them to
/// `check_database_inner` already built.
#[tauri::command]
pub async fn check_database(app: AppHandle, state: State<'_, AppState>) -> Result<IntegrityReport> {
    let schedule_config = backup_commands::get_backup_schedule_config(app.clone()).await?;
    let backup_dir = backup_commands::backup_root_dir(&app)?;
    let manifest_path = backup_commands::schedule_manifest_path(&app)?;
    check_database_inner(&state, &backup_dir, &manifest_path, &schedule_config).await
}

/// The testable core of [`check_database`]. Backs up first, through the same
/// choke point ([`trigger_risky_operation_backup`]) every risky-operation
/// caller uses, and only calls `check_and_repair` — the part that can
/// actually delete a row — once that backup has actually landed on disk.
/// `?` on the backup call is deliberate: a backup that silently failed
/// (disco cheio, permissão negada na pasta de backup) would leave the user
/// believing a safety net exists when it doesn't, which is worse than no
/// backup at all, so the repair simply never runs in that case and the
/// error surfaces to the UI unchanged.
async fn check_database_inner(
    state: &AppState,
    backup_dir: &Path,
    manifest_path: &Path,
    schedule_config: &ScheduleConfig,
) -> Result<IntegrityReport> {
    let pool = state.pool()?;
    trigger_risky_operation_backup(&pool, backup_dir, manifest_path, schedule_config, "check_database").await?;

    IntegrityRepository::new(pool).check_and_repair().await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    /// Neither of `import_apkg_inner`'s early-return branches below ever
    /// looks at `backup_dir`/`manifest_path`/`schedule_config`, so a plain
    /// temp path stands in for all three — these tests are about the
    /// ordering of the two checks in front of the import, not about backup
    /// mechanics (that's `schedule.rs`'s own tests, and the `live_database`
    /// module further down for the reachability proof PLT-013 actually
    /// asks for).
    fn unused_backup_args() -> (PathBuf, PathBuf, ScheduleConfig) {
        let dir = std::env::temp_dir();
        let manifest = dir.join("learno-test-unused-manifest.json");
        (dir, manifest, ScheduleConfig::default())
    }

    #[tokio::test]
    async fn import_apkg_rejects_an_empty_path_without_touching_the_database() {
        let state = AppState::new();
        let (backup_dir, manifest_path, schedule_config) = unused_backup_args();
        let result = import_apkg_inner(&state, String::new(), &backup_dir, &manifest_path, &schedule_config).await;
        assert!(matches!(result, Err(Error::Invalid(_))));
    }

    // O backup precisa do pool, então uma sessão que ainda não abriu a pasta
    // de trabalho falha em `state.pool()` (`Error::Config`) antes de o
    // arquivo ser aberto — "baralho.apkg" nem existe, e o erro não é de
    // arquivo. O caminho com banco está em
    // `com_banco::import_apkg_backs_up_before_reading_the_package` abaixo.
    #[tokio::test]
    async fn import_apkg_reports_no_connection_configured_before_reading_the_package() {
        let state = AppState::new();
        let (backup_dir, manifest_path, schedule_config) = unused_backup_args();
        let result =
            import_apkg_inner(&state, "baralho.apkg".into(), &backup_dir, &manifest_path, &schedule_config).await;
        assert!(matches!(result, Err(Error::Config(_))));
    }

    // Every page command shares `page_repository`'s "no pool yet" branch
    // (TODO PLT-002) — one representative test per command proves each is
    // actually wired to it, without needing a live database.
    //
    // Exercised through the `_inner` functions against a plain
    // `AppState::new()`, never through `tauri::test::mock_builder`: see the
    // doc comment on `page_repository` above (and on
    // `autosave_merge_with_saved_inner` in `ipc::backup_commands`) for why —
    // that builder crashes this crate's whole `cargo test` binary on this
    // toolchain (`STATUS_ENTRYPOINT_NOT_FOUND`).
    mod page_commands_without_a_pool {
        use super::*;

        #[tokio::test]
        async fn list_page_tree_reports_not_connected() {
            let state = AppState::new();
            let result = list_page_tree_inner(&state).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_page_reports_not_connected() {
            let state = AppState::new();
            let result = create_page_inner(&state, None, None, None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn move_page_reports_not_connected() {
            let state = AppState::new();
            let result = move_page_inner(&state, Uuid::now_v7(), None, SiblingPosition::End).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn trash_page_reports_not_connected() {
            let state = AppState::new();
            let result = trash_page_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn restore_page_reports_not_connected() {
            let state = AppState::new();
            let result = restore_page_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn permanently_delete_page_reports_not_connected() {
            let state = AppState::new();
            let result = permanently_delete_page_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_trashed_pages_reports_not_connected() {
            let state = AppState::new();
            let result = list_trashed_pages_inner(&state).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_page_version_snapshot_reports_not_connected() {
            let state = AppState::new();
            let result =
                create_page_version_snapshot_inner(&state, Uuid::now_v7(), "Título", serde_json::json!({}))
                    .await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn get_page_breadcrumb_reports_not_connected() {
            let state = AppState::new();
            let result = get_page_breadcrumb_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_page_versions_reports_not_connected() {
            let state = AppState::new();
            let result = list_page_versions_inner(&state, Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn restore_page_version_reports_not_connected() {
            let state = AppState::new();
            let result = restore_page_version_inner(&state, Uuid::now_v7(), Uuid::now_v7()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn search_pages_reports_not_connected() {
            let state = AppState::new();
            let result = search_pages_inner(&state, "bio").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn check_database_reports_not_connected() {
            let state = AppState::new();
            let (backup_dir, manifest_path, schedule_config) = unused_backup_args();
            let result = check_database_inner(&state, &backup_dir, &manifest_path, &schedule_config).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        // FUN-037: a blank query returns an empty list even with no pool at
        // all — searching never fails just because the palette opened before
        // typing anything. If the command asked for a pool before checking
        // this, it would fail with `Error::Config` instead.
        #[tokio::test]
        async fn search_pages_with_blank_query_short_circuits_before_needing_a_pool() {
            let state = AppState::new();
            let result = search_pages_inner(&state, "   ").await;
            assert!(result.unwrap().is_empty());
        }
    }

    // O achado que faltava nesta suíte: todo teste acima ou chamava
    // `db::connect_and_migrate`/`connect_migrate_with_rollback` direto (sem
    // tocar num `AppState`) ou chamava `AppState::set_pool` direto com um
    // pool `connect_lazy` montado à mão (sem tocar numa migração de verdade).
    // Nenhuma das duas formas pegaria o bug real do PLT-002 —
    // `open_workspace_and_wire_state` existir, e nada chamá-la — porque
    // nenhuma exercita a costura entre as duas. Este módulo dirige
    // exatamente essa função (a que `open_workspace`, o `#[tauri::command]`
    // que o app chama ao subir, delega) de ponta a ponta contra um banco de
    // verdade, e prova que o `AppState` resultante é de fato consultável
    // pelo mesmo `page_repository` que todo comando de página usa — não só
    // que `state.pool()` devolve `Ok(_)`, o que um pool para lugar nenhum
    // também faria.
    //
    // Nada aqui é `#[ignore]`, e essa é a mudança que a migração para SQLite
    // trouxe: antes cada um destes precisava de `LEARNO_TEST_DATABASE_URL` e
    // de um cluster Postgres de pé, então na prática ninguém rodava. Agora o
    // banco é um arquivo em pasta temporária que o próprio teste cria.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use super::*;
        use crate::backup::{BackupTrigger, ScheduleManifest};
        use crate::db::ids::IdBind;

        /// Pasta de trabalho descartável, uma por teste, para que os testes
        /// em paralelo (padrão do `cargo test`) nunca disputem o mesmo
        /// arquivo de banco.
        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        /// Insere um cartão cujo `note_id` não aponta para nota nenhuma,
        /// desligando a checagem de chave estrangeira nesta conexão só.
        ///
        /// É o equivalente SQLite do `session_replication_role = replica`
        /// que a versão Postgres usava, e continua sendo a única forma de
        /// reproduzir a "inconsistência introduzida artificialmente" do
        /// PLT-014, dado que a constraint impede isso por todo caminho de
        /// escrita normal. `PRAGMA foreign_keys` é por conexão: religar
        /// antes de devolver a conexão ao pool não deixa rastro.
        async fn insere_cartao_orfao(pool: &sqlx::SqlitePool) -> Uuid {
            let mut conn = pool.acquire().await.unwrap();
            sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await.unwrap();

            let card_id = Uuid::now_v7();
            sqlx::query("INSERT INTO cards (id, note_id, deck_id) VALUES (?, ?, ?)")
                .bind(card_id.db())
                .bind(Uuid::now_v7().db())
                .bind(Uuid::now_v7().db())
                .execute(&mut *conn)
                .await
                .unwrap();

            sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await.unwrap();
            card_id
        }

        #[tokio::test]
        async fn open_workspace_and_wire_state_leaves_the_pool_actually_usable() {
            let state = AppState::new();
            assert!(state.pool().is_err(), "sanidade: um AppState novo começa sem pool nenhum");

            let data_dir = pasta_temporaria("abre");
            let backup_dir = pasta_temporaria("abre-backup");

            let app_config = open_workspace_and_wire_state(&state, &data_dir, &backup_dir).await.unwrap();
            assert_eq!(app_config.data_dir_path(), data_dir);
            assert!(app_config.database_path().is_file(), "o arquivo do banco precisa existir depois de abrir");

            // A checagem de regressão de verdade: o helper de repositório de
            // um comando de página, montado exatamente como
            // `list_page_tree`/`create_page` montam, precisa conseguir ir e
            // voltar do banco pelo pool que esta função acabou de ligar.
            let repository = page_repository(&state).unwrap();
            repository.list_tree(None).await.unwrap();

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&backup_dir);
        }

        /// A contraparte PLT-014 do teste acima: prova o caminho inteiro de
        /// uma ação do usuário até o efeito dela, não só que o repositório
        /// funciona (os testes `plt_014_*` de `db::integrity` já provavam
        /// isso chamando `IntegrityRepository` direto — que é justamente o
        /// que deixava a feature inalcançável, já que nada em `src-tauri`
        /// exercitava o `#[tauri::command]` que um botão de Configurações
        /// invocaria).
        ///
        /// E fecha o achado do PLT-013 junto: os testes de `schedule.rs` já
        /// provavam `trigger_risky_operation_backup` isolado, e essa nunca
        /// foi a lacuna — a lacuna era nada alcançável por ação real do
        /// usuário chamar aquilo. Então as asserções sobre o manifesto e
        /// sobre o arquivo em disco vêm DEPOIS de chamar
        /// `check_database_inner`, a função de comando em si.
        #[tokio::test]
        async fn check_database_backs_up_before_repairing_an_orphaned_card() {
            let state = AppState::new();
            let data_dir = pasta_temporaria("check-dados");
            let connect_backup_dir = pasta_temporaria("check-conexao");
            open_workspace_and_wire_state(&state, &data_dir, &connect_backup_dir).await.unwrap();

            let pool = state.pool().unwrap();
            let orphan_id = insere_cartao_orfao(&pool).await;

            // Pasta própria, distinta da de cima (aquela guarda a rede de
            // segurança pré-migração do `connect_migrate_with_rollback`, uma
            // preocupação separada — ver o comentário daquela função em
            // `db::pool`), com o mesmo nome de manifesto que
            // `ipc::backup_commands::backup_root_dir` usa.
            let risky_backup_dir = pasta_temporaria("check-risco");
            let manifest_path = risky_backup_dir.join("schedule-manifest.json");
            let schedule_config = ScheduleConfig::default();

            let report =
                check_database_inner(&state, &risky_backup_dir, &manifest_path, &schedule_config).await.unwrap();

            assert!(report.orphaned_card_ids.contains(&orphan_id));
            assert!(report.total_repaired >= 1);

            // O ponto do teste: quem produziu o backup foi o comando que um
            // clique em "Verificar banco de dados" de fato invoca — não
            // `trigger_risky_operation_backup` chamado à mão.
            let manifest = ScheduleManifest::new(&manifest_path);
            let records = manifest.load().unwrap();
            assert_eq!(records.len(), 1, "check_database_inner precisa registrar exatamente um backup de risco");
            assert!(records[0].path.is_file(), "o registro do manifesto precisa apontar para um arquivo que existe");
            assert!(matches!(
                &records[0].trigger,
                BackupTrigger::RiskyOperation { operation } if operation == "check_database"
            ));

            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id = ?")
                .bind(orphan_id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(remaining, 0);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&connect_backup_dir);
            let _ = std::fs::remove_dir_all(&risky_backup_dir);
        }

        /// O outro gatilho real de operação de risco do PLT-013. O caminho
        /// aponta para um arquivo que não existe, e é isso que este teste
        /// precisa: prova que o backup roda ANTES — e independentemente — de o
        /// pacote ser aberto, não só num caminho em que a importação dá certo.
        /// Se a ordem em `import_apkg_inner` fosse invertida, este teste ainda
        /// veria o erro de arquivo, mas as asserções de manifesto abaixo
        /// falhariam, porque backup nenhum teria rodado.
        #[tokio::test]
        async fn import_apkg_backs_up_before_reading_the_package() {
            let state = AppState::new();
            let data_dir = pasta_temporaria("apkg-dados");
            let connect_backup_dir = pasta_temporaria("apkg-conexao");
            open_workspace_and_wire_state(&state, &data_dir, &connect_backup_dir).await.unwrap();

            let risky_backup_dir = pasta_temporaria("apkg-risco");
            let manifest_path = risky_backup_dir.join("schedule-manifest.json");
            let schedule_config = ScheduleConfig::default();

            let result =
                import_apkg_inner(&state, "baralho.apkg".into(), &risky_backup_dir, &manifest_path, &schedule_config)
                    .await;

            assert!(
                matches!(result, Err(Error::Io(_))),
                "esperava o erro de arquivo inexistente depois de o backup já ter rodado, obtido {result:?}"
            );

            let manifest = ScheduleManifest::new(&manifest_path);
            let records = manifest.load().unwrap();
            assert_eq!(records.len(), 1, "import_apkg_inner precisa registrar exatamente um backup de risco");
            assert!(records[0].path.is_file(), "o registro do manifesto precisa apontar para um arquivo que existe");
            assert!(matches!(
                &records[0].trigger,
                BackupTrigger::RiskyOperation { operation } if operation == "import_apkg"
            ));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&connect_backup_dir);
            let _ = std::fs::remove_dir_all(&risky_backup_dir);
        }

        /// PLT-016: trocar de pasta leva o banco junto quando a pasta nova
        /// está vazia — o comportamento que separa "mudei de lugar" de
        /// "perdi tudo".
        #[tokio::test]
        async fn open_workspace_adopts_an_existing_database_in_the_folder() {
            let data_dir = pasta_temporaria("adota-dados");
            let backup_dir = pasta_temporaria("adota-backup");

            let primeiro = AppState::new();
            open_workspace_and_wire_state(&primeiro, &data_dir, &backup_dir).await.unwrap();
            page_repository(&primeiro).unwrap().create(None, "Mitocôndria").await.unwrap();
            primeiro.take_pool().unwrap().close().await;

            // Segunda abertura, mesmo diretório: tem que enxergar a página
            // que a primeira criou, e não um banco novo em folha.
            let segundo = AppState::new();
            open_workspace_and_wire_state(&segundo, &data_dir, &backup_dir).await.unwrap();
            let paginas = page_repository(&segundo).unwrap().list_tree(None).await.unwrap();
            assert_eq!(paginas.len(), 1, "reabrir a mesma pasta precisa reencontrar o conteúdo");

            segundo.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&backup_dir);
        }

        /// Duas aberturas simultâneas da MESMA pasta não podem migrar o banco
        /// duas vezes.
        ///
        /// É exatamente o que `React.StrictMode` provoca em desenvolvimento —
        /// o efeito de `App.tsx` monta duas vezes, e `open_workspace` sai duas
        /// vezes quase junto. Sem a serialização de
        /// `AppState::lock_workspace_open`, as duas chamadas rodavam
        /// `migrate()` em paralelo e a perdedora falhava com
        /// `table mindmaps already exists` (observado na suíte e2e, na tela
        /// "Não deu para abrir o banco de dados").
        #[tokio::test]
        async fn duas_aberturas_simultaneas_da_mesma_pasta_nao_migram_duas_vezes() {
            let data_dir = pasta_temporaria("corrida-dados");
            let backup_dir = pasta_temporaria("corrida-backup");
            let state = AppState::new();

            let (primeira, segunda) = tokio::join!(
                open_workspace_and_wire_state(&state, &data_dir, &backup_dir),
                open_workspace_and_wire_state(&state, &data_dir, &backup_dir),
            );

            assert!(primeira.is_ok(), "primeira abertura falhou: {primeira:?}");
            assert!(segunda.is_ok(), "segunda abertura falhou: {segunda:?}");
            // E o pool que sobrou é utilizável, não um meio-termo das duas.
            page_repository(&state).unwrap().list_tree(None).await.unwrap();

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&backup_dir);
        }

        /// Uma pasta de trabalho impossível de abrir precisa falhar como
        /// tentativa, não deixar o app sem banco. Aqui a "pasta" é na verdade
        /// um arquivo, então `create_dir_all` falha e a abertura vai junto.
        #[tokio::test]
        async fn abrir_uma_pasta_invalida_falha_sem_derrubar_o_pool_atual() {
            let data_dir = pasta_temporaria("invalida-dados");
            let backup_dir = pasta_temporaria("invalida-backup");
            let state = AppState::new();
            open_workspace_and_wire_state(&state, &data_dir, &backup_dir).await.unwrap();

            let bloqueada = pasta_temporaria("bloqueada");
            std::fs::write(&bloqueada, b"nao sou uma pasta").unwrap();

            assert!(open_workspace_and_wire_state(&state, &bloqueada, &backup_dir).await.is_err());
            // O pool anterior segue no estado, e segue utilizável — é sobre
            // ele que `save_data_dir` faz a volta atrás quando a troca falha.
            page_repository(&state).unwrap().list_tree(None).await.unwrap();

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_file(&bloqueada);
            let _ = std::fs::remove_dir_all(&data_dir);
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
    }
}
