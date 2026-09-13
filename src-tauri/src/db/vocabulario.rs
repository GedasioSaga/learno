//! Repositório do vocabulário novo — `library_vocabulary`
//! (`0033_biblioteca_categoria_capitulo_vocabulario.sql`, seção C).
//!
//! DECISÃO sobre a mesma palavra coletada duas vezes no mesmo livro com
//! caixa/acento diferentes ("mitocôndria" vs. "Mitocôndria"): RECUSAR, não
//! atualizar a existente. Dois motivos, um do lado do banco e um do lado do
//! produto:
//!
//! 1. A migração já modela a checagem como um gatilho `BEFORE INSERT`/
//!    `BEFORE UPDATE OF term` com `RAISE(ABORT, 'library_vocabulary.term
//!    duplicado neste livro (ignorando caixa e acento)')` — não como
//!    `ON CONFLICT DO UPDATE`, ao contrário do resumo por capítulo
//!    (`db::resumo_capitulo`). Essa diferença não é acidental: a comparação
//!    usa `MATCH` de frase acento-insensível contra um índice FTS5 auxiliar,
//!    e SQL declarativo não expressa "ignorando acento" numa `UNIQUE` — só um
//!    gatilho consegue. Não há para QUE linha fazer upsert sem primeiro
//!    REFAZER essa mesma busca FTS5 em Rust, duplicando o mecanismo que o
//!    gatilho já implementa.
//! 2. Mesmo que fosse simples, upsert seria a escolha errada aqui: a segunda
//!    coleta da mesma palavra provavelmente chega com um trecho de contexto e
//!    uma nota diferentes da primeira, e decidir sozinho qual versão vence
//!    apagaria a outra em silêncio. `coletar` deixa a violação do gatilho
//!    subir como `Error::Database` — cuja mensagem já é a mensagem útil do
//!    `RAISE(ABORT, ...)` — para o chamador decidir: editar a entrada
//!    existente (`atualizar_nota_da_palavra`) ou desistir da nova coleta.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::error::{Error, Result};

/// Nenhum destes tetos vem da migração; existem porque `coletar_palavra` é
/// comando de IPC, alcançável por script na WebView — mesma postura de
/// `db::biblioteca`/`db::resumo_capitulo`.
const MAX_TERM_CHARS: usize = 500;
const MAX_CONTEXT_CHARS: usize = 20_000;
const MAX_NOTE_CHARS: usize = 20_000;
const MAX_LOCATOR_CHARS: usize = 2_000;

const VOCABULARY_COLUMNS: &str = "id, book_id, term, context_snippet, note, locator, created_at, updated_at";

/// Uma palavra nova colhida durante a leitura — `library_vocabulary`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PalavraColetada {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub book_id: Uuid,
    pub term: String,
    pub context_snippet: Option<String>,
    pub note: Option<String>,
    pub locator: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct VocabularioRepository {
    pool: SqlitePool,
}

