//! Backup e restauração manual do banco inteiro (PLT-011), portado de
//! `pg_dump`/`pg_restore` para SQLite em 05/09/2026 (ver
//! `docs/MIGRACAO-SQLITE.md`).
//!
//! O que a porta muda, e por quê importa: um backup deixou de ser um
//! processo externo (`pg_dump`) e virou uma instrução SQL, `VACUUM INTO`.
//! Isso apaga de uma vez o binário que precisava estar no PATH, a senha que
//! precisava viajar por variável de ambiente, o timeout de processo pendurado
//! e o parsing de stderr alheio. Sobra uma cópia lógica completa do banco,
//! escrita pela própria conexão, atômica, e que — diferente de copiar o
//! arquivo com `fs::copy` — nunca sai desatualizada em relação ao que ainda
//! só existe no `-wal`.
//!
//! A restauração é a metade que continua exigindo cuidado, porque substituir
//! o arquivo por baixo de um pool aberto é justamente como se corrompe um
//! banco SQLite. O contrato está em [`run_restore`]: quem chama fecha o pool
//! antes. Em troca, a restauração ganhou o que a versão Postgres não tinha —
//! o arquivo restaurado é verificado ANTES de a substituição acontecer, e o
//! banco atual é copiado para o lado antes de ser sobrescrito.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{ConnectOptions, Connection, SqlitePool};

use crate::error::{Error, Result};

/// Extensão dos arquivos de backup. É um banco SQLite completo e abrível,
/// não um formato de dump proprietário: dá para inspecionar com qualquer
/// ferramenta SQLite sem passar pelo Learno.
const BACKUP_EXTENSION: &str = "sqlite";

/// `learno-backup-<timestamp UTC>.sqlite`. Dois-pontos são deliberadamente
/// ausentes do formato — `HH:MM:SS` é hora ISO-8601 legal e nome de arquivo
/// ilegal no Windows. Os milissegundos não são enfeite: `VACUUM INTO` recusa
/// escrever sobre um arquivo existente, então dois backups no mesmo segundo
/// (o periódico do PLT-013 e o de operação de risco, por exemplo) falhariam
/// com precisão de segundo.
fn backup_file_name(now: DateTime<Utc>) -> String {
    format!("learno-backup-{}.{BACKUP_EXTENSION}", now.format("%Y%m%dT%H%M%S%.3fZ"))
}

/// Caminho do arquivo `-wal`/`-shm` que o SQLite mantém ao lado do arquivo
/// principal em `journal_mode = WAL` — não é extensão (`.wal`), é um sufixo
/// colado ao nome completo do arquivo.
fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut with_suffix = database_path.as_os_str().to_os_string();
    with_suffix.push(suffix);
    PathBuf::from(with_suffix)
}

/// PLT-011: escreve uma cópia consistente do banco atrás de `pool` num
/// arquivo novo e datado sob `output_dir`, criando a pasta se preciso.
///
/// `VACUUM INTO` roda na conexão que o pool já tem aberta, então não existe
/// caso de "o binário não está instalado" nem de "a senha está errada" — os
/// dois modos de falha que dominavam a versão `pg_dump`. O que sobra é erro
/// de disco (sem espaço, sem permissão), e esse chega como `Error::Database`
/// com a mensagem do próprio SQLite.
pub async fn run_backup(pool: &SqlitePool, output_dir: &Path) -> Result<PathBuf> {
    tokio::fs::create_dir_all(output_dir).await?;
    let output_path = output_dir.join(backup_file_name(Utc::now()));

    // `VACUUM INTO` falha se o alvo existir; conferir antes transforma um
    // "SQL logic error" opaco numa mensagem que diz o que aconteceu.
    if output_path.exists() {
        return Err(Error::Invalid(format!(
            "já existe um arquivo de backup em {} — apague-o ou tente de novo",
            output_path.display()
        )));
    }

    sqlx::query("VACUUM INTO ?").bind(output_path.to_string_lossy().as_ref()).execute(pool).await?;
    Ok(output_path)
}

