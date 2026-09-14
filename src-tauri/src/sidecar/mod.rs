//! Bridge to the Python sidecar: one JSON request/response per line over
//! stdio (see `protocol.rs`). Fase 1 wired the transport and a health check.
//! No production command calls `SidecarProcess::call` today: `.apkg` import,
//! its first caller, moved to Rust (`crate::anki`), where the database lives.
//! Work that genuinely needs Python arrives the same way, no change needed
//! here. `lib.rs`'s
//! `tauri::Builder` chain spawns one `SidecarProcess` in `.setup()`, stores
//! it in `ipc::AppState`, and shuts it down on `ExitRequested`; see
//! `sidecar/README.md` for the `externalBin`/capability entries that make
//! `spawn` able to find the packaged binary.

mod pending;
mod protocol;
mod reader;

pub use protocol::{HealthReport, SidecarErrorPayload, SidecarResponse};

use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};

use crate::error::{Error, Result};
use pending::PendingRequests;
use protocol::SidecarRequest;

/// Base name Tauri's `externalBin` resolves per-platform; see `sidecar/README.md`.
const SIDECAR_NAME: &str = "learno-sidecar";

/// How long a call waits for a response before it's treated as a timeout,
/// so a hung sidecar surfaces as an error instead of hanging the UI forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Handle to the running sidecar process. Cheap to clone — every clone
/// shares the same process and can issue calls or shut it down.
#[derive(Clone)]
pub struct SidecarProcess {
    child: Arc<Mutex<Option<CommandChild>>>,
    pending: Arc<Mutex<PendingRequests>>,
}

impl SidecarProcess {
    /// Spawns the Python sidecar and starts the background reader that
    /// matches responses back to callers. Call once at app startup.
    ///
    /// Not covered by a unit test: it needs a real `AppHandle` backed by the
    /// shell plugin and, to succeed, the packaged binary from
    /// `sidecar/README.md`'s build step. `pending`/`reader`/`protocol` carry
    /// the logic that can run without either.
    pub fn spawn(app: &AppHandle) -> Result<Self> {
        let command = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|err| Error::Sidecar(format!("sidecar não encontrado: {err}")))?;

        let (events, child) = command
            .spawn()
            .map_err(|err| Error::Sidecar(format!("falha ao iniciar o sidecar: {err}")))?;

        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        tauri::async_runtime::spawn(reader::run(events, pending.clone()));

        Ok(Self {
            child: Arc::new(Mutex::new(Some(child))),
            pending,
        })
    }

    /// Health check every later fase can rely on: proves the process is up
    /// and reports what methods it currently answers to.
    pub async fn health_check(&self) -> Result<HealthReport> {
        self.call("health.check", serde_json::json!({})).await
    }

    /// Sends `method` with `params` and awaits the matching response, subject
    /// to `CALL_TIMEOUT`. A dead or hung sidecar surfaces as `Error::Sidecar`
    /// instead of panicking or blocking the caller forever.
    pub async fn call<P, R>(&self, method: &str, params: P) -> Result<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let request = SidecarRequest::new(method, serde_json::to_value(params)?);
        let waiter = self.pending.lock().await.register(request.id.clone());

        self.write_request(&request).await?;

        await_response(waiter, method, CALL_TIMEOUT).await
    }

    /// Not covered by a unit test: writing to `CommandChild`'s stdin needs a
    /// real spawned process. `await_response` below covers everything that
    /// happens after the write.
    async fn write_request(&self, request: &SidecarRequest) -> Result<()> {
        let line = request.to_line()?;
        let mut guard = self.child.lock().await;
        let child = guard
            .as_mut()
            .ok_or_else(|| Error::Sidecar("sidecar já foi encerrado".to_string()))?;
        child
            .write(line.as_bytes())
            .map_err(|err| Error::Sidecar(format!("falha ao escrever no sidecar: {err}")))
    }

    /// Kills the process. Safe to call more than once, and safe for the
    /// caller to forget — but dropping the last handle does not itself kill
    /// the child, so this must run explicitly on app shutdown (see
    /// `sidecar/README.md`).
    pub async fn shutdown(&self) {
        if let Some(child) = self.child.lock().await.take() {
            let _ = child.kill();
        }
        self.pending.lock().await.fail_all("sidecar encerrado pelo app");
    }
}

