//! Estado que sobrevive entre chamadas de comando, injetado no app via
//! `tauri::Builder::manage`.

use std::sync::RwLock;

use sqlx::PgPool;

use crate::config::AppConfig;
use crate::error::{Error, Result};
use crate::sidecar::SidecarProcess;

/// Estado compartilhado do app.
///
/// `pool` fica `None` até `ipc::commands::connect_database` preencher com o
/// resultado de `db::connect_migrate_with_rollback` — uma vez no fim do
/// assistente de primeira execução, e de novo a cada abertura do app em que
/// existe configuração salva mas a sessão ainda não digitou a senha (ela
/// nunca é persistida). Este arquivo só guarda o slot; os comandos de página
/// em `ipc::commands` já leem daqui via `pool()`.
///
/// `sidecar` segue o mesmo desenho: `lib.rs` sobe o processo uma vez, em
/// `.setup()` (precisa de um `AppHandle` real, que `AppState` nunca tem), e
/// grava o handle aqui via `set_sidecar`. Comandos como `import_apkg` só leem
/// o slot — igual a `pool()`, e pelo mesmo motivo: nenhum deles tem acesso a
/// um `AppHandle` para poder subir o processo sozinho. Um sidecar que morre
/// no meio de uma chamada não limpa este slot: `SidecarProcess::call` já
/// falha toda chamada pendente na hora, via `PendingRequests::fail_all` (ver
/// `sidecar::reader::run`), então quem estava esperando recebe o erro
/// imediatamente em vez de travar até o timeout. Decisão deliberada de não
/// reconectar sozinho depois disso — mesmo espírito de `pool`, que também não
/// reconecta ao Postgres sozinho depois de caído.
pub struct AppState {
    config_cache: RwLock<Option<AppConfig>>,
    pool: RwLock<Option<PgPool>>,
    sidecar: RwLock<Option<SidecarProcess>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            config_cache: RwLock::new(None),
            pool: RwLock::new(None),
            sidecar: RwLock::new(None),
        }
    }

    /// A conexão ativa com o Postgres, ou `Error::Config` quando o app ainda
    /// não passou pelo assistente de primeira execução (ou a sessão ainda
    /// não digitou a senha) — ver o comentário da struct acima. `PgPool::clone`
    /// é barato: é só um handle para o mesmo pool de conexões.
    pub fn pool(&self) -> Result<PgPool> {
        self.pool
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| Error::Config("banco de dados ainda não conectado".into()))
    }

    /// Chamado por `ipc::commands::connect_database`, depois que a conexão é
    /// aberta e migrada com sucesso.
    pub fn set_pool(&self, pool: PgPool) {
        if let Ok(mut guard) = self.pool.write() {
            *guard = Some(pool);
        }
    }

    /// Lê a última configuração conhecida sem tocar o disco.
    ///
    /// `RwLock::read` só falha se outra thread deixou o lock envenenado (um
    /// pânico segurando o lock) — quando isso acontece o processo já está em
    /// estado inválido, então tratamos como "sem config em cache" em vez de
    /// propagar um segundo pânico daqui.
    pub fn cached_config(&self) -> Option<AppConfig> {
        self.config_cache
            .read()
            .map(|guard| guard.clone())
            .unwrap_or(None)
    }

    /// Atualiza o cache em memória. Chamado depois que um comando lê ou grava
    /// a configuração no store, para manter as duas cópias em sincronia.
    pub fn set_cached_config(&self, config: Option<AppConfig>) {
        if let Ok(mut guard) = self.config_cache.write() {
            *guard = config;
        }
    }

    /// O handle do processo sidecar, ou `Error::Sidecar` quando `lib.rs`
    /// ainda não subiu o processo (falha de spawn no `.setup()`, ou binário
    /// empacotado ausente nesta máquina) — ver o comentário da struct acima.
    /// `SidecarProcess::clone` é barato: é só um `Arc` para o mesmo processo.
    pub fn sidecar(&self) -> Result<SidecarProcess> {
        self.sidecar
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| Error::Sidecar("sidecar Python não está disponível".into()))
    }

    /// Chamado por `lib.rs`'s `.setup()`, depois que `SidecarProcess::spawn`
    /// sobe o processo com sucesso.
    pub fn set_sidecar(&self, sidecar: SidecarProcess) {
        if let Ok(mut guard) = self.sidecar.write() {
            *guard = Some(sidecar);
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn sample_config() -> AppConfig {
        AppConfig {
            host: "localhost".into(),
            port: 5432,
            database: "learno".into(),
            user: "postgres".into(),
        }
    }

    #[test]
    fn starts_with_no_cached_config() {
        let state = AppState::new();
        assert_eq!(state.cached_config(), None);
    }

    #[test]
    fn round_trips_a_cached_config() {
        let state = AppState::new();
        state.set_cached_config(Some(sample_config()));
        assert_eq!(state.cached_config(), Some(sample_config()));
    }

    #[test]
    fn can_clear_the_cache_back_to_none() {
        let state = AppState::new();
        state.set_cached_config(Some(sample_config()));
        state.set_cached_config(None);
        assert_eq!(state.cached_config(), None);
    }

    #[test]
    fn pool_reports_not_connected_before_set_pool_is_called() {
        let state = AppState::new();
        assert!(matches!(state.pool(), Err(Error::Config(_))));
    }

    // `connect_lazy` não abre socket nenhum, mas o pool nasce com
    // `idle_timeout`/`max_lifetime` padrão (`PoolOptions::new`), e isso faz
    // `PoolInner::new_arc` agendar a tarefa de manutenção via
    // `sqlx::rt::spawn` já na construção — sem um runtime Tokio de pé, esse
    // spawn entra em pânico ("this functionality requires a Tokio context")
    // antes mesmo do teste chegar em `assert!`. `#[tokio::test]` dá esse
    // contexto sem abrir conexão nenhuma com o banco.
    #[tokio::test]
    async fn set_pool_makes_pool_return_it() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://user:pass@localhost/learno_test")
            .unwrap();

        let state = AppState::new();
        state.set_pool(pool);

        assert!(state.pool().is_ok());
    }

    #[test]
    fn sidecar_reports_unavailable_before_set_sidecar_is_called() {
        let state = AppState::new();
        assert!(matches!(state.sidecar(), Err(Error::Sidecar(_))));
    }
}
