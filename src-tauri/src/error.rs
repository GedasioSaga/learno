//! The one error type that crosses module boundaries.
//!
//! Every module below `lib` returns `Result<T>` from here, so an error raised in
//! the data layer can travel through IPC and reach the frontend as JSON without
//! each layer inventing its own conversion.

use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("banco de dados: {0}")]
    Database(#[from] sqlx::Error),

    /// PLT-016: distinto de `Database` — este é o caso em que nenhuma
    /// instância de Postgres respondeu no endereço testado (porta fechada,
    /// host errado, serviço parado), não uma credencial rejeitada por um
    /// servidor que de fato atendeu. O assistente de primeira execução usa
    /// esse `kind` para mostrar orientação de instalação em vez da mensagem
    /// crua de conexão.
    #[error("nenhuma instância de Postgres encontrada: {0}")]
    DatabaseUnreachable(String),

    #[error("migração do banco: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("configuração: {0}")]
    Config(String),

    #[error("sidecar Python: {0}")]
    Sidecar(String),

    #[error("não encontrado: {0}")]
    NotFound(String),

    #[error("entrada inválida: {0}")]
    Invalid(String),

    #[error("entrada e saída: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialização: {0}")]
    Serde(#[from] serde_json::Error),
}

/// What the frontend actually receives. The `kind` is stable and safe to branch
/// on in TypeScript; `message` is for humans and may change wording freely.
#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub kind: &'static str,
    pub message: String,
}

impl Error {
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Database(_) => "database",
            Error::DatabaseUnreachable(_) => "database_unreachable",
            Error::Migration(_) => "migration",
            Error::Config(_) => "config",
            Error::Sidecar(_) => "sidecar",
            Error::NotFound(_) => "not_found",
            Error::Invalid(_) => "invalid",
            Error::Io(_) => "io",
            Error::Serde(_) => "serde",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}
