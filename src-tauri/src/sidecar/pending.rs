//! Correlation table matching stdio responses back to the caller awaiting them.
//!
//! Kept free of any process or transport type so the matching logic is unit
//! tested without spawning the sidecar binary.

use std::collections::HashMap;

use tokio::sync::oneshot;

use crate::sidecar::protocol::SidecarResponse;

#[derive(Default)]
pub(crate) struct PendingRequests {
    waiters: HashMap<String, oneshot::Sender<SidecarResponse>>,
}

impl PendingRequests {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a waiter for `id` and returns the receiver half to await on.
    pub fn register(&mut self, id: String) -> oneshot::Receiver<SidecarResponse> {
        let (tx, rx) = oneshot::channel();
        self.waiters.insert(id, tx);
        rx
    }

    /// Delivers `response` to whoever is waiting on its id.
    ///
    /// Returns false when no one is waiting: the caller already timed out
    /// and dropped its receiver, or the sidecar echoed an id we never sent.
    pub fn resolve(&mut self, response: SidecarResponse) -> bool {
        let Some(id) = response.id.clone() else {
            return false;
        };
        match self.waiters.remove(&id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    /// Fails every outstanding waiter — used when the sidecar process dies
    /// or its stdout pipe closes, so no caller is left awaiting forever.
    pub fn fail_all(&mut self, message: &str) {
        for (id, tx) in self.waiters.drain() {
            let _ = tx.send(SidecarResponse::transport_failure(Some(id), message));
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.waiters.len()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[tokio::test]
    async fn resolve_delivers_the_response_to_the_matching_waiter() {
        let mut pending = PendingRequests::new();
        let rx = pending.register("1".to_string());

        let delivered = pending.resolve(SidecarResponse {
            id: Some("1".to_string()),
            ok: true,
            result: Some(serde_json::json!({"version": "0.1.0"})),
            error: None,
        });

        assert!(delivered);
        let response = rx.await.unwrap();
        assert!(response.ok);
    }

    #[tokio::test]
    async fn resolve_with_unknown_id_is_reported_and_does_not_panic() {
        let mut pending = PendingRequests::new();
        pending.register("1".to_string());

        let delivered = pending.resolve(SidecarResponse {
            id: Some("does-not-exist".to_string()),
            ok: true,
            result: None,
            error: None,
        });

        assert!(!delivered);
        assert_eq!(pending.len(), 1);
    }

    #[tokio::test]
    async fn resolve_with_missing_id_is_reported_and_does_not_panic() {
        let mut pending = PendingRequests::new();

        let delivered = pending.resolve(SidecarResponse {
            id: None,
            ok: false,
            result: None,
            error: None,
        });

        assert!(!delivered);
    }

    #[tokio::test]
    async fn fail_all_delivers_a_transport_failure_to_every_waiter() {
        let mut pending = PendingRequests::new();
        let rx_a = pending.register("a".to_string());
        let rx_b = pending.register("b".to_string());

        pending.fail_all("sidecar encerrou pelo app");

        assert_eq!(pending.len(), 0);
        let response_a = rx_a.await.unwrap();
        let response_b = rx_b.await.unwrap();
        assert!(!response_a.ok);
        assert!(!response_b.ok);
        assert_eq!(response_a.error.unwrap().message, "sidecar encerrou pelo app");
        assert_eq!(response_b.error.unwrap().message, "sidecar encerrou pelo app");
    }
}
