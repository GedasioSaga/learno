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
//!    existente (`atualizar_palavra`) ou desistir da nova coleta.
//!
//! SINÔNIMOS E ANTÔNIMOS (0045): listas guardadas como array JSON. Este
//! módulo é o único escritor, então é aqui que a lista é normalizada antes de
//! gravar — ver [`normalizar_lista`].

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::types::Json;
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
/// Teto de itens de UMA lista (sinônimos ou antônimos), contado depois da
/// normalização — duplicata e item vazio não gastam vaga.
const MAX_LIST_ITEMS: usize = 50;
/// Teto de bytes de UM item, medido depois do `trim`.
const MAX_LIST_ITEM_BYTES: usize = 200;

const VOCABULARY_COLUMNS: &str =
    "id, book_id, term, context_snippet, note, locator, synonyms, antonyms, highlight_in_book, created_at, updated_at";

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
    #[sqlx(json)]
    pub synonyms: Vec<String>,
    #[sqlx(json)]
    pub antonyms: Vec<String>,
    /// Liga a marcação da palavra no texto do livro onde foi colhida.
    pub highlight_in_book: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// O que o usuário informa ao colher uma palavra — a entrada de
/// [`VocabularioRepository::coletar`]. Agrupado num struct porque são seis
/// campos e quase todos opcionais: na chamada, o nome do campo diz qual
/// `None` é qual.
#[derive(Debug, Clone, Copy, Default)]
pub struct NovaPalavra<'a> {
    pub term: &'a str,
    pub context_snippet: Option<&'a str>,
    pub note: Option<&'a str>,
    pub synonyms: &'a [String],
    pub antonyms: &'a [String],
    pub locator: Option<&'a str>,
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
    ///
    /// `highlight_in_book` não está em [`NovaPalavra`]: palavra nova nasce
    /// marcada (o DEFAULT 1 da 0045), e quem quiser desligar usa
    /// [`Self::definir_marcacao`].
    pub async fn coletar(&self, book_id: Uuid, nova: NovaPalavra<'_>) -> Result<PalavraColetada> {
        let NovaPalavra { term, context_snippet, note, synonyms, antonyms, locator } = nova;
        validate_term(term)?;
        validate_optional_text_len("trecho_de_contexto", context_snippet, MAX_CONTEXT_CHARS)?;
        validate_optional_text_len("nota", note, MAX_NOTE_CHARS)?;
        validate_optional_text_len("locator", locator, MAX_LOCATOR_CHARS)?;
        let synonyms = normalizar_lista("sinônimos", synonyms)?;
        let antonyms = normalizar_lista("antônimos", antonyms)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, PalavraColetada>(&format!(
            "INSERT INTO library_vocabulary (id, book_id, term, context_snippet, note, locator, synonyms, antonyms) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {VOCABULARY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(book_id.db())
        .bind(term)
        .bind(context_snippet)
        .bind(note)
        .bind(locator)
        .bind(Json(&synonyms))
        .bind(Json(&antonyms))
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

    /// `atualizar_palavra`. Muda nota, sinônimos e antônimos, sempre os três
    /// juntos (a tela edita os três no mesmo formulário, então a lista que
    /// chega é a lista inteira, não um diff). `term`/`context_snippet`/
    /// `locator` são o registro congelado do momento da coleta (mesmo
    /// raciocínio de `library_annotations.excerpt`, ver a migração 0022) e
    /// não passam por aqui.
    pub async fn atualizar(
        &self,
        id: Uuid,
        note: Option<&str>,
        synonyms: &[String],
        antonyms: &[String],
    ) -> Result<PalavraColetada> {
        validate_optional_text_len("nota", note, MAX_NOTE_CHARS)?;
        let synonyms = normalizar_lista("sinônimos", synonyms)?;
        let antonyms = normalizar_lista("antônimos", antonyms)?;

        let row = sqlx::query_as::<_, PalavraColetada>(&format!(
            "UPDATE library_vocabulary SET note = $2, synonyms = $3, antonyms = $4 WHERE id = $1 \
             RETURNING {VOCABULARY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(note)
        .bind(Json(&synonyms))
        .bind(Json(&antonyms))
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("palavra coletada {id}")))
    }

    /// `definir_marcacao_da_palavra`: liga ou desliga a marcação da palavra
    /// no texto do livro. Só esta coluna muda.
    pub async fn definir_marcacao(&self, id: Uuid, ativa: bool) -> Result<PalavraColetada> {
        let row = sqlx::query_as::<_, PalavraColetada>(&format!(
            "UPDATE library_vocabulary SET highlight_in_book = $2 WHERE id = $1 RETURNING {VOCABULARY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(ativa)
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

/// Normaliza uma lista de sinônimos ou antônimos antes de gravar: `trim` em
/// cada item, descarta item vazio, remove duplicata ignorando caixa e acento
/// (fica a PRIMEIRA ocorrência, com a grafia original dela) e aplica os tetos
/// [`MAX_LIST_ITEM_BYTES`] por item e [`MAX_LIST_ITEMS`] por lista.
///
/// `[" ávido ", " ", "Ávido", "faminto"]` vira `["ávido", "faminto"]`.
fn normalizar_lista(label: &str, itens: &[String]) -> Result<Vec<String>> {
    let mut vistos: HashSet<String> = HashSet::new();
    let mut normalizada: Vec<String> = Vec::new();

    for item in itens {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if item.len() > MAX_LIST_ITEM_BYTES {
            return Err(Error::Invalid(format!(
                "cada item de {label} não pode passar de {MAX_LIST_ITEM_BYTES} bytes (recebido: {})",
                item.len()
            )));
        }
        if vistos.insert(chave_sem_caixa_nem_acento(item)) {
            normalizada.push(item.to_string());
        }
    }

    if normalizada.len() > MAX_LIST_ITEMS {
        return Err(Error::Invalid(format!(
            "{label} não pode passar de {MAX_LIST_ITEMS} itens (recebido: {})",
            normalizada.len()
        )));
    }
    Ok(normalizada)
}

/// Chave de comparação da dedupe: minúscula e sem acento.
///
/// Escrita à mão, sem crate de normalização Unicode, e por isso LIMITADA às
/// letras latinas acentuadas (Latin-1 e Latin Extended-A, que cobrem
/// português, espanhol, francês, alemão e italiano) mais as marcas
/// combinantes U+0300–U+036F soltas — o que já cobre texto que chegou
/// decomposto (NFD). Letra acentuada fora disso (grego com tonos, vietnamita
/// pré-composto) só é comparada sem caixa, não sem acento.
fn chave_sem_caixa_nem_acento(texto: &str) -> String {
    texto.chars().flat_map(char::to_lowercase).filter_map(letra_base).collect()
}

/// A letra sem o acento, ou `None` para uma marca combinante solta (que
/// simplesmente some da chave). Recebe a letra já minúscula.
fn letra_base(letra: char) -> Option<char> {
    let base = match letra {
        '\u{0300}'..='\u{036F}' => return None,
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        outra => outra,
    };
    Some(base)
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

    fn so_termo(term: &str) -> NovaPalavra<'_> {
        NovaPalavra { term, ..NovaPalavra::default() }
    }

    fn lista(itens: &[&str]) -> Vec<String> {
        itens.iter().map(|item| (*item).to_string()).collect()
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

        let palavra = repo
            .coletar(
                book_id,
                NovaPalavra {
                    term: "mitocôndria",
                    context_snippet: Some("a mitocôndria é a usina da célula"),
                    note: Some("lembrar de revisar"),
                    locator: Some("42"),
                    ..NovaPalavra::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(palavra.book_id, book_id);
        assert_eq!(palavra.term, "mitocôndria");
        assert_eq!(palavra.context_snippet.as_deref(), Some("a mitocôndria é a usina da célula"));
        assert_eq!(palavra.note.as_deref(), Some("lembrar de revisar"));
        assert_eq!(palavra.locator.as_deref(), Some("42"));
        assert!(palavra.synonyms.is_empty());
        assert!(palavra.antonyms.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: o que foi colhido com sinônimos e antônimos volta
    /// igual, tanto no `RETURNING` do INSERT quanto numa leitura nova.
    #[tokio::test]
    async fn coletar_with_synonyms_and_antonyms_round_trips_them() {
        let (pool, data_dir) = banco_temporario("cria-listas").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let sinonimos = lista(&["ávido", "faminto"]);
        let antonimos = lista(&["saciado"]);
        let palavra = repo
            .coletar(
                book_id,
                NovaPalavra { term: "voraz", synonyms: &sinonimos, antonyms: &antonimos, ..NovaPalavra::default() },
            )
            .await
            .unwrap();

        assert_eq!(palavra.synonyms, sinonimos);
        assert_eq!(palavra.antonyms, antonimos);

        let lida = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lida.len(), 1);
        assert_eq!(lida[0], palavra, "a leitura nova precisa devolver exatamente a linha que o INSERT devolveu");

        let gravado: String =
            sqlx::query_scalar("SELECT synonyms FROM library_vocabulary WHERE id = $1").bind(palavra.id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(gravado, r#"["ávido","faminto"]"#, "a coluna guarda um array JSON de strings");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: palavra nova nasce com a marcação ligada.
    #[tokio::test]
    async fn a_new_word_is_born_with_the_highlight_on() {
        let (pool, data_dir) = banco_temporario("nasce-marcada").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let palavra = repo.coletar(book_id, so_termo("voraz")).await.unwrap();
        assert!(palavra.highlight_in_book);

        let json = serde_json::to_value(&palavra).unwrap();
        assert_eq!(json["highlightInBook"], serde_json::json!(true), "o contrato IPC é camelCase");
        assert_eq!(json["synonyms"], serde_json::json!([]));
        assert_eq!(json["antonyms"], serde_json::json!([]));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: a lista é normalizada antes de gravar — trim,
    /// vazio descartado, duplicata (ignorando caixa e acento) removida,
    /// mantendo a primeira grafia.
    #[tokio::test]
    async fn coletar_normalizes_the_lists_before_saving() {
        let (pool, data_dir) = banco_temporario("normaliza").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        // " ávido , ,Ávido, faminto" separado por vírgula, como a tela manda.
        let sinonimos = lista(&[" ávido ", " ", "Ávido", " faminto"]);
        let antonimos = lista(&["saciado", "SACIADO", "satisfeito", "", "\t"]);
        let palavra = repo
            .coletar(
                book_id,
                NovaPalavra { term: "voraz", synonyms: &sinonimos, antonyms: &antonimos, ..NovaPalavra::default() },
            )
            .await
            .unwrap();

        assert_eq!(palavra.synonyms, lista(&["ávido", "faminto"]));
        assert_eq!(palavra.antonyms, lista(&["saciado", "satisfeito"]));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn coletar_rejects_lists_over_the_ceilings() {
        let (pool, data_dir) = banco_temporario("tetos").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let item_grande = vec!["a".repeat(MAX_LIST_ITEM_BYTES + 1)];
        let result =
            repo.coletar(book_id, NovaPalavra { term: "voraz", synonyms: &item_grande, ..NovaPalavra::default() }).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        let itens_demais: Vec<String> = (0..=MAX_LIST_ITEMS).map(|n| format!("item{n}")).collect();
        let result =
            repo.coletar(book_id, NovaPalavra { term: "voraz", antonyms: &itens_demais, ..NovaPalavra::default() }).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_vocabulary").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 0, "lista recusada não pode ter gravado nada");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: uma linha gravada sem as colunas da 0045 (o
    /// formato de antes da migração) lê `[]`, `[]` e marcação ligada.
    #[tokio::test]
    async fn a_row_written_without_the_0045_columns_reads_empty_lists_and_highlight_on() {
        let (pool, data_dir) = banco_temporario("linha-antiga-sql-cru").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO library_vocabulary (id, book_id, term, context_snippet, note, locator) VALUES ($1, $2, 'antiga', NULL, 'nota velha', NULL)")
            .bind(id.db())
            .bind(book_id.db())
            .execute(&pool)
            .await
            .unwrap();

        let lida = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lida.len(), 1);
        assert_eq!(lida[0].id, id);
        assert!(lida[0].synonyms.is_empty());
        assert!(lida[0].antonyms.is_empty());
        assert!(lida[0].highlight_in_book);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O mesmo critério, agora com a 0045 aplicada DE VERDADE sobre uma linha
    /// que já existia: as três colunas são removidas, o registro da 0045 é
    /// apagado do histórico do sqlx, a linha antiga é gravada, e reabrir o
    /// banco reaplica a 0045 por cima dela (o caminho do usuário que atualiza
    /// o app com palavras já colhidas).
    #[tokio::test]
    async fn migration_0045_applied_over_an_existing_row_gives_empty_lists_and_highlight_on() {
        let (pool, data_dir) = banco_temporario("linha-antiga-migracao").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        for coluna in ["synonyms", "antonyms", "highlight_in_book"] {
            sqlx::query(&format!("ALTER TABLE library_vocabulary DROP COLUMN {coluna}")).execute(&pool).await.unwrap();
        }
        let apagadas = sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 45").execute(&pool).await.unwrap();
        assert_eq!(apagadas.rows_affected(), 1, "a 0045 precisava estar no histórico para este teste valer");

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO library_vocabulary (id, book_id, term, note) VALUES ($1, $2, 'antiga', 'nota velha')")
            .bind(id.db())
            .bind(book_id.db())
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let pool = connect_and_migrate(&data_dir.join("learno.sqlite")).await.unwrap();
        let lida = VocabularioRepository::new(pool.clone()).listar_do_livro(book_id).await.unwrap();
        assert_eq!(lida.len(), 1);
        assert_eq!(lida[0].id, id);
        assert_eq!(lida[0].note.as_deref(), Some("nota velha"));
        assert!(lida[0].synonyms.is_empty());
        assert!(lida[0].antonyms.is_empty());
        assert!(lida[0].highlight_in_book);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O `CHECK` da 0045 recusa o que não é array JSON, mesmo vindo de SQL cru.
    #[tokio::test]
    async fn the_0045_checks_reject_a_non_array_list_and_a_non_boolean_highlight() {
        let (pool, data_dir) = banco_temporario("check-0045").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        for (coluna, valor) in [("synonyms", "'{}'"), ("antonyms", "'\"solto\"'"), ("synonyms", "'nao e json'"), ("highlight_in_book", "2")] {
            let result = sqlx::query(&format!("INSERT INTO library_vocabulary (id, book_id, term, {coluna}) VALUES ($1, $2, 'x', {valor})"))
                .bind(Uuid::now_v7().db())
                .bind(book_id.db())
                .execute(&pool)
                .await;
            assert!(result.is_err(), "{coluna} = {valor} precisava ser recusado pelo CHECK");
        }

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn normalizar_lista_dedupes_ignoring_case_and_accent_keeping_the_first() {
        let normalizada = normalizar_lista("sinônimos", &lista(&["Ávido", "avido", "AVIDO", "a\u{0301}vido", "ávidos"])).unwrap();
        assert_eq!(normalizada, lista(&["Ávido", "ávidos"]), "acento composto, decomposto (NFD) e sem acento são a mesma palavra");

        let normalizada = normalizar_lista("sinônimos", &lista(&["coração", "CORACAO", "ação", "acao"])).unwrap();
        assert_eq!(normalizada, lista(&["coração", "ação"]));
    }

    #[test]
    fn normalizar_lista_edges() {
        assert_eq!(normalizar_lista("sinônimos", &[]).unwrap(), Vec::<String>::new());
        assert_eq!(normalizar_lista("sinônimos", &lista(&["", "  ", "\n"])).unwrap(), Vec::<String>::new());

        // Teto por item é em BYTES depois do trim: 100 "á" (2 bytes cada) = 200, cabe; 101 não.
        let no_teto = "á".repeat(100);
        assert_eq!(normalizar_lista("sinônimos", &[format!("  {no_teto}  ")]).unwrap(), vec![no_teto]);
        let acima = normalizar_lista("sinônimos", &["á".repeat(101)]);
        assert!(matches!(acima, Err(Error::Invalid(ref m)) if m.contains("sinônimos")), "obtido {acima:?}");

        // Teto de itens conta DEPOIS da dedupe: 50 distintos + repetidos cabem.
        let mut cinquenta: Vec<String> = (0..MAX_LIST_ITEMS).map(|n| format!("item{n}")).collect();
        cinquenta.extend(["ITEM0".to_string(), " item1 ".to_string(), String::new()]);
        assert_eq!(normalizar_lista("antônimos", &cinquenta).unwrap().len(), MAX_LIST_ITEMS);
        cinquenta.push("item50".to_string());
        let demais = normalizar_lista("antônimos", &cinquenta);
        assert!(matches!(demais, Err(Error::Invalid(ref m)) if m.contains("antônimos")), "obtido {demais:?}");
    }

    #[tokio::test]
    async fn coletar_palavra_rejects_a_blank_term() {
        let (pool, data_dir) = banco_temporario("termo-vazio").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let vazio = repo.coletar(book_id, so_termo("")).await;
        assert!(matches!(vazio, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {vazio:?}");

        let so_espaco = repo.coletar(book_id, so_termo("   ")).await;
        assert!(matches!(so_espaco, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {so_espaco:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn coletar_palavra_rejects_an_unknown_book() {
        let (pool, data_dir) = banco_temporario("livro-inexistente").await;
        let repo = VocabularioRepository::new(pool.clone());

        let result = repo.coletar(Uuid::now_v7(), so_termo("palavra")).await;
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

        repo.coletar(book_id, so_termo("mitocôndria")).await.unwrap();
        let segunda = repo
            .coletar(
                book_id,
                NovaPalavra { term: "Mitocôndria", context_snippet: Some("contexto diferente"), ..NovaPalavra::default() },
            )
            .await;

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

        repo.coletar(livro_a, so_termo("mitocôndria")).await.unwrap();
        let no_livro_b = repo.coletar(livro_b, so_termo("mitocôndria")).await;

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

        repo.coletar(livro_a, so_termo("alfa")).await.unwrap();
        repo.coletar(livro_b, so_termo("beta")).await.unwrap();

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

        repo.coletar(livro_a, so_termo("alfa")).await.unwrap();
        repo.coletar(livro_b, so_termo("beta")).await.unwrap();

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

        repo.coletar(book_id, so_termo("mitocôndria")).await.unwrap();
        repo.coletar(book_id, so_termo("ribossomo")).await.unwrap();

        let filtrada = repo.listar(Some("MITO")).await.unwrap();
        assert_eq!(filtrada.len(), 1);
        assert_eq!(filtrada[0].term, "mitocôndria");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: `atualizar` troca os três campos editáveis e não
    /// toca no registro congelado da coleta nem na marcação.
    #[tokio::test]
    async fn atualizar_replaces_note_synonyms_and_antonyms_only() {
        let (pool, data_dir) = banco_temporario("atualizar").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let antigos = lista(&["guloso"]);
        let palavra = repo
            .coletar(
                book_id,
                NovaPalavra {
                    term: "mitocôndria",
                    context_snippet: Some("contexto original"),
                    note: Some("nota velha"),
                    synonyms: &antigos,
                    antonyms: &antigos,
                    locator: Some("42"),
                },
            )
            .await
            .unwrap();
        repo.definir_marcacao(palavra.id, false).await.unwrap();

        let atualizada = repo
            .atualizar(palavra.id, Some("agora com nota"), &lista(&[" ávido ", "Ávido", "faminto"]), &lista(&["saciado"]))
            .await
            .unwrap();

        assert_eq!(atualizada.note.as_deref(), Some("agora com nota"));
        assert_eq!(atualizada.synonyms, lista(&["ávido", "faminto"]), "atualizar também normaliza");
        assert_eq!(atualizada.antonyms, lista(&["saciado"]));
        assert_eq!(atualizada.term, "mitocôndria", "não pedido na atualização, continua igual");
        assert_eq!(atualizada.context_snippet.as_deref(), Some("contexto original"), "não pedido na atualização, continua igual");
        assert_eq!(atualizada.locator.as_deref(), Some("42"), "não pedido na atualização, continua igual");
        assert!(!atualizada.highlight_in_book, "atualizar não religa a marcação desligada");

        let lida = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lida[0].synonyms, atualizada.synonyms);
        assert_eq!(lida[0].antonyms, atualizada.antonyms);

        // Listas vazias e nota ausente limpam os três campos.
        let limpa = repo.atualizar(palavra.id, None, &[], &[]).await.unwrap();
        assert_eq!(limpa.note, None);
        assert!(limpa.synonyms.is_empty());
        assert!(limpa.antonyms.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn atualizar_rejects_an_oversized_list_and_keeps_the_row() {
        let (pool, data_dir) = banco_temporario("atualizar-teto").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let originais = lista(&["ávido"]);
        let palavra = repo
            .coletar(book_id, NovaPalavra { term: "voraz", synonyms: &originais, ..NovaPalavra::default() })
            .await
            .unwrap();

        let result = repo.atualizar(palavra.id, Some("nota"), &["x".repeat(MAX_LIST_ITEM_BYTES + 1)], &[]).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        let lida = repo.listar_do_livro(book_id).await.unwrap();
        assert_eq!(lida[0].synonyms, originais, "atualização recusada não pode ter mudado nada");
        assert_eq!(lida[0].note, None);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn atualizar_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("atualizar-inexistente").await;
        let repo = VocabularioRepository::new(pool.clone());

        let result = repo.atualizar(Uuid::now_v7(), Some("nota"), &[], &[]).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Critério de pronto 1: `definir_marcacao` liga e desliga, e só mexe na
    /// marcação.
    #[tokio::test]
    async fn definir_marcacao_turns_the_highlight_off_and_on() {
        let (pool, data_dir) = banco_temporario("marcacao").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let sinonimos = lista(&["ávido"]);
        let palavra = repo
            .coletar(
                book_id,
                NovaPalavra { term: "voraz", note: Some("come muito"), synonyms: &sinonimos, ..NovaPalavra::default() },
            )
            .await
            .unwrap();
        assert!(palavra.highlight_in_book);

        let desligada = repo.definir_marcacao(palavra.id, false).await.unwrap();
        assert!(!desligada.highlight_in_book);
        assert_eq!(desligada.note.as_deref(), Some("come muito"));
        assert_eq!(desligada.synonyms, sinonimos);
        assert!(!repo.listar_do_livro(book_id).await.unwrap()[0].highlight_in_book, "desligada precisa persistir");

        let gravado: i64 = sqlx::query_scalar("SELECT highlight_in_book FROM library_vocabulary WHERE id = $1")
            .bind(palavra.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gravado, 0, "bool vira 0/1, o que o CHECK da 0045 aceita");

        let religada = repo.definir_marcacao(palavra.id, true).await.unwrap();
        assert!(religada.highlight_in_book);
        assert!(repo.listar_do_livro(book_id).await.unwrap()[0].highlight_in_book);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_marcacao_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("marcacao-inexistente").await;
        let repo = VocabularioRepository::new(pool.clone());

        let result = repo.definir_marcacao(Uuid::now_v7(), false).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn remover_deletes_and_a_second_removal_reports_not_found() {
        let (pool, data_dir) = banco_temporario("remover").await;
        let book_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;
        let repo = VocabularioRepository::new(pool.clone());

        let palavra = repo.coletar(book_id, so_termo("mitocôndria")).await.unwrap();
        repo.remover(palavra.id).await.unwrap();

        let segunda = repo.remover(palavra.id).await;
        assert!(matches!(segunda, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
