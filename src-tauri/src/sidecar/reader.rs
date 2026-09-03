//! Drains the sidecar's stdout/stderr event stream and resolves pending calls.
//!
//! Runs as a background task for the life of the process. Split out from
//! `SidecarProcess` so it can be driven with a synthetic event channel in
//! tests, without spawning the real binary.

use std::sync::Arc;

use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::{mpsc, Mutex};
use tracing::warn;

use crate::sidecar::pending::PendingRequests;
use crate::sidecar::protocol::SidecarResponse;

/// Consumes `events` until the sidecar's stdout pipe closes, i.e. the process
/// exited. A malformed line from the sidecar is logged and skipped — it must
/// not take down the whole bridge along with every other in-flight call.
pub(crate) async fn run(mut events: mpsc::Receiver<CommandEvent>, pending: Arc<Mutex<PendingRequests>>) {
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => handle_stdout_line(&bytes, &pending).await,
            CommandEvent::Stderr(bytes) => log_stderr_line(&bytes),
            CommandEvent::Error(message) => {
                warn!(error = %message, "sidecar transport error");
                pending.lock().await.fail_all(&message);
            }
            CommandEvent::Terminated(payload) => {
                let message = format!("sidecar process exited (code {:?})", payload.code);
                pending.lock().await.fail_all(&message);
            }
            // `CommandEvent` is `#[non_exhaustive]`: the plugin may add event
            // kinds later that this bridge doesn't need to act on.
            _ => {}
        }
    }
    pending.lock().await.fail_all("sidecar stdout pipe closed");
}

async fn handle_stdout_line(bytes: &[u8], pending: &Arc<Mutex<PendingRequests>>) {
    let line = String::from_utf8_lossy(bytes);
    let response = match SidecarResponse::from_line(line.trim()) {
        Ok(response) => response,
        Err(err) => {
            warn!(error = %err, "sidecar sent an unparseable line");
            return;
        }
    };
    pending.lock().await.resolve(response);
}

fn log_stderr_line(bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    if !line.trim().is_empty() {
        warn!(sidecar_stderr = %line.trim());
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use tauri_plugin_shell::process::TerminatedPayload;
    use tokio::sync::mpsc;

    use super::*;

    fn stdout_line(json: &str) -> CommandEvent {
        CommandEvent::Stdout(format!("{json}\n").into_bytes())
    }

    #[tokio::test]
    async fn valid_stdout_line_resolves_the_matching_waiter() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let rx = pending.lock().await.register("1".to_string());
        let (tx, events) = mpsc::channel(4);

        tx.send(stdout_line(r#"{"id":"1","ok":true,"result":{"version":"0.1.0"}}"#))
            .await
            .unwrap();
        drop(tx);

        run(events, pending).await;

        let response = rx.await.unwrap();
        assert!(response.ok);
    }

    #[tokio::test]
    async fn malformed_line_is_skipped_and_a_later_valid_line_still_resolves() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let rx = pending.lock().await.register("1".to_string());
        let (tx, events) = mpsc::channel(4);

        tx.send(CommandEvent::Stdout(b"not json\n".to_vec())).await.unwrap();
        tx.send(stdout_line(r#"{"id":"1","ok":true,"result":{}}"#))
            .await
            .unwrap();
        drop(tx);

        run(events, pending).await;

        let response = rx.await.unwrap();
        assert!(response.ok);
    }

    #[tokio::test]
    async fn terminated_event_fails_every_pending_waiter() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let rx = pending.lock().await.register("1".to_string());
        let (tx, events) = mpsc::channel(4);

        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(1),
            signal: None,
        }))
        .await
        .unwrap();
        drop(tx);

        run(events, pending).await;

        let response = rx.await.unwrap();
        assert!(!response.ok);
    }

    #[tokio::test]
    async fn error_event_fails_every_pending_waiter() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let rx = pending.lock().await.register("1".to_string());
        let (tx, events) = mpsc::channel(4);

        tx.send(CommandEvent::Error("pipe quebrou".to_string())).await.unwrap();
        drop(tx);

        run(events, pending).await;

        let response = rx.await.unwrap();
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().message, "pipe quebrou");
    }

    #[tokio::test]
    async fn channel_closing_without_a_terminated_event_still_fails_pending_waiters() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let rx = pending.lock().await.register("1".to_string());
        let (tx, events) = mpsc::channel::<CommandEvent>(4);

        drop(tx);

        run(events, pending).await;

        let response = rx.await.unwrap();
        assert!(!response.ok);
    }
}
