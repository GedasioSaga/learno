#![allow(clippy::unwrap_used, clippy::expect_used)]
// Cada `tests/*.rs` compila este módulo como um crate separado e usa só uma
// parte dele (`EmptyDatabase` só serve a `backup_dump.rs`, `path` só é lido
// por quem precisa do arquivo em si) — nada disso é código morto de verdade,
// só código não usado do ponto de vista de um binário específico.
#![allow(dead_code)]
//! Compartilhado por todo arquivo de teste de integração deste crate: cada
//! teste provisiona seu próprio banco descartável, invisível para os
//! demais.
//!
//! O que a migração para SQLite mudou aqui, e é a mudança mais importante
//! desta pasta: não existe mais `LEARNO_TEST_DATABASE_URL`, nem cluster
//! Postgres para criar banco em cima, nem `#[ignore]`. Um banco é um
//! arquivo em pasta temporária, então todo teste de banco deste crate roda
//! num `cargo test` limpo, em qualquer máquina, sem preparação nenhuma.
//! Antes, "roda" dependia de alguém ter subido o cluster e exportado a
//! variável — e o resultado prático era que quase nunca rodavam.
//!
//! `tests/support/mod.rs` (e não `tests/support.rs`) é deliberado: só
//! arquivos diretamente dentro de `tests/` viram binário de `cargo test`,
//! então este nunca é confundido com uma suíte (vazia) própria — cada
//! arquivo que o quer o puxa com `mod support;`.

use std::path::PathBuf;

use sqlx::SqlitePool;
use uuid::Uuid;

/// `learno-<rótulo>-<uuid>.sqlite` numa pasta temporária. O rótulo só existe
/// para deixar legível qual teste deixou um arquivo para trás quando algum
/// deles morre no meio.
fn fresh_database_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("learno-{label}-{}.sqlite", Uuid::new_v4().simple()))
}

/// Apaga o arquivo do banco e os sidecars que o WAL deixa ao lado. Ausência
/// de qualquer um dos três não é erro: `-wal`/`-shm` só existem quando houve
/// escrita desde o último checkpoint.
fn remove_database_files(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut with_suffix = path.clone().into_os_string();
        with_suffix.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(with_suffix));
    }
}

/// Um banco privado e totalmente migrado que nada fora do teste que o segura
/// enxerga — a forma que todo teste `db_*.rs` quer.
pub struct IsolatedDatabase {
    pub pool: SqlitePool,
    /// O arquivo deste banco. Necessário para os testes que precisam falar
    /// do banco como arquivo (`backup_dump.rs` restaurando por cima dele),
    /// e não só através do pool.
    pub path: PathBuf,
}

impl IsolatedDatabase {
    pub async fn setup(label: &str) -> Self {
        let path = fresh_database_path(label);
        let pool = learno_lib::db::connect_and_migrate(&path)
            .await
            .expect("falhou ao conectar/migrar o banco de teste isolado");

        Self { pool, path }
    }

    /// Não é um `Drop`: fechar o pool é `async` e `Drop` não roda `async`,
    /// então cada teste chama isto explicitamente ao terminar. Fechar antes
    /// de apagar importa no Windows, onde um arquivo com handle aberto não
    /// pode ser removido.
    pub async fn teardown(self) {
        self.pool.close().await;
        remove_database_files(&self.path);
    }
}

/// Um caminho de banco que ainda não existe — o alvo de restauração de
/// `backup_dump.rs`. Não é migrado de propósito: a restauração copia o
/// arquivo inteiro por cima, histórico de migração incluído, então
/// pré-migrar só criaria um arquivo para ser imediatamente substituído.
pub struct EmptyDatabase {
    pub path: PathBuf,
}

impl EmptyDatabase {
    pub fn create(label: &str) -> Self {
        Self { path: fresh_database_path(label) }
    }

    pub fn teardown(self) {
        remove_database_files(&self.path);
    }
}
