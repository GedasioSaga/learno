//! Manual backup/restore of the whole local Postgres database (PLT-011),
//! shelling out to the `pg_dump`/`pg_restore` binaries that ship with any
//! Postgres 18 install rather than reimplementing a dump format.
//!
//! No credential lives in this file: the password always arrives as a
//! parameter from the caller (mirroring `test_database_connection` in
//! `ipc::commands`) and is only ever passed to the child process through the
//! `PGPASSWORD` environment variable — never as a `-W`/`--password` argument,
//! which would leak it into the process list.
//!
//! The full round trip (`run_backup` then `run_restore` into an empty
//! database) needs a live Postgres plus the `pg_dump`/`pg_restore` binaries,
//! so it is exercised only by the `#[ignore]`d test in
//! `src-tauri/tests/backup_dump.rs`, against the throwaway trust-auth
//! cluster from `scripts/dev-db.ps1` — never the machine's own Postgres
//! service, whose password is not ours to have. Everything that can be
//! proven without a database — the exact arguments built, the filename
//! format, and how a failed/missing process is reported — is a plain test
//! right here, and was actually run (not just read) while writing this file.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::process::Command;
use tokio::time::timeout;

use crate::config::AppConfig;
use crate::error::{Error, Result};

const PG_DUMP_BIN: &str = "pg_dump";
const PG_RESTORE_BIN: &str = "pg_restore";

/// How long a single `pg_dump`/`pg_restore` invocation may run before this
/// gives up on it rather than blocking forever — this gate sits in front of
/// a schema migration at app startup (PLT-020) and of every PLT-013
/// risky-operation trigger, so a hung child process must not freeze either.
/// A local desktop-scale Postgres dump/restore finishes in seconds; a
/// process still running after this long is far more likely stuck (a
/// locked table, a slow disk, a non-local host that stopped responding)
/// than legitimately busy.
const BACKUP_PROCESS_TIMEOUT: Duration = Duration::from_secs(300);

/// `learno-backup-<UTC timestamp>.dump`. Colons are deliberately absent from
/// the timestamp format — `HH:MM:SS` is a legal ISO-8601 time but an illegal
/// Windows filename.
fn backup_file_name(now: DateTime<Utc>) -> String {
    format!("learno-backup-{}.dump", now.format("%Y%m%dT%H%M%SZ"))
}

/// `pg_dump`'s custom format (`-Fc`) is compressed and is the one
/// `pg_restore` expects — plain SQL would also work but loses the
/// selective-restore and compression `pg_restore` gives us for free.
fn dump_args(config: &AppConfig, output_path: &Path) -> Vec<String> {
    vec![
        "--host".into(),
        config.host.clone(),
        "--port".into(),
        config.port.to_string(),
        "--username".into(),
        config.user.clone(),
        "--dbname".into(),
        config.database.clone(),
        "--format".into(),
        "custom".into(),
        "--no-password".into(),
        "--file".into(),
        output_path.display().to_string(),
    ]
}

/// `--clean --if-exists`: PLT-011's acceptance is "restored into an empty
/// base recovers all content", but a restore run against a non-empty target
/// (retried after a partial failure, say) should still land correctly
/// instead of erroring on every object that already exists.
fn restore_args(config: &AppConfig, dump_path: &Path) -> Vec<String> {
    vec![
        "--host".into(),
        config.host.clone(),
        "--port".into(),
        config.port.to_string(),
        "--username".into(),
        config.user.clone(),
        "--dbname".into(),
        config.database.clone(),
        "--no-password".into(),
        "--clean".into(),
        "--if-exists".into(),
        dump_path.display().to_string(),
    ]
}

