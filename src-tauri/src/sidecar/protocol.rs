//! Wire format for the stdio protocol shared with `sidecar/learno_sidecar`.
//!
//! One JSON object per line, in both directions. Keep the field names here
//! in lockstep with `sidecar/learno_sidecar/protocol.py` — the two sides
//! agree on shape by convention, not by a shared schema file.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SidecarRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

impl SidecarRequest {
    /// Builds a request with a fresh correlation id — the caller never picks
    /// its own, so two concurrent calls can never collide.
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            method: method.into(),
            params,
        }
    }

    /// Serializes to one line ready for the sidecar's stdin, newline included.
    pub fn to_line(&self) -> Result<String> {
        let mut line = serde_json::to_string(self)?;
        line.push('\n');
        Ok(line)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SidecarErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SidecarResponse {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<SidecarErrorPayload>,
}

impl SidecarResponse {
    /// Synthesizes a failure that never actually round-tripped through the
    /// sidecar — used when the process dies or the pipe breaks mid-request.
    pub(crate) fn transport_failure(id: Option<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(SidecarErrorPayload {
                code: "transport_error".to_string(),
                message: message.into(),
            }),
        }
    }

    pub(crate) fn from_line(line: &str) -> Result<Self> {
        Ok(serde_json::from_str(line)?)
    }
}

/// Result of `health.check`, the one method Fase 1 requires every builder
/// after this to be able to call.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HealthReport {
    pub version: String,
    pub capabilities: Vec<String>,
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn request_to_line_carries_method_and_params_and_ends_in_newline() {
        let request = SidecarRequest::new("health.check", serde_json::json!({"a": 1}));

        let line = request.to_line().unwrap();

        assert!(line.ends_with('\n'));
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["method"], "health.check");
        assert_eq!(value["params"], serde_json::json!({"a": 1}));
        assert_eq!(value["id"], request.id);
    }

    #[test]
    fn request_ids_are_unique_per_call() {
        let a = SidecarRequest::new("health.check", Value::Null);
        let b = SidecarRequest::new("health.check", Value::Null);

        assert_ne!(a.id, b.id);
    }

    #[test]
    fn response_from_line_parses_success() {
        let line = r#"{"id":"1","ok":true,"result":{"version":"0.1.0"}}"#;

        let response = SidecarResponse::from_line(line).unwrap();

        assert!(response.ok);
        assert_eq!(response.id.as_deref(), Some("1"));
        assert_eq!(response.result.unwrap()["version"], "0.1.0");
    }

    #[test]
    fn response_from_line_parses_failure_without_result() {
        let line = r#"{"id":"1","ok":false,"error":{"code":"method_not_found","message":"nope"}}"#;

        let response = SidecarResponse::from_line(line).unwrap();

        assert!(!response.ok);
        assert!(response.result.is_none());
        assert_eq!(response.error.unwrap().code, "method_not_found");
    }

    #[test]
    fn response_from_line_rejects_malformed_json() {
        assert!(SidecarResponse::from_line("{not json").is_err());
    }

    #[test]
    fn transport_failure_carries_the_given_id_and_message() {
        let response = SidecarResponse::transport_failure(Some("1".to_string()), "processo morreu");

        assert!(!response.ok);
        assert_eq!(response.id.as_deref(), Some("1"));
        assert_eq!(response.error.unwrap().message, "processo morreu");
    }
}