/// Confere que `backup_path` é de fato um banco SQLite íntegro e do Learno,
/// antes que ele possa substituir o banco de verdade de alguém.
///
/// Duas checagens, e as duas importam por motivos diferentes:
///
/// - `PRAGMA integrity_check` lê o banco inteiro e responde exatamente `ok`
///   quando não há página corrompida. Um arquivo truncado por uma cópia
///   interrompida passa por qualquer teste de extensão ou de cabeçalho, e é
///   pego aqui.
/// - a presença de `_sqlx_migrations` separa "um banco SQLite qualquer" de
///   "um banco do Learno". Restaurar o arquivo errado apagaria tudo sem
///   nenhum erro visível: o app abriria vazio, e migrações rodariam sobre um
///   schema desconhecido.
///
/// Abre em modo somente-leitura e sem `create_if_missing`, então um caminho
/// inexistente falha aqui em vez de virar um arquivo vazio recém-criado.
pub async fn validate_backup_file(backup_path: &Path) -> Result<()> {
    if !backup_path.is_file() {
        return Err(Error::Invalid(format!("arquivo de backup não encontrado: {}", backup_path.display())));
    }

    let mut connection: SqliteConnection = SqliteConnectOptions::new()
        .filename(backup_path)
        .create_if_missing(false)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| Error::Invalid(format!("{} não é um banco SQLite legível ({e})", backup_path.display())))?;

    // O erro de "isto não é um banco" não aparece no `connect` acima: o
    // SQLite só lê o cabeçalho do arquivo na primeira instrução de verdade.
    // Por isso a falha desta consulta é traduzida para `Invalid` em vez de
    // vazar como `Database` — para quem escolheu o arquivo errado no seletor,
    // é um problema de escolha, não do banco.
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|e| Error::Invalid(format!("{} não é um banco SQLite legível ({e})", backup_path.display())))?;
    if integrity != "ok" {
        let _ = connection.close().await;
        return Err(Error::Invalid(format!(
            "o arquivo de backup {} está corrompido: {integrity}",
            backup_path.display()
        )));
    }

    let is_learno: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
            .fetch_optional(&mut connection)
            .await?;
    let _ = connection.close().await;

    if is_learno.is_none() {
        return Err(Error::Invalid(format!(
            "{} é um banco SQLite, mas não um backup do Learno (não tem histórico de migração)",
            backup_path.display()
        )));
    }

    Ok(())
}

/// Onde o banco atual é guardado antes de ser sobrescrito por uma
/// restauração. Fica ao lado do próprio banco, e não em `output_dir`, para
/// que a rede de segurança sobreviva mesmo a uma restauração feita a partir
/// de um arquivo em pendrive que some logo depois.
fn pre_restore_copy_path(database_path: &Path, now: DateTime<Utc>) -> PathBuf {
    sidecar_path(database_path, &format!(".antes-da-restauracao-{}", now.format("%Y%m%dT%H%M%S%.3fZ")))
}