impl VocabularioRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `coletar_palavra`. `book_id` inexistente vira `Error::Database` da FK
    /// (mesma escolha de `BibliotecaRepository::create_annotation`); termo
    /// duplicado no mesmo livro (ignorando caixa/acento) vira `Error::Database`
    /// do gatilho — ver o comentário do módulo para o porquê de não traduzir
    /// nem fazer upsert por cima disso.
    pub async fn coletar(
        &self,
        book_id: Uuid,
        term: &str,
        context_snippet: Option<&str>,
        note: Option<&str>,
        locator: Option<&str>,
    ) -> Result<PalavraColetada> {
        validate_term(term)?;
        validate_optional_text_len("trecho_de_contexto", context_snippet, MAX_CONTEXT_CHARS)?;
        validate_optional_text_len("nota", note, MAX_NOTE_CHARS)?;
        validate_optional_text_len("locator", locator, MAX_LOCATOR_CHARS)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, PalavraColetada>(&format!(
            "INSERT INTO library_vocabulary (id, book_id, term, context_snippet, note, locator) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING {VOCABULARY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(book_id.db())
        .bind(term)
        .bind(context_snippet)
        .bind(note)
        .bind(locator)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_palavras_do_livro`. Mais recém-coletada primeiro.
    pub async fn listar_do_livro(&self, book_id: Uuid) -> Result<Vec<PalavraColetada>> {
        let rows = sqlx::query_as::<_, PalavraColetada>(&format!(
            "SELECT {VOCABULARY_COLUMNS} FROM library_vocabulary WHERE book_id = $1 ORDER BY created_at DESC"
        ))
        .bind(book_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// `listar_palavras`: a lista geral, de todos os livros, para revisar
    /// vocabulário. `termo_busca` filtra por substring de `term`, sem
    /// diferenciar caixa (via `lower()` dos dois lados) — um filtro simples de
    /// tela de revisão, deliberadamente MAIS simples que a checagem
    /// acento-insensível do gatilho de duplicata: aquela existe para achar a
    /// palavra EXATA (uma decisão de integridade de dado), esta é busca livre
    /// de usuário, e reusar o índice FTS5 aqui misturaria os dois propósitos
    /// sem necessidade. `None` ou string em branco (após `trim`) lista tudo.
    pub async fn listar(&self, termo_busca: Option<&str>) -> Result<Vec<PalavraColetada>> {
        let filtro = termo_busca.map(str::trim).filter(|termo| !termo.is_empty());

        let rows = match filtro {
            Some(termo) => {
                sqlx::query_as::<_, PalavraColetada>(&format!(
                    "SELECT {VOCABULARY_COLUMNS} FROM library_vocabulary \
                     WHERE lower(term) LIKE '%' || lower($1) || '%' ESCAPE '\\' \
                     ORDER BY created_at DESC"
                ))
                .bind(escape_like(termo))
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query_as::<_, PalavraColetada>(&format!(
                    "SELECT {VOCABULARY_COLUMNS} FROM library_vocabulary ORDER BY created_at DESC"
                ))
                .fetch_all(&self.pool)
                .await?
            }
        };

        Ok(rows)
    }

    /// `atualizar_nota_da_palavra`. Só a nota muda — `term`/`context_snippet`/
    /// `locator` são o registro congelado do momento da coleta (mesmo
    /// raciocínio de `library_annotations.excerpt`, ver a migração 0022); a
    /// nota é o único campo que o usuário deveria revisitar depois.
    pub async fn atualizar_nota(&self, id: Uuid, note: Option<&str>) -> Result<PalavraColetada> {
        validate_optional_text_len("nota", note, MAX_NOTE_CHARS)?;

        let row = sqlx::query_as::<_, PalavraColetada>(&format!(
            "UPDATE library_vocabulary SET note = $2 WHERE id = $1 RETURNING {VOCABULARY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(note)
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("palavra coletada {id}")))
    }

    /// `remover_palavra`.
    pub async fn remover(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM library_vocabulary WHERE id = $1").bind(id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("palavra coletada {id}")));
        }
        Ok(())
    }
}

fn validate_term(term: &str) -> Result<()> {
    if term.trim().is_empty() {
        return Err(Error::Invalid("termo não pode ser vazio".into()));
    }
    if term.len() > MAX_TERM_CHARS {
        return Err(Error::Invalid(format!("termo não pode passar de {MAX_TERM_CHARS} caracteres (recebido: {})", term.len())));
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

/// Escapa `%`/`_`/o próprio caractere de escape dentro de um padrão `LIKE`
/// vindo de busca de usuário — sem isso, buscar por `"100%"` casaria com
/// qualquer termo, e `_` casaria com qualquer caractere único.
fn escape_like(input: &str) -> String {
    input.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
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
        std::env::temp_dir().join(format!("learno-vocabulario-test-{rotulo}-{}", Uuid::new_v4()))
    }

    async fn banco_temporario(rotulo: &str) -> (SqlitePool, PathBuf) {
        let data_dir = pasta_temporaria(rotulo);
        let db_path = data_dir.join("learno.sqlite");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        (pool, data_dir)
    }

    async fn livro_de_teste(pool: &SqlitePool, data_dir: &std::path::Path, nome: &str) -> Uuid {
        let media_dir = data_dir.join("media");
        std::fs::create_dir_all(data_dir).unwrap();
        let origem = data_dir.join(nome);
        std::fs::write(&origem, format!("conteudo de {nome}").as_bytes()).unwrap();

        let biblioteca = BibliotecaRepository::new(pool.clone());
        biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro.id
    }

    #[tokio::test]
    async fn coletar_palavra_creates_a_row() {
        let (pool, data_dir) = banco_temporario("cria").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let palavra = repo.coletar(book_id, "mitocôndria", Some("a mitocôndria é a usina da célula"), Some("lembrar de revisar"), Some("42")).await.unwrap();

        assert_eq!(palavra.book_id, book_id);
        assert_eq!(palavra.term, "mitocôndria");
        assert_eq!(palavra.context_snippet.as_deref(), Some("a mitocôndria é a usina da célula"));
        assert_eq!(palavra.note.as_deref(), Some("lembrar de revisar"));
        assert_eq!(palavra.locator.as_deref(), Some("42"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn coletar_palavra_rejects_a_blank_term() {
        let (pool, data_dir) = banco_temporario("termo-vazio").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let vazio = repo.coletar(book_id, "", None, None, None).await;
        assert!(matches!(vazio, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {vazio:?}");

        let so_espaco = repo.coletar(book_id, "   ", None, None, None).await;
        assert!(matches!(so_espaco, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {so_espaco:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn coletar_palavra_rejects_an_unknown_book() {
        let (pool, data_dir) = banco_temporario("livro-inexistente").await;
        let repo = VocabularioRepository::new(pool.clone());

        let result = repo.coletar(Uuid::now_v7(), "palavra", None, None, None).await;
        assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL da decisão documentada no topo do módulo: a mesma
    /// palavra colhida duas vezes no mesmo livro, com caixa diferente, é
    /// RECUSADA — não vira uma segunda linha, nem substitui a primeira.
    #[tokio::test]
    async fn collecting_the_same_word_twice_with_different_case_is_rejected_not_merged() {
        let (pool, data_dir) = banco_temporario("duplicado-caixa").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        repo.coletar(book_id, "mitocôndria", None, None, None).await.unwrap();
        let segunda = repo.coletar(book_id, "Mitocôndria", Some("contexto diferente"), None, None).await;

        assert!(matches!(segunda, Err(Error::Database(_))), "esperava Error::Database (gatilho de duplicata), obtido {segunda:?}");
        let mensagem = format!("{}", segunda.unwrap_err());
        assert!(mensagem.contains("duplicado"), "mensagem devia explicar a duplicata, obtido: {mensagem}");

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_vocabulary").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 1, "a segunda coleta não pode ter criado nem substituído nada");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A mesma palavra em DOIS livros diferentes não é duplicata — a
    /// checagem do gatilho é por livro (ver o comentário da migração).
    #[tokio::test]
    async fn the_same_word_in_two_different_books_is_not_a_duplicate() {
        let (pool, data_dir) = banco_temporario("dois-livros").await;
        let livro_a = livro_de_teste(&pool, &data_dir, "Livro A.pdf").await;
        let livro_b = livro_de_teste(&pool, &data_dir, "Livro B.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        repo.coletar(livro_a, "mitocôndria", None, None, None).await.unwrap();
        let no_livro_b = repo.coletar(livro_b, "mitocôndria", None, None, None).await;

        assert!(no_livro_b.is_ok(), "a mesma palavra em outro livro precisa ser aceita, obtido {no_livro_b:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_do_livro_only_returns_words_from_that_book() {
        let (pool, data_dir) = banco_temporario("listar-do-livro").await;
        let livro_a = livro_de_teste(&pool, &data_dir, "Livro A.pdf").await;
        let livro_b = livro_de_teste(&pool, &data_dir, "Livro B.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        repo.coletar(livro_a, "alfa", None, None, None).await.unwrap();
        repo.coletar(livro_b, "beta", None, None, None).await.unwrap();

        let lista = repo.listar_do_livro(livro_a).await.unwrap();
        assert_eq!(lista.len(), 1);
        assert_eq!(lista[0].term, "alfa");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_without_a_search_term_returns_words_from_every_book() {
        let (pool, data_dir) = banco_temporario("listar-geral").await;
        let livro_a = livro_de_teste(&pool, &data_dir, "Livro A.pdf").await;
        let livro_b = livro_de_teste(&pool, &data_dir, "Livro B.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        repo.coletar(livro_a, "alfa", None, None, None).await.unwrap();
        repo.coletar(livro_b, "beta", None, None, None).await.unwrap();

        let lista = repo.listar(None).await.unwrap();
        assert_eq!(lista.len(), 2);

        let lista_espaco = repo.listar(Some("   ")).await.unwrap();
        assert_eq!(lista_espaco.len(), 2, "termo_busca só espaço precisa se comportar como None");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_with_a_search_term_filters_case_insensitively_by_substring() {
        let (pool, data_dir) = banco_temporario("listar-filtro").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        repo.coletar(book_id, "mitocôndria", None, None, None).await.unwrap();
        repo.coletar(book_id, "ribossomo", None, None, None).await.unwrap();

        let filtrada = repo.listar(Some("MITO")).await.unwrap();
        assert_eq!(filtrada.len(), 1);
        assert_eq!(filtrada[0].term, "mitocôndria");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn atualizar_nota_da_palavra_changes_only_the_note() {
        let (pool, data_dir) = banco_temporario("atualizar-nota").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let palavra = repo.coletar(book_id, "mitocôndria", Some("contexto original"), None, None).await.unwrap();
        let atualizada = repo.atualizar_nota(palavra.id, Some("agora com nota")).await.unwrap();

        assert_eq!(atualizada.note.as_deref(), Some("agora com nota"));
        assert_eq!(atualizada.term, "mitocôndria", "não pedido na atualização, continua igual");
        assert_eq!(atualizada.context_snippet.as_deref(), Some("contexto original"), "não pedido na atualização, continua igual");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn atualizar_nota_da_palavra_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("atualizar-inexistente").await;
        let repo = VocabularioRepository::new(pool.clone());

        let result = repo.atualizar_nota(Uuid::now_v7(), Some("nota")).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn remover_deletes_and_a_second_removal_reports_not_found() {
        let (pool, data_dir) = banco_temporario("remover").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let palavra = repo.coletar(book_id, "mitocôndria", None, None, None).await.unwrap();
        repo.remover(palavra.id).await.unwrap();

        let segunda = repo.remover(palavra.id).await;
        assert!(matches!(segunda, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