/// Runs `program` with `args`, feeding `password` in through the
/// environment, and reports the three ways this can go wrong for someone
/// who has no console to see it in (a packaged desktop app): the binary
/// missing from PATH, the process hanging past `process_timeout`, and the
/// process exiting with an error — for which its own `stderr` (the disk-full
/// or permission message `pg_dump`/`pg_restore` actually printed) is folded
/// into the returned error instead of being silently inherited into a
/// terminal nobody is watching. `kill_on_drop` matters for the timeout
/// case specifically: `timeout()` dropping this future must not leave a
/// hung `pg_dump` running detached in the background.
///
/// Factored out of `run_backup`/`run_restore` so every failure shape above
/// can be proven with a real spawned process and no Postgres at all.
/// `process_timeout` is a parameter (rather than always reading
/// `BACKUP_PROCESS_TIMEOUT` directly) only so the timeout path itself can be
/// exercised in a test without an actual 5-minute wait.
async fn spawn_and_check(program: &str, args: &[String], password: &str, process_timeout: Duration) -> Result<()> {
    let mut command = Command::new(program);
    command.args(args).env("PGPASSWORD", password).kill_on_drop(true);

    let output = match timeout(process_timeout, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::Config(format!(
                "{program} não encontrado no PATH — instale as ferramentas de cliente do Postgres (pg_dump/pg_restore) e tente novamente"
            )));
        }
        Ok(Err(error)) => return Err(error.into()),
        Err(_elapsed) => {
            return Err(Error::Invalid(format!(
                "{program} não respondeu em {}s e foi interrompido — processo pode estar travado, disco cheio ou muito lento",
                process_timeout.as_secs()
            )));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        let detail = if stderr.is_empty() { "sem detalhes na saída de erro do processo".to_string() } else { stderr.to_string() };
        return Err(Error::Invalid(format!("{program} saiu com código de erro {}: {detail}", output.status)));
    }
    Ok(())
}

/// PLT-011: dumps the configured database to a fresh, timestamped file under
/// `output_dir`, creating that directory if needed.
pub async fn run_backup(config: &AppConfig, password: &str, output_dir: &Path) -> Result<PathBuf> {
    tokio::fs::create_dir_all(output_dir).await?;
    let output_path = output_dir.join(backup_file_name(Utc::now()));

    spawn_and_check(PG_DUMP_BIN, &dump_args(config, &output_path), password, BACKUP_PROCESS_TIMEOUT).await?;
    Ok(output_path)
}

