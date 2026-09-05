//! Comandos de IPC para resiliência e exportação: autosave/crash-recovery
//! (PLT-005), backup/restauração manual do Postgres (PLT-011), backup
//! automático periódico com retenção (PLT-013), e exportar página como
//! Markdown (FUN-023).
//!
//! `export_page_markdown` e `autosave_merge_with_saved` lêem de
//! `state.pool()`, o mesmo pool compartilhado que `ipc::commands` já usa
//! para os comandos de página — nenhuma conexão própria é aberta aqui.
//! `create_backup`/`restore_backup`/`run_due_scheduled_backup`/
//! `trigger_backup_for_risky_operation` são a exceção: `pg_dump`/
//! `pg_restore` são processos externos, não o driver sqlx, então continuam
//! recebendo a senha da própria chamada (mesmo padrão de
//! `test_database_connection`), nunca persistida.
//!
//! Todos os comandos deste arquivo estão em `tauri::generate_handler!` em
//! `lib.rs` — o TODO que dizia o contrário foi fechado junto com FUN-023.
//!
//! PLT-013's dois gatilhos por operação de risco do checklist que já têm
//! código real por trás — `check_database` (PLT-014, apaga linha ao
//! reparar) e `import_apkg` (PLT-004, sobrescreve dados via sidecar) — agora
//! chamam [`trigger_risky_operation_backup`] direto de dentro de
//! `ipc::commands`, através de [`backup_root_dir`], [`schedule_manifest_path`]
//! e [`require_config`] (as três peças que este módulo expõe `pub(crate)`
//! só para isso) — nunca chamando `dump::run_backup` cru, que puxaria o
//! rastreamento/poda de PLT-013 inteiro pra fora do caminho. `sync one-way`
//! continua sem ponto de chamada porque a feature em si ainda não existe
//! neste código — nada a proteger ainda.
//!
//! `trigger_backup_for_risky_operation` abaixo continua existindo como o
//! comando que a tela de Configurações usa para o botão manual "disparar
//! agora" — as duas rotas (esta e a de `ipc::commands`) levam ao mesmo
//! [`trigger_risky_operation_backup`], só que uma resolve `backup_dir`/
//! `manifest_path`/`schedule_config` a partir de um `AppHandle` que ela
//! mesma recebe, e a outra recebe os três já prontos porque
//! `check_database_inner`/`import_apkg_inner` continuam testáveis sem
//! `AppHandle` (mesmo motivo do comentário em
//! `ipc::commands::connect_database_and_wire_state`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

use crate::backup::{autosave, dump, markdown_export, schedule};
use crate::config::{self, AppConfig};
use crate::db::{PageRepository, PageVersionRepository};
use crate::error::{Error, Result};
use crate::ipc::state::AppState;

/// Diretório dos arquivos de diário de autosave, dentro dos dados do app —
/// deliberadamente separado de qualquer coisa relacionada a backup/dump, já
/// que sobrevive de forma independente de qualquer um dos dois.
fn autosave_dir(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Config(format!("diretório de dados do app: {e}")))?;
    Ok(base.join("autosave"))
}

fn journal(app: &AppHandle) -> Result<autosave::AutosaveJournal> {
    Ok(autosave::AutosaveJournal::new(autosave_dir(app)?))
}

/// Onde os backups criados por este app (manuais e agendados) vivem por
/// padrão, dentro dos dados do app — o scheduler (PLT-013) sempre grava
/// aqui, nunca num caminho escolhido em tempo de chamada.
///
/// `pub(crate)`: `ipc::commands::check_database`/`import_apkg` resolvem o
/// mesmo diretório a partir do `AppHandle` que só a camada de comando (não o
/// `_inner` testável) recebe, para que o backup de uma operação de risco
/// pouse no mesmo lugar que todo outro backup deste app, nunca num diretório
/// próprio e esquecido.
pub(crate) fn backup_root_dir(app: &AppHandle) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Config(format!("diretório de dados do app: {e}")))?;
    Ok(base.join("backups"))
}

