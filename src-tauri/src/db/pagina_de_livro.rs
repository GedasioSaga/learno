//! Repositório das páginas de anotação que o usuário cria dentro de um livro
//! — `library_book_pages` (`0038_paginas_de_anotacao_do_livro.sql`).
//!
//! Substituem, na tela lateral do leitor, a lista automática de capítulos do
//! sumário (`db::resumo_capitulo`, que continua existindo intacta — ver o
//! cabeçalho da migração para o porquê de não migrar aquela tabela). Aqui o
//! usuário escolhe o título, escreve o conteúdo quando quiser (a página nasce
//! vazia) e decide a ORDEM — por isso `position` é índice fracionário
//! (`db::position`), reordenado por [`PaginaDeLivroRepository::mover`] sem
//! nunca renumerar as vizinhas.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

/// Nenhum destes tetos vem da migração (que não limita comprimento de TEXT);
/// existem porque todo comando aqui é IPC, alcançável por script na WebView —
/// mesma postura de `db::resumo_capitulo`/`db::vocabulario`.
///
/// `MAX_CONTENT_CHARS` é bem maior que o teto do resumo por capítulo
/// (50.000): uma página de anotação do usuário pode acumular o equivalente a
/// um capítulo inteiro de nota manuscrita, não um resumo de parágrafo — 200.000
/// caracteres é ~40 páginas de texto corrido, uma folga generosa acima de
/// qualquer nota real, e ainda assim um teto (contra um comando de IPC
/// hostil tentando gravar uma string sem fim).
const MAX_TITLE_CHARS: usize = 500;
const MAX_CONTENT_CHARS: usize = 200_000;

const BOOK_PAGE_COLUMNS: &str = "id, book_id, title, content, position, created_at, updated_at";

/// Uma página de anotação do usuário dentro de um livro — `library_book_pages`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginaDeLivro {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub book_id: Uuid,
    pub title: String,
    pub content: String,
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct PaginaDeLivroRepository {
    pool: SqlitePool,
}

