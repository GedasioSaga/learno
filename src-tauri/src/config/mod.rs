//! Dados e regras da conexão Postgres do usuário: o formato que o assistente de
//! primeira execução preenche, a validação desses campos, e a montagem das
//! opções de conexão do sqlx a partir deles.
//!
//! Este módulo não fala com o Postgres nem com o `tauri-plugin-store` — isso é
//! trabalho do `ipc`, que empresta os comandos de `#[tauri::command]`. Aqui só
//! fica a lógica pura, testável sem banco e sem app Tauri de pé.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::postgres::PgConnectOptions;

use crate::error::{Error, Result};

/// Porta padrão do Postgres, usada quando o assistente não recebe outra.
pub const DEFAULT_PORT: u16 = 5432;

/// Tempo máximo de espera ao testar uma conexão no assistente de primeira
/// execução — o usuário está olhando para a tela, então isso precisa falhar
/// rápido em vez de travar a UI esperando um host que não responde.
pub const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Nome do arquivo do `tauri-plugin-store` onde a conexão fica salva.
pub const STORE_FILE: &str = "config.json";

/// Chave, dentro do store acima, onde o valor serializado de [`AppConfig`] mora.
pub const CONFIG_STORE_KEY: &str = "postgres_connection";

/// Chave, no mesmo store, onde a pasta de dados que o assistente de primeira
/// execução coletou (PLT-016) fica salva. Fica fora de [`AppConfig`] de
/// propósito: aquele tipo é reconstruído por struct-literal em módulos que
/// não são deste PR (`backup::dump`, `ipc::state`), e uma chave separada
/// evita quebrar essas construções só para acrescentar este campo opcional.
pub const DATA_DIR_STORE_KEY: &str = "app_data_dir";

/// O que persiste em disco depois que o assistente de primeira execução roda
/// com sucesso. Nunca tem uma senha — essa é pedida de novo a cada sessão que
/// precisar abrir conexão, e nunca toca o disco.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
}

/// O que o assistente de primeira execução manda para testar uma conexão.
/// Inclui a senha porque o teste precisa autenticar de verdade — mas o `Debug`
/// abaixo é escrito à mão para nunca deixá-la escapar num log.
#[derive(Deserialize)]
pub struct ConnectionTestInput {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

// Debug manual em vez do derive: precisa custar bem para omitir a senha do
// próprio código-fonte, não confiar em disciplina de quem chama `{:?}` depois.
impl std::fmt::Debug for ConnectionTestInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionTestInput")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl AppConfig {
    /// Confere que os campos exibidos e editados pelo assistente fazem sentido
    /// antes de gravar no store. Não valida a senha — ela nem chega até aqui.
    pub fn validate(&self) -> Result<()> {
        if self.host.trim().is_empty() {
            return Err(Error::Invalid("host não pode ser vazio".into()));
        }
        if self.port == 0 {
            return Err(Error::Invalid("porta precisa ser maior que zero".into()));
        }
        if self.database.trim().is_empty() {
            return Err(Error::Invalid("nome do banco não pode ser vazio".into()));
        }
        if self.user.trim().is_empty() {
            return Err(Error::Invalid("usuário não pode ser vazio".into()));
        }
        Ok(())
    }
}

impl From<&ConnectionTestInput> for AppConfig {
    /// Extrai a parte persistível de um teste de conexão bem-sucedido — sem a senha.
    fn from(input: &ConnectionTestInput) -> Self {
        AppConfig {
            host: input.host.clone(),
            port: input.port,
            database: input.database.clone(),
            user: input.user.clone(),
        }
    }
}

/// PLT-016: confere que a pasta de dados informada no assistente não é só
/// espaço em branco antes de persistir. Só valida forma — não confere que o
/// caminho existe nem que é gravável; isso é responsabilidade de quem de
/// fato ler/escrever nela (PLT-008, a tela de configurações, ainda não
/// implementada), não do assistente de primeira execução.
pub fn validate_data_dir(data_dir: &str) -> Result<()> {
    if data_dir.trim().is_empty() {
        return Err(Error::Invalid("pasta de dados não pode ser vazia".into()));
    }
    Ok(())
}

/// Monta as opções de conexão do sqlx a partir do que o assistente coletou.
/// Função pura — não abre socket nenhum, só existe para ser testável sem rede.
pub fn build_connect_options(input: &ConnectionTestInput) -> PgConnectOptions {
    PgConnectOptions::new()
        .host(&input.host)
        .port(input.port)
        .username(&input.user)
        .password(&input.password)
        .database(&input.database)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> ConnectionTestInput {
        ConnectionTestInput {
            host: "localhost".into(),
            port: 5432,
            database: "learno".into(),
            user: "postgres".into(),
            password: "segredo".into(),
        }
    }

    #[test]
    fn build_connect_options_copies_every_field_except_password() {
        let input = sample_input();
        let options = build_connect_options(&input);

        assert_eq!(options.get_host(), "localhost");
        assert_eq!(options.get_port(), 5432);
        assert_eq!(options.get_username(), "postgres");
        assert_eq!(options.get_database(), Some("learno"));
    }

    #[test]
    fn app_config_from_connection_test_input_drops_password() {
        let input = sample_input();
        let config = AppConfig::from(&input);

        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 5432);
        assert_eq!(config.database, "learno");
        assert_eq!(config.user, "postgres");
        // Não há campo `password` em AppConfig — se houvesse, este teste
        // pegaria a regressão na primeira vez que alguém tentasse adicionar um.
    }

    #[test]
    fn validate_rejects_empty_host() {
        let config = AppConfig {
            host: "  ".into(),
            port: 5432,
            database: "learno".into(),
            user: "postgres".into(),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_zero_port() {
        let config = AppConfig {
            host: "localhost".into(),
            port: 0,
            database: "learno".into(),
            user: "postgres".into(),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_database() {
        let config = AppConfig {
            host: "localhost".into(),
            port: 5432,
            database: "".into(),
            user: "postgres".into(),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_user() {
        let config = AppConfig {
            host: "localhost".into(),
            port: 5432,
            database: "learno".into(),
            user: "".into(),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_accepts_well_formed_config() {
        let config = AppConfig {
            host: "localhost".into(),
            port: 5432,
            database: "learno".into(),
            user: "postgres".into(),
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_data_dir_rejects_blank_input() {
        assert!(validate_data_dir("   ").is_err());
        assert!(validate_data_dir("").is_err());
    }

    #[test]
    fn validate_data_dir_accepts_a_real_looking_path() {
        assert!(validate_data_dir(r"C:\Users\alguem\Learno").is_ok());
    }

    #[test]
    fn debug_output_never_contains_the_password() {
        let input = sample_input();
        let formatted = format!("{input:?}");
        assert!(!formatted.contains("segredo"));
        assert!(formatted.contains("<redacted>"));
    }
}