/// O caminho do manifesto de backups agendados (PLT-013), sem abrir/carregar
/// nada ainda — separado de [`schedule_manifest`] (que devolve o
/// `ScheduleManifest` já construído em cima dele) porque
/// `trigger_risky_operation_backup` pede um `&Path` cru, não um
/// `ScheduleManifest`, e `ipc::commands`'s `_inner` functions (sem
/// `AppHandle`) recebem esse `&Path` já resolvido pelo comando.
pub(crate) fn schedule_manifest_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(backup_root_dir(app)?.join("schedule-manifest.json"))
}

/// Arquivo onde o histórico de backups agendados (PLT-013) vive — separado
/// do diário de autosave e de qualquer backup manual avulso.
fn schedule_manifest(app: &AppHandle) -> Result<schedule::ScheduleManifest> {
    Ok(schedule::ScheduleManifest::new(schedule_manifest_path(app)?))
}

/// `create_backup`/`restore_backup` shellam para fora do pool sqlx, então
/// continuam precisando dos dados de conexão avulsos (não de um `SqlitePool`).
///
/// Recebe `&AppState` (não `State<'_, AppState>`): como `State` não tem
/// construtor público fora de um `App`/`AppHandle` real, mantê-lo aqui
/// obrigaria todo teste a passar por `tauri::test::mock_builder`. Ver o
/// comentário nos `_inner` abaixo para por que isso importa nesta versão.
///
/// `pub(crate)`: `ipc::commands::check_database_inner`/`import_apkg_inner`
/// precisam do mesmo `AppConfig` para poder chamar
/// `trigger_risky_operation_backup` antes de fazer a parte arriscada de
/// cada um — sem isso, cada um reimplementaria esta checagem por conta
/// própria.
pub(crate) fn require_config(state: &AppState) -> Result<AppConfig> {
    state
        .cached_config()
        .ok_or_else(|| Error::Config("nenhuma conexão configurada".into()))
}

/// PLT-005: grava (ou substitui) o rascunho não salvo de uma página. Chamado
/// pelo editor a cada poucos segundos de digitação — bem mais frequente que
/// o snapshot de versão de 10 minutos do FUN-034, porque este é o que
/// sobrevive a uma queda do processo entre um snapshot e outro.
#[tauri::command]
pub async fn autosave_write_pending(
    app: AppHandle,
    page_id: Uuid,
    title: String,
    content: serde_json::Value,
) -> Result<()> {
    journal(&app)?.write_pending(page_id, &title, content)
}

/// PLT-005: chamado depois que o conteúdo já está de fato salvo no
/// Postgres — só então o rascunho local deixa de ser necessário.
#[tauri::command]
pub async fn autosave_clear_pending(app: AppHandle, page_id: Uuid) -> Result<()> {
    journal(&app)?.clear_pending(page_id)
}

/// PLT-005: chamado na inicialização do app. Qualquer entrada aqui existe só
/// porque a sessão anterior terminou sem confirmar que aquele conteúdo
/// chegou ao banco — ver o comentário em `backup::autosave`.
#[tauri::command]
pub async fn autosave_list_recoverable(app: AppHandle) -> Result<Vec<autosave::JournalEntry>> {
    journal(&app)?.list_pending()
}

/// PLT-005 (etapa de fusão ao reabrir): compara o rascunho recuperado do
/// disco com o snapshot mais recente já confirmado em `page_versions` para
/// esta página, e só oferece o rascunho quando ele é de fato mais novo —
/// nunca sobrescrevendo um save que já aconteceu depois dele.
#[tauri::command]
pub async fn autosave_merge_with_saved(
    state: State<'_, AppState>,
    entry: autosave::JournalEntry,
) -> Result<Option<autosave::JournalEntry>> {
    autosave_merge_with_saved_inner(&state, entry).await
}

