//! Pool de conexão SQLite e bootstrap de migração (PLT-002), portado de Postgres
//! em 05/09/2026 — ver `docs/MIGRACAO-SQLITE.md`.
//!
//! Nada mais no app roda antes disto ter sucesso, então falhas aqui aparecem
//! como um `Error` simples e cabe a quem chama (o assistente de primeira
//! execução, um prompt de nova tentativa) decidir o que o usuário vê.
//!
//! Diferença estrutural em relação à versão Postgres: não existe mais
//! host/porta/usuário/senha nem "banco que talvez não exista no servidor" —
//! o banco É um arquivo, e `create_if_missing` cobre o caso de primeira
//! execução sozinho. O que sobreviveu da versão anterior é a forma do
//! contrato (`connect_and_migrate` / `connect_migrate_with_rollback`) e a
//! ideia do PLT-020 (proteger dados existentes antes de migrar), não a
//! implementação.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

use crate::backup::schedule::ScheduleConfig;
use crate::error::Result;

/// Quantas conexões simultâneas o pool abre. Com `journal_mode = WAL`
/// (ligado abaixo) leitores não bloqueiam o escritor, então mais de uma
/// conexão ainda vale para leituras concorrentes — mas o contrato lembra
/// (armadilha #4) que só existe UM escritor por vez em SQLite; o número
/// aqui não muda isso, só limita quantos leitores esperam na fila do pool.
const MAX_POOL_CONNECTIONS: u32 = 10;

/// Quanto uma conexão espera por um lock antes de devolver "database is
/// locked" em vez de falhar na hora. Sem isso, duas escritas quase
/// simultâneas (autosave de um bloco + recálculo de fórmula, por exemplo)
/// fariam a segunda falhar completamente em vez de só esperar a primeira
/// terminar — e um app local de um usuário só não tem outro jeito de achar
/// essa colisão aceitável.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Nome do arquivo de manifesto do PLT-013 dentro de `backup_dir` — o mesmo
/// usado pelo backup periódico e pelo de operação de risco, para os dois
/// caírem na mesma retenção por `ScheduleManifest::prune`.
const SCHEDULE_MANIFEST_FILE: &str = "schedule-manifest.json";

/// Rótulo gravado em `BackupTrigger::RiskyOperation` para o backup que este
/// módulo tira antes de rodar uma migração sobre um banco já estabelecido —
/// o mesmo rótulo que a versão Postgres usava, para quem lê o manifesto não
/// precisar saber que o mecanismo por trás mudou de `pg_dump` para
/// `VACUUM INTO`.
const SCHEMA_MIGRATION_OPERATION: &str = "schema_migration";

/// Monta as opções de conexão para o arquivo em `database_path`, ligando os
/// três PRAGMAs que `docs/MIGRACAO-SQLITE.md` marca como armadilha:
///
/// - `foreign_keys(true)` — é por conexão e vem DESLIGADO por padrão no
///   SQLite. Sem isso todo `ON DELETE CASCADE` deste schema simplesmente não
///   acontece, sem erro nenhum: apagar uma página deixaria blocos, valores e
///   arestas órfãos. É a armadilha nomeada no pedido desta peça.
/// - `journal_mode(Wal)` — leitura não bloqueia escrita; sem isso a UI
///   travaria enquanto o recálculo de fórmula grava.
/// - `busy_timeout` — uma escrita concorrente espera em vez de falhar.
///
/// `synchronous(Normal)` é o mesmo ajuste usado nas medições de
/// `docs/FASE-3-MEDICOES.md` (seguro com WAL: só perde durabilidade da
/// última transação numa queda de energia do sistema operacional, nunca
/// corrompe o arquivo). `create_if_missing(true)` porque a primeira
/// execução do app não tem arquivo nenhum ainda para conectar.
fn connect_options(database_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(BUSY_TIMEOUT)
}

