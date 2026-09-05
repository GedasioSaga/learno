//! Os comandos que `invoke()` chama do frontend.
//!
//! Cada um devolve o `Result` de `crate::error` — nunca inventa outro tipo de
//! erro — para que o frontend sempre receba `{ kind, message }` e nunca uma
//! exceção não tratada.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

use crate::backup::{trigger_risky_operation_backup, ScheduleConfig};
use crate::config::{self, AppConfig, ConnectionTestInput};
use crate::db::{
    IntegrityReport, IntegrityRepository, PageRepository, PageRow, PageVersionRepository,
    PageVersionRow, SearchRepository, SearchResultRow, SiblingPosition, SnapshotReason,
    DEFAULT_RESULT_LIMIT,
};
use crate::error::{Error, Result};
use crate::ipc::backup_commands;
use crate::ipc::state::AppState;

/// O que a UI recebe quando um import de `.apkg` termina com sucesso.
///
/// Também é o formato que o sidecar devolve na resposta de `apkg.import`
/// (por isso `Deserialize` além de `Serialize`) — um único tipo cobre a
/// ponte inteira, do wire format do sidecar até o `invoke()` do frontend,
/// sem uma struct intermediária redundante. O handler Python de Fase 1
/// (`sidecar/learno_sidecar/handlers/apkg.py`) só prova a ponte: sempre
/// devolve `notes_imported: 0`. Ler o `.apkg` de verdade e contar as notas é
/// Fase 4.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ApkgImportResult {
    pub notes_imported: u32,
}

/// Lê a configuração de conexão salva, se o assistente de primeira execução
/// já rodou. `None` é o sinal para o frontend mostrar o assistente.
#[tauri::command]
pub async fn get_app_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<AppConfig>> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    let loaded = match store.get(config::CONFIG_STORE_KEY) {
        Some(value) => Some(serde_json::from_value::<AppConfig>(value)?),
        None => None,
    };

    state.set_cached_config(loaded.clone());
    Ok(loaded)
}

/// Onde `connect_database` guarda a salvaguarda pré-migração do PLT-020 —
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

/// O núcleo testável de `connect_database`: dado um `backup_dir` já
/// resolvido, conecta, migra e escreve o pool resultante em `state`. Fica
/// separado do comando porque `backup_dir` normalmente vem de
/// `AppHandle::path().app_data_dir()`, e um `AppHandle` de verdade não é
/// construível fora de um app Tauri de pé neste toolchain (mesmo motivo do
/// comentário em `page_repository`, abaixo) — os testes chamam esta função
/// diretamente com um diretório temporário no lugar.
///
/// Esta é a peça que faltava enquanto PLT-002 vivia só como
/// `db::connect_and_migrate` (nunca chamada fora de teste) e
/// `AppState::set_pool` (nunca chamada fora de teste): nenhuma das duas
/// chamava a outra em nenhum caminho de produção.
async fn connect_database_and_wire_state(
    state: &AppState,
    input: &ConnectionTestInput,
    backup_dir: &Path,
) -> Result<AppConfig> {
    let pool = crate::db::connect_migrate_with_rollback(input, backup_dir).await?;

    let app_config = AppConfig::from(input);
    state.set_pool(pool);
    state.set_cached_config(Some(app_config.clone()));
    Ok(app_config)
}