/// Same logic as [`autosave_merge_with_saved`], split out to take a plain
/// `&AppState` instead of `State<'_, AppState>`. `State` has no public
/// constructor outside a real `App`/`AppHandle`, so exercising this command's
/// actual branching (has vs. lacks a pool) from a test would otherwise have
/// to go through `tauri::test::mock_builder` — which, in this crate, spins up
/// the real window/menu/plugin stack and crashes the whole `cargo test`
/// binary at process load on this toolchain (`STATUS_ENTRYPOINT_NOT_FOUND`,
/// confirmed by bisection: reproduces from `ipc::commands`'s own use of the
/// same mock builder alone, with this file's tests entirely removed). Command
/// wrappers above stay thin `#[tauri::command]` shims; every branch worth
/// testing lives in an `_inner` that never touches `tauri::test`.
async fn autosave_merge_with_saved_inner(
    state: &AppState,
    entry: autosave::JournalEntry,
) -> Result<Option<autosave::JournalEntry>> {
    let versions = PageVersionRepository::new(state.pool()?).list(entry.page_id).await?;
    // FUN-035: `list` ordena do mais recente para o mais antigo — o primeiro
    // item, se existir, é a última gravação durável conhecida da página.
    let last_saved = versions
        .first()
        .map(|version| autosave::LastDurableSave { saved_at: version.created_at });

    Ok(autosave::merge_after_crash(entry, last_saved))
}

/// PLT-011 / achado de segurança 7: `output_dir` chega como string livre
/// pelo IPC — alcançável por qualquer script rodando no WebView, não só pelo
/// diálogo nativo que `BackupSettings` mostra ao usuário. Uma string vazia
/// resolveria `create_dir_all` contra o diretório de trabalho do processo
/// (imprevisível num app empacotado); uma relativa dependeria do mesmo cwd.
/// Rejeitar os dois aqui, antes de qualquer `pg_dump` rodar, transforma isso
/// no mesmo formato de erro que todo outro caminho de entrada inválida deste
/// arquivo já usa — sem restringir a pasta de destino a um diretório fixo do
/// app, o que quebraria o propósito de backup manual (guardar a cópia fora
/// da própria máquina, num disco externo ou pasta sincronizada).
fn validate_backup_output_dir(output_dir: &str) -> Result<PathBuf> {
    let trimmed = output_dir.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("pasta de destino do backup não pode ser vazia".into()));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(Error::Invalid("pasta de destino do backup precisa ser um caminho absoluto".into()));
    }
    Ok(path)
}

/// PLT-011 / achado de segurança 7: mesma preocupação acima, mas para o
/// arquivo que `restore_backup` entrega direto a `pg_restore`. A extensão
/// `.dump` é o que a própria `dump::run_backup` sempre produz — exigi-la
/// aqui pega o caso concreto que a auditoria apontou (nenhuma validação de
/// diretório/extensão) sem estreitar o que este comando documenta suportar:
/// restaurar "qualquer `pg_dump -Fc` compatível", inclusive um arquivo
/// copiado de outra máquina, não só os que este app criou.
fn validate_restore_dump_path(dump_path: &str) -> Result<PathBuf> {
    let trimmed = dump_path.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("arquivo de backup não pode ser vazio".into()));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(Error::Invalid("arquivo de backup precisa ser um caminho absoluto".into()));
    }
    let has_dump_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("dump"));
    if !has_dump_extension {
        return Err(Error::Invalid("arquivo de backup precisa ter extensão .dump".into()));
    }
    Ok(path)
}

/// PLT-011: dispara um `pg_dump` real contra o Postgres configurado. A senha
/// nunca é persistida — só vive na memória desta chamada.
#[tauri::command]
pub async fn create_backup(state: State<'_, AppState>, password: String, output_dir: String) -> Result<String> {
    create_backup_inner(&state, &password, &output_dir).await
}

/// See [`autosave_merge_with_saved_inner`] for why this takes `&AppState`
/// rather than `State<'_, AppState>`.
async fn create_backup_inner(state: &AppState, password: &str, output_dir: &str) -> Result<String> {
    let config = require_config(state)?;
    let destination = validate_backup_output_dir(output_dir)?;
    let path = dump::run_backup(&config, password, &destination).await?;
    Ok(path.display().to_string())
}

