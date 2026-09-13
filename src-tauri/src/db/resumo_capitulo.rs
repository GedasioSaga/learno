//! Repositório do resumo por capítulo — `library_chapter_notes`
//! (`0033_biblioteca_categoria_capitulo_vocabulario.sql`, seção B).
//!
//! Um resumo por capítulo: a chave natural é `(book_id, chapter_locator)`, e
//! a migração já declara essa `UNIQUE` com o comentário explícito de que o
//! caminho de escrita é `INSERT ... ON CONFLICT DO UPDATE` — salvar de novo
//! no mesmo capítulo SUBSTITUI o resumo anterior, nunca duplica nem falha.
//! [`ResumoCapituloRepository::salvar`] é exatamente esse upsert.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::error::{Error, Result};

/// Nenhum destes tetos vem da migração (que não limita comprimento de TEXT);
/// existem porque `salvar_resumo_de_capitulo` é comando de IPC, alcançável
/// por script na WebView — entrada hostil por padrão, mesma postura de
/// `db::biblioteca`.
const MAX_LOCATOR_CHARS: usize = 2_000;
const MAX_CHAPTER_TITLE_CHARS: usize = 500;
const MAX_SUMMARY_CHARS: usize = 50_000;

const CHAPTER_NOTE_COLUMNS: &str = "id, book_id, chapter_locator, chapter_title, summary, created_at, updated_at";

/// Um resumo por capítulo — `library_chapter_notes`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumoDeCapitulo {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub book_id: Uuid,
    pub chapter_locator: String,
    pub chapter_title: Option<String>,
    pub summary: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct ResumoCapituloRepository {
    pool: SqlitePool,
}