/// Abre a conexão real de produção com o Postgres e a deixa disponível para
/// todo o resto do app: chamado quando o assistente de primeira execução
/// termina, e de novo sempre que o app abre com uma configuração salva mas
/// sem pool ainda (a senha nunca é persistida — ver o comentário de
/// `AppConfig` — então toda sessão que precisa do banco a recolhe de novo
/// por aqui, com os outros campos já preenchidos a partir da config salva).
///
/// Usa `connect_migrate_with_rollback` (PLT-020), não o `connect_and_migrate`
/// puro: uma migração quebrada contra um banco já estabelecido é desfeita em
/// vez de deixar o schema parado no meio de um upgrade. Só grava a
/// configuração no store depois que a conexão e a migração realmente
/// funcionaram — uma tentativa malsucedida nunca fica parecendo uma conexão
/// válida na próxima abertura do app.
#[tauri::command]
pub async fn connect_database(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionTestInput,
) -> Result<AppConfig> {
    AppConfig::from(&input).validate()?;

    let backup_dir = pre_migration_backup_dir(&app)?;
    let app_config = connect_database_and_wire_state(&state, &input, &backup_dir).await?;

    let store = app
        .store(crate::config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;
    store.set(
        crate::config::CONFIG_STORE_KEY,
        serde_json::to_value(&app_config)?,
    );
    store
        .save()
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    Ok(app_config)
}

/// PLT-016: lê a pasta de dados que o assistente de primeira execução
/// coletou, se alguma foi salva. `None` significa "usar o padrão do SO via
/// `app_data_dir()`" — o mesmo default que `backup::dump` já usa hoje.
#[tauri::command]
pub async fn get_data_dir(app: AppHandle) -> Result<Option<String>> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    Ok(store
        .get(config::DATA_DIR_STORE_KEY)
        .and_then(|value| serde_json::from_value::<String>(value).ok()))
}

/// PLT-016: persiste a pasta de dados coletada pelo assistente. Valida antes
/// de gravar para nunca deixar um valor em branco entrar no store parecendo
/// uma escolha real do usuário.
#[tauri::command]
pub async fn save_data_dir(app: AppHandle, data_dir: String) -> Result<()> {
    config::validate_data_dir(&data_dir)?;

    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    store.set(config::DATA_DIR_STORE_KEY, serde_json::to_value(&data_dir)?);
    store
        .save()
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    Ok(())
}

/// Abre e fecha uma conexão real com o Postgres informado, sem persistir nada
/// em nenhum dos dois desfechos. A senha só existe na memória desta chamada:
/// quem quiser de fato conectar e guardar a configuração chama
/// `connect_database` depois, com os mesmos campos.
#[tauri::command]
pub async fn test_database_connection(input: ConnectionTestInput) -> Result<()> {
    use sqlx::Connection;

    let options = config::build_connect_options(&input);

    let attempt = tokio::time::timeout(
        config::CONNECTION_TEST_TIMEOUT,
        sqlx::sqlite::PgConnection::connect_with(&options),
    )
    .await;

    match attempt {
        Ok(Ok(connection)) => {
            // Falha ao fechar não invalida o teste: a conexão já provou que
            // autentica e existe, que é a única coisa que o assistente
            // precisa saber antes de deixar o usuário seguir.
            let _ = connection.close().await;
            Ok(())
        }
        Ok(Err(e)) if connection_failure_is_credential_related(&e) => Err(Error::Database(e)),
        Ok(Err(e)) => Err(Error::DatabaseUnreachable(format!(
            "nenhuma instância de Postgres respondeu em {}:{} ({e})",
            input.host, input.port
        ))),
        Err(_) => Err(Error::DatabaseUnreachable(format!(
            "tempo esgotado ({}s) tentando conectar a {}:{} — nenhuma instância de Postgres respondeu",
            config::CONNECTION_TEST_TIMEOUT.as_secs(),
            input.host,
            input.port
        ))),
    }
}

/// PLT-016: sqlx separa uma falha de `connect` em dois grupos que a UI do
/// assistente precisa distinguir — `Database(_)` significa que uma instância
/// de Postgres respondeu e rejeitou a tentativa (senha errada, banco
/// inexistente, usuário sem permissão: um problema de credencial que orientar
/// a "instalar o Postgres" só confundiria). Qualquer outra variante (`Io`,
/// `Tls`, `Protocol`, `Configuration`, ...) nunca chegou a falar com nada
/// naquele host:porta — é exatamente o caso "nenhuma instância encontrada"
/// que o critério de PLT-016 pede para orientar a instalação.
///
/// Pura e testável sem abrir socket nenhum: só o branch `Database` de
/// verdade não é construível fora do crate do sqlx-postgres (o campo interno
/// de `PgDatabaseError` é `pub(crate)`), então os testes abaixo cobrem o
/// branch "não-credencial" com as variantes que dá para montar à mão.
fn connection_failure_is_credential_related(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(_))
}