/// PLT-011: restaura um dump gerado por `create_backup` (ou qualquer
/// `pg_dump -Fc` compatível) sobre o banco configurado.
#[tauri::command]
pub async fn restore_backup(state: State<'_, AppState>, password: String, dump_path: String) -> Result<()> {
    restore_backup_inner(&state, &password, &dump_path).await
}

/// See [`autosave_merge_with_saved_inner`] for why this takes `&AppState`
/// rather than `State<'_, AppState>`.
async fn restore_backup_inner(state: &AppState, password: &str, dump_path: &str) -> Result<()> {
    let config = require_config(state)?;
    let source = validate_restore_dump_path(dump_path)?;
    dump::run_restore(&config, password, &source).await
}

/// PLT-013: lê a configuração de backup automático salva, ou o padrão
/// (desativado) se o usuário nunca abriu a tela de configurações de backup.
#[tauri::command]
pub async fn get_backup_schedule_config(app: AppHandle) -> Result<schedule::ScheduleConfig> {
    let store = app
        .store(config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    match store.get(schedule::SCHEDULE_STORE_KEY) {
        Some(value) => Ok(serde_json::from_value(value)?),
        None => Ok(schedule::ScheduleConfig::default()),
    }
}

/// PLT-013: grava a configuração de backup automático já validada.
#[tauri::command]
pub async fn save_backup_schedule_config(app: AppHandle, config: schedule::ScheduleConfig) -> Result<()> {
    config.validate()?;

    let store = app
        .store(crate::config::STORE_FILE)
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;

    store.set(schedule::SCHEDULE_STORE_KEY, serde_json::to_value(&config)?);
    store
        .save()
        .map_err(|e| Error::Config(format!("armazenamento local: {e}")))?;
    Ok(())
}

/// PLT-013: se a cadência configurada já decorreu desde o último backup
/// agendado, cria um novo (gravado sempre em `backup_root_dir`, nunca num
/// caminho escolhido pelo chamador) e descarta os que excedem a retenção
/// configurada para essa cadência. `None` quando o backup automático está
/// desativado ou ainda não é hora — quem chama (a tela de configurações,
/// hoje; futuramente um agendador de verdade) decide o que fazer com isso.
#[tauri::command]
pub async fn run_due_scheduled_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<Option<String>> {
    run_due_scheduled_backup_inner(&app, &state, &password).await
}

async fn run_due_scheduled_backup_inner(app: &AppHandle, state: &AppState, password: &str) -> Result<Option<String>> {
    let schedule_config = get_backup_schedule_config(app.clone()).await?;
    if !schedule_config.enabled {
        return Ok(None);
    }

    let manifest = schedule_manifest(app)?;
    let last_run = manifest.last_cadence_backup_at()?;
    if !schedule::is_due(last_run, schedule_config.cadence, chrono::Utc::now()) {
        return Ok(None);
    }

    let config = require_config(state)?;
    let output_dir = backup_root_dir(app)?;
    let path = dump::run_backup(&config, password, &output_dir).await?;

    manifest.record(schedule::ScheduledBackupRecord {
        path: path.clone(),
        created_at: chrono::Utc::now(),
        trigger: schedule::BackupTrigger::Cadence,
    })?;
    manifest.prune(&schedule_config)?;

    Ok(Some(path.display().to_string()))
}

/// PLT-013: cria um backup automático imediatamente, marcado como disparado
/// por uma operação de risco (`operation` é um rótulo livre, ex.:
/// `"import_colpkg"`) em vez de pela cadência normal — e prunado pela sua
/// própria retenção (`keep_risky_operation`), independente da retenção da
/// cadência. Ver o comentário no topo do arquivo: nenhuma feature desta
/// árvore ainda chama isto, porque nenhuma delas existe ainda.
#[tauri::command]
pub async fn trigger_backup_for_risky_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    operation: String,
) -> Result<String> {
    trigger_backup_for_risky_operation_inner(&app, &state, &password, &operation).await
}