/// Garante que a pasta que vai conter o arquivo do banco existe.
/// `create_if_missing` do sqlx cria o ARQUIVO, não os diretórios acima dele
/// — numa primeira execução com uma pasta de dados customizada
/// (`config::validate_data_dir`) que ainda não existe, a conexão falharia
/// com "unable to open database file" sem isto.
fn ensure_parent_dir_exists(database_path: &Path) -> Result<()> {
    if let Some(parent) = database_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

/// Abre um pool contra o arquivo em `database_path` (criando-o se não
/// existir) e aplica toda migração pendente sob `migrations/` antes de
/// devolvê-lo, para que quem chame nunca observe um pool cujo schema não
/// está totalmente em dia.
pub async fn connect_and_migrate(database_path: &Path) -> Result<SqlitePool> {
    ensure_parent_dir_exists(database_path)?;

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
        .connect_with(connect_options(database_path))
        .await?;

    sqlx::migrate!().run(&pool).await?;

    Ok(pool)
}

/// Toda migração embutida neste build, em ordem de versão. Compartilhado por
/// [`connect_migrate_with_rollback`] (para saber se uma migração está prestes
/// a rodar sobre dado já existente) e pelos testes abaixo (para saber o que
/// "totalmente migrado" significa sem cravar um número de versão).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// Verdadeiro exatamente no momento do gatilho do PLT-020: este banco já tem
/// histórico de migração (então há algo a perder) E pelo menos uma migração
/// embutida ainda não está nele (então uma migração está de fato prestes a
/// rodar). Um banco novo em folha (sem histórico nenhum) e um já totalmente
/// migrado (com histórico, mas nada pendente) respondem `false` os dois — o
/// primeiro não tem nada que valha proteger, o segundo não tem nada prestes
/// a mudar contra o que um backup defenderia.
///
/// `sqlite_master` é consultado em vez de `to_regclass` (o equivalente
/// Postgres): SQLite não tem catálogo de OID, só a tabela `sqlite_master`
/// listando o que existe por nome — e ela sempre existe, mesmo num arquivo
/// recém-criado, então não precisa de um caso especial "tabela de catálogo
/// não existe ainda" como a versão Postgres precisava.
async fn has_a_pending_migration_against_established_history(pool: &SqlitePool) -> Result<bool> {
    let table_exists: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'")
            .fetch_optional(pool)
            .await?;
    if table_exists.is_none() {
        return Ok(false);
    }

    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success").fetch_all(pool).await?;
    if applied.is_empty() {
        return Ok(false);
    }

    let applied: std::collections::HashSet<i64> = applied.into_iter().collect();
    Ok(MIGRATOR.iter().any(|migration| !applied.contains(&migration.version)))
}

/// Caminho do arquivo `-wal`/`-shm` que o SQLite mantém ao lado do arquivo
/// principal quando `journal_mode = WAL` está ligado — não é extensão
/// (`.wal`), é um sufixo colado ao nome completo do arquivo.
fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut with_suffix = database_path.as_os_str().to_os_string();
    with_suffix.push(suffix);
    PathBuf::from(with_suffix)
}

/// PLT-020, lado SQLite: tira uma cópia consistente do banco em
/// `database_path` para dentro de `backup_dir` usando `VACUUM INTO`, e
/// registra essa cópia no manifesto do PLT-013 — o mesmo choke point que a
/// versão Postgres usava (`ScheduleManifest` + `BackupTrigger::RiskyOperation`),
/// só que sem precisar de `pg_dump`: `VACUUM INTO` é uma instrução SQL só,
/// atômica, executada pela própria conexão, sem processo externo e sem
/// depender do estado do WAL (ela sempre escreve o conteúdo lógico completo
/// do banco, nunca uma cópia de bytes do arquivo que poderia estar
/// desatualizada em relação ao que ainda só existe no `-wal`).
///
/// Passa por `backup::schedule::trigger_risky_operation_backup` — o choke
/// point único do PLT-013 — em vez de montar o `VACUUM INTO` e o registro no
/// manifesto por conta própria. Enquanto aquela função exigia senha de
/// Postgres isso não era possível daqui; depois da migração ela só precisa
/// do pool, que este módulo tem em mãos.
async fn backup_before_migration(pool: &SqlitePool, backup_dir: &Path) -> Result<PathBuf> {
    crate::backup::trigger_risky_operation_backup(
        pool,
        backup_dir,
        &backup_dir.join(SCHEDULE_MANIFEST_FILE),
        &ScheduleConfig::default(),
        SCHEMA_MIGRATION_OPERATION,
    )
    .await
}