/// PLT-011: restores `dump_path` (as produced by `run_backup`, or any
/// `pg_dump -Fc` output) over the configured database.
pub async fn run_restore(config: &AppConfig, password: &str, dump_path: &Path) -> Result<()> {
    if !dump_path.is_file() {
        return Err(Error::Invalid(format!(
            "arquivo de dump não encontrado: {}",
            dump_path.display()
        )));
    }

    spawn_and_check(PG_RESTORE_BIN, &restore_args(config, dump_path), password, BACKUP_PROCESS_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use chrono::TimeZone;

    fn sample_config() -> AppConfig {
        AppConfig {
            host: "localhost".into(),
            port: 5432,
            database: "learno".into(),
            user: "postgres".into(),
        }
    }

    fn strs(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn backup_file_name_has_no_colon_so_it_is_a_legal_windows_filename() {
        let fixed = Utc.with_ymd_and_hms(2026, 9, 2, 14, 30, 5).unwrap();
        let name = backup_file_name(fixed);

        assert_eq!(name, "learno-backup-20260902T143005Z.dump");
        assert!(!name.contains(':'));
    }

    #[test]
    fn dump_args_carries_every_connection_field_and_the_output_path() {
        let config = sample_config();
        let output = PathBuf::from("C:/tmp/learno-backup-x.dump");

        let args = dump_args(&config, &output);

        assert_eq!(
            args,
            strs(&[
                "--host", "localhost",
                "--port", "5432",
                "--username", "postgres",
                "--dbname", "learno",
                "--format", "custom",
                "--no-password",
                "--file", "C:/tmp/learno-backup-x.dump",
            ])
        );
    }

    #[test]
    fn restore_args_carries_every_connection_field_and_the_dump_path() {
        let config = sample_config();
        let dump = PathBuf::from("C:/tmp/learno-backup-x.dump");

        let args = restore_args(&config, &dump);

        assert_eq!(
            args,
            strs(&[
                "--host", "localhost",
                "--port", "5432",
                "--username", "postgres",
                "--dbname", "learno",
                "--no-password",
                "--clean",
                "--if-exists",
                "C:/tmp/learno-backup-x.dump",
            ])
        );
    }

    #[test]
    fn dump_and_restore_args_never_carry_the_password_as_a_literal_argument() {
        let config = sample_config();
        let path = PathBuf::from("C:/tmp/x.dump");

        assert!(!dump_args(&config, &path).iter().any(|a| a == "supersecret"));
        assert!(!restore_args(&config, &path).iter().any(|a| a == "supersecret"));
    }

    // Was `Error::Io` before `spawn_and_check` learned to tell "binary
    // missing" apart from other I/O failures — a bare `Io` gave a user with
    // no console just "entrada e saída: program not found", with no hint
    // that installing Postgres client tools is the fix.
    #[tokio::test]
    async fn spawn_and_check_reports_config_error_when_the_binary_does_not_exist() {
        let result = spawn_and_check("learno-nonexistent-binary-xyz", &[], "unused", BACKUP_PROCESS_TIMEOUT).await;
        match result {
            Err(Error::Config(message)) => assert!(message.contains("PATH")),
            other => panic!("expected Err(Error::Config(_)), got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn spawn_and_check_reports_invalid_when_the_process_exits_with_an_error_code() {
        let args = vec!["/C".to_string(), "exit".to_string(), "1".to_string()];
        let result = spawn_and_check("cmd", &args, "unused", BACKUP_PROCESS_TIMEOUT).await;
        assert!(matches!(result, Err(Error::Invalid(_))));
    }

    // Disco cheio ou permissão negada chegam do processo real via stderr —
    // sem isso, tudo que sobrevivia era o código de saída, e o usuário via
    // "pg_dump saiu com código de erro: exit code: 1" sem nenhuma pista do
    // porquê.
    #[cfg(windows)]
    #[tokio::test]
    async fn spawn_and_check_includes_the_process_stderr_in_the_error_message() {
        let args = strs(&["/C", "echo disco sem espaco 1>&2 & exit 3"]);
        let result = spawn_and_check("cmd", &args, "unused", BACKUP_PROCESS_TIMEOUT).await;
        match result {
            Err(Error::Invalid(message)) => assert!(
                message.contains("disco sem espaco"),
                "expected the process's own stderr in the error, got: {message}"
            ),
            other => panic!("expected Err(Error::Invalid(_)), got {other:?}"),
        }
    }

    // `ping` (not `pg_dump`) só para ter um processo real que fica de pé por
    // alguns segundos sem exigir um Postgres — o timeout de 200ms é bem
    // menor que os ~5s que `-n 6` leva, então isto sempre estoura de
    // verdade, e não por acaso.
    #[cfg(windows)]
    #[tokio::test]
    async fn spawn_and_check_reports_invalid_when_the_process_runs_past_the_timeout() {
        let args = strs(&["-n", "6", "127.0.0.1"]);
        let result = spawn_and_check("ping", &args, "unused", Duration::from_millis(200)).await;
        match result {
            Err(Error::Invalid(message)) => assert!(message.contains("não respondeu")),
            other => panic!("expected Err(Error::Invalid(_)), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_restore_rejects_a_dump_path_that_does_not_exist_before_spawning_anything() {
        let config = sample_config();
        let missing = std::env::temp_dir().join("learno-test-missing-dump-file.dump");

        let result = run_restore(&config, "unused", &missing).await;
        assert!(matches!(result, Err(Error::Invalid(_))));
    }
}
