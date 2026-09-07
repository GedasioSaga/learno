//! Estado que sobrevive entre chamadas de comando, injetado no app via
//! `tauri::Builder::manage`.

use std::sync::RwLock;

use sqlx::SqlitePool;

use crate::config::AppConfig;
use crate::error::{Error, Result};
use crate::sidecar::SidecarProcess;

/// Estado compartilhado do app.
///
/// `pool` fica `None` até `ipc::commands::open_workspace` preencher com o
/// resultado de `db::connect_migrate_with_rollback` — uma vez por abertura do
/// app, e de novo se o usuário trocar de pasta de trabalho ou restaurar um
/// backup. Este arquivo só guarda o slot; os comandos de página em
/// `ipc::commands` já leem daqui via `pool()`.
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
/// se reabre sozinho depois de fechado.
pub struct AppState {
    config_cache: RwLock<Option<AppConfig>>,
    pool: RwLock<Option<SqlitePool>>,
    sidecar: RwLock<Option<SidecarProcess>>,
    open_workspace_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            config_cache: RwLock::new(None),
            pool: RwLock::new(None),
            sidecar: RwLock::new(None),
            open_workspace_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Segura o direito de abrir a pasta de trabalho — só uma abertura por
    /// vez, no processo inteiro.
    ///
    /// Não é zelo teórico: `React.StrictMode` monta cada efeito DUAS vezes em
    /// desenvolvimento, então `App.tsx` chama `open_workspace` duas vezes
    /// quase ao mesmo tempo, e as duas chamadas abriam o mesmo arquivo em
    /// paralelo. Contra um banco novo isso faz as duas rodarem `migrate()`
    /// juntas e a perdedora falhar com `table mindmaps already exists`; contra
    /// um banco existente, `database is locked`. Os dois erros foram
    /// observados na suíte e2e, na tela de "Não deu para abrir o banco de
    /// dados".
    ///
    /// É `tokio::sync::Mutex` (e não o `std`) porque quem o segura atravessa
    /// um `await` — conectar e migrar — e um mutex síncrono bloquearia a
    /// thread do runtime inteira nesse meio-tempo.
    pub async fn lock_workspace_open(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.open_workspace_lock.lock().await
    }

    /// A conexão ativa com o banco, ou `Error::Config` quando o app ainda não
    /// abriu a pasta de trabalho — ver o comentário da struct acima.
    /// `SqlitePool::clone` é barato: é só um handle para o mesmo pool de
    /// conexões.
    pub fn pool(&self) -> Result<SqlitePool> {
        self.pool
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .ok_or_else(|| Error::Config("banco de dados ainda não conectado".into()))
    }

    /// Chamado por `ipc::commands::open_workspace`, depois que a conexão é
    /// aberta e migrada com sucesso.
    pub fn set_pool(&self, pool: SqlitePool) {
        if let Ok(mut guard) = self.pool.write() {
            *guard = Some(pool);
        }
    }

    /// Tira o pool do slot e devolve para quem chamou, deixando o app sem
    /// conexão até alguém chamar `set_pool` de novo.
    ///
    /// Existe por causa de um detalhe do SQLite que não tinha equivalente em
    /// Postgres: restaurar um backup significa trocar o ARQUIVO do banco, e
    /// fazer isso com conexões abertas em cima dele é o caminho conhecido
    /// para corrompê-lo. Devolver o pool (em vez de só limpar o slot) obriga
    /// quem chama a fechá-lo de verdade — `SqlitePool::close` é `async`, e um
    /// pool meramente derrubado não garante que os handles do sistema
    /// operacional já foram soltos.
    pub fn take_pool(&self) -> Option<SqlitePool> {
        self.pool.write().ok().and_then(|mut guard| guard.take())
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

    /// Registra qual pasta de trabalho está aberta. Só quem de fato abre uma
    /// chama isto — hoje, `ipc::commands::open_workspace_and_wire_state`.
    ///
    /// Recebe `AppConfig`, não `Option<AppConfig>`, e a diferença é a correção
    /// de uma classe inteira de bug, não estilo. Enquanto aceitava `Option`,
    /// "esquecer a pasta de trabalho" era uma operação que qualquer chamador
    /// podia fazer sem querer — e foi exatamente o que aconteceu:
    /// `get_app_config` passava adiante o que o store devolvia, e o store
    /// devolve `None` em toda instalação que nunca escolheu pasta à mão. Com
    /// isso, a tela de Configurações (montada no boot dentro do `<dialog>`
    /// fechado de `App.tsx`) apagava a pasta aberta, e TODO comando que passa
    /// por `ipc::backup_commands::require_config` — importar/abrir/excluir
    /// livro, restaurar backup — falhava com "nenhuma conexão configurada"
    /// pelo resto da sessão.
    ///
    /// Agora o cache só pode ser preenchido ou substituído, nunca esvaziado.
    /// O único estado em que `cached_config()` é `None` é o inicial, antes da
    /// primeira abertura de pasta — e aí `pool()` também falha, com a
    /// mensagem certa ("banco de dados ainda não conectado"), em vez de o app
    /// ficar num meio-termo com banco aberto e configuração ausente.
    pub fn set_cached_config(&self, config: AppConfig) {
        if let Ok(mut guard) = self.config_cache.write() {
            *guard = Some(config);
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
        AppConfig::new(r"C:\Users\alguem\Learno")
    }

    #[test]
    fn starts_with_no_cached_config() {
        let state = AppState::new();
        assert_eq!(state.cached_config(), None);
    }

    #[test]
    fn round_trips_a_cached_config() {
        let state = AppState::new();
        state.set_cached_config(sample_config());
        assert_eq!(state.cached_config(), Some(sample_config()));
    }

    /// O teste que substituiu `can_clear_the_cache_back_to_none`: esvaziar o
    /// cache deixou de ser possível de propósito (ver `set_cached_config`).
    /// Trocar de pasta continua sendo — é o que `save_data_dir` faz.
    #[test]
    fn a_second_open_replaces_the_cached_config_instead_of_clearing_it() {
        let state = AppState::new();
        state.set_cached_config(sample_config());
        state.set_cached_config(AppConfig::new(r"D:\Estudos"));
        assert_eq!(state.cached_config(), Some(AppConfig::new(r"D:\Estudos")));
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
        let pool = sqlx::sqlite::SqlitePoolOptions::new().connect_lazy("sqlite::memory:").unwrap();

        let state = AppState::new();
        state.set_pool(pool);

        assert!(state.pool().is_ok());
    }

    /// O contrato que `restore_backup` depende: depois de tirar o pool, o
    /// app fica sem conexão — e é justamente por isso que a troca do arquivo
    /// pode acontecer com segurança.
    #[tokio::test]
    async fn take_pool_hands_it_over_and_leaves_the_slot_empty() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().connect_lazy("sqlite::memory:").unwrap();

        let state = AppState::new();
        state.set_pool(pool);

        assert!(state.take_pool().is_some());
        assert!(matches!(state.pool(), Err(Error::Config(_))));
        assert!(state.take_pool().is_none(), "tirar de novo não pode ressuscitar um pool");
    }

    #[test]
    fn sidecar_reports_unavailable_before_set_sidecar_is_called() {
        let state = AppState::new();
        assert!(matches!(state.sidecar(), Err(Error::Sidecar(_))));
    }
}