async fn trigger_backup_for_risky_operation_inner(
    app: &AppHandle,
    state: &AppState,
    password: &str,
    operation: &str,
) -> Result<String> {
    let schedule_config = get_backup_schedule_config(app.clone()).await?;
    let config = require_config(state)?;
    let output_dir = backup_root_dir(app)?;
    let path = dump::run_backup(&config, password, &output_dir).await?;

    let manifest = schedule_manifest(app)?;
    manifest.record(schedule::ScheduledBackupRecord {
        path: path.clone(),
        created_at: chrono::Utc::now(),
        trigger: schedule::BackupTrigger::RiskyOperation { operation: operation.to_string() },
    })?;
    manifest.prune(&schedule_config)?;

    Ok(path.display().to_string())
}

/// `export_page_markdown_inner` guard: `target_path` arrives as a bare
/// string over IPC, reachable from any script running in the WebView, not
/// only through the save dialog `ExportMarkdownButton` actually shows the
/// user. Without this, a caller that skips the dialog could point the write
/// at any file the app process has permission to touch. Rejecting anything
/// that is not an already-existing directory plus a `.md` file name closes
/// that off while still accepting whatever real location the native dialog
/// returned.
fn validate_export_target(target_path: &str) -> Result<PathBuf> {
    let path = Path::new(target_path);

    // `eq_ignore_ascii_case`: o Explorer do Windows deixa o usuário digitar
    // ".MD" na caixa de salvar apesar do filtro sugerir minúsculo — o sistema
    // de arquivos não diferencia, então a validação também não deveria.
    let has_md_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !has_md_extension {
        return Err(Error::Invalid("caminho de exportação precisa terminar em .md".into()));
    }
    // The save dialog always hands back an absolute, already-resolved path —
    // a `..` component only appears here if a caller assembled the string by
    // hand, which this command has no legitimate reason to accept.
    if path.components().any(|component| component == std::path::Component::ParentDir) {
        return Err(Error::Invalid("caminho de exportação não pode conter '..'".into()));
    }

    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| Error::Invalid("caminho de exportação sem diretório".into()))?;
    // Canonicalizing the *directory* (the file itself does not exist yet)
    // confirms it is a real path already on disk, not one that only looks
    // plausible, and resolves any symlink in it before the write happens.
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| Error::Invalid("diretório de exportação não existe".into()))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::Invalid("nome de arquivo de exportação inválido".into()))?;

    Ok(canonical_parent.join(markdown_export::sanitize_filename(file_name)))
}

/// FUN-023: converte a página (título + árvore de blocos ativa) para
/// Markdown e grava no caminho escolhido pelo usuário no diálogo do
/// frontend.
#[tauri::command]
pub async fn export_page_markdown(state: State<'_, AppState>, page_id: Uuid, target_path: String) -> Result<()> {
    export_page_markdown_inner(&state, page_id, &target_path).await
}

/// See [`autosave_merge_with_saved_inner`] for why this takes `&AppState`
/// rather than `State<'_, AppState>`.
async fn export_page_markdown_inner(state: &AppState, page_id: Uuid, target_path: &str) -> Result<()> {
    let destination = validate_export_target(target_path)?;
    let pool = state.pool()?;

    let page = PageRepository::new(pool.clone()).get(page_id).await?;
    let blocks = markdown_export::fetch_page_blocks(&pool, page_id).await?;
    let markdown = markdown_export::export_page_to_markdown(&page.title, &blocks);

    tokio::fs::write(destination, markdown).await?;
    Ok(())
}