/// PLT-011: substitui o banco em `database_path` pelo conteúdo de
/// `backup_path`.
///
/// **Contrato, e é o ponto perigoso deste arquivo:** o pool que aponta para
/// `database_path` precisa estar FECHADO antes desta chamada. Trocar o
/// arquivo por baixo de conexões abertas é o caminho conhecido para
/// corromper um banco SQLite — as conexões seguiriam com páginas em cache e
/// um `-wal` que descreve um arquivo que não existe mais. Quem chama
/// (`ipc::backup_commands::restore_backup`) fecha o pool, chama isto, e só
/// então reconecta.
///
/// Ordem deliberada: valida primeiro, copia o banco atual para o lado
/// depois, sobrescreve por último. Assim uma restauração a partir de um
/// arquivo ruim para antes de tocar em qualquer coisa, e mesmo uma
/// restauração bem-sucedida deixa o estado anterior recuperável em disco.
pub async fn run_restore(database_path: &Path, backup_path: &Path) -> Result<()> {
    validate_backup_file(backup_path).await?;

    if database_path.is_file() {
        std::fs::copy(database_path, pre_restore_copy_path(database_path, Utc::now()))?;
    }

    // Os sidecars pertencem ao banco que está sendo substituído: descrevem
    // páginas de um arquivo que deixa de existir na linha seguinte, e deixá-los
    // para trás arriscaria a próxima conexão reaplicar frames de WAL sobre um
    // banco que já é outro. Ausência de qualquer um dos dois não é erro — é o
    // caso comum quando não houve escrita desde o último checkpoint.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sidecar_path(database_path, suffix));
    }

    std::fs::copy(backup_path, database_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use chrono::TimeZone;
    use sqlx::sqlite::SqlitePoolOptions;

    fn fixed_time() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 2, 14, 30, 5).unwrap()
    }

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-dump-test-{label}-{}", uuid::Uuid::new_v4()))
    }

    /// Um banco SQLite de verdade, com uma tabela e uma linha, para os testes
    /// que precisam de conteúdo a copiar.
    async fn database_with_content(path: &Path, with_migration_history: bool) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(path).create_if_missing(true))
            .await
            .unwrap();
        sqlx::query("CREATE TABLE anotacao (id INTEGER PRIMARY KEY, texto TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO anotacao (texto) VALUES ('mitocôndria')").execute(&pool).await.unwrap();
        if with_migration_history {
            sqlx::query("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN)")
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[test]
    fn backup_file_name_has_no_colon_so_it_is_a_legal_windows_filename() {
        let name = backup_file_name(fixed_time());

        assert!(name.starts_with("learno-backup-20260902T143005"));
        assert!(name.ends_with(".sqlite"));
        assert!(!name.contains(':'));
    }

    /// Milissegundos no nome não são enfeite: `VACUUM INTO` recusa escrever
    /// sobre arquivo existente, então dois backups no mesmo segundo colidiriam
    /// com precisão de segundo.
    #[test]
    fn backup_file_names_differ_within_the_same_second() {
        let base = fixed_time();
        let primeiro = backup_file_name(base + chrono::Duration::milliseconds(10));
        let segundo = backup_file_name(base + chrono::Duration::milliseconds(20));

        assert_ne!(primeiro, segundo);
    }

    #[tokio::test]
    async fn run_backup_writes_a_readable_copy_of_the_data() {
        let db_path = temp_path("origem.sqlite");
        let pool = database_with_content(&db_path, true).await;
        let output_dir = temp_path("saida");

        let backup = run_backup(&pool, &output_dir).await.unwrap();

        assert!(backup.is_file());
        validate_backup_file(&backup).await.unwrap();

        let copia = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&backup).create_if_missing(false))
            .await
            .unwrap();
        let texto: String = sqlx::query_scalar("SELECT texto FROM anotacao").fetch_one(&copia).await.unwrap();
        assert_eq!(texto, "mitocôndria");
    }

    #[tokio::test]
    async fn validate_backup_file_rejects_a_path_that_does_not_exist() {
        let missing = temp_path("nao-existe.sqlite");
        assert!(matches!(validate_backup_file(&missing).await, Err(Error::Invalid(_))));
    }

    /// Um arquivo que não é banco nenhum — o caso "o usuário escolheu o
    /// arquivo errado no seletor" — para antes de qualquer substituição.
    #[tokio::test]
    async fn validate_backup_file_rejects_a_file_that_is_not_a_database() {
        let lixo = temp_path("lixo.sqlite");
        std::fs::write(&lixo, b"isto aqui nao e um banco de dados").unwrap();

        match validate_backup_file(&lixo).await {
            Err(Error::Invalid(_)) => {}
            other => panic!("esperava Err(Error::Invalid(_)), obtido {other:?}"),
        }
    }

    /// Um banco SQLite legítimo, mas de outro programa: restaurá-lo apagaria
    /// tudo sem erro visível. Sem `_sqlx_migrations` não é backup do Learno.
    #[tokio::test]
    async fn validate_backup_file_rejects_a_sqlite_database_that_is_not_learnos() {
        let alheio = temp_path("alheio.sqlite");
        let pool = database_with_content(&alheio, false).await;
        pool.close().await;

        match validate_backup_file(&alheio).await {
            Err(Error::Invalid(message)) => assert!(message.contains("Learno"), "mensagem inesperada: {message}"),
            other => panic!("esperava Err(Error::Invalid(_)), obtido {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_restore_refuses_a_bad_backup_without_touching_the_live_database() {
        let db_path = temp_path("vivo.sqlite");
        let pool = database_with_content(&db_path, true).await;
        pool.close().await;
        let antes = std::fs::read(&db_path).unwrap();

        let lixo = temp_path("lixo2.sqlite");
        std::fs::write(&lixo, b"nao e banco").unwrap();

        assert!(run_restore(&db_path, &lixo).await.is_err());
        assert_eq!(std::fs::read(&db_path).unwrap(), antes, "o banco vivo não pode ter sido tocado");
    }

    #[tokio::test]
    async fn run_restore_replaces_the_database_and_keeps_a_copy_of_what_it_replaced() {
        let db_path = temp_path("alvo.sqlite");
        let pool = database_with_content(&db_path, true).await;
        let backup_dir = temp_path("backups");
        let backup = run_backup(&pool, &backup_dir).await.unwrap();

        sqlx::query("UPDATE anotacao SET texto = 'depois do backup'").execute(&pool).await.unwrap();
        pool.close().await;

        run_restore(&db_path, &backup).await.unwrap();

        let restaurado = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&db_path).create_if_missing(false))
            .await
            .unwrap();
        let texto: String = sqlx::query_scalar("SELECT texto FROM anotacao").fetch_one(&restaurado).await.unwrap();
        assert_eq!(texto, "mitocôndria", "o conteúdo do backup precisa ter substituído o conteúdo novo");

        let vizinhos: Vec<String> = std::fs::read_dir(db_path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("antes-da-restauracao"))
            .collect();
        assert!(!vizinhos.is_empty(), "a restauração precisa deixar uma cópia do que sobrescreveu");
    }
}