impl ResumoCapituloRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `salvar_resumo_de_capitulo`. Upsert por `(book_id, chapter_locator)` —
    /// ver o comentário do módulo. O `id` gerado aqui só vale na primeira vez:
    /// numa atualização, `ON CONFLICT` mantém o `id` da linha existente (não
    /// está no `DO UPDATE SET`), então o chamador que salvou o mesmo capítulo
    /// duas vezes recebe o MESMO id nas duas respostas — é o que prova que
    /// não houve duplicação, e não só que o conteúdo bateu por acaso.
    ///
    /// `book_id` que não existe surge como `Error::Database` da própria FK,
    /// mesma escolha que `BibliotecaRepository::create_annotation` já faz
    /// para `book_id` — sem pré-checagem redundante aqui.
    pub async fn salvar(
        &self,
        book_id: Uuid,
        chapter_locator: &str,
        chapter_title: Option<&str>,
        summary: &str,
    ) -> Result<ResumoDeCapitulo> {
        validate_chapter_locator(chapter_locator)?;
        validate_optional_text_len("chapter_title", chapter_title, MAX_CHAPTER_TITLE_CHARS)?;
        validate_summary(summary)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, ResumoDeCapitulo>(&format!(
            "INSERT INTO library_chapter_notes (id, book_id, chapter_locator, chapter_title, summary) \
                 VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (book_id, chapter_locator) DO UPDATE SET \
                 chapter_title = excluded.chapter_title, \
                 summary = excluded.summary \
             RETURNING {CHAPTER_NOTE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(book_id.db())
        .bind(chapter_locator)
        .bind(chapter_title)
        .bind(summary)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_resumos_do_livro`. Mais recém-atualizado primeiro — a
    /// atualização de um resumo já existente (via `salvar`) é o sinal de que
    /// o usuário voltou a mexer nele, e essa é a ordem mais útil de revisão.
    pub async fn listar_do_livro(&self, book_id: Uuid) -> Result<Vec<ResumoDeCapitulo>> {
        let rows = sqlx::query_as::<_, ResumoDeCapitulo>(&format!(
            "SELECT {CHAPTER_NOTE_COLUMNS} FROM library_chapter_notes WHERE book_id = $1 ORDER BY updated_at DESC"
        ))
        .bind(book_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// `remover_resumo_de_capitulo`.
    pub async fn remover(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM library_chapter_notes WHERE id = $1").bind(id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("resumo de capítulo {id}")));
        }
        Ok(())
    }
}

fn validate_chapter_locator(chapter_locator: &str) -> Result<()> {
    if chapter_locator.trim().is_empty() {
        return Err(Error::Invalid("chapter_locator não pode ser vazio".into()));
    }
    if chapter_locator.len() > MAX_LOCATOR_CHARS {
        return Err(Error::Invalid(format!(
            "chapter_locator não pode passar de {MAX_LOCATOR_CHARS} caracteres (recebido: {})",
            chapter_locator.len()
        )));
    }
    Ok(())
}

/// Um resumo em branco não é um resumo — recusado aqui, em vez de deixar o
/// `CHECK (length(trim(summary)) > 0)` da migração recusar mais longe, para a
/// mensagem de erro nomear o campo certo (`resumo`, o nome do parâmetro de
/// IPC) em vez de vazar o nome da coluna SQL.
fn validate_summary(summary: &str) -> Result<()> {
    if summary.trim().is_empty() {
        return Err(Error::Invalid("resumo não pode ser vazio".into()));
    }
    if summary.len() > MAX_SUMMARY_CHARS {
        return Err(Error::Invalid(format!(
            "resumo não pode passar de {MAX_SUMMARY_CHARS} caracteres (recebido: {})",
            summary.len()
        )));
    }
    Ok(())
}

fn validate_optional_text_len(label: &str, value: Option<&str>, max: usize) -> Result<()> {
    if let Some(value) = value {
        if value.len() > max {
            return Err(Error::Invalid(format!("{label} não pode passar de {max} caracteres (recebido: {})", value.len())));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;
    use crate::db::biblioteca::BibliotecaRepository;
    use crate::db::pool::connect_and_migrate;

    fn pasta_temporaria(rotulo: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-resumo-capitulo-test-{rotulo}-{}", Uuid::new_v4()))
    }

    async fn banco_temporario(rotulo: &str) -> (SqlitePool, PathBuf) {
        let data_dir = pasta_temporaria(rotulo);
        let db_path = data_dir.join("learno.sqlite");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        (pool, data_dir)
    }

    /// Um livro de verdade, para o `book_id` das linhas de resumo apontarem
    /// para uma FK válida — a mesma peça que `db::biblioteca` já usa para
    /// montar seus próprios testes de tabela filha.
    async fn livro_de_teste(pool: &SqlitePool, data_dir: &std::path::Path) -> Uuid {
        let media_dir = data_dir.join("media");
        std::fs::create_dir_all(data_dir).unwrap();
        let origem = data_dir.join("Livro de Teste.pdf");
        std::fs::write(&origem, b"conteudo de teste").unwrap();

        let biblioteca = BibliotecaRepository::new(pool.clone());
        biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro.id
    }

    #[tokio::test]
    async fn salvar_resumo_de_capitulo_creates_a_row() {
        let (pool, data_dir) = banco_temporario("cria").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let resumo = repo.salvar(book_id, "text/cap01.xhtml", Some("Capítulo 1"), "O herói parte de casa.").await.unwrap();

        assert_eq!(resumo.book_id, book_id);
        assert_eq!(resumo.chapter_locator, "text/cap01.xhtml");
        assert_eq!(resumo.chapter_title.as_deref(), Some("Capítulo 1"));
        assert_eq!(resumo.summary, "O herói parte de casa.");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL do contrato: salvar de novo no MESMO capítulo
    /// SUBSTITUI, não duplica nem falha.
    #[tokio::test]
    async fn saving_the_same_chapter_twice_replaces_instead_of_duplicating() {
        let (pool, data_dir) = banco_temporario("substitui").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let primeiro = repo.salvar(book_id, "12", None, "Rascunho inicial.").await.unwrap();
        let segundo = repo.salvar(book_id, "12", Some("Capítulo Doze"), "Versão final do resumo.").await.unwrap();

        assert_eq!(primeiro.id, segundo.id, "salvar de novo no mesmo capítulo precisa manter o MESMO id");
        assert_eq!(segundo.summary, "Versão final do resumo.");
        assert_eq!(segundo.chapter_title.as_deref(), Some("Capítulo Doze"));

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_chapter_notes").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 1, "não pode ter criado uma segunda linha para o mesmo capítulo");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn salvar_resumo_de_capitulo_rejects_a_blank_summary() {
        let (pool, data_dir) = banco_temporario("resumo-vazio").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let result = repo.salvar(book_id, "12", None, "   ").await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn salvar_resumo_de_capitulo_rejects_an_unknown_book() {
        let (pool, data_dir) = banco_temporario("livro-inexistente").await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let result = repo.salvar(Uuid::now_v7(), "12", None, "Resumo qualquer.").await;
        assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_do_livro_orders_most_recently_updated_first() {
        let (pool, data_dir) = banco_temporario("listar").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        repo.salvar(book_id, "1", None, "Primeiro capítulo.").await.unwrap();
        repo.salvar(book_id, "2", None, "Segundo capítulo.").await.unwrap();
        // Reatualiza o primeiro — ele precisa vir na frente agora.
        repo.salvar(book_id, "1", None, "Primeiro capítulo, revisado.").await.unwrap();

        let lista = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lista.len(), 2);
        assert_eq!(lista[0].chapter_locator, "1");
        assert_eq!(lista[0].summary, "Primeiro capítulo, revisado.");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_do_livro_on_a_book_without_summaries_returns_empty_without_panicking() {
        let (pool, data_dir) = banco_temporario("sem-resumo").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let lista = repo.listar_do_livro(book_id).await.unwrap();
        assert!(lista.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn remover_deletes_and_a_second_removal_reports_not_found() {
        let (pool, data_dir) = banco_temporario("remover").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = ResumoCapituloRepository::new(pool.clone());

        let resumo = repo.salvar(book_id, "1", None, "Um resumo qualquer.").await.unwrap();
        repo.remover(resumo.id).await.unwrap();

        let segunda = repo.remover(resumo.id).await;
        assert!(matches!(segunda, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