/// Importa um baralho `.apkg` através do sidecar Python.
///
/// PLT-004: manda `path` para o método `apkg.import` do sidecar (ver
/// `sidecar::SidecarProcess::call`) e devolve a resposta dele. O timeout, a
/// detecção de processo morto e a conversão para `Error::Sidecar` já vivem em
/// `SidecarProcess::call`/`await_response` — este comando só valida a entrada
/// e propaga o que a ponte devolver, exatamente como `search_pages_inner`
/// propaga o que `SearchRepository` devolve.
///
/// PLT-013: import de baralho é um dos dois gatilhos de operação de risco
/// que já têm código real por trás (o outro é `check_database` abaixo) — um
/// `.apkg` malformado ou um import repetido pode sobrescrever cartões que já
/// existiam. `password` só existe para isso: resolve `backup_dir`/
/// `manifest_path`/`schedule_config` aqui (a única camada com um `AppHandle`
/// de verdade) e entrega prontos a `import_apkg_inner`, que fica testável
/// sem `AppHandle` — mesmo desenho de `connect_database`/
/// `connect_database_and_wire_state` acima.
#[tauri::command]
pub async fn import_apkg(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<ApkgImportResult> {
    let schedule_config = backup_commands::get_backup_schedule_config(app.clone()).await?;
    let backup_dir = backup_commands::backup_root_dir(&app)?;
    let manifest_path = backup_commands::schedule_manifest_path(&app)?;
    import_apkg_inner(&state, path, &password, &backup_dir, &manifest_path, &schedule_config).await
}

/// The testable core of [`import_apkg`]. `backup_dir`/`manifest_path`/
/// `schedule_config` arrive already resolved (never an `AppHandle`) for the
/// same reason `connect_database_and_wire_state` takes `backup_dir` instead
/// of resolving it itself — see that function's doc comment.
///
/// Order matters: the empty-path check runs first (so a call with nothing to
/// import never touches Postgres or the filesystem at all, same as before
/// this change), but everything past it — including the backup — now runs
/// *before* the sidecar call, never after. A backup that failed silently
/// would be worse than no backup (the user would act believing a safety net
/// exists), so `?` here means a failed backup aborts the import outright;
/// [`dump::run_backup`](crate::backup::dump::run_backup)'s own error
/// messages already say why (`pg_dump` missing from PATH, disk full, the
/// process timing out) and reach the user unchanged through `Result`'s
/// normal IPC path — nothing here needs to invent a second explanation.
async fn import_apkg_inner(
    state: &AppState,
    path: String,
    password: &str,
    backup_dir: &Path,
    manifest_path: &Path,
    schedule_config: &ScheduleConfig,
) -> Result<ApkgImportResult> {
    if path.trim().is_empty() {
        return Err(Error::Invalid("caminho do arquivo .apkg está vazio".into()));
    }

    let config = backup_commands::require_config(state)?;
    trigger_risky_operation_backup(&config, password, backup_dir, manifest_path, schedule_config, "import_apkg")
        .await?;

    state
        .sidecar()?
        .call("apkg.import", serde_json::json!({ "path": path }))
        .await
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
#[tauri::command]
pub async fn create_page(
    state: State<'_, AppState>,
    parent_id: Option<Uuid>,
    title: Option<String>,
) -> Result<PageRow> {
    create_page_inner(&state, parent_id, title).await
}

async fn create_page_inner(
    state: &AppState,
    parent_id: Option<Uuid>,
    title: Option<String>,
) -> Result<PageRow> {
    page_repository(state)?
        .create(parent_id, title.as_deref().unwrap_or(""))
        .await
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
/// asking Postgres.
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
/// exists for, so `password` is new here purely to make that backup
/// possible (the app never persists one — see `AppState`'s doc comment).
/// Same split as `import_apkg` right above: this wrapper is the only place
/// with a real `AppHandle`, so it resolves `backup_dir`/`manifest_path`/
/// `schedule_config` and hands them to `check_database_inner` already built.
#[tauri::command]
pub async fn check_database(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<IntegrityReport> {
    let schedule_config = backup_commands::get_backup_schedule_config(app.clone()).await?;
    let backup_dir = backup_commands::backup_root_dir(&app)?;
    let manifest_path = backup_commands::schedule_manifest_path(&app)?;
    check_database_inner(&state, &password, &backup_dir, &manifest_path, &schedule_config).await
}

/// The testable core of [`check_database`]. Backs up first, through the same
/// choke point ([`trigger_risky_operation_backup`]) every risky-operation
/// caller uses, and only calls `check_and_repair` — the part that can
/// actually delete a row — once that backup has actually landed on disk.
/// `?` on the backup call is deliberate: a backup that silently failed
/// (`pg_dump` missing, disk full, `pg_dump` timing out) would leave the user
/// believing a safety net exists when it doesn't, which is worse than no
/// backup at all, so the repair simply never runs in that case and the
/// error surfaces to the UI unchanged.
async fn check_database_inner(
    state: &AppState,
    password: &str,
    backup_dir: &Path,
    manifest_path: &Path,
    schedule_config: &ScheduleConfig,
) -> Result<IntegrityReport> {
    let config = backup_commands::require_config(state)?;
    trigger_risky_operation_backup(&config, password, backup_dir, manifest_path, schedule_config, "check_database")
        .await?;

    IntegrityRepository::new(state.pool()?).check_and_repair().await
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
    /// ordering of the two checks in front of the sidecar, not about backup
    /// mechanics (that's `schedule.rs`'s own tests, and the `live_database`
    /// module further down for the reachability proof PLT-013 actually
    /// asks for).
    fn unused_backup_args() -> (PathBuf, PathBuf, ScheduleConfig) {
        let dir = std::env::temp_dir();
        let manifest = dir.join("learno-test-unused-manifest.json");
        (dir, manifest, ScheduleConfig::default())
    }

    #[tokio::test]
    async fn import_apkg_rejects_an_empty_path_without_touching_the_sidecar() {
        let state = AppState::new();
        let (backup_dir, manifest_path, schedule_config) = unused_backup_args();
        let result =
            import_apkg_inner(&state, String::new(), "unused", &backup_dir, &manifest_path, &schedule_config).await;
        assert!(matches!(result, Err(Error::Invalid(_))));
    }

    // PLT-013 changed this test's own expectation: before the backup gate
    // existed, a session with no connection at all still reached the
    // sidecar check first and failed there. Now the backup has to be
    // *attempted* before the sidecar is ever touched, and a backup needs a
    // known connection — so a session that never finished the first-run
    // wizard now fails on `require_config` (`Error::Config`), never
    // `Error::Sidecar`, even though this same `AppState` also has no
    // sidecar wired. The sidecar-not-ready path this test used to cover now
    // needs a connection that can actually back itself up, which needs a
    // live database — see
    // `live_database::import_apkg_backs_up_before_reporting_the_sidecar_is_not_ready`
    // below for that proof.
    #[tokio::test]
    async fn import_apkg_reports_no_connection_configured_before_touching_the_sidecar() {
        let state = AppState::new();
        let (backup_dir, manifest_path, schedule_config) = unused_backup_args();
        let result = import_apkg_inner(
            &state,
            "baralho.apkg".into(),
            "unused",
            &backup_dir,
            &manifest_path,
            &schedule_config,
        )
        .await;
        assert!(matches!(result, Err(Error::Config(_))));
    }

    #[test]
    fn connection_failure_is_credential_related_is_false_for_a_socket_level_error() {
        let io_error = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "recusada");
        assert!(!connection_failure_is_credential_related(&sqlx::Error::Io(
            io_error
        )));
    }

    #[test]
    fn connection_failure_is_credential_related_is_false_for_a_configuration_error() {
        let boxed: Box<dyn std::error::Error + Send + Sync> = "url malformada".into();
        assert!(!connection_failure_is_credential_related(
            &sqlx::Error::Configuration(boxed)
        ));
    }

    #[tokio::test]
    async fn test_database_connection_fails_fast_against_a_closed_port() {
        // Porta 1 é reservada e não tem nada escutando nela: a conexão é
        // recusada quase imediatamente, sem precisar de um Postgres real de
        // pé nem de credencial nenhuma — é o caminho de falha, não o de
        // sucesso. O valor abaixo nunca chega a autenticar em lugar nenhum.
        let never_sent_over_the_wire: String =
            ["nao", "existe", "conexao", "para", "autenticar"].join("-");
        let input = ConnectionTestInput {
            host: "127.0.0.1".into(),
            port: 1,
            database: "learno".into(),
            user: "postgres".into(),
            password: never_sent_over_the_wire,
        };

        let result = test_database_connection(input).await;
        // Porta fechada é sinal de "ninguém respondeu" (`Io`), não de
        // credencial rejeitada — a variante certa é `DatabaseUnreachable`,
        // que é a que dispara a orientação de instalação na UI (PLT-016).
        assert!(matches!(result, Err(Error::DatabaseUnreachable(_))));
    }

    // Every page command shares `page_repository`'s "no pool yet" branch
    // (TODO PLT-002) — one representative test per command proves each is
    // actually wired to it, without needing a live Postgres.
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
            let result = create_page_inner(&state, None, None).await;
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
            let result = check_database_inner(&state, "unused", &backup_dir, &manifest_path, &schedule_config).await;
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

    // The finding this suite was missing: every test above either called
    // `db::connect_and_migrate`/`connect_migrate_with_rollback` directly
    // (never touching an `AppState`) or called `AppState::set_pool` directly
    // with a hand-built `connect_lazy` pool (never touching a real
    // migration). Neither shape could have caught PLT-002's actual bug —
    // `connect_database_and_wire_state` existing, but nothing calling it —
    // because neither one exercises the seam between the two. This module
    // drives that exact function (the one `connect_database`, the real
    // `#[tauri::command]` the wizard and the startup reconnect screen call,
    // delegates to) end to end against a live database and then proves the
    // resulting `AppState` is actually queryable through the same
    // `page_repository` helper every page command shares — not just that
    // `state.pool()` returns `Ok(_)`, which a pool to nowhere could also do.
    mod live_database {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use super::*;
        use crate::backup::{BackupTrigger, ScheduleManifest};

        /// Same host/port/user extraction `db::pool`'s own PLT-020 tests use
        /// to turn `LEARNO_TEST_DATABASE_URL` into a `ConnectionTestInput` —
        /// duplicated rather than imported because `db::pool`'s copy is
        /// `#[cfg(test)]`-private to that module.
        fn test_connection_input() -> ConnectionTestInput {
            let raw = std::env::var("LEARNO_TEST_DATABASE_URL")
                .expect("LEARNO_TEST_DATABASE_URL must be set to run ignored DB tests");
            let url = url::Url::parse(&raw).expect("LEARNO_TEST_DATABASE_URL must be a valid URL");
            ConnectionTestInput {
                host: url.host_str().expect("LEARNO_TEST_DATABASE_URL must have a host").to_string(),
                port: url.port().unwrap_or(5432),
                database: url.path().trim_start_matches('/').to_string(),
                user: url.username().to_string(),
                password: url.password().unwrap_or_default().to_string(),
            }
        }

        #[tokio::test]
        #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
        async fn connect_database_and_wire_state_leaves_the_pool_actually_usable() {
            let state = AppState::new();
            assert!(
                state.pool().is_err(),
                "sanity: a fresh AppState must start with no pool at all"
            );

            let input = test_connection_input();
            let backup_dir = std::env::temp_dir()
                .join(format!("learno-connect-database-test-{}", Uuid::new_v4()));

            let app_config = connect_database_and_wire_state(&state, &input, &backup_dir)
                .await
                .unwrap();
            assert_eq!(app_config.host, input.host);
            assert_eq!(app_config.database, input.database);

            // The actual regression check for the reported defect: a page
            // command's own repository helper, built exactly the way
            // `list_page_tree`/`create_page`/etc. build it, must be able to
            // round-trip against Postgres through the pool this function
            // just wired in. Before this function existed, this line would
            // have failed with `Error::Config("banco de dados ainda não
            // conectado")` — the same failure every IPC command hit in the
            // real app after the first-run wizard "finished".
            let repository = page_repository(&state).unwrap();
            repository.list_tree(None).await.unwrap();
        }

        /// The PLT-014 counterpart of the test above: proves the whole path
        /// from a user action to its effect, not just that the repository
        /// works (`db::integrity`'s `plt_014_*` tests already proved that by
        /// calling `IntegrityRepository` directly — which is exactly what
        /// left the feature unreachable, since nothing in `src-tauri`
        /// exercised the `#[tauri::command]` a Settings button would
        /// actually invoke). This drives `check_database`, the real command
        /// `generate_handler!` registers, end to end: wire a pool through
        /// `connect_database_and_wire_state` the same way the wizard does,
        /// plant an orphan the same way `db::integrity`'s tests do, then call
        /// the command function and check the repair actually landed.
        ///
        /// PLT-013's finding this test now also closes: `schedule.rs`'s own
        /// tests already proved `trigger_risky_operation_backup` works in
        /// isolation, and that was never the gap — the gap was that nothing
        /// reachable from a real user action called it. So this asserts on
        /// the manifest and the `.dump` file on disk *after calling
        /// `check_database_inner`*, the command function itself, not after
        /// calling the backup trigger directly — the same distinction the
        /// task's own instructions draw between "a função de backup
        /// funciona" and "a operação de risco produz o arquivo".
        #[tokio::test]
        #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
        async fn check_database_backs_up_before_repairing_an_orphaned_card() {
            let state = AppState::new();
            let input = test_connection_input();
            let connect_backup_dir =
                std::env::temp_dir().join(format!("learno-check-database-connect-{}", Uuid::new_v4()));
            connect_database_and_wire_state(&state, &input, &connect_backup_dir).await.unwrap();

            let pool = state.pool().unwrap();

            // Bypasses the `cards.note_id` foreign key for this one session,
            // the same `session_replication_role` trick
            // `db::integrity::tests::insert_orphaned_card` uses — it's the
            // only way to reproduce "inconsistência introduzida
            // artificialmente" at all, given the constraint that blocks it
            // through every normal write path.
            let mut conn = pool.acquire().await.unwrap();
            sqlx::query("SET session_replication_role = replica").execute(&mut *conn).await.unwrap();
            let orphan_id = Uuid::now_v7();
            sqlx::query("INSERT INTO cards (id, note_id, deck_id) VALUES ($1, $2, $3)")
                .bind(orphan_id)
                .bind(Uuid::now_v7())
                .bind(Uuid::now_v7())
                .execute(&mut *conn)
                .await
                .unwrap();
            sqlx::query("SET session_replication_role = origin").execute(&mut *conn).await.unwrap();
            drop(conn);

            // A directory of its own, distinct from `connect_backup_dir`
            // above (that one holds `connect_migrate_with_rollback`'s own
            // pre-migration safety net, a separate concern — see that
            // function's doc comment in `db::pool`) and from PLT-013's
            // manifest naming (`schedule-manifest.json` inside it), the same
            // convention `ipc::backup_commands::backup_root_dir` uses.
            let risky_backup_dir =
                std::env::temp_dir().join(format!("learno-check-database-risky-{}", Uuid::new_v4()));
            let manifest_path = risky_backup_dir.join("schedule-manifest.json");
            let schedule_config = ScheduleConfig::default();

            let report = check_database_inner(&state, &input.password, &risky_backup_dir, &manifest_path, &schedule_config)
                .await
                .unwrap();

            assert!(report.orphaned_card_ids.contains(&orphan_id));
            assert!(report.total_repaired >= 1);

            // The point of this test: the command that a "Verificar banco de
            // dados" click actually invokes is what produced the backup —
            // not `trigger_risky_operation_backup` called by hand.
            let manifest = ScheduleManifest::new(&manifest_path);
            let records = manifest.load().unwrap();
            assert_eq!(records.len(), 1, "check_database_inner must record exactly one risky-operation backup");
            assert!(
                records[0].path.is_file(),
                "the manifest's own record must point at a .dump file that actually exists on disk"
            );
            assert!(matches!(
                &records[0].trigger,
                BackupTrigger::RiskyOperation { operation } if operation == "check_database"
            ));

            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id = $1")
                .bind(orphan_id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(remaining, 0);

            let _ = std::fs::remove_dir_all(&connect_backup_dir);
            let _ = std::fs::remove_dir_all(&risky_backup_dir);
        }

        /// PLT-013's other real risky-operation trigger. No sidecar is wired
        /// in this test process (`AppState::new()` never calls
        /// `set_sidecar`), which is exactly what this test needs: it proves
        /// the backup runs *before* — and regardless of — the sidecar step,
        /// not only on a path where the import happens to succeed. If the
        /// ordering in `import_apkg_inner` were ever reversed (sidecar call
        /// first, backup after), this would still see `Error::Sidecar` but
        /// the manifest assertions below would fail, since no backup would
        /// have run yet.
        #[tokio::test]
        #[ignore = "requires LEARNO_TEST_DATABASE_URL"]
        async fn import_apkg_backs_up_before_reporting_the_sidecar_is_not_ready() {
            let state = AppState::new();
            let input = test_connection_input();
            let connect_backup_dir =
                std::env::temp_dir().join(format!("learno-import-apkg-connect-{}", Uuid::new_v4()));
            connect_database_and_wire_state(&state, &input, &connect_backup_dir).await.unwrap();

            let risky_backup_dir =
                std::env::temp_dir().join(format!("learno-import-apkg-risky-{}", Uuid::new_v4()));
            let manifest_path = risky_backup_dir.join("schedule-manifest.json");
            let schedule_config = ScheduleConfig::default();

            let result = import_apkg_inner(
                &state,
                "baralho.apkg".into(),
                &input.password,
                &risky_backup_dir,
                &manifest_path,
                &schedule_config,
            )
            .await;

            assert!(
                matches!(result, Err(Error::Sidecar(_))),
                "expected the sidecar-not-ready error once the backup step already ran, got {result:?}"
            );

            let manifest = ScheduleManifest::new(&manifest_path);
            let records = manifest.load().unwrap();
            assert_eq!(records.len(), 1, "import_apkg_inner must record exactly one risky-operation backup");
            assert!(
                records[0].path.is_file(),
                "the manifest's own record must point at a .dump file that actually exists on disk"
            );
            assert!(matches!(
                &records[0].trigger,
                BackupTrigger::RiskyOperation { operation } if operation == "import_apkg"
            ));

            let _ = std::fs::remove_dir_all(&connect_backup_dir);
            let _ = std::fs::remove_dir_all(&risky_backup_dir);
        }
    }
}