/// FUN-023: nome de arquivo sugerido no diálogo de salvar, já livre de
/// caractere inválido no Windows — pura, não precisa de banco nem de app.
#[tauri::command]
pub fn default_export_file_name(title: String) -> String {
    markdown_export::default_export_file_name(&title)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use serde_json::json;

    // Same convention as `ipc::commands`'s `page_commands_without_a_pool`:
    // every command that needs `state.pool()` reports the same
    // `Error::Config` before ever touching Postgres. Exercised through the
    // `_inner` functions against a plain `AppState::new()` — see the doc
    // comment on `autosave_merge_with_saved_inner` for why these tests never
    // touch `tauri::test`.
    mod validate_backup_output_dir_tests {
        use super::*;

        #[test]
        fn rejects_empty() {
            assert!(matches!(validate_backup_output_dir(""), Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_blank_string() {
            assert!(matches!(validate_backup_output_dir("   "), Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_relative_path() {
            assert!(matches!(validate_backup_output_dir("backups"), Err(Error::Invalid(_))));
        }

        #[test]
        fn accepts_an_absolute_path() {
            assert_eq!(validate_backup_output_dir("C:/backups").unwrap(), PathBuf::from("C:/backups"));
        }
    }

    mod validate_restore_dump_path_tests {
        use super::*;

        #[test]
        fn rejects_empty() {
            assert!(matches!(validate_restore_dump_path(""), Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_relative_path() {
            assert!(matches!(validate_restore_dump_path("x.dump"), Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_an_extension_other_than_dump() {
            let result = validate_restore_dump_path("C:/backups/x.txt");
            assert!(matches!(result, Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_missing_extension() {
            assert!(matches!(validate_restore_dump_path("C:/backups/x"), Err(Error::Invalid(_))));
        }

        #[test]
        fn accepts_an_absolute_dump_file_case_insensitively() {
            assert!(validate_restore_dump_path("C:/backups/x.dump").is_ok());
            assert!(validate_restore_dump_path("C:/backups/x.DUMP").is_ok());
        }
    }

    mod validate_export_target_tests {
        use super::*;

        #[test]
        fn rejects_extension_other_than_md() {
            let path = std::env::temp_dir().join("nota.txt");
            let result = validate_export_target(&path.display().to_string());
            assert!(matches!(result, Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_parent_dir_component() {
            let path = std::env::temp_dir().join("..").join("nota.md");
            let result = validate_export_target(&path.display().to_string());
            assert!(matches!(result, Err(Error::Invalid(_))));
        }

        #[test]
        fn rejects_a_directory_that_does_not_exist() {
            let path = std::env::temp_dir()
                .join("learno-diretorio-que-nao-existe-12345")
                .join("nota.md");
            let result = validate_export_target(&path.display().to_string());
            assert!(matches!(result, Err(Error::Invalid(_))));
        }

        #[test]
        fn accepts_an_existing_directory_with_an_md_file_name() {
            let path = std::env::temp_dir().join("nota.md");
            let result = validate_export_target(&path.display().to_string()).unwrap();
            assert_eq!(result.file_name().unwrap(), "nota.md");
        }

        // FUN-023's own `sanitize_filename` still runs on the final path
        // component — a caller cannot smuggle a Windows-forbidden character
        // into the file name just because the directory check passed.
        #[test]
        fn sanitizes_the_final_file_name_component() {
            let path = std::env::temp_dir().join("aula: 1.md");
            let result = validate_export_target(&path.display().to_string()).unwrap();
            assert!(!result.file_name().unwrap().to_str().unwrap().contains(':'));
        }
    }

    mod commands_without_a_pool {
        use super::*;

        #[tokio::test]
        async fn autosave_merge_with_saved_reports_not_connected() {
            let state = AppState::new();
            let entry = autosave::JournalEntry {
                page_id: Uuid::now_v7(),
                title: "X".into(),
                content: json!({}),
                captured_at: chrono::Utc::now(),
            };

            let result = autosave_merge_with_saved_inner(&state, entry).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn export_page_markdown_reports_not_connected() {
            let state = AppState::new();
            let target = std::env::temp_dir().join("learno-test-export-without-pool.md");

            let result = export_page_markdown_inner(&state, Uuid::now_v7(), &target.display().to_string()).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }
    }

    mod commands_without_a_config {
        use super::*;

        #[tokio::test]
        async fn create_backup_reports_no_connection_configured() {
            let state = AppState::new();
            let result = create_backup_inner(&state, "unused", "C:/tmp").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn restore_backup_reports_no_connection_configured() {
            let state = AppState::new();
            let result = restore_backup_inner(&state, "unused", "C:/tmp/x.dump").await;
            assert!(matches!(result, Err(Error::Config(_))));
        }
    }

    #[test]
    fn default_export_file_name_sanitizes_and_appends_extension() {
        assert_eq!(default_export_file_name("Aula: 1".into()), "Aula_ 1.md");
    }
}