/// Awaits one response, decodes it into `R`, and maps every failure mode —
/// timeout, the sender dropping without a response, or the sidecar's own
/// error payload — into `Error::Sidecar`.
///
/// Free of `SidecarProcess`/`CommandChild` on purpose: it is exercised in
/// tests with a plain `oneshot` channel and no spawned process.
async fn await_response<R: DeserializeOwned>(
    waiter: oneshot::Receiver<SidecarResponse>,
    method: &str,
    timeout: Duration,
) -> Result<R> {
    let response = tokio::time::timeout(timeout, waiter)
        .await
        .map_err(|_| Error::Sidecar(format!("sidecar não respondeu a '{method}' a tempo")))?
        .map_err(|_| Error::Sidecar("sidecar encerrou antes de responder".to_string()))?;

    into_result(response)
}

fn into_result<R: DeserializeOwned>(response: SidecarResponse) -> Result<R> {
    if !response.ok {
        let error = response.error.unwrap_or_else(|| SidecarErrorPayload {
            code: "unknown".to_string(),
            message: "sidecar retornou erro sem detalhe".to_string(),
        });
        return Err(Error::Sidecar(format!("[{}] {}", error.code, error.message)));
    }

    let result = response
        .result
        .ok_or_else(|| Error::Sidecar("sidecar retornou sucesso sem resultado".to_string()))?;

    Ok(serde_json::from_value(result)?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[tokio::test]
    async fn await_response_decodes_a_successful_result() {
        let (tx, rx) = oneshot::channel();
        tx.send(SidecarResponse {
            id: Some("1".to_string()),
            ok: true,
            result: Some(serde_json::json!({"version": "0.1.0", "capabilities": []})),
            error: None,
        })
        .unwrap();

        let report: HealthReport = await_response(rx, "health.check", Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(report.version, "0.1.0");
    }

    #[tokio::test]
    async fn await_response_surfaces_the_sidecar_error_payload() {
        let (tx, rx) = oneshot::channel();
        tx.send(SidecarResponse {
            id: Some("1".to_string()),
            ok: false,
            result: None,
            error: Some(SidecarErrorPayload {
                code: "method_not_found".to_string(),
                message: "unknown method: nope".to_string(),
            }),
        })
        .unwrap();

        let err = await_response::<HealthReport>(rx, "nope", Duration::from_secs(1))
            .await
            .unwrap_err();

        assert!(matches!(err, Error::Sidecar(msg) if msg.contains("method_not_found")));
    }

    #[tokio::test]
    async fn await_response_times_out_on_a_hung_sidecar_instead_of_blocking_forever() {
        let (_tx, rx) = oneshot::channel::<SidecarResponse>();

        let err = await_response::<HealthReport>(rx, "health.check", Duration::from_millis(20))
            .await
            .unwrap_err();

        assert!(matches!(err, Error::Sidecar(msg) if msg.contains("não respondeu")));
    }

    #[tokio::test]
    async fn await_response_reports_a_dead_sidecar_instead_of_panicking() {
        let (tx, rx) = oneshot::channel::<SidecarResponse>();
        drop(tx);

        let err = await_response::<HealthReport>(rx, "health.check", Duration::from_secs(1))
            .await
            .unwrap_err();

        assert!(matches!(err, Error::Sidecar(_)));
    }

    #[test]
    fn into_result_rejects_a_success_response_with_no_result() {
        let response = SidecarResponse {
            id: Some("1".to_string()),
            ok: true,
            result: None,
            error: None,
        };

        let err = into_result::<HealthReport>(response).unwrap_err();

        assert!(matches!(err, Error::Sidecar(_)));
    }

    /// Exercises `reader::run` + `PendingRequests` against a real OS
    /// process talking the real wire protocol over real stdio — the gap
    /// left by every test above, which only ever fed a hand-built
    /// `SidecarResponse` through a plain `oneshot` channel.
    ///
    /// Deliberately does not go through `SidecarProcess::spawn` (which is
    /// what production uses): that needs a live `AppHandle` with the shell
    /// plugin registered, and the only way to get one in this crate's tests
    /// is `tauri::test::mock_builder`, which crashes this crate's whole
    /// `cargo test` binary on this toolchain (`STATUS_ENTRYPOINT_NOT_FOUND`
    /// — see the doc comment on `ipc::commands::page_repository`, confirmed
    /// there by bisection). Spawning the packaged binary directly with
    /// `tokio::process::Command` and translating its stdout into the same
    /// `CommandEvent`s the shell plugin would hand `reader::run` exercises
    /// the identical downstream code path without that crash.
    mod real_process {
        use std::process::Stdio;

        use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::process::Command;
        use tokio::sync::mpsc;

        use super::*;

        /// Built by `pyinstaller learno_sidecar.spec` from `sidecar/` (see
        /// `sidecar/README.md`). Not committed — `sidecar/dist/` is
        /// build output — so both tests below are `#[ignore]`d the same
        /// way the live-Postgres tests are: they prove the real thing when
        /// the artifact exists, without making a fresh checkout's
        /// `cargo test` depend on a Python/PyInstaller toolchain.
        fn packaged_binary_path() -> std::path::PathBuf {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("sidecar")
                .join("dist")
                .join("learno-sidecar.exe")
        }

        /// Stands in for the one piece of `tauri_plugin_shell` this test
        /// cannot use without an `AppHandle`: turning a real child's stdout
        /// into the `CommandEvent` stream `reader::run` consumes in
        /// production.
        async fn forward_stdout_as_command_events(
            stdout: tokio::process::ChildStdout,
            tx: mpsc::Sender<CommandEvent>,
        ) {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let mut bytes = line.into_bytes();
                        bytes.push(b'\n');
                        if tx.send(CommandEvent::Stdout(bytes)).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = tx
                            .send(CommandEvent::Terminated(TerminatedPayload { code: None, signal: None }))
                            .await;
                        return;
                    }
                    Err(err) => {
                        let _ = tx.send(CommandEvent::Error(err.to_string())).await;
                        return;
                    }
                }
            }
        }

        async fn call_real_sidecar<R: DeserializeOwned>(method: &str, params: serde_json::Value) -> Result<R> {
            let binary = packaged_binary_path();
            assert!(
                binary.exists(),
                "packaged binary not found at {binary:?} — run `pyinstaller learno_sidecar.spec` in sidecar/ first"
            );

            let mut child = Command::new(&binary)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to start the packaged sidecar binary");
            let mut stdin = child.stdin.take().expect("child stdin");
            let stdout = child.stdout.take().expect("child stdout");

            let (tx, rx) = mpsc::channel(8);
            tokio::spawn(forward_stdout_as_command_events(stdout, tx));

            let pending = Arc::new(Mutex::new(PendingRequests::new()));
            tokio::spawn(reader::run(rx, pending.clone()));

            let request = SidecarRequest::new(method, params);
            let waiter = pending.lock().await.register(request.id.clone());
            stdin
                .write_all(request.to_line()?.as_bytes())
                .await
                .expect("failed to write to the real child's stdin");

            let result = await_response(waiter, method, Duration::from_secs(5)).await;
            let _ = child.kill().await;
            result
        }

        #[tokio::test]
        #[ignore = "requires the packaged sidecar binary — run `pyinstaller learno_sidecar.spec` in sidecar/ first"]
        async fn health_check_round_trips_through_the_real_packaged_process() {
            let report: HealthReport = call_real_sidecar("health.check", serde_json::json!({}))
                .await
                .unwrap();

            assert_eq!(report.version, "0.1.0");
            assert!(report.capabilities.iter().any(|c| c == "health.check"));
        }

        #[tokio::test]
        #[ignore = "requires the packaged sidecar binary — run `pyinstaller learno_sidecar.spec` in sidecar/ first"]
        async fn unknown_method_surfaces_the_real_sidecar_error_payload() {
            let err = call_real_sidecar::<HealthReport>("nope.not.a.method", serde_json::json!({}))
                .await
                .unwrap_err();

            assert!(matches!(err, Error::Sidecar(msg) if msg.contains("method_not_found")));
        }
    }
}
