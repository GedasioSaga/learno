#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration test para o backfill da migração `0037_livro_titulo_autor_ordem.sql`
//! — precisa de acesso ao `Migrator` de tempo de execução (não o embutido por
//! macro que `support::IsolatedDatabase` usa), então não cabe nos testes
//! `#[cfg(test)]` de `db::biblioteca`. Mesma técnica de
//! `tests/db_pages.rs::banco_migrado_ate_antes_de_0034`/`statements_da_migracao`
//! — duplicada aqui em vez de promovida para `tests/support/mod.rs` por um
//! segundo uso só; ver o comentário de aquela função para o porquê do
//! `Migrator::new` de disco em vez do embutido.

mod support;

use std::path::PathBuf;

use learno_lib::db::{BibliotecaRepository, IdBind};
use uuid::Uuid;

fn statements_da_migracao(sql: &str) -> Vec<String> {
    let sem_comentarios: String =
        sql.lines().filter(|linha| !linha.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");

    sem_comentarios.split(';').map(str::trim).filter(|statement| !statement.is_empty()).map(str::to_string).collect()
}

/// Um banco migrado só até IMEDIATAMENTE ANTES de
/// `0037_livro_titulo_autor_ordem.sql` — para o teste abaixo inserir livro
/// "como uma versão anterior do app já teria gravado" (sem `position`, que
/// 0037 é quem introduz) e só então aplicar 0037 sozinha por cima.
async fn banco_migrado_ate_antes_de_0037(label: &str) -> (sqlx::SqlitePool, PathBuf, PathBuf, PathBuf) {
    let db_path = std::env::temp_dir().join(format!("learno-{label}-{}.sqlite", Uuid::new_v4().simple()));
    let migrations_reais = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let migrations_truncadas =
        std::env::temp_dir().join(format!("learno-migrations-sem-0037-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&migrations_truncadas).unwrap();

    for entrada in std::fs::read_dir(&migrations_reais).unwrap() {
        let entrada = entrada.unwrap();
        let nome = entrada.file_name();
        if nome.to_string_lossy().starts_with("0037_") {
            continue;
        }
        std::fs::copy(entrada.path(), migrations_truncadas.join(&nome)).unwrap();
    }

    let opcoes = sqlx::sqlite::SqliteConnectOptions::new().filename(&db_path).create_if_missing(true).foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().connect_with(opcoes).await.unwrap();

    let migrator = sqlx::migrate::Migrator::new(migrations_truncadas.clone()).await.unwrap();
    migrator.run(&pool).await.unwrap();

    (pool, db_path, migrations_truncadas, migrations_reais)
}

async fn cria_pagina(pool: &sqlx::SqlitePool, titulo: &str, position: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, $2, $3)")
        .bind(id.db())
        .bind(titulo)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    id
}

/// Uma linha de `library_books` EXATAMENTE como uma versão do app anterior a
/// 0037 gravaria — sem `position` na lista de colunas, porque a coluna nem
/// existe neste banco ainda (só depois que o teste aplicar 0037).
async fn cria_livro_legado(pool: &sqlx::SqlitePool, page_id: Uuid, rotulo: &str, created_at: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO library_books \
             (id, page_id, format, content_hash, file_name, original_file_name, file_size, created_at, updated_at) \
         VALUES ($1, $2, 'pdf', $3, $4, $4, 10, $5, $5)",
    )
    .bind(id.db())
    .bind(page_id.db())
    .bind(rotulo.repeat(64))
    .bind(format!("{rotulo}.pdf"))
    .bind(created_at)
    .execute(pool)
    .await
    .unwrap();
    id
}

/// O CASO CENTRAL do pedido desta peça: a migração rodando sobre um banco que
/// JÁ TEM livros importados. Três livros "legados" — a ordem de HOJE
/// (`created_at DESC`, a que `list_shelf` usava antes de 0037) precisa
/// sobreviver ao backfill, e duas leituras seguidas de `list_shelf` (agora em
/// ordem de `position`) precisam devolver a MESMA ordem.
#[tokio::test]
async fn migracao_0037_atribui_position_a_livros_que_ja_existiam_e_preserva_a_ordem_de_hoje() {
    let (pool, db_path, migrations_truncadas, migrations_reais) =
        banco_migrado_ate_antes_de_0037("migracao-0037").await;

    // B é o mais ANTIGO, A o do meio, C o mais RECENTE — a ordem de hoje
    // (`created_at DESC`) que a migração precisa preservar é C, A, B.
    let pagina_a = cria_pagina(&pool, "Percy Jackson 1", "a0").await;
    let pagina_b = cria_pagina(&pool, "Percy Jackson 2", "a1").await;
    let pagina_c = cria_pagina(&pool, "Percy Jackson 3", "a2").await;
    let livro_b = cria_livro_legado(&pool, pagina_b, "b", "2024-01-01T00:00:00.000Z").await;
    let livro_a = cria_livro_legado(&pool, pagina_a, "a", "2024-06-01T00:00:00.000Z").await;
    let livro_c = cria_livro_legado(&pool, pagina_c, "c", "2024-12-01T00:00:00.000Z").await;
    for book_id in [livro_a, livro_b, livro_c] {
        sqlx::query("INSERT INTO library_reading_progress (book_id) VALUES ($1)")
            .bind(book_id.db())
            .execute(&pool)
            .await
            .unwrap();
    }

    // Aplica 0037 sozinha, lendo o MESMO arquivo que roda em produção.
    let sql_0037 =
        std::fs::read_to_string(migrations_reais.join("0037_livro_titulo_autor_ordem.sql")).unwrap();
    for statement in statements_da_migracao(&sql_0037) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }

    // Toda linha ganhou uma posição de verdade — nenhuma ficou com o
    // placeholder `''` do `DEFAULT` do `ALTER TABLE`.
    let posicoes: Vec<String> =
        sqlx::query_scalar("SELECT position FROM library_books ORDER BY position").fetch_all(&pool).await.unwrap();
    assert_eq!(posicoes.len(), 3);
    assert!(posicoes.iter().all(|p| !p.is_empty()), "nenhuma posição pode ter sobrado como o placeholder vazio");

    // A ordem crua, direto da tabela: C, A, B — a mesma que `created_at DESC`
    // já dava antes desta migração.
    let ids_crus: Vec<String> =
        sqlx::query_scalar("SELECT id FROM library_books ORDER BY position").fetch_all(&pool).await.unwrap();
    assert_eq!(
        ids_crus,
        vec![livro_c.hyphenated().to_string(), livro_a.hyphenated().to_string(), livro_b.hyphenated().to_string()],
        "o backfill precisa preservar a ordem de hoje (mais recente primeiro)"
    );

    // E através do repositório de verdade, duas vezes seguidas: a mesma
    // ordem nas duas leituras — a posição é dado persistido, não recalculada.
    let repo = BibliotecaRepository::new(pool.clone());
    let primeira: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
    let segunda: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
    assert_eq!(primeira, vec![livro_c, livro_a, livro_b]);
    assert_eq!(primeira, segunda, "duas leituras de list_shelf precisam devolver a mesma ordem");

    pool.close().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_dir_all(&migrations_truncadas);
}