impl PaginaDeLivroRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `criar_pagina_de_livro`. Nasce no FIM da lista do livro (mesmo
    /// raciocínio de `CronogramaRepository::criar_bloco` -> `next_position_in_day`)
    /// e com `content` vazio — o usuário escreve depois.
    ///
    /// `book_id` que não existe surge como `Error::Database` da própria FK,
    /// mesma escolha que `ResumoCapituloRepository::salvar`/`VocabularioRepository::coletar`
    /// já fazem — sem pré-checagem redundante aqui.
    pub async fn criar(&self, book_id: Uuid, title: &str) -> Result<PaginaDeLivro> {
        validate_title(title)?;

        let new_position = next_position_for_book(&self.pool, book_id).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, PaginaDeLivro>(&format!(
            "INSERT INTO library_book_pages (id, book_id, title, position) \
             VALUES ($1, $2, $3, $4) RETURNING {BOOK_PAGE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(book_id.db())
        .bind(title)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_paginas_do_livro`, na ordem do usuário.
    pub async fn listar_do_livro(&self, book_id: Uuid) -> Result<Vec<PaginaDeLivro>> {
        let rows = sqlx::query_as::<_, PaginaDeLivro>(&format!(
            "SELECT {BOOK_PAGE_COLUMNS} FROM library_book_pages WHERE book_id = $1 ORDER BY position"
        ))
        .bind(book_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// `renomear_pagina_de_livro`.
    pub async fn renomear(&self, id: Uuid, title: &str) -> Result<PaginaDeLivro> {
        validate_title(title)?;

        let row = sqlx::query_as::<_, PaginaDeLivro>(&format!(
            "UPDATE library_book_pages SET title = $2 WHERE id = $1 RETURNING {BOOK_PAGE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(title)
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("página de livro {id}")))
    }

    /// `escrever_conteudo_da_pagina`. Sobrescreve o texto inteiro — a mesma
    /// escolha de `ResumoCapituloRepository::salvar` para `summary`, só que
    /// aqui vazio é um valor válido de chegada, não recusado.
    pub async fn escrever_conteudo(&self, id: Uuid, content: &str) -> Result<PaginaDeLivro> {
        validate_content(content)?;

        let row = sqlx::query_as::<_, PaginaDeLivro>(&format!(
            "UPDATE library_book_pages SET content = $2 WHERE id = $1 RETURNING {BOOK_PAGE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(content)
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("página de livro {id}")))
    }

    /// `mover_pagina_de_livro`. Mesmo par vizinho-antes/vizinho-depois +
    /// índice fracionário de `CronogramaRepository::mover_bloco`/`BlockRepository::move_block`
    /// — `apos_pagina_id = None` significa "primeira do livro". O livro de
    /// destino nunca muda (diferente de `mover_bloco`, que troca de dia): não
    /// existe caso de produto para "mover esta página de anotação para outro
    /// livro", então `book_id` nem entra como parâmetro — vem da própria
    /// página encontrada por `pagina_id`.
    ///
    /// `apos_pagina_id` igual à própria `pagina_id` cai no mesmo caminho de
    /// "referência desconhecida": a lista de irmãos exclui a página que está
    /// sendo movida (ver `siblings_in_book_tx`), então ela nunca é encontrada
    /// como sua própria vizinha, e a operação falha em vez de embaralhar a
    /// ordem das demais — mesmo comportamento observável de
    /// `BlockRepository::move_block` para o mesmo caso.
    pub async fn mover(&self, pagina_id: Uuid, apos_pagina_id: Option<Uuid>) -> Result<PaginaDeLivro> {
        let mut tx = self.pool.begin().await?;

        // Confirma que a página existe antes de tocar em qualquer coisa — um
        // `mover` de id desconhecido vira `NotFound`, não a confusão de um
        // `UPDATE` de zero linhas.
        let current = fetch_pagina_tx(&mut tx, pagina_id).await?;

        let siblings = siblings_in_book_tx(&mut tx, current.book_id, Some(pagina_id)).await?;
        let new_position = position_between(&siblings, apos_pagina_id)?;

        let row = sqlx::query_as::<_, PaginaDeLivro>(&format!(
            "UPDATE library_book_pages SET position = $2 WHERE id = $1 RETURNING {BOOK_PAGE_COLUMNS}"
        ))
        .bind(pagina_id.db())
        .bind(&new_position)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(row)
    }

    /// `remover_pagina_de_livro`. Só a página — `ON DELETE CASCADE` é de
    /// `library_books` para cá, nunca desta tabela para `library_annotations`
    /// (as duas não têm FK entre si; ver a migração).
    pub async fn remover(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM library_book_pages WHERE id = $1").bind(id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("página de livro {id}")));
        }
        Ok(())
    }
}

fn validate_title(title: &str) -> Result<()> {
    if title.trim().is_empty() {
        return Err(Error::Invalid("título não pode ser vazio".into()));
    }
    if title.len() > MAX_TITLE_CHARS {
        return Err(Error::Invalid(format!("título não pode passar de {MAX_TITLE_CHARS} caracteres (recebido: {})", title.len())));
    }
    Ok(())
}

/// Vazio é aceito de propósito — ver o comentário de `content` na migração e
/// de `escrever_conteudo` acima.
fn validate_content(content: &str) -> Result<()> {
    if content.len() > MAX_CONTENT_CHARS {
        return Err(Error::Invalid(format!(
            "conteúdo não pode passar de {MAX_CONTENT_CHARS} caracteres (recebido: {})",
            content.len()
        )));
    }
    Ok(())
}

async fn next_position_for_book(pool: &SqlitePool, book_id: Uuid) -> Result<String> {
    let last: Option<String> =
        sqlx::query_scalar("SELECT position FROM library_book_pages WHERE book_id = $1 ORDER BY position DESC LIMIT 1")
            .bind(book_id.db())
            .fetch_optional(pool)
            .await?;

    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

async fn fetch_pagina_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<PaginaDeLivro> {
    sqlx::query_as::<_, PaginaDeLivro>(&format!("SELECT {BOOK_PAGE_COLUMNS} FROM library_book_pages WHERE id = $1"))
        .bind(id.db())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("página de livro {id}")))
}

/// Leitura escalar de par (id, position): `DbId` no lugar de `Uuid`,
/// convertido de volta ao devolver — mesmo desenho de
/// `db::cronograma::siblings_in_day_tx`/`db::blocks::active_siblings_tx`.
async fn siblings_in_book_tx(
    tx: &mut Transaction<'_, Sqlite>,
    book_id: Uuid,
    exclude_id: Option<Uuid>,
) -> Result<Vec<(Uuid, String)>> {
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM library_book_pages \
         WHERE book_id = $1 AND id IS DISTINCT FROM $2 ORDER BY position",
    )
    .bind(book_id.db())
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

/// Mesmo par `neighbours_for`/`position_between` de `db::blocks`/`db::cronograma`,
/// reescrito aqui porque aquelas funções são privadas aos módulos delas — ver
/// o comentário equivalente em `db::cronograma::neighbours_for` para o porquê
/// de não compartilhar em vez de reescrever.
fn neighbours_for(siblings: &[(Uuid, String)], apos_pagina_id: Option<Uuid>) -> Result<(Option<&str>, Option<&str>)> {
    match apos_pagina_id {
        None => Ok((None, siblings.first().map(|(_, p)| p.as_str()))),
        Some(after_id) => {
            let index = siblings
                .iter()
                .position(|(id, _)| *id == after_id)
                .ok_or_else(|| Error::Invalid("página de referência não é irmã ativa neste livro".into()))?;
            let before = siblings[index].1.as_str();
            let after = siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after))
        }
    }
}

fn position_between(siblings: &[(Uuid, String)], apos_pagina_id: Option<Uuid>) -> Result<String> {
    let (before_raw, after_raw) = neighbours_for(siblings, apos_pagina_id)?;
    let before = before_raw.map(position::parse).transpose()?;
    let after = after_raw.map(position::parse).transpose()?;
    position::between(before.as_ref(), after.as_ref())
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
        std::env::temp_dir().join(format!("learno-pagina-de-livro-test-{rotulo}-{}", Uuid::new_v4()))
    }

    async fn banco_temporario(rotulo: &str) -> (SqlitePool, PathBuf) {
        let data_dir = pasta_temporaria(rotulo);
        let db_path = data_dir.join("learno.sqlite");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        (pool, data_dir)
    }

    /// Um livro de verdade, para o `book_id` das páginas apontarem para uma FK
    /// válida — a mesma peça que `db::resumo_capitulo`/`db::vocabulario` usam
    /// para montar seus próprios testes de tabela filha.
    async fn livro_de_teste(pool: &SqlitePool, data_dir: &std::path::Path) -> Uuid {
        let media_dir = data_dir.join("media");
        std::fs::create_dir_all(data_dir).unwrap();
        let origem = data_dir.join("Livro de Teste.pdf");
        std::fs::write(&origem, b"conteudo de teste").unwrap();

        let biblioteca = BibliotecaRepository::new(pool.clone());
        biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro.id
    }

    #[tokio::test]
    async fn criar_pagina_de_livro_creates_a_row_with_empty_content() {
        let (pool, data_dir) = banco_temporario("cria").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let pagina = repo.criar(book_id, "Minhas anotações do capítulo 1").await.unwrap();

        assert_eq!(pagina.book_id, book_id);
        assert_eq!(pagina.title, "Minhas anotações do capítulo 1");
        // O CASO CENTRAL que diferencia esta tabela de `library_chapter_notes`:
        // a página nasce com conteúdo vazio, e isso é válido.
        assert_eq!(pagina.content, "");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn criar_pagina_de_livro_rejects_a_blank_title() {
        let (pool, data_dir) = banco_temporario("titulo-vazio").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let vazio = repo.criar(book_id, "").await;
        assert!(matches!(vazio, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {vazio:?}");

        let so_espaco = repo.criar(book_id, "   ").await;
        assert!(matches!(so_espaco, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {so_espaco:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn criar_pagina_de_livro_rejects_an_unknown_book() {
        let (pool, data_dir) = banco_temporario("livro-inexistente").await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let result = repo.criar(Uuid::now_v7(), "Título qualquer").await;
        assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A borda escolhida para o teto de conteúdo: exatamente `MAX_CONTENT_CHARS`
    /// é aceito, um caractere a mais é recusado.
    #[tokio::test]
    async fn escrever_conteudo_accepts_the_maximum_and_rejects_one_char_over_it() {
        let (pool, data_dir) = banco_temporario("conteudo-teto").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());
        let pagina = repo.criar(book_id, "Página grande").await.unwrap();

        let no_limite = "a".repeat(MAX_CONTENT_CHARS);
        let atualizada = repo.escrever_conteudo(pagina.id, &no_limite).await.unwrap();
        assert_eq!(atualizada.content.len(), MAX_CONTENT_CHARS);

        let acima_do_limite = "a".repeat(MAX_CONTENT_CHARS + 1);
        let result = repo.escrever_conteudo(pagina.id, &acima_do_limite).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn renomear_pagina_de_livro_of_an_unknown_id_reports_not_found() {
        let (pool, data_dir) = banco_temporario("renomear-inexistente").await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let result = repo.renomear(Uuid::now_v7(), "Novo título").await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn escrever_conteudo_da_pagina_of_an_unknown_id_reports_not_found() {
        let (pool, data_dir) = banco_temporario("escrever-inexistente").await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let result = repo.escrever_conteudo(Uuid::now_v7(), "texto").await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_pagina_de_livro_of_an_unknown_id_reports_not_found() {
        let (pool, data_dir) = banco_temporario("mover-inexistente").await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let result = repo.mover(Uuid::now_v7(), None).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn remover_pagina_de_livro_of_an_unknown_id_reports_not_found() {
        let (pool, data_dir) = banco_temporario("remover-inexistente").await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let result = repo.remover(Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn reordering_three_pages_reads_back_in_the_exact_order() {
        let (pool, data_dir) = banco_temporario("reordenar-tres").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        repo.criar(book_id, "A").await.unwrap();
        let b = repo.criar(book_id, "B").await.unwrap();
        let c = repo.criar(book_id, "C").await.unwrap();
        // Ordem de criação: A, B, C.

        // Move C para o início.
        repo.mover(c.id, None).await.unwrap();
        let lista = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lista.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["C", "A", "B"]);

        // Move A para depois de C (troca C, A, B -> C, A, B — já está lá; agora
        // move B para depois de C: C, B, A).
        repo.mover(b.id, Some(c.id)).await.unwrap();
        let lista_final = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lista_final.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["C", "B", "A"]);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL de `mover`: pedir para mover uma página para depois DELA
    /// MESMA não pode embaralhar a ordem das outras. Ela é recusada (mesmo
    /// comportamento de `BlockRepository::move_block` para o mesmo caso — ver
    /// o comentário de `mover`), e a ordem inteira continua exatamente igual.
    #[tokio::test]
    async fn moving_a_page_after_itself_does_not_reshuffle_anything() {
        let (pool, data_dir) = banco_temporario("mover-si-mesma").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());

        let a = repo.criar(book_id, "A").await.unwrap();
        let b = repo.criar(book_id, "B").await.unwrap();
        let antes = repo.listar_do_livro(book_id).await.unwrap();

        let result = repo.mover(b.id, Some(b.id)).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        let depois = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(antes, depois, "a tentativa recusada não pode ter mudado a ordem de nenhuma página");
        let _ = a;

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn deleting_the_book_cascades_to_its_pages() {
        let (pool, data_dir) = banco_temporario("cascata-livro").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());
        repo.criar(book_id, "Página que some com o livro").await.unwrap();

        let media_dir = data_dir.join("media");
        let biblioteca = BibliotecaRepository::new(pool.clone());
        // `delete_permanently` só aceita livro já na lixeira — mesmo dois
        // passos que `BibliotecaRepository` exige em produção.
        biblioteca.move_to_trash(book_id).await.unwrap();
        biblioteca.delete_permanently(&media_dir, book_id).await.unwrap();

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_book_pages WHERE book_id = ?")
            .bind(book_id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 0, "apagar o livro precisa apagar em cascata as páginas dele");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Apagar uma página de anotação não pode levar nenhuma anotação (grifo)
    /// junto — as duas tabelas não têm FK entre si (ver a migração).
    #[tokio::test]
    async fn deleting_a_page_does_not_delete_any_annotation() {
        let (pool, data_dir) = banco_temporario("remover-nao-afeta-anotacao").await;
        let book_id = livro_de_teste(&pool, &data_dir).await;
        let repo = PaginaDeLivroRepository::new(pool.clone());
        let pagina = repo.criar(book_id, "Página qualquer").await.unwrap();

        let biblioteca = BibliotecaRepository::new(pool.clone());
        biblioteca.create_annotation(book_id, "highlight", "10", None, 0.1, "trecho grifado", None, None).await.unwrap();

        repo.remover(pagina.id).await.unwrap();

        let anotacoes = biblioteca.list_annotations(book_id).await.unwrap();
        assert_eq!(anotacoes.len(), 1, "remover a página não pode ter apagado a anotação do livro");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