/// Restaura `database_path` a partir da cópia em `backup_path`, chamado
/// depois que `pool.close()` já soltou as conexões deste processo.
///
/// Apaga `-wal`/`-shm` antes de copiar por cima do arquivo principal: eles
/// pertencem à tentativa de migração que acabou de falhar, referenciam
/// páginas de um schema que não é mais o que está no arquivo restaurado, e
/// deixá-los para trás arriscaria a próxima conexão tentar reaplicar frames
/// de WAL sobre um banco que já é outro. Ausência de qualquer um dos dois
/// não é erro — é o caso comum quando não houve escrita alguma desde o
/// último checkpoint.
fn restore_from_backup(backup_path: &Path, database_path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sidecar_path(database_path, suffix));
    }
    std::fs::copy(backup_path, database_path)?;
    Ok(())
}

/// PLT-020: como [`connect_and_migrate`], mas ao atualizar um banco que já
/// tem histórico de migração commitado para uma versão com migração
/// pendente, tira uma cópia em `backup_dir` primeiro, e essa cópia é
/// restaurada automaticamente se a migração então falhar — então uma
/// migração quebrada nunca deixa o schema preso pela metade sem caminho de
/// volta ao último estado bom conhecido. Um banco novo em folha, ou um já
/// totalmente migrado, não têm esse momento a proteger, então isto pula
/// direto para `sqlx::migrate!().run()`, igual a [`connect_and_migrate`].
///
/// `backup_dir` guarda só a rede de segurança pré-migração desta função; é
/// uma preocupação separada dos backups voltados ao usuário (PLT-011/013).
pub async fn connect_migrate_with_rollback(database_path: &Path, backup_dir: &Path) -> Result<SqlitePool> {
    ensure_parent_dir_exists(database_path)?;

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
        .connect_with(connect_options(database_path))
        .await?;

    if !has_a_pending_migration_against_established_history(&pool).await? {
        sqlx::migrate!().run(&pool).await?;
        return Ok(pool);
    }

    let backup_path = backup_before_migration(&pool, backup_dir).await?;

    if let Err(migration_error) = sqlx::migrate!().run(&pool).await {
        // Solta as conexões deste pool antes de sobrescrever o arquivo por
        // baixo delas — o mesmo motivo da versão Postgres, adaptado: aqui
        // não é lock de linha de catálogo, é o arquivo em si podendo estar
        // memory-mapped ou com handle aberto no processo.
        pool.close().await;
        restore_from_backup(&backup_path, database_path)?;
        return Err(migration_error.into());
    }

    Ok(pool)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use sqlx::Row;

    use super::*;
    use crate::backup::schedule::{BackupTrigger, ScheduleManifest};

    /// Caminho de arquivo temporário único por teste, para que testes
    /// rodando em paralelo (padrão do `cargo test`) nunca disputem o mesmo
    /// arquivo — substitui o "banco descartável por teste" que a versão
    /// Postgres conseguia com `CREATE DATABASE`/`DROP DATABASE` num cluster
    /// compartilhado. Aqui é só um arquivo no diretório temp do SO, sem
    /// cluster nenhum de pé.
    fn temp_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-pool-test-{label}-{}.sqlite", uuid::Uuid::new_v4()))
    }

    /// Remove o arquivo do banco e os sidecars de WAL que o teste possa ter
    /// deixado para trás — ausência de qualquer um deles não é erro.
    fn cleanup_database_file(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(sidecar_path(path, "-wal"));
        let _ = std::fs::remove_file(sidecar_path(path, "-shm"));
    }

    /// O nome da primeira tabela criada por um script de migração.
    ///
    /// Parser deliberadamente ingênuo: existe só para o teste de rollback
    /// forçar uma colisão sem cravar um nome de tabela que envelhece a cada
    /// migração nova. Reconhece `CREATE TABLE nome` e
    /// `CREATE TABLE IF NOT EXISTS nome`, que é a única forma que as migrações
    /// deste projeto usam, e pula linha de comentário — a `0025` menciona
    /// `CREATE TABLE ... AS SELECT` dentro de um comentário, e um parser que
    /// varresse o texto corrido pararia lá.
    fn primeira_tabela_criada(sql: &str) -> Option<String> {
        for linha in sql.lines() {
            let linha = linha.trim();
            if linha.starts_with("--") {
                continue;
            }
            let Some(posicao) = linha.find("CREATE TABLE ") else {
                continue;
            };
            let resto = linha[posicao + "CREATE TABLE ".len()..].trim_start();
            let resto = resto.strip_prefix("IF NOT EXISTS ").unwrap_or(resto).trim_start();
            let nome: String = resto.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if !nome.is_empty() {
                return Some(nome);
            }
        }
        None
    }

    #[test]
    fn migrations_are_embedded_and_strictly_ordered() {
        let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();

        assert!(!versions.is_empty(), "esperava pelo menos uma migração sob migrations/");

        // Conta os arquivos em disco em vez de cravar um número.
        //
        // O número cravado (era 21) obrigava a editar este teste a cada
        // migração nova, e o que ele de fato protege não é a quantidade — é
        // que NENHUM arquivo de `migrations/` fique de fora do binário. Uma
        // migração que existe no repositório mas não foi embutida aplica na
        // máquina de quem roda `sqlite3` à mão e não aplica no app, que é a
        // divergência mais difícil de enxergar deste projeto.
        //
        // Arquivo vazio conta: a `0015` virou um comentário só na porta para
        // SQLite (o FTS5 de 0004 já nasce acento-insensível), mas continua
        // existindo para preservar a numeração 1:1 com o histórico Postgres —
        // e o `sqlx` conta arquivos, não instruções.
        let em_disco = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
            .expect("a pasta migrations/ precisa existir ao lado do Cargo.toml")
            .filter_map(|entrada| entrada.ok())
            .filter(|entrada| entrada.path().extension().is_some_and(|ext| ext == "sql"))
            .count();
        assert_eq!(
            versions.len(),
            em_disco,
            "há {em_disco} arquivos .sql em migrations/ mas {} foram embutidos no binário",
            versions.len()
        );
        assert!(
            versions.windows(2).all(|pair| pair[0] < pair[1]),
            "versões de migração precisam ser estritamente crescentes, obtido {versions:?}"
        );
    }

    #[test]
    fn foundational_tables_have_a_migration() {
        let descriptions: Vec<String> = MIGRATOR.iter().map(|migration| migration.description.to_string()).collect();

        // sqlx deriva a descrição do nome do arquivo (troca `_` por espaço):
        // `0003_pages.sql` -> "pages".
        for expected in ["pages", "page versions", "blocks"] {
            assert!(
                descriptions.iter().any(|d| d.contains(expected)),
                "esperava uma migração cobrindo `{expected}`, obtido {descriptions:?}"
            );
        }
    }

    /// Prova o essencial do PLT-002 no alvo novo: as 21 migrações aplicam em
    /// sequência sobre um arquivo vazio e o schema resultante é consultável
    /// de ponta a ponta (não só "sqlx disse que aplicou" — insere e lê de
    /// volta em três tabelas que vieram de migrações bem distantes uma da
    /// outra: `pages` é a 0003, `database_record_values` é a 0009).
    #[tokio::test]
    async fn as_21_migracoes_aplicam_em_sequencia_sobre_um_arquivo_vazio() {
        let db_path = temp_database_path("schema");
        let pool = connect_and_migrate(&db_path).await.unwrap();

        let applied_versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        let expected_versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
        assert_eq!(applied_versions, expected_versions, "toda migração embutida precisa constar como aplicada");

        let page_id = "11111111-1111-1111-1111-111111111111";
        sqlx::query("INSERT INTO pages (id, title, position, created_at, updated_at) VALUES (?, 'Título', 'a0', ?, ?)")
            .bind(page_id)
            .bind("2026-09-05T10:00:00.000Z")
            .bind("2026-09-05T10:00:00.000Z")
            .execute(&pool)
            .await
            .unwrap();

        let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = ?")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(title, "Título");

        pool.close().await;
        cleanup_database_file(&db_path);
    }

    /// A armadilha nomeada no pedido desta peça: sem `PRAGMA foreign_keys =
    /// ON`, todo `ON DELETE CASCADE` do schema simplesmente não acontece,
    /// sem erro nenhum. Este teste prova a CASCATA de verdade — insere
    /// página, bloco e valor de propriedade, apaga a página, e conta que os
    /// filhos sumiram — não a configuração (`PRAGMA foreign_keys` lido de
    /// volta provaria só que o pragma foi aceito, não que uma FK real
    /// respeita `ON DELETE CASCADE` com ele ligado). Se `connect_options`
    /// perder o `.foreign_keys(true)`, é este teste que quebra, e quebra
    /// contando linha, não lendo configuração.
    #[tokio::test]
    async fn apagar_uma_pagina_apaga_blocos_e_valores_filhos_em_cascata() {
        let db_path = temp_database_path("cascade");
        let pool = connect_and_migrate(&db_path).await.unwrap();

        let page_id = "22222222-2222-2222-2222-222222222222";
        let block_id = "33333333-3333-3333-3333-333333333333";
        let now = "2026-09-05T10:00:00.000Z";

        sqlx::query("INSERT INTO pages (id, title, position, created_at, updated_at) VALUES (?, 'Página', 'a0', ?, ?)")
            .bind(page_id)
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, page_id, parent_block_id, block_type, content, position, created_at, updated_at) \
             VALUES (?, ?, NULL, 'paragraph', '{}', 'a0', ?, ?)",
        )
        .bind(block_id)
        .bind(page_id)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        // `databases` + `database_properties` + `database_record_values`
        // são a cadeia mais longa de FK em cascata do schema
        // (page -> database -> property -> record value), e é justamente a
        // que a armadilha do contrato descreve como a que fica órfã em
        // silêncio: página, bloco e valor, todos filhos (diretos ou
        // indiretos) de `pages.id`.
        let database_id = "44444444-4444-4444-4444-444444444444";
        let property_id = "55555555-5555-5555-5555-555555555555";
        sqlx::query("INSERT INTO databases (id, container_page_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(database_id)
            .bind(page_id)
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO database_properties (id, database_id, name, property_type, config, position, created_at, updated_at) \
             VALUES (?, ?, 'Status', 'select', '{}', 'a0', ?, ?)",
        )
        .bind(property_id)
        .bind(database_id)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            // Sem `created_at`: esta tabela guarda só `updated_at` — o valor de
            // uma propriedade não tem história própria, quem a tem é o
            // registro.
            "INSERT INTO database_record_values (record_id, property_id, value, updated_at) \
             VALUES (?, ?, '\"Feito\"', ?)",
        )
        .bind(page_id)
        .bind(property_id)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM pages WHERE id = ?").bind(page_id).execute(&pool).await.unwrap();

        let remaining_blocks: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE page_id = ?").bind(page_id).fetch_one(&pool).await.unwrap();
        assert_eq!(remaining_blocks, 0, "bloco filho deveria ter sido apagado em cascata com a página");

        let remaining_values: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM database_record_values WHERE record_id = ?")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining_values, 0, "valor de propriedade deveria ter sido apagado em cascata com a página que é o registro");

        pool.close().await;
        cleanup_database_file(&db_path);
    }

    #[tokio::test]
    async fn has_a_pending_migration_against_established_history_e_falso_num_banco_novo() {
        let db_path = temp_database_path("pending-fresh");
        let pool = connect_and_migrate(&db_path).await.unwrap();

        assert!(!has_a_pending_migration_against_established_history(&pool).await.unwrap());

        pool.close().await;
        cleanup_database_file(&db_path);
    }

    #[tokio::test]
    async fn has_a_pending_migration_against_established_history_e_verdadeiro_apos_apagar_a_ultima_migracao_aplicada() {
        let db_path = temp_database_path("pending-stale");
        let pool = connect_and_migrate(&db_path).await.unwrap();

        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
            .execute(&pool)
            .await
            .unwrap();

        assert!(has_a_pending_migration_against_established_history(&pool).await.unwrap());

        pool.close().await;
        cleanup_database_file(&db_path);
    }

    /// PLT-020 de ponta a ponta no alvo SQLite: um banco com histórico
    /// estabelecido, uma migração forçada a falhar (o mesmo truque da versão
    /// Postgres — apagar o registro da última migração faz o sqlx tentar
    /// reaplicá-la sobre objetos que já existem, e falhar de verdade), e a
    /// prova de que o arquivo volta a ser exatamente o banco funcional de
    /// antes, não um estado corrompido pela metade.
    #[tokio::test]
    async fn migracao_que_falha_e_revertida_para_o_backup_pre_migracao() {
        let db_path = temp_database_path("rollback");
        let backup_dir = std::env::temp_dir().join(format!("learno-pool-backup-{}", uuid::Uuid::new_v4()));

        let pool = connect_and_migrate(&db_path).await.unwrap();
        let page_id = "66666666-6666-6666-6666-666666666666";
        let now = "2026-09-05T10:00:00.000Z";
        sqlx::query("INSERT INTO pages (id, title, position, created_at, updated_at) VALUES (?, 'Sobrevive', 'a0', ?, ?)")
            .bind(page_id)
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();

        // Apagar o registro da última migração faz o `sqlx` querer reaplicá-la
        // — é assim que este teste cria uma migração pendente e, com ela, o
        // backup pré-migração que ele quer provar.
        //
        // A FALHA em si depende de a reaplicação COLIDIR, e este teste já
        // quebrou três vezes por depender do formato da última migração:
        //
        //  1. a versão original contava com a colisão acontecer sozinha
        //     (`CREATE TABLE` sobre tabela existente) — e a `0025` reconstrói
        //     tabelas, então reaplicá-la simplesmente funcionava;
        //  2. a correção pré-criava a primeira tabela da migração — e no caso
        //     NORMAL essa tabela já existe, então o próprio setup morria com
        //     "table já existe";
        //  3. a correção seguinte usou `IF NOT EXISTS` — e a `0032` é um
        //     `ALTER TABLE ADD COLUMN`, que não cria tabela NENHUMA, então a
        //     busca devolvia nada e o `expect` derrubava o teste.
        //
        // A premissa errada nas três foi a mesma: supor uma FORMA para a
        // última migração. A maioria não é reaplicável por natureza — `CREATE
        // TABLE` colide com a tabela, `ADD COLUMN` colide com a coluna. Então
        // o teste passa a TENTAR ajudar a colisão quando reconhece o formato,
        // e a confiar na não-idempotência natural quando não reconhece.
        //
        // Se um dia a última migração for de fato reaplicável, a asserção
        // adiante falha com a mensagem dizendo exatamente isso — que é o
        // comportamento certo: significa que este teste precisa de atenção, e
        // não que o rollback quebrou.
        let ultima = MIGRATOR.iter().last().expect("esperava pelo menos uma migração embutida");
        if let Some(colidente) = primeira_tabela_criada(&ultima.sql) {
            sqlx::query(&format!("CREATE TABLE IF NOT EXISTS {colidente} (colisao_proposital INTEGER)"))
                .execute(&pool)
                .await
                .unwrap();
        }

        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let result = connect_migrate_with_rollback(&db_path, &backup_dir).await;
        assert!(
            result.is_err(),
            "reaplicar a última migração precisava falhar, e não falhou — ou seja, ela é reaplicável \
             (idempotente). Isto NÃO significa que o rollback quebrou: significa que este teste \
             perdeu o jeito de forçar a falha. Force-a de outro modo (pré-criar um objeto que ela \
             cria, por exemplo) em vez de afrouxar a asserção."
        );

        assert!(backup_dir.exists(), "um banco com migração commitada precisa ser copiado antes de migrar");
        let manifest = ScheduleManifest::new(backup_dir.join(SCHEDULE_MANIFEST_FILE));
        let records = manifest.load().unwrap();
        assert_eq!(records.len(), 1, "esperava exatamente um backup pré-migração registrado");
        assert!(
            matches!(&records[0].trigger, BackupTrigger::RiskyOperation { operation } if operation == SCHEMA_MIGRATION_OPERATION)
        );

        // A prova real do PLT-020: o arquivo restaurado ainda é o banco
        // funcional de antes da tentativa — abre, consulta e devolve a linha
        // que estava lá.
        //
        // Abre sem migrar de propósito. O estado que este teste restaurou é,
        // por construção, o estado de ANTES da migração que falhou: o registro
        // da última migração continua apagado, então `connect_and_migrate`
        // tentaria reaplicá-la e falharia de novo, exatamente como falhou
        // acima. Isso é o comportamento certo — o rollback devolve o banco ao
        // ponto anterior, não conserta a migração quebrada que o levou até
        // ali — e chamar `connect_and_migrate` aqui estaria testando outra
        // coisa.
        let recovered = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(connect_options(&db_path))
            .await
            .unwrap();
        let title: String =
            sqlx::query_scalar("SELECT title FROM pages WHERE id = ?").bind(page_id).fetch_one(&recovered).await.unwrap();
        assert_eq!(title, "Sobrevive");
        assert!(
            has_a_pending_migration_against_established_history(&recovered).await.unwrap(),
            "o arquivo restaurado precisa ser o estado de antes da tentativa, migração pendente inclusive"
        );
        recovered.close().await;

        cleanup_database_file(&db_path);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// `VACUUM INTO` grava um arquivo SQLite completo e independente — não
    /// um dump de outro formato — então uma linha de sanidade sobre o
    /// arquivo de backup em si (não só "existe") prova que o mecanismo de
    /// verdade funciona, não só que um arquivo com aquele nome apareceu.
    #[tokio::test]
    async fn o_arquivo_de_backup_e_um_banco_sqlite_valido_por_si_so() {
        let db_path = temp_database_path("backup-valid");
        let backup_dir = std::env::temp_dir().join(format!("learno-pool-backup-valid-{}", uuid::Uuid::new_v4()));

        let pool = connect_and_migrate(&db_path).await.unwrap();
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
            .execute(&pool)
            .await
            .unwrap();

        let backup_path = backup_before_migration(&pool, &backup_dir).await.unwrap();
        pool.close().await;

        let backup_pool = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&backup_path).read_only(true))
            .await
            .unwrap();
        let row = sqlx::query("SELECT COUNT(*) AS n FROM _sqlx_migrations").fetch_one(&backup_pool).await.unwrap();
        let count: i64 = row.get("n");
        assert!(count > 0, "o backup precisa conter o histórico de migração já aplicado até aquele ponto");
        backup_pool.close().await;

        cleanup_database_file(&db_path);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }
}
