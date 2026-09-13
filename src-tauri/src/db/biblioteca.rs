//! Repository for the Biblioteca — Fase 5's `library_books` /
//! `library_reading_progress` / `library_annotations` (`0022_biblioteca.sql`):
//! o acervo de PDFs e EPUBs, o par (locator, fraction) que marca onde o
//! usuário está e onde já chegou, e as anotações presas ao texto.
//!
//! Não implementa leitura de PDF/EPUB nem extração de metadado/capa — isso é
//! do frontend (dependência ainda não escolhida) e fica fora desta peça. O
//! que este módulo entrega é o acervo em si: importar (copiar para
//! `media/`, deduplicar por hash), abrir, registrar progresso a cada virada
//! de página, remover (mover para a lixeira da própria página) e anotar.
//!
//! `format!("{COLUNAS}")` dentro de cada consulta (em vez de `SELECT *`)
//! segue a mesma convenção de `db::pomodoro`/`db::decks`: uma lista de
//! colunas nomeada, para uma migração que reordena colunas nunca embaralhar
//! silenciosamente `sqlx::FromRow` posicional.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::pages::PageRepository;
use crate::db::position;
use crate::error::{Error, Result};

/// Só estes dois formatos entram — espelha o `CHECK` da migração.
/// `.mobi`/`.azw` (DRM da Amazon) ficam de fora por decisão do projeto, não
/// por esquecimento (ponto 3 do pedido desta peça).
const ACCEPTED_EXTENSIONS: [(&str, &str); 2] = [("pdf", "pdf"), ("epub", "epub")];

const VALID_ANNOTATION_KINDS: [&str; 3] = ["bookmark", "highlight", "note"];

/// Nenhum destes tetos vem da migração (que não limita comprimento de TEXT);
/// existem porque `criar_anotacao`/`registrar_progresso` são comandos de
/// IPC, alcançáveis por script na WebView — entrada hostil por padrão.
const MAX_LOCATOR_CHARS: usize = 2_000;
const MAX_EXCERPT_CHARS: usize = 20_000;
const MAX_NOTE_CHARS: usize = 20_000;
const MAX_COLOR_CHARS: usize = 32;
/// Mesmo motivo dos tetos acima: `definir_metadados_do_livro` é comando de
/// IPC, alcançável por script na WebView.
const MAX_METADATA_TITLE_CHARS: usize = 500;
const MAX_METADATA_AUTHOR_CHARS: usize = 300;

const PROGRESS_COLUMNS: &str = "book_id, current_locator, current_fraction, furthest_locator, furthest_fraction, \
     status, last_read_at, finished_at, updated_at";

/// Colunas de `library_books` sozinha, na mesma convenção de
/// `PROGRESS_COLUMNS`/`ANNOTATION_COLUMNS`: uma lista nomeada, para uma
/// migração que reordena colunas nunca embaralhar `sqlx::FromRow`
/// silenciosamente. Usada por [`BibliotecaRepository::definir_metadados_do_livro`]
/// e [`BibliotecaRepository::mover_livro`], que devolvem a linha inteira do
/// livro sem o `JOIN` de `SHELF_QUERY_BASE`.
const LIVRO_COLUMNS: &str = "id, page_id, format, content_hash, file_name, original_file_name, file_size, \
     cover_file_name, metadata_title, metadata_author, total_units, has_text_layer, position, created_at, updated_at";

const ANNOTATION_COLUMNS: &str = "id, book_id, kind, locator_start, locator_end, fraction, excerpt, note, color, \
     block_id, note_id, created_at, updated_at";

/// O lado ARQUIVO de um livro — `library_books`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivroRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub page_id: Uuid,
    pub format: String,
    pub content_hash: String,
    pub file_name: String,
    pub original_file_name: String,
    pub file_size: i64,
    pub cover_file_name: Option<String>,
    pub metadata_title: Option<String>,
    pub metadata_author: Option<String>,
    pub total_units: Option<i64>,
    pub has_text_layer: Option<bool>,
    /// Índice fracionário da ordem ARRASTÁVEL na estante — ver
    /// `0037_livro_titulo_autor_ordem.sql` para o porquê desta tabela ganha
    /// `position` e `library_annotations` não. Reordenar é
    /// [`BibliotecaRepository::mover_livro`]; nunca escreva aqui direto.
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// O lado LEITURA — `library_reading_progress`. `current_*` é onde o
/// usuário está agora; `furthest_*` é o ponto mais distante já alcançado (a
/// barra). Ver o comentário da migração para por que os dois existem
/// separados e por que não há `CHECK (furthest >= current)`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressoDeLeitura {
    #[sqlx(try_from = "DbId")]
    pub book_id: Uuid,
    pub current_locator: Option<String>,
    pub current_fraction: f64,
    pub furthest_locator: Option<String>,
    pub furthest_fraction: f64,
    pub status: String,
    pub last_read_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// Um marcador, destaque ou anotação — `library_annotations`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnotacaoRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub book_id: Uuid,
    pub kind: String,
    pub locator_start: String,
    pub locator_end: Option<String>,
    pub fraction: f64,
    pub excerpt: String,
    pub note: Option<String>,
    pub color: Option<String>,
    #[sqlx(try_from = "DbIdOpt")]
    pub block_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
    pub note_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// O que a estante mostra por livro — `listar_livros`. `autor` é
/// `library_books.metadata_author` direto — até esta peça sempre `None`
/// (nada escrevia lá; por isso todo livro mostrava "Autor desconhecido"),
/// agora gravável por [`BibliotecaRepository::definir_metadados_do_livro`].
///
/// `titulo` prefere `library_books.metadata_title` quando definido, e cai
/// para `pages.title` (o título derivado do nome do arquivo na importação)
/// quando `metadata_title` é `NULL` — ver [`LivroNaEstante::from`] para a
/// implementação e o comentário de `definir_metadados_do_livro` para por que
/// um título em branco APAGA `metadata_title` em vez de gravar string vazia:
/// é o que faz esta projeção voltar sozinha ao título derivado do arquivo.
/// `pages.title` em si nunca é escrito por este módulo — ele continua sendo a
/// identidade única da página (sidebar, busca, histórico de versão, ver o
/// comentário grande de `0022_biblioteca.sql`); só a ESTANTE aprende a
/// mostrar uma correção sem renomear a página por baixo.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivroNaEstante {
    pub livro: LivroRow,
    pub progresso: ProgressoDeLeitura,
    pub titulo: String,
    pub autor: Option<String>,
}

/// O que `abrir_livro` devolve: o par livro+progresso de sempre, mais o
/// caminho absoluto do arquivo dentro da pasta de mídia — o leitor (fora
/// desta peça) abre o arquivo por aí.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivroAberto {
    pub livro: LivroRow,
    pub progresso: ProgressoDeLeitura,
    pub caminho_absoluto: String,
}

/// Linha de junção privada: `library_books` + `library_reading_progress` +
/// `pages.title`, com toda coluna prefixada para não colidir (as duas
/// primeiras tabelas têm `updated_at`/`id`-like colunas com o mesmo nome).
/// Existe só para `sqlx::FromRow` ler a consulta; [`LivroNaEstante::from`]
/// reparte de volta nos dois estruturas públicas.
#[derive(Debug, Clone, sqlx::FromRow)]
struct EstanteRow {
    #[sqlx(try_from = "DbId")]
    book_id: Uuid,
    #[sqlx(try_from = "DbId")]
    book_page_id: Uuid,
    book_format: String,
    book_content_hash: String,
    book_file_name: String,
    book_original_file_name: String,
    book_file_size: i64,
    book_cover_file_name: Option<String>,
    book_metadata_title: Option<String>,
    book_metadata_author: Option<String>,
    book_total_units: Option<i64>,
    book_has_text_layer: Option<bool>,
    book_position: String,
    book_created_at: DateTime<Utc>,
    book_updated_at: DateTime<Utc>,
    progress_current_locator: Option<String>,
    progress_current_fraction: f64,
    progress_furthest_locator: Option<String>,
    progress_furthest_fraction: f64,
    progress_status: String,
    progress_last_read_at: Option<DateTime<Utc>>,
    progress_finished_at: Option<DateTime<Utc>>,
    progress_updated_at: DateTime<Utc>,
    page_title: String,
}

impl From<EstanteRow> for LivroNaEstante {
    /// `titulo`: `metadata_title` quando definido (a correção que
    /// `definir_metadados_do_livro` grava), senão `pages.title` (o título
    /// derivado do arquivo na importação) — ver o comentário de
    /// [`LivroNaEstante`] para o porquê desta ordem de preferência.
    fn from(row: EstanteRow) -> Self {
        let autor = row.book_metadata_author.clone();
        let titulo = row.book_metadata_title.clone().unwrap_or(row.page_title);
        LivroNaEstante {
            livro: LivroRow {
                id: row.book_id,
                page_id: row.book_page_id,
                format: row.book_format,
                content_hash: row.book_content_hash,
                file_name: row.book_file_name,
                original_file_name: row.book_original_file_name,
                file_size: row.book_file_size,
                cover_file_name: row.book_cover_file_name,
                metadata_title: row.book_metadata_title,
                metadata_author: row.book_metadata_author,
                total_units: row.book_total_units,
                has_text_layer: row.book_has_text_layer,
                position: row.book_position,
                created_at: row.book_created_at,
                updated_at: row.book_updated_at,
            },
            progresso: ProgressoDeLeitura {
                book_id: row.book_id,
                current_locator: row.progress_current_locator,
                current_fraction: row.progress_current_fraction,
                furthest_locator: row.progress_furthest_locator,
                furthest_fraction: row.progress_furthest_fraction,
                status: row.progress_status,
                last_read_at: row.progress_last_read_at,
                finished_at: row.progress_finished_at,
                updated_at: row.progress_updated_at,
            },
            titulo,
            autor,
        }
    }
}

/// `JOIN` compartilhado por `list_shelf` e `get_shelf_entry` — a mesma forma,
/// uma com filtro de id a mais. `pg.deleted_at IS NULL`: um livro cuja
/// página foi movida para a lixeira (`remove`) some da estante, mesma regra
/// de toda listagem de página ativa do resto do app.
const SHELF_QUERY_BASE: &str = "\
    SELECT \
        b.id AS book_id, b.page_id AS book_page_id, b.format AS book_format, \
        b.content_hash AS book_content_hash, b.file_name AS book_file_name, \
        b.original_file_name AS book_original_file_name, b.file_size AS book_file_size, \
        b.cover_file_name AS book_cover_file_name, b.metadata_title AS book_metadata_title, \
        b.metadata_author AS book_metadata_author, b.total_units AS book_total_units, \
        b.has_text_layer AS book_has_text_layer, b.position AS book_position, \
        b.created_at AS book_created_at, b.updated_at AS book_updated_at, \
        p.current_locator AS progress_current_locator, p.current_fraction AS progress_current_fraction, \
        p.furthest_locator AS progress_furthest_locator, p.furthest_fraction AS progress_furthest_fraction, \
        p.status AS progress_status, p.last_read_at AS progress_last_read_at, \
        p.finished_at AS progress_finished_at, p.updated_at AS progress_updated_at, \
        pg.title AS page_title \
    FROM library_books b \
    JOIN library_reading_progress p ON p.book_id = b.id \
    JOIN pages pg ON pg.id = b.page_id \
    WHERE pg.deleted_at IS NULL";

/// O que [`BibliotecaRepository::delete_permanently`] precisa ler antes de
/// apagar — ver o comentário lá.
struct DeletableBook {
    page_id: Uuid,
    file_name: String,
    cover_file_name: Option<String>,
}

pub struct BibliotecaRepository {
    pool: SqlitePool,
}

impl BibliotecaRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `listar_livros`. Sem paginação: o contrato não pede (a estante
    /// inteira é o caso de uso — BIB-012's filtro/ordenação/agrupamento é da
    /// VIEW da database, fora de escopo aqui). Em ordem de `position` — a
    /// ordem que o USUÁRIO arrastou (`Self::mover_livro`), não mais
    /// `created_at`; um livro recém-importado entra no FIM dessa ordem (ver
    /// `Self::next_position`), então a estante nunca embaralha sozinha.
    pub async fn list_shelf(&self) -> Result<Vec<LivroNaEstante>> {
        let rows = sqlx::query_as::<_, EstanteRow>(&format!("{SHELF_QUERY_BASE} ORDER BY b.position"))
            .fetch_all(&self.pool)
            .await?;

        Ok(rows.into_iter().map(LivroNaEstante::from).collect())
    }

    /// `importar_livro`. Três passos, nesta ordem, e a ordem importa:
    ///
    /// 1. Validar e ler o arquivo de origem (só formato aceito, caminho
    ///    absoluto, arquivo existente) e calcular o hash — nada no banco
    ///    ainda muda.
    /// 2. Se o hash já existe no acervo (ponto 2 do pedido), devolve o livro
    ///    existente. Decisão: idempotente, não erro — reimportar o mesmo
    ///    PDF por engano (arrastar de novo) é comum, e "já está aqui" é mais
    ///    útil que uma mensagem para o usuário descartar. A garantia de
    ///    verdade continua sendo o `UNIQUE (content_hash)` do banco; esta
    ///    checagem só evita uma cópia de arquivo e uma página órfã que a
    ///    violação da constraint deixaria para trás.
    /// 3. Copiar o arquivo para `media/<hash>.<formato>` (pula a cópia se o
    ///    arquivo de mídia já existir — mesma lógica de dedupe de
    ///    `storeMediaFile`, `media-storage.ts`) e só então criar a página e
    ///    as linhas de livro/progresso.
    ///
    /// Metadado (título/autor do arquivo, capa, contagem de página,
    /// se tem camada de texto) fica `NULL` — extrair isso é do frontend,
    /// fora desta peça; o título da página nasce do nome do arquivo.
    ///
    /// Não é atômico entre "página criada" e "linha de livro inserida": se o
    /// processo cair exatamente nesse meio, sobra uma página vazia sem livro
    /// associado (recuperável excluindo-a pela árvore normal). O que TEM que
    /// ser atômico — livro e progresso não podem existir um sem o outro,
    /// porque toda leitura desta peça faz `JOIN` entre os dois — está numa
    /// transação.
    pub async fn import(&self, media_dir: &Path, source_path: &str) -> Result<LivroNaEstante> {
        let (path, format) = validate_source_path(source_path)?;

        let original_file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::Invalid(format!("nome de arquivo inválido: {}", path.display())))?
            .to_string();

        let bytes = tokio::fs::read(&path).await?;
        if bytes.is_empty() {
            return Err(Error::Invalid(format!("arquivo vazio: {}", path.display())));
        }

        let content_hash = sha256_hex(&bytes);

        if let Some(existing) = self.find_by_content_hash(&content_hash).await? {
            return Ok(existing);
        }

        let file_size = i64::try_from(bytes.len())
            .map_err(|_| Error::Invalid("arquivo grande demais para importar".into()))?;
        let file_name = format!("{content_hash}.{format}");

        tokio::fs::create_dir_all(media_dir).await?;
        let destination = media_dir.join(&file_name);
        let already_present = tokio::fs::try_exists(&destination).await.unwrap_or(false);
        if !already_present {
            tokio::fs::write(&destination, &bytes).await?;
        }

        let title = derive_title(&original_file_name);
        let page = PageRepository::new(self.pool.clone()).create(None, &title).await?;
        // Fim da fila da estante — ver `Self::next_position`. Fora da
        // transação abaixo de propósito: é só leitura, e não precisa do
        // isolamento que o INSERT dos dois satélites precisa entre si.
        let new_position = self.next_position().await?;

        let book_id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO library_books \
                 (id, page_id, format, content_hash, file_name, original_file_name, file_size, position) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(book_id.db())
        .bind(page.id.db())
        .bind(format)
        .bind(&content_hash)
        .bind(&file_name)
        .bind(&original_file_name)
        .bind(file_size)
        .bind(&new_position)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO library_reading_progress (book_id) VALUES ($1)")
            .bind(book_id.db())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        self.get_shelf_entry(book_id).await
    }

    /// Posição do próximo livro importado — sempre o ÚLTIMO da estante ATIVA,
    /// mesma convenção de `CategoriaRepository::next_position`
    /// (`db::biblioteca_categorias`) e `PageRepository::next_position_under`
    /// (`db::pages`): entra no fim da fila; reordenar para o meio é
    /// `Self::mover_livro`, não a importação. Escopo de "irmãos" igual ao de
    /// `Self::mover_livro`: só livros cuja página está ativa
    /// (`pages.deleted_at IS NULL`) contam — um livro na lixeira não aparece
    /// na estante, então não pode ser o "último" dela.
    async fn next_position(&self) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT b.position FROM library_books b \
             JOIN pages pg ON pg.id = b.page_id \
             WHERE pg.deleted_at IS NULL \
             ORDER BY b.position DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }

    /// `definir_metadados_do_livro`. Escreve em `library_books.metadata_title`/
    /// `metadata_author` — as duas colunas que 0022 já declarou e que nunca
    /// tiveram escritor até esta peça (por isso todo livro mostrava "Autor
    /// desconhecido"; `LivroNaEstante.autor` já lê `metadata_author` direto).
    ///
    /// SEMÂNTICA DE `None` vs. TEXTO EM BRANCO, por campo, independentemente
    /// um do outro:
    ///
    ///   `None`                      -> NÃO MUDE (a coluna preserva o valor atual)
    ///   `Some(texto em branco)`     -> APAGUE (grava `NULL`)
    ///   `Some(texto com conteúdo)`  -> DEFINE o valor, aparado nas pontas
    ///
    /// Por que isto não é `COALESCE($n, coluna)` puro — a convenção de
    /// `BlocoPatchInput` (`db::cronograma`) e `PrazoPatchInput` (`db::prazos`):
    /// os dois documentam, no próprio comentário, que aquele patch NÃO sabe
    /// limpar um campo de volta para `NULL` ("consequência aceita"). É
    /// exatamente essa capacidade que o pedido desta peça exige ("existe
    /// diferença entre não mude e apague"). Em vez de abrir um SEGUNDO
    /// `Option` (`Option<Option<String>>` — a saída que os dois comentários
    /// citam e descartam por não valer a pena para `deckId`/`pageId`), o
    /// sinal de "apague" é o próprio texto em branco: a mesma noção de "sem
    /// conteúdo" que toda validação de texto deste módulo já usa
    /// (`validate_locator`, `validate_annotation_kind`, ...). O `UPDATE`
    /// então veicula os TRÊS estados com um `CASE` por coluna — `$mudou` diz
    /// se o campo foi sequer mencionado, `$valor` (que pode ser `NULL`) é o
    /// que gravar quando foi — em vez do `COALESCE` de um estado só que
    /// aqueles dois patches usam.
    ///
    /// TÍTULO em branco fecha um círculo com [`LivroNaEstante::from`]: apagar
    /// `metadata_title` faz a projeção da estante cair de volta no título
    /// derivado do arquivo na importação (`pages.title`) — a opção "voltar ao
    /// título derivado do arquivo" que o pedido desta peça ofereceu como
    /// alternativa a recusar um título vazio. `pages.title` em si NUNCA é
    /// tocado por este método: continua sendo a identidade única da página
    /// (sidebar, busca, histórico de versão — comentário grande de
    /// `0022_biblioteca.sql`); só a projeção da estante aprende a preferir a
    /// correção sem renomear a página por baixo.
    pub async fn definir_metadados_do_livro(
        &self,
        livro_id: Uuid,
        titulo: Option<String>,
        autor: Option<String>,
    ) -> Result<LivroRow> {
        validate_optional_text_len("título do livro", titulo.as_deref(), MAX_METADATA_TITLE_CHARS)?;
        validate_optional_text_len("autor do livro", autor.as_deref(), MAX_METADATA_AUTHOR_CHARS)?;

        let (titulo_mudou, titulo_valor) = metadata_field_change(titulo);
        let (autor_mudou, autor_valor) = metadata_field_change(autor);

        sqlx::query_as::<_, LivroRow>(&format!(
            "UPDATE library_books SET \
                 metadata_title = CASE WHEN $2 THEN $3 ELSE metadata_title END, \
                 metadata_author = CASE WHEN $4 THEN $5 ELSE metadata_author END \
             WHERE id = $1 RETURNING {LIVRO_COLUMNS}"
        ))
        .bind(livro_id.db())
        .bind(titulo_mudou)
        .bind(&titulo_valor)
        .bind(autor_mudou)
        .bind(&autor_valor)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("livro {livro_id}")))
    }

    /// `mover_livro`: arrasta o livro para a posição imediatamente após
    /// `apos_livro_id` na estante (`None` = primeiro). Mesma família de
    /// `CronogramaRepository::mover_bloco`/`CategoriaRepository::mover`:
    /// índice fracionário entre os dois vizinhos, recalculado dentro de uma
    /// transação para o `SELECT` dos vizinhos e o `UPDATE` verem o mesmo
    /// estado.
    ///
    /// Escopo de "irmãos" igual ao de `Self::next_position`: só livros cuja
    /// página está ativa. `apos_livro_id` que não é um irmão ativo — não
    /// existe, está na lixeira, ou é o PRÓPRIO livro sendo movido (excluído
    /// da lista de vizinhos antes da busca) — devolve `Error::Invalid`, nunca
    /// embaralha nem entra em pânico.
    pub async fn mover_livro(&self, livro_id: Uuid, apos_livro_id: Option<Uuid>) -> Result<LivroRow> {
        let mut tx = self.pool.begin().await?;

        // Confirma que o livro existe antes de tocar em qualquer coisa — um
        // `mover_livro` de id desconhecido vira `NotFound`, não a confusão de
        // um `UPDATE` de zero linhas.
        ensure_livro_exists_tx(&mut tx, livro_id).await?;

        let siblings = active_siblings_tx(&mut tx, livro_id).await?;
        let new_position = position_between(&siblings, apos_livro_id)?;

        let row = sqlx::query_as::<_, LivroRow>(&format!(
            "UPDATE library_books SET position = $2 WHERE id = $1 RETURNING {LIVRO_COLUMNS}"
        ))
        .bind(livro_id.db())
        .bind(&new_position)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(row)
    }

    /// `abrir_livro`. Só leitura — não toca `last_read_at` (isso é
    /// `record_progress`, disparado por uma virada de página de verdade, não
    /// por abrir o leitor e fechar sem ler nada).
    /// O caminho passa pela MESMA validação de `delete_permanently`, e essa
    /// simetria é o ponto: `resolve_safe_media_path` foi escrita tratando
    /// `file_name` vindo do banco como hostil, e por um tempo só a exclusão a
    /// usava — a LEITURA, que é o que de fato entrega um caminho à WebView,
    /// montava `media_dir.join(file_name)` cru.
    ///
    /// E `join` não concatena quando o argumento é absoluto: ele SUBSTITUI a
    /// base. Um `file_name` como `C:\outra\coisa` numa linha corrompida
    /// produzia um `caminho_absoluto` inteiramente fora de `media/`, que
    /// seguia direto para `convertFileSrc` e para o protocolo `asset:`.
    /// O escopo do `assetProtocol` em `tauri.conf.json` é uma segunda camada,
    /// mas defender só na camada de fora é confiar num arquivo de
    /// configuração para uma decisão que o código sabe tomar.
    pub async fn open(&self, media_dir: &Path, book_id: Uuid) -> Result<LivroAberto> {
        let entry = self.get_shelf_entry(book_id).await?;

        // A validação é chamada pelo seu EFEITO (recusar `..`, caminho
        // absoluto e link simbólico que sai de `media/`), e o caminho
        // devolvido à tela é o `join` simples — não o canônico.
        //
        // A distinção não é cosmética: no Windows, `canonicalize` devolve o
        // prefixo de caminho estendido (`\\?\C:\...`), que não é o que o
        // `convertFileSrc` e o protocolo `asset:` esperam receber. Validar com
        // o caminho real e entregar o caminho normal é o que mantém as duas
        // coisas certas ao mesmo tempo.
        //
        // Depois de `resolve_safe_media_path` aceitar, `file_name` é
        // comprovadamente um nome isolado, então o `join` não escapa da pasta.
        resolve_safe_media_path(media_dir, &entry.livro.file_name).await?.ok_or_else(|| {
            // Ausente do disco é NotFound com mensagem, não um caminho
            // inventado: entregar à tela o caminho de um arquivo que não
            // existe só empurra a falha para um erro opaco dentro do leitor.
            Error::NotFound(format!("o arquivo do livro {:?} não está mais na pasta de mídia", entry.livro.file_name))
        })?;

        let caminho_absoluto = media_dir.join(&entry.livro.file_name).to_string_lossy().into_owned();

        Ok(LivroAberto { livro: entry.livro, progresso: entry.progresso, caminho_absoluto })
    }

    /// `definir_capa_do_livro`: grava (ou limpa, com `None`) o nome do
    /// arquivo de capa em `library_books.cover_file_name`. A extração da
    /// imagem em si é do frontend — `pdfjs` desenha a primeira página do PDF,
    /// `epubjs` lê a capa do EPUB — e o arquivo já chega gravado em `media/`
    /// pelo mesmo armazenamento de mídia que os blocos usam
    /// (`media-storage.ts`); este método só registra o nome que passa a
    /// apontar para ele.
    ///
    /// `cover_file_name` vem do frontend e é HOSTIL, mesmo motivo do
    /// comentário de [`Self::delete_permanently`] sobre `file_name`/
    /// `cover_file_name`: em vez de validação nova, reusa
    /// [`resolve_safe_media_path`] e herda as duas camadas de defesa de lá
    /// (checagem léxica contra separador/`..`/caminho absoluto, e prefixo
    /// pós-`canonicalize` contra link simbólico escapando de `media/`).
    /// Diferente de `delete_permanently` — onde um arquivo já ausente do
    /// disco não pode travar a exclusão da linha — aqui um arquivo ausente
    /// TAMBÉM é recusado: gravar uma capa que não existe em `media/`
    /// deixaria a leitura (`Self::open`, a estante) apontando para nada.
    pub async fn definir_capa_do_livro(
        &self,
        media_dir: &Path,
        book_id: Uuid,
        cover_file_name: Option<String>,
    ) -> Result<()> {
        if let Some(name) = &cover_file_name {
            resolve_safe_media_path(media_dir, name)
                .await?
                .ok_or_else(|| Error::Invalid(format!("arquivo de capa não encontrado em media/: {name:?}")))?;
        }

        let result = sqlx::query("UPDATE library_books SET cover_file_name = $2 WHERE id = $1")
            .bind(book_id.db())
            .bind(cover_file_name)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("livro {book_id}")));
        }
        Ok(())
    }

    /// `registrar_progresso`, chamado a cada virada de página — por isso é
    /// um `UPDATE` só, indexado pela chave primária de
    /// `library_reading_progress`, que nunca toca `pages` (e portanto nunca
    /// dispara o gatilho de `pages.updated_at`, ver o comentário da
    /// migração). `furthest_*` só AVANÇA aqui: `MAX(furthest_fraction, $3)`
    /// como função escalar do SQLite (dois argumentos = maior dos dois, não
    /// agregada), com o locator seguindo apenas quando a fração de fato
    /// avançou. `finished_at` nasce na primeira vez que a fração mais
    /// distante alcança 1.0, e nunca é sobrescrito depois (ele marca QUANDO
    /// terminou, não o estado atual — `status` já deriva o estado).
    ///
    /// A correção manual PARA BAIXO do ponto mais distante (BIB-010) é
    /// [`Self::correct_furthest_progress`] — um caminho de escrita
    /// deliberadamente diferente deste, ver o comentário lá.
    pub async fn record_progress(&self, book_id: Uuid, locator: &str, fraction: f64) -> Result<ProgressoDeLeitura> {
        validate_locator(locator)?;
        validate_fraction(fraction)?;

        let row = sqlx::query_as::<_, ProgressoDeLeitura>(&format!(
            "UPDATE library_reading_progress SET \
                 current_locator = $2, \
                 current_fraction = $3, \
                 furthest_locator = CASE WHEN $3 > furthest_fraction THEN $2 ELSE furthest_locator END, \
                 furthest_fraction = MAX(furthest_fraction, $3), \
                 last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                 finished_at = CASE \
                     WHEN finished_at IS NULL AND MAX(furthest_fraction, $3) >= 1.0 \
                         THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     ELSE finished_at \
                 END \
             WHERE book_id = $1 \
             RETURNING {PROGRESS_COLUMNS}"
        ))
        .bind(book_id.db())
        .bind(locator)
        .bind(fraction)
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("progresso de leitura do livro {book_id}")))
    }

    /// BIB-010: correção manual do ponto mais distante, podendo MOVÊ-LO PARA
    /// TRÁS — o caso que a migração documenta ("pulei para o fim só para
    /// consultar; corrija a barra para onde eu realmente parei"). Diferente
    /// de [`Self::record_progress`]: não há `MAX` aqui (o valor novo
    /// substitui o antigo, para cima ou para baixo) e `current_*` não é
    /// tocado — a posição atual do leitor continua sendo onde ele está
    /// olhando agora, só "até onde eu já li de fato" está sendo corrigido.
    ///
    /// O contrato de IPC fixado para esta peça só lista `registrar_progresso`
    /// (o caminho de avanço automático); este método existe no repositório —
    /// e é testado — porque a migração decide explicitamente que a correção
    /// para baixo é legítima (nenhum `CHECK` a impede), mas não tem comando
    /// de IPC próprio ainda. Quando a tela de correção manual for desenhada,
    /// o `#[tauri::command]` chama este método direto.
    pub async fn correct_furthest_progress(
        &self,
        book_id: Uuid,
        locator: Option<&str>,
        fraction: f64,
    ) -> Result<ProgressoDeLeitura> {
        validate_fraction(fraction)?;
        validate_optional_locator(locator)?;

        let row = sqlx::query_as::<_, ProgressoDeLeitura>(&format!(
            "UPDATE library_reading_progress SET furthest_locator = $2, furthest_fraction = $3 \
             WHERE book_id = $1 RETURNING {PROGRESS_COLUMNS}"
        ))
        .bind(book_id.db())
        .bind(locator)
        .bind(fraction)
        .fetch_optional(&self.pool)
        .await?;

        row.ok_or_else(|| Error::NotFound(format!("progresso de leitura do livro {book_id}")))
    }

    /// `remover_livro`. NÃO apaga nenhuma linha nem o arquivo — move a
    /// PÁGINA do livro para a lixeira, mesma regra de todo o resto do app
    /// (ver o comentário da migração: "a lixeira é a da página"). O livro
    /// continua no banco, o arquivo continua em `media/`, e a página é
    /// restaurável dali (`PageRepository::restore`) até que alguém a exclua
    /// definitivamente.
    ///
    /// A exclusão de verdade — que apaga a linha, o arquivo em `media/` e
    /// leva progresso/anotações junto — é [`Self::delete_permanently`], um
    /// caminho separado de propósito (ver o comentário lá). O nome deste
    /// método evita `remove`, que sugeriria o oposto do que ele faz.
    pub async fn move_to_trash(&self, book_id: Uuid) -> Result<()> {
        let page_id: Option<DbId> = sqlx::query_scalar("SELECT page_id FROM library_books WHERE id = $1")
            .bind(book_id.db())
            .fetch_optional(&self.pool)
            .await?;
        let page_id = page_id.ok_or_else(|| Error::NotFound(format!("livro {book_id}")))?;

        PageRepository::new(self.pool.clone()).trash(Uuid::from(page_id)).await?;
        Ok(())
    }

    /// Segundo caminho de exclusão, deliberadamente separado de
    /// [`Self::move_to_trash`] — ESTE apaga de verdade: a linha de
    /// `library_books` (com o `ON DELETE CASCADE` da migração 0022 levando
    /// `library_reading_progress` e toda `library_annotations` do livro
    /// junto — progresso de leitura e anotações somem aqui, sem forma de
    /// desfazer) e o arquivo em `media/`.
    ///
    /// Exige que a página já esteja na lixeira: delega em
    /// `PageRepository::permanently_delete`, que recusa uma página ainda
    /// ativa (`Error::Invalid`) em vez de este método duplicar aquela
    /// checagem — mesmo raciocínio do comentário de `move_to_trash`. O fluxo
    /// é sempre em dois passos: `move_to_trash` primeiro, isto depois.
    ///
    /// O arquivo só é apagado se nenhuma OUTRA linha de `library_books`
    /// também o referenciar (hoje isso nunca acontece de verdade —
    /// `content_hash` é `UNIQUE` e `import` deduplica por ele antes de
    /// gravar, então dois livros nunca compartilham `file_name` — mas a
    /// checagem é barata e é exatamente o que evita que uma leitura duplique
    /// e a segunda exclusão apague o arquivo da primeira). Um arquivo já
    /// ausente do disco não vira erro: perder o arquivo de outra forma (o
    /// usuário mexeu na pasta `media/` à mão, uma exclusão anterior que
    /// falhou no meio) não pode travar a exclusão da linha.
    ///
    /// Todo caminho é validado (ver [`resolve_safe_media_path`]) ANTES de
    /// qualquer exclusão acontecer — linha do banco ou arquivo. `file_name` e
    /// `cover_file_name` vêm do banco, e são tratados como hostis pelo mesmo
    /// motivo que `db::ids` trata id vindo do banco como hostil: um valor
    /// corrompido ou manipulado à mão poderia carregar `..` e apontar para
    /// fora da pasta de dados do aplicativo.
    pub async fn delete_permanently(&self, media_dir: &Path, book_id: Uuid) -> Result<()> {
        let book = self.find_deletable_book(book_id).await?;

        // Passo 1 (só leitura): prova que cada caminho é seguro, ou aborta
        // sem tocar em nada — nem banco, nem arquivo.
        let file_path = resolve_safe_media_path(media_dir, &book.file_name).await?;
        let cover_path = match &book.cover_file_name {
            Some(cover) => resolve_safe_media_path(media_dir, cover).await?,
            None => None,
        };
        let file_is_shared = self.file_name_used_by_another_book(&book.file_name, book_id).await?;

        // Passo 2: a exclusão de verdade da linha, que cascateia progresso e
        // anotações — só acontece depois que os dois caminhos acima já
        // passaram pela validação.
        PageRepository::new(self.pool.clone()).permanently_delete(book.page_id).await?;

        // Passo 3: limpeza do arquivo, agora que o banco já concorda que o
        // livro sumiu. Best-effort quanto a "já não existia"
        // (`resolve_safe_media_path` devolveu `None`); qualquer outra falha
        // de E/S ainda propaga.
        if let (false, Some(path)) = (file_is_shared, file_path) {
            tokio::fs::remove_file(&path).await?;
        }
        if let Some(path) = cover_path {
            tokio::fs::remove_file(&path).await?;
        }

        Ok(())
    }

    /// Leitura para [`Self::delete_permanently`]: os únicos três campos que a
    /// exclusão de verdade precisa, num tipo privado em vez de reusar
    /// [`LivroRow`] inteiro — não há motivo para buscar/expor metadado que a
    /// operação não olha.
    async fn find_deletable_book(&self, book_id: Uuid) -> Result<DeletableBook> {
        let row: Option<(DbId, String, Option<String>)> = sqlx::query_as(
            "SELECT page_id, file_name, cover_file_name FROM library_books WHERE id = $1",
        )
        .bind(book_id.db())
        .fetch_optional(&self.pool)
        .await?;

        let (page_id, file_name, cover_file_name) =
            row.ok_or_else(|| Error::NotFound(format!("livro {book_id}")))?;

        Ok(DeletableBook { page_id: Uuid::from(page_id), file_name, cover_file_name })
    }

    /// O `COUNT` de dedupe do comentário de [`Self::delete_permanently`]:
    /// existe hoje só como segunda camada de defesa (ver lá o porquê de o
    /// invariante do banco já impedir isto na prática).
    async fn file_name_used_by_another_book(&self, file_name: &str, excluding_book_id: Uuid) -> Result<bool> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books WHERE file_name = $1 AND id <> $2")
            .bind(file_name)
            .bind(excluding_book_id.db())
            .fetch_one(&self.pool)
            .await?;

        Ok(count > 0)
    }

    /// `listar_anotacoes`: em ordem de leitura (por `fraction`, não por
    /// `locator` — ver o comentário da migração sobre por que `locator` não
    /// é ordenável de forma confiável nos dois formatos).
    pub async fn list_annotations(&self, book_id: Uuid) -> Result<Vec<AnotacaoRow>> {
        let rows = sqlx::query_as::<_, AnotacaoRow>(&format!(
            "SELECT {ANNOTATION_COLUMNS} FROM library_annotations WHERE book_id = $1 ORDER BY fraction"
        ))
        .bind(book_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// `criar_anotacao`. `book_id` que não existe surge como o `Error::Database`
    /// da própria FK — mesma escolha de `DeckRepository::create` para
    /// `parent_id`, em vez de uma pré-checagem redundante aqui.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_annotation(
        &self,
        book_id: Uuid,
        kind: &str,
        locator_start: &str,
        locator_end: Option<&str>,
        fraction: f64,
        excerpt: &str,
        note: Option<&str>,
        color: Option<&str>,
    ) -> Result<AnotacaoRow> {
        validate_annotation_kind(kind)?;
        validate_locator(locator_start)?;
        validate_optional_locator(locator_end)?;
        validate_fraction(fraction)?;
        validate_text_len("trecho selecionado", excerpt, MAX_EXCERPT_CHARS)?;
        validate_optional_text_len("comentário da anotação", note, MAX_NOTE_CHARS)?;
        validate_optional_text_len("cor da anotação", color, MAX_COLOR_CHARS)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, AnotacaoRow>(&format!(
            "INSERT INTO library_annotations \
                 (id, book_id, kind, locator_start, locator_end, fraction, excerpt, note, color) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {ANNOTATION_COLUMNS}"
        ))
        .bind(id.db())
        .bind(book_id.db())
        .bind(kind)
        .bind(locator_start)
        .bind(locator_end)
        .bind(fraction)
        .bind(excerpt)
        .bind(note)
        .bind(color)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// Acha o livro já importado com o mesmo conteúdo, e o TRAZ DE VOLTA da
    /// lixeira quando ele estiver lá.
    ///
    /// `remover_livro` só manda a página para a lixeira; a linha de
    /// `library_books` (e o arquivo em `media/`) continuam existindo. Sem a
    /// restauração abaixo, reimportar um livro apagado virava um beco sem
    /// saída para o usuário: a estante não mostra o livro (ela filtra por
    /// `pg.deleted_at IS NULL`), reimportar o mesmo arquivo achava a linha
    /// pelo hash e então falhava em `get_shelf_entry` com `NotFound` — o
    /// livro "não existe" e ao mesmo tempo "não pode ser importado".
    /// Reproduzido no banco de um usuário de verdade, com a página na lixeira
    /// desde a véspera.
    ///
    /// Restaurar é a leitura certa da intenção: quem manda importar um
    /// arquivo quer o livro na estante, e a alternativa (recusar com "esse
    /// livro está na lixeira") empurraria para Notas uma tarefa que nasceu na
    /// Biblioteca. O progresso de leitura e as anotações voltam junto, porque
    /// nunca foram apagados — é a mesma linha de sempre.
    async fn find_by_content_hash(&self, content_hash: &str) -> Result<Option<LivroNaEstante>> {
        let existing: Option<(DbId, DbId)> =
            sqlx::query_as("SELECT id, page_id FROM library_books WHERE content_hash = $1")
                .bind(content_hash)
                .fetch_optional(&self.pool)
                .await?;

        let Some((book_id, page_id)) = existing else { return Ok(None) };
        let (book_id, page_id) = (Uuid::from(book_id), Uuid::from(page_id));

        let pages = PageRepository::new(self.pool.clone());
        if pages.get(page_id).await?.deleted_at.is_some() {
            pages.restore(page_id).await?;
        }

        Ok(Some(self.get_shelf_entry(book_id).await?))
    }

    async fn get_shelf_entry(&self, book_id: Uuid) -> Result<LivroNaEstante> {
        sqlx::query_as::<_, EstanteRow>(&format!("{SHELF_QUERY_BASE} AND b.id = $1"))
            .bind(book_id.db())
            .fetch_optional(&self.pool)
            .await?
            .map(LivroNaEstante::from)
            .ok_or_else(|| Error::NotFound(format!("livro {book_id}")))
    }
}

/// Pure: SHA-256 em hex minúsculo — a mesma forma canônica que
/// `content_hash CHECK` exige e que `media-storage.ts` já usa para bloco de
/// mídia (`sha256Hex`, `media-storage.ts`), para o livro reusar a mesma
/// convenção de nome de arquivo em vez de inventar uma segunda.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.as_slice().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Pure: ponto 3 e 5 do pedido — só `.pdf`/`.epub`, caminho absoluto,
/// arquivo (não pasta) existente. `importar_livro` é alcançável por
/// qualquer script na WebView, não só pelo diálogo nativo que normalmente
/// fornece este caminho — entrada hostil por padrão.
fn validate_source_path(source_path: &str) -> Result<(PathBuf, &'static str)> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("caminho de origem não pode ser vazio".into()));
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(Error::Invalid("caminho de origem precisa ser um caminho absoluto".into()));
    }
    if !path.is_file() {
        return Err(Error::Invalid(format!("arquivo não encontrado: {}", path.display())));
    }

    let extension = path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase);
    let format = extension
        .as_deref()
        .and_then(|ext| ACCEPTED_EXTENSIONS.iter().find(|(candidate, _)| *candidate == ext))
        .map(|(_, canonical)| *canonical)
        .ok_or_else(|| {
            Error::Invalid(format!(
                "formato não suportado (a Biblioteca aceita apenas .pdf e .epub): {}",
                path.display()
            ))
        })?;

    Ok((path, format))
}

/// A validação de caminho de [`BibliotecaRepository::delete_permanently`] —
/// prova que `file_name` (um valor confiável quando foi escrito, mas hostil
/// quando volta do banco: uma linha corrompida ou editada à mão poderia
/// carregar `..` ou um caminho absoluto) resolve para algo estritamente
/// DENTRO de `media_dir`, antes de qualquer coisa ser apagada.
///
/// Duas camadas independentes, porque defendem contra duas coisas
/// diferentes:
///
/// 1. A checagem léxica (sem tocar o disco) rejeita QUALQUER coisa que não
///    seja um nome de arquivo isolado — sem separador, sem `..`, sem prefixo
///    de unidade. Funciona mesmo quando o arquivo não existe, o que
///    `canonicalize` (que exige um caminho real) não permitiria — e é
///    exatamente essa checagem que cobre o caso descrito no pedido desta
///    peça: um caminho com `..` tentando escapar da pasta.
/// 2. O `canonicalize` + confirmação de prefixo, só quando o arquivo existe
///    de fato, cobre o que a checagem léxica não alcança: um link simbólico
///    plantado dentro de `media_dir` apontando para fora dela.
///
/// Um arquivo ausente do disco devolve `Ok(None)`, não erro — perder o
/// arquivo de outro jeito não pode travar a exclusão da linha do banco (ponto
/// do pedido desta peça).
async fn resolve_safe_media_path(media_dir: &Path, file_name: &str) -> Result<Option<PathBuf>> {
    let relative = Path::new(file_name);
    let is_bare_file_name = relative.components().count() == 1
        && matches!(relative.components().next(), Some(std::path::Component::Normal(_)));
    if !is_bare_file_name {
        return Err(Error::Invalid(format!(
            "nome de arquivo de mídia fora do formato esperado (esperado um nome isolado, sem separador nem `..`): {file_name:?}"
        )));
    }

    if !tokio::fs::try_exists(media_dir).await.unwrap_or(false) {
        return Ok(None);
    }
    let candidate = media_dir.join(relative);
    if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
        return Ok(None);
    }

    let media_dir_real = tokio::fs::canonicalize(media_dir).await?;
    let candidate_real = tokio::fs::canonicalize(&candidate).await?;
    if !candidate_real.starts_with(&media_dir_real) {
        return Err(Error::Invalid(format!(
            "arquivo de mídia resolveu para fora da pasta de mídia: {file_name:?}"
        )));
    }

    Ok(Some(candidate_real))
}

/// Pure: o título inicial da página nasce do nome do arquivo (sem extensão)
/// — o único dado de título disponível antes de o frontend extrair metadado
/// do PDF/EPUB, fora desta peça.
fn derive_title(original_file_name: &str) -> String {
    Path::new(original_file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Livro importado")
        .to_string()
}

fn validate_annotation_kind(kind: &str) -> Result<()> {
    if !VALID_ANNOTATION_KINDS.contains(&kind) {
        return Err(Error::Invalid(format!(
            "tipo de anotação inválido: {kind:?} (esperado um de {VALID_ANNOTATION_KINDS:?})"
        )));
    }
    Ok(())
}

fn validate_locator(locator: &str) -> Result<()> {
    if locator.trim().is_empty() {
        return Err(Error::Invalid("locator não pode ser vazio".into()));
    }
    if locator.len() > MAX_LOCATOR_CHARS {
        return Err(Error::Invalid(format!(
            "locator não pode passar de {MAX_LOCATOR_CHARS} caracteres (recebido: {})",
            locator.len()
        )));
    }
    Ok(())
}

fn validate_optional_locator(locator: Option<&str>) -> Result<()> {
    match locator {
        Some(value) => validate_locator(value),
        None => Ok(()),
    }
}

/// `contains` numa `RangeInclusive<f64>` já rejeita `NaN` sozinho (`NaN >=
/// 0.0` é `false`), então não é preciso um `is_nan` à parte.
fn validate_fraction(fraction: f64) -> Result<()> {
    if !(0.0..=1.0).contains(&fraction) {
        return Err(Error::Invalid(format!(
            "fração de progresso precisa estar entre 0.0 e 1.0 (recebido: {fraction})"
        )));
    }
    Ok(())
}

fn validate_text_len(field: &str, value: &str, max: usize) -> Result<()> {
    if value.len() > max {
        return Err(Error::Invalid(format!(
            "{field} não pode passar de {max} caracteres (recebido: {})",
            value.len()
        )));
    }
    Ok(())
}

fn validate_optional_text_len(field: &str, value: Option<&str>, max: usize) -> Result<()> {
    match value {
        Some(v) => validate_text_len(field, v, max),
        None => Ok(()),
    }
}

/// Ver o comentário de [`BibliotecaRepository::definir_metadados_do_livro`]
/// para a semântica dos três estados. `(mudou, valor)`: `mudou = false` faz o
/// `CASE` do `UPDATE` ignorar `valor` e preservar a coluna atual; `mudou =
/// true` com `valor = None` grava `NULL` (apaga); `mudou = true` com
/// `valor = Some(x)` grava `x` já aparado.
fn metadata_field_change(value: Option<String>) -> (bool, Option<String>) {
    match value {
        None => (false, None),
        Some(texto) => {
            let aparado = texto.trim();
            if aparado.is_empty() { (true, None) } else { (true, Some(aparado.to_string())) }
        }
    }
}

/// Existência crua de `library_books`, independente de a página estar na
/// lixeira — mesma checagem "mínima" de [`BibliotecaRepository::find_deletable_book`]
/// (que também não filtra por `deleted_at`): um `mover_livro` de id
/// desconhecido precisa de `NotFound` claro, não da confusão de um `UPDATE`
/// de zero linhas.
async fn ensure_livro_exists_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<()> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM library_books WHERE id = $1").bind(id.db()).fetch_optional(&mut **tx).await?;

    if exists.is_none() {
        return Err(Error::NotFound(format!("livro {id}")));
    }
    Ok(())
}

/// Vizinhos de `exclude_id` (o livro sendo movido) na estante ATIVA — mesmo
/// filtro `pages.deleted_at IS NULL` de `PageRepository::active_siblings`
/// (`db::pages`) e de [`BibliotecaRepository::next_position`]: um livro na
/// lixeira não é vizinho válido nem destino de `apos_livro_id`.
async fn active_siblings_tx(tx: &mut Transaction<'_, Sqlite>, exclude_id: Uuid) -> Result<Vec<(Uuid, String)>> {
    // Leitura escalar de par (id, position): `DbId` no lugar de `Uuid`,
    // convertido de volta ao devolver — mesmo desenho de
    // `db::cronograma::siblings_in_day_tx`/`db::blocks::active_siblings_tx`.
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT b.id, b.position FROM library_books b \
         JOIN pages pg ON pg.id = b.page_id \
         WHERE pg.deleted_at IS NULL AND b.id <> $1 \
         ORDER BY b.position",
    )
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

/// Mesmo par `neighbours_for`/`position_between` de `db::cronograma`
/// (`mover_bloco`) e `db::pages` (`move_page`), reescrito aqui porque o
/// escopo de vizinhos (a estante inteira, sem agrupar por dia nem por pai) é
/// outra vez diferente o bastante para não valer a pena generalizar por um
/// terceiro uso — mesma decisão que `CronogramaRepository`'s já documenta.
fn neighbours_for(siblings: &[(Uuid, String)], apos_livro_id: Option<Uuid>) -> Result<(Option<&str>, Option<&str>)> {
    match apos_livro_id {
        None => Ok((None, siblings.first().map(|(_, p)| p.as_str()))),
        Some(after_id) => {
            let index = siblings
                .iter()
                .position(|(id, _)| *id == after_id)
                .ok_or_else(|| Error::Invalid("livro de referência não é um irmão ativo na estante".into()))?;
            let before = siblings[index].1.as_str();
            let after = siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after))
        }
    }
}

fn position_between(siblings: &[(Uuid, String)], apos_livro_id: Option<Uuid>) -> Result<String> {
    let (before_raw, after_raw) = neighbours_for(siblings, apos_livro_id)?;
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
    use crate::db::pool::connect_and_migrate;

    fn pasta_temporaria(rotulo: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-biblioteca-test-{rotulo}-{}", Uuid::new_v4()))
    }

    async fn banco_temporario(rotulo: &str) -> (SqlitePool, PathBuf) {
        let data_dir = pasta_temporaria(rotulo);
        let db_path = data_dir.join("learno.sqlite");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        (pool, data_dir)
    }

    fn escreve_arquivo_fonte(data_dir: &std::path::Path, nome: &str, conteudo: &[u8]) -> PathBuf {
        std::fs::create_dir_all(data_dir).unwrap();
        let caminho = data_dir.join(nome);
        std::fs::write(&caminho, conteudo).unwrap();
        caminho
    }

    /// Escreve um arquivo dentro de `media_dir`, como se `media-storage.ts`
    /// já tivesse gravado a capa antes de `definir_capa_do_livro` ser
    /// chamado — o caminho feliz nunca extrai imagem, só registra um nome já
    /// existente.
    fn escreve_capa(media_dir: &std::path::Path, nome: &str, conteudo: &[u8]) {
        std::fs::create_dir_all(media_dir).unwrap();
        std::fs::write(media_dir.join(nome), conteudo).unwrap();
    }

    async fn livro_na_estante(repo: &BibliotecaRepository, book_id: Uuid) -> LivroNaEstante {
        repo.list_shelf().await.unwrap().into_iter().find(|entrada| entrada.livro.id == book_id).unwrap()
    }

    // --- validate_source_path (puro, sem banco) -----------------------

    #[test]
    fn validate_source_path_rejects_blank_input() {
        assert!(validate_source_path("   ").is_err());
        assert!(validate_source_path("").is_err());
    }

    #[test]
    fn validate_source_path_rejects_a_relative_path() {
        assert!(validate_source_path("livro.pdf").is_err());
    }

    #[test]
    fn validate_source_path_rejects_an_unsupported_extension() {
        let data_dir = pasta_temporaria("ext-invalida");
        let caminho = escreve_arquivo_fonte(&data_dir, "livro.mobi", b"conteudo");

        let result = validate_source_path(&caminho.to_string_lossy());
        assert!(result.is_err(), "mobi (DRM da Amazon) precisa ser recusado");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn validate_source_path_rejects_a_missing_file() {
        let data_dir = pasta_temporaria("ausente");
        let caminho = data_dir.join("nao-existe.pdf");

        assert!(validate_source_path(&caminho.to_string_lossy()).is_err());
    }

    #[test]
    fn validate_source_path_accepts_pdf_and_epub_case_insensitively() {
        let data_dir = pasta_temporaria("ext-valida");
        let pdf = escreve_arquivo_fonte(&data_dir, "livro.PDF", b"conteudo");
        let epub = escreve_arquivo_fonte(&data_dir, "livro.epub", b"conteudo");

        let (_, formato_pdf) = validate_source_path(&pdf.to_string_lossy()).unwrap();
        let (_, formato_epub) = validate_source_path(&epub.to_string_lossy()).unwrap();
        assert_eq!(formato_pdf, "pdf");
        assert_eq!(formato_epub, "epub");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- derive_title (puro) -------------------------------------------

    #[test]
    fn derive_title_strips_the_extension() {
        assert_eq!(derive_title("Anatomia Humana.pdf"), "Anatomia Humana");
    }

    #[test]
    fn derive_title_falls_back_when_there_is_no_file_stem_at_all() {
        // `Path::file_stem` só devolve `None` quando não há nome de arquivo
        // nenhum a extrair (ex.: string vazia) — um nome como ".pdf" tem
        // `file_stem` igual a ".pdf" (arquivo oculto sem extensão), não
        // vazio, então não é um bom caso de teste para a borda que este
        // `unwrap_or` cobre.
        assert_eq!(derive_title(""), "Livro importado");
    }

    // --- validate_fraction (puro) ---------------------------------------

    #[test]
    fn validate_fraction_accepts_the_closed_interval() {
        assert!(validate_fraction(0.0).is_ok());
        assert!(validate_fraction(1.0).is_ok());
        assert!(validate_fraction(0.5).is_ok());
    }

    #[test]
    fn validate_fraction_rejects_out_of_range_and_nan() {
        assert!(validate_fraction(-0.01).is_err());
        assert!(validate_fraction(1.01).is_err());
        assert!(validate_fraction(f64::NAN).is_err());
    }

    // --- import / dedupe / get_shelf_entry (banco de verdade) ----------

    #[tokio::test]
    async fn import_creates_a_page_a_book_and_a_progress_row() {
        let (pool, data_dir) = banco_temporario("import-basico").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Anatomia Humana.pdf", b"conteudo pdf de teste");

        let entrada = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        assert_eq!(entrada.titulo, "Anatomia Humana");
        assert_eq!(entrada.livro.format, "pdf");
        assert_eq!(entrada.livro.original_file_name, "Anatomia Humana.pdf");
        assert_eq!(entrada.livro.content_hash.len(), 64);
        assert_eq!(entrada.progresso.book_id, entrada.livro.id);
        assert_eq!(entrada.progresso.status, "unread");
        assert!(media_dir.join(&entrada.livro.file_name).is_file(), "o arquivo precisa ter sido copiado para media/");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn importing_the_same_content_twice_returns_the_existing_book_not_a_second_one() {
        let (pool, data_dir) = banco_temporario("import-duplicado").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Duplicado.epub", b"mesmo conteudo sempre");

        let primeiro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        let segundo = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        assert_eq!(primeiro.livro.id, segundo.livro.id, "reimportar o mesmo conteúdo não pode criar um segundo livro");

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 1);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O beco sem saída que um usuário de verdade encontrou: livro mandado
    /// para a lixeira ontem, reimportado hoje, e o app respondendo
    /// `NotFound: livro <id>` — a estante não mostrava o livro (filtra
    /// `deleted_at IS NULL`) e reimportar também não funcionava, porque a
    /// linha continuava lá e `get_shelf_entry` não a enxergava.
    #[tokio::test]
    async fn reimporting_a_trashed_book_brings_it_back_instead_of_failing() {
        let (pool, data_dir) = banco_temporario("import-da-lixeira").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let pages = PageRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Percy Jackson.epub", b"mesmo conteudo sempre");

        let primeiro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        repo.move_to_trash(primeiro.livro.id).await.unwrap();
        assert!(repo.list_shelf().await.unwrap().is_empty(), "na lixeira, o livro some da estante");

        let reimportado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        assert_eq!(reimportado.livro.id, primeiro.livro.id, "é o MESMO livro de volta, não uma segunda cópia");
        assert!(
            pages.get(primeiro.livro.page_id).await.unwrap().deleted_at.is_none(),
            "a página do livro precisa ter saído da lixeira"
        );
        assert_eq!(repo.list_shelf().await.unwrap().len(), 1, "e o livro volta a aparecer na estante");

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 1, "restaurar não pode criar uma segunda linha");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn import_rejects_an_unsupported_extension_without_touching_the_database() {
        let (pool, data_dir) = banco_temporario("import-formato-invalido").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.mobi", b"conteudo");

        let result = repo.import(&media_dir, &origem.to_string_lossy()).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn list_shelf_returns_every_imported_book() {
        let (pool, data_dir) = banco_temporario("lista-estante").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let um = escreve_arquivo_fonte(&data_dir, "Um.pdf", b"conteudo um");
        let dois = escreve_arquivo_fonte(&data_dir, "Dois.epub", b"conteudo dois");

        repo.import(&media_dir, &um.to_string_lossy()).await.unwrap();
        repo.import(&media_dir, &dois.to_string_lossy()).await.unwrap();

        let estante = repo.list_shelf().await.unwrap();
        assert_eq!(estante.len(), 2);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- open ------------------------------------------------------------

    #[tokio::test]
    async fn open_returns_the_absolute_path_inside_the_media_dir() {
        let (pool, data_dir) = banco_temporario("abre-livro").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Aberto.pdf", b"conteudo do livro aberto");

        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        let aberto = repo.open(&media_dir, importado.livro.id).await.unwrap();

        assert_eq!(aberto.caminho_absoluto, media_dir.join(&importado.livro.file_name).to_string_lossy());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn open_of_an_unknown_book_reports_not_found() {
        let (pool, data_dir) = banco_temporario("abre-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.open(&data_dir.join("media"), Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- definir_capa_do_livro: `cover_file_name` é entrada hostil ------

    #[tokio::test]
    async fn definir_capa_do_livro_grava_o_nome_de_um_arquivo_ja_existente_em_media() {
        let (pool, data_dir) = banco_temporario("capa-caminho-feliz").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Com Capa.pdf", b"conteudo com capa");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        escreve_capa(&media_dir, "capa.png", b"png fake");

        repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("capa.png".into())).await.unwrap();

        let entrada = livro_na_estante(&repo, importado.livro.id).await;
        assert_eq!(entrada.livro.cover_file_name.as_deref(), Some("capa.png"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_capa_do_livro_com_none_limpa_a_capa_ja_gravada() {
        let (pool, data_dir) = banco_temporario("capa-limpa").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Capa Removida.epub", b"conteudo capa removida");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        escreve_capa(&media_dir, "capa-antiga.png", b"png antigo");
        repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("capa-antiga.png".into())).await.unwrap();

        repo.definir_capa_do_livro(&media_dir, importado.livro.id, None).await.unwrap();

        let entrada = livro_na_estante(&repo, importado.livro.id).await;
        assert_eq!(entrada.livro.cover_file_name, None);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Vetor 1 do pedido de segurança: separador `/` no meio do nome.
    #[tokio::test]
    async fn definir_capa_do_livro_rejeita_nome_com_barra_normal() {
        let (pool, data_dir) = banco_temporario("capa-barra-normal").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Barra Normal.pdf", b"conteudo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        let result = repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("sub/capa.png".into())).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Vetor 2: separador `\` — o `Path` do Rust reconhece os dois no
    /// Windows, mas a checagem léxica não pode depender disso por acidente:
    /// é exatamente o vetor que o pedido de segurança nomeia à parte.
    #[tokio::test]
    async fn definir_capa_do_livro_rejeita_nome_com_barra_invertida() {
        let (pool, data_dir) = banco_temporario("capa-barra-invertida").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Barra Invertida.pdf", b"conteudo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        let result =
            repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("sub\\capa.png".into())).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Vetor 3: `..` tentando escapar de `media/`.
    #[tokio::test]
    async fn definir_capa_do_livro_rejeita_nome_com_ponto_ponto() {
        let (pool, data_dir) = banco_temporario("capa-ponto-ponto").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Ponto Ponto.pdf", b"conteudo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        let result =
            repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("../fora-de-media.png".into())).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Vetor 4: caminho absoluto com prefixo de unidade do Windows.
    #[tokio::test]
    async fn definir_capa_do_livro_rejeita_caminho_absoluto_com_prefixo_de_unidade() {
        let (pool, data_dir) = banco_temporario("capa-caminho-absoluto").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Caminho Absoluto.pdf", b"conteudo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        let result = repo
            .definir_capa_do_livro(&media_dir, importado.livro.id, Some("C:/fora-de-media.png".into()))
            .await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Nome lexicamente seguro, mas o arquivo nunca foi gravado em `media/`
    /// — diferente de `delete_permanently`, aqui isto é recusado em vez de
    /// tolerado, para nunca deixar `cover_file_name` apontando para nada.
    #[tokio::test]
    async fn definir_capa_do_livro_rejeita_arquivo_que_nao_existe_em_media() {
        let (pool, data_dir) = banco_temporario("capa-arquivo-ausente").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Sem Capa.pdf", b"conteudo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

        let result =
            repo.definir_capa_do_livro(&media_dir, importado.livro.id, Some("nao-existe.png".into())).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_capa_de_um_livro_desconhecido_reporta_not_found() {
        let (pool, data_dir) = banco_temporario("capa-livro-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.definir_capa_do_livro(&data_dir.join("media"), Uuid::now_v7(), None).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- record_progress: o par de comportamentos do ponto 4 -----------

    /// A metade "avança normalmente": ler para frente empurra `furthest`
    /// junto com `current`.
    #[tokio::test]
    async fn record_progress_advances_both_current_and_furthest_when_reading_forward() {
        let (pool, data_dir) = banco_temporario("progresso-avanca").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Avanco.epub", b"conteudo avanco");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let p1 = repo.record_progress(livro.id, "epubcfi(/6/2!/4/2)", 0.10).await.unwrap();
        assert_eq!(p1.current_fraction, 0.10);
        assert_eq!(p1.furthest_fraction, 0.10);
        assert_eq!(p1.status, "reading");

        let p2 = repo.record_progress(livro.id, "epubcfi(/6/4!/4/2)", 0.40).await.unwrap();
        assert_eq!(p2.current_fraction, 0.40);
        assert_eq!(p2.furthest_fraction, 0.40);
        assert_eq!(p2.furthest_locator.as_deref(), Some("epubcfi(/6/4!/4/2)"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A metade que É o ponto central da peça: voltar para reler (BIB-009)
    /// move `current` para trás sem mexer em `furthest` — a barra não
    /// desanda porque o usuário releu um capítulo.
    #[tokio::test]
    async fn record_progress_going_backward_moves_current_but_never_lowers_furthest() {
        let (pool, data_dir) = banco_temporario("progresso-releitura").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Releitura.epub", b"conteudo releitura");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        repo.record_progress(livro.id, "epubcfi(/6/8!/4/2)", 0.80).await.unwrap();
        let voltou = repo.record_progress(livro.id, "epubcfi(/6/2!/4/2)", 0.20).await.unwrap();

        assert_eq!(voltou.current_fraction, 0.20, "current precisa refletir a releitura");
        assert_eq!(voltou.furthest_fraction, 0.80, "furthest não pode regredir num avanço normal");
        assert_eq!(voltou.furthest_locator.as_deref(), Some("epubcfi(/6/8!/4/2)"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn record_progress_reaching_the_end_sets_finished_at_and_status() {
        let (pool, data_dir) = banco_temporario("progresso-termina").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Termina.pdf", b"conteudo termina");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let final_page = repo.record_progress(livro.id, "300", 1.0).await.unwrap();
        assert_eq!(final_page.status, "finished");
        assert!(final_page.finished_at.is_some());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn record_progress_rejects_a_fraction_outside_the_unit_interval() {
        let (pool, data_dir) = banco_temporario("progresso-fracao-invalida").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Invalido.pdf", b"conteudo invalido");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let result = repo.record_progress(livro.id, "1", 1.5).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn record_progress_for_an_unknown_book_reports_not_found() {
        let (pool, data_dir) = banco_temporario("progresso-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.record_progress(Uuid::now_v7(), "1", 0.5).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- correct_furthest_progress: a outra metade do ponto 4 (BIB-010) --

    /// A correção manual PARA BAIXO — o caso central de BIB-010 — precisa
    /// funcionar mesmo com a posição atual ainda à frente, exatamente o
    /// cenário que a migração descreve.
    #[tokio::test]
    async fn correct_furthest_progress_can_lower_furthest_while_current_stays_ahead() {
        let (pool, data_dir) = banco_temporario("correcao-bib-010").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Consulta.pdf", b"conteudo consulta");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        // "Pulei para a última página só para consultar": current e
        // furthest avançam juntos até 0.95.
        repo.record_progress(livro.id, "400", 0.95).await.unwrap();

        // "Corrija para 62%": furthest desce, current continua onde estava.
        let corrigido = repo.correct_furthest_progress(livro.id, Some("260"), 0.62).await.unwrap();

        assert_eq!(corrigido.furthest_fraction, 0.62);
        assert_eq!(corrigido.furthest_locator.as_deref(), Some("260"));
        assert_eq!(corrigido.current_fraction, 0.95, "a posição atual não é tocada pela correção");
        assert_eq!(corrigido.current_locator.as_deref(), Some("400"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn correct_furthest_progress_rejects_an_out_of_range_fraction() {
        let (pool, data_dir) = banco_temporario("correcao-invalida").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "CorrecaoInvalida.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let result = repo.correct_furthest_progress(livro.id, None, -0.1).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- move_to_trash -------------------------------------------------

    #[tokio::test]
    async fn move_to_trash_trashes_the_page_instead_of_deleting_any_row_or_the_file() {
        let (pool, data_dir) = banco_temporario("remove-livro").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Removido.pdf", b"conteudo removido");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        repo.move_to_trash(livro.id).await.unwrap();

        let estante = repo.list_shelf().await.unwrap();
        assert!(estante.is_empty(), "livro cuja página foi trashed some da estante");

        // A linha continua existindo — nada foi de fato apagado.
        let ainda_existe: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books WHERE id = ?")
            .bind(livro.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ainda_existe, 1);
        assert!(media_dir.join(&livro.file_name).is_file(), "o arquivo em media/ não pode ser tocado por isto");

        let pagina_deletada: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?").bind(livro.page_id.db()).fetch_one(&pool).await.unwrap();
        assert!(pagina_deletada.is_some());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn move_to_trash_of_an_unknown_book_reports_not_found() {
        let (pool, data_dir) = banco_temporario("remove-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.move_to_trash(Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- delete_permanently ---------------------------------------------

    #[tokio::test]
    async fn delete_permanently_removes_the_row_the_file_and_everything_cascaded_when_already_trashed() {
        let (pool, data_dir) = banco_temporario("exclusao-definitiva").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Definitivo.pdf", b"conteudo definitivo");
        let importado = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
        let livro = importado.livro.clone();

        repo.create_annotation(livro.id, "bookmark", "1", None, 0.1, "", None, None).await.unwrap();
        repo.move_to_trash(livro.id).await.unwrap();
        let caminho_arquivo = media_dir.join(&livro.file_name);
        assert!(caminho_arquivo.is_file());

        repo.delete_permanently(&media_dir, livro.id).await.unwrap();

        assert!(!caminho_arquivo.exists(), "o arquivo precisa ter sido apagado de media/");

        let livros_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(livros_restantes, 0);
        let progresso_restante: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_reading_progress").fetch_one(&pool).await.unwrap();
        assert_eq!(progresso_restante, 0, "progresso precisa ter cascateado junto");
        let anotacoes_restantes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_annotations").fetch_one(&pool).await.unwrap();
        assert_eq!(anotacoes_restantes, 0, "anotação precisa ter cascateado junto");
        let paginas_restantes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = ?").bind(livro.page_id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(paginas_restantes, 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn delete_permanently_rejects_a_book_whose_page_is_still_active() {
        let (pool, data_dir) = banco_temporario("exclusao-sem-lixeira").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "AindaAtivo.pdf", b"conteudo ativo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        // NÃO passou por move_to_trash: a exclusão definitiva de um livro
        // ainda ativo na estante precisa ser recusada, não silenciosamente
        // aceita.
        let result = repo.delete_permanently(&media_dir, livro.id).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        assert!(media_dir.join(&livro.file_name).is_file(), "recusar a exclusão não pode ter apagado o arquivo");
        let ainda_existe: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books WHERE id = ?")
            .bind(livro.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ainda_existe, 1);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn delete_permanently_of_an_unknown_book_reports_not_found() {
        let (pool, data_dir) = banco_temporario("exclusao-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");

        let result = repo.delete_permanently(&media_dir, Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A borda que o arquivo não existir mais NÃO pode virar erro que trava
    /// a exclusão da linha — ponto explícito do pedido desta peça.
    #[tokio::test]
    async fn delete_permanently_still_removes_the_row_when_the_file_was_already_gone_from_disk() {
        let (pool, data_dir) = banco_temporario("exclusao-arquivo-sumido").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Sumido.pdf", b"conteudo sumido");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.move_to_trash(livro.id).await.unwrap();

        // O usuário mexeu na pasta media/ por fora do app.
        std::fs::remove_file(media_dir.join(&livro.file_name)).unwrap();

        repo.delete_permanently(&media_dir, livro.id).await.unwrap();

        let livros_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(livros_restantes, 0);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CENTRO do pedido de segurança desta peça: `file_name` é lido do
    /// banco como se fosse entrada hostil (a migração só garante que ele
    /// tem essa forma quando escrito por `import`; uma linha corrompida ou
    /// editada à mão à força é o que este teste simula com um `UPDATE`
    /// direto). Um `..` tentando escapar de `media/` precisa ser recusado
    /// ANTES de qualquer exclusão — nem o arquivo canário fora de `media/`,
    /// nem a linha do banco, podem ser tocados.
    #[tokio::test]
    async fn delete_permanently_refuses_a_file_name_that_tries_to_escape_media_dir() {
        let (pool, data_dir) = banco_temporario("exclusao-path-traversal").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Normal.pdf", b"conteudo normal");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.move_to_trash(livro.id).await.unwrap();

        // O canário: um arquivo FORA de media/ que a exclusão nunca deveria
        // conseguir alcançar.
        let canario = data_dir.join("segredo.txt");
        std::fs::write(&canario, b"nao pode sumir").unwrap();

        sqlx::query("UPDATE library_books SET file_name = ? WHERE id = ?")
            .bind("../segredo.txt")
            .bind(livro.id.db())
            .execute(&pool)
            .await
            .unwrap();

        let result = repo.delete_permanently(&media_dir, livro.id).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        assert!(canario.is_file(), "o arquivo fora de media/ não pode ter sido apagado");
        assert_eq!(std::fs::read(&canario).unwrap(), b"nao pode sumir");
        let ainda_existe: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books WHERE id = ?")
            .bind(livro.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ainda_existe, 1, "a linha também não pode ter sido apagada — a validação roda antes de tudo");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A MESMA defesa, no caminho de LEITURA — que é o que de fato entrega um
    /// caminho para a WebView carregar.
    ///
    /// Por um tempo só `delete_permanently` validava, e `open` montava
    /// `media_dir.join(file_name)` cru. `join` com caminho absoluto SUBSTITUI
    /// a base, então uma linha corrompida entregava um caminho de qualquer
    /// lugar do disco direto para o protocolo `asset:`.
    #[tokio::test]
    async fn open_refuses_a_file_name_that_tries_to_escape_media_dir() {
        let (pool, data_dir) = banco_temporario("abertura-path-traversal").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Normal.pdf", b"conteudo normal");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let canario = data_dir.join("segredo.txt");
        std::fs::write(&canario, b"nao pode vazar").unwrap();

        sqlx::query("UPDATE library_books SET file_name = ? WHERE id = ?")
            .bind("../segredo.txt")
            .bind(livro.id.db())
            .execute(&pool)
            .await
            .unwrap();

        let result = repo.open(&media_dir, livro.id).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Arquivo sumido do disco vira `NotFound` com mensagem, não um caminho
    /// para um arquivo inexistente — que só empurraria a falha para um erro
    /// opaco dentro do leitor.
    #[tokio::test]
    async fn open_reports_not_found_when_the_file_vanished_from_disk() {
        let (pool, data_dir) = banco_temporario("abertura-arquivo-sumido").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Normal.pdf", b"conteudo normal");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        std::fs::remove_file(media_dir.join(&livro.file_name)).unwrap();

        let result = repo.open(&media_dir, livro.id).await;
        assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O caminho feliz continua funcionando: livro íntegro abre e devolve um
    /// caminho DENTRO de `media/`.
    #[tokio::test]
    async fn open_returns_a_path_inside_the_media_dir() {
        let (pool, data_dir) = banco_temporario("abertura-feliz").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Normal.pdf", b"conteudo normal");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let aberto = repo.open(&media_dir, livro.id).await.unwrap();

        let real = std::fs::canonicalize(&aberto.caminho_absoluto).unwrap();
        let media_real = std::fs::canonicalize(&media_dir).unwrap();
        assert!(real.starts_with(&media_real), "o caminho aberto precisa estar dentro de media/, obtido {real:?}");

        // E o caminho ENTREGUE não pode ser o canônico: no Windows ele vem com
        // o prefixo de caminho estendido (`\\?\C:\...`), que não é o que o
        // `convertFileSrc` e o protocolo `asset:` esperam.
        assert!(
            !aberto.caminho_absoluto.starts_with(r"\\?\"),
            "o caminho entregue à tela não pode carregar o prefixo estendido do Windows, obtido {:?}",
            aberto.caminho_absoluto
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Segunda camada de defesa do pedido ("dois livros importados do mesmo
    /// arquivo apagariam a leitura um do outro"): mesmo que o invariante do
    /// banco (`content_hash UNIQUE`) hoje impeça duas linhas com o mesmo
    /// `file_name` de nascerem por `import`, o `COUNT` de dedupe é testado
    /// direto contra uma segunda linha inserida à mão — a checagem que
    /// protege esse cenário se ele algum dia deixar de ser impossível.
    #[tokio::test]
    async fn delete_permanently_keeps_the_file_when_another_book_row_still_names_it() {
        let (pool, data_dir) = banco_temporario("exclusao-arquivo-compartilhado").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Compartilhado.pdf", b"conteudo compartilhado");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.move_to_trash(livro.id).await.unwrap();

        // Uma segunda linha de livro apontando para o MESMO file_name —
        // inalcançável por `import` (content_hash é UNIQUE), inserida direto
        // para testar a defesa como se o invariante já tivesse sido furado.
        let segundo_id = Uuid::now_v7();
        let segunda_pagina = PageRepository::new(pool.clone()).create(None, "Segunda leitura").await.unwrap();
        sqlx::query(
            "INSERT INTO library_books (id, page_id, format, content_hash, file_name, original_file_name, file_size) \
             VALUES ($1, $2, 'pdf', $3, $4, 'outro.pdf', 10)",
        )
        .bind(segundo_id.db())
        .bind(segunda_pagina.id.db())
        .bind("a".repeat(64))
        .bind(&livro.file_name)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO library_reading_progress (book_id) VALUES ($1)")
            .bind(segundo_id.db())
            .execute(&pool)
            .await
            .unwrap();

        repo.delete_permanently(&media_dir, livro.id).await.unwrap();

        assert!(
            media_dir.join(&livro.file_name).is_file(),
            "a segunda linha ainda referencia o arquivo — ele não pode ter sido apagado"
        );
        let livros_restantes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(livros_restantes, 1, "só o livro excluído sai; a segunda linha fica");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- annotations ---------------------------------------------------

    #[tokio::test]
    async fn create_annotation_and_list_annotations_round_trip_in_reading_order() {
        let (pool, data_dir) = banco_temporario("anotacoes").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Anotado.epub", b"conteudo anotado");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        repo.create_annotation(
            livro.id,
            "highlight",
            "epubcfi(/6/8!/4/2:0)",
            Some("epubcfi(/6/8!/4/2:40)"),
            0.75,
            "trecho grifado depois",
            None,
            Some("#ffd54f"),
        )
        .await
        .unwrap();
        repo.create_annotation(
            livro.id,
            "bookmark",
            "epubcfi(/6/2!/4/2:0)",
            None,
            0.10,
            "",
            None,
            None,
        )
        .await
        .unwrap();

        let anotacoes = repo.list_annotations(livro.id).await.unwrap();
        assert_eq!(anotacoes.len(), 2);
        // Em ordem de leitura (fraction crescente), não de criação.
        assert_eq!(anotacoes[0].kind, "bookmark");
        assert_eq!(anotacoes[1].kind, "highlight");
        assert_eq!(anotacoes[1].color.as_deref(), Some("#ffd54f"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn create_annotation_rejects_an_unknown_kind() {
        let (pool, data_dir) = banco_temporario("anotacoes-kind-invalido").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "KindInvalido.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let result = repo
            .create_annotation(livro.id, "sublinhado", "1", None, 0.5, "", None, None)
            .await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn create_annotation_for_an_unknown_book_surfaces_the_foreign_key_as_a_database_error() {
        let (pool, data_dir) = banco_temporario("anotacoes-livro-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo
            .create_annotation(Uuid::now_v7(), "bookmark", "1", None, 0.1, "", None, None)
            .await;
        assert!(matches!(result, Err(Error::Database(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- definir_metadados_do_livro -------------------------------------

    #[tokio::test]
    async fn definir_metadados_do_livro_sets_title_and_author_trimmed() {
        let (pool, data_dir) = banco_temporario("metadados-define").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "The-Titan_s-Curse.pdf", b"conteudo do titan");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let atualizado = repo
            .definir_metadados_do_livro(livro.id, Some("  A Maldição do Titã  ".into()), Some("  Rick Riordan  ".into()))
            .await
            .unwrap();

        assert_eq!(atualizado.metadata_title.as_deref(), Some("A Maldição do Titã"));
        assert_eq!(atualizado.metadata_author.as_deref(), Some("Rick Riordan"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL da semântica de `None`: campo ausente não muda o valor
    /// já gravado.
    #[tokio::test]
    async fn definir_metadados_do_livro_none_does_not_change_the_existing_value() {
        let (pool, data_dir) = banco_temporario("metadados-none-mantem").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.definir_metadados_do_livro(livro.id, Some("Título Original".into()), Some("Autor Original".into()))
            .await
            .unwrap();

        // Só o autor muda desta vez; `None` no título precisa preservá-lo.
        let atualizado = repo.definir_metadados_do_livro(livro.id, None, Some("Autor Novo".into())).await.unwrap();

        assert_eq!(atualizado.metadata_title.as_deref(), Some("Título Original"), "título não podia ter mudado");
        assert_eq!(atualizado.metadata_author.as_deref(), Some("Autor Novo"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL da semântica de "apague": texto em branco (vazio ou só
    /// espaço) grava `NULL`, não a string em branco — a diferença que o
    /// pedido desta peça exigiu explicitamente.
    #[tokio::test]
    async fn definir_metadados_do_livro_blank_text_erases_the_field_to_null() {
        let (pool, data_dir) = banco_temporario("metadados-apaga").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.definir_metadados_do_livro(livro.id, Some("Título".into()), Some("Autor".into())).await.unwrap();

        let apagado = repo.definir_metadados_do_livro(livro.id, Some("   ".into()), Some("".into())).await.unwrap();

        assert_eq!(apagado.metadata_title, None, "título em branco precisa apagar para NULL, não gravar ''");
        assert_eq!(apagado.metadata_author, None, "autor em branco precisa apagar para NULL, não gravar ''");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Fecha o círculo com [`LivroNaEstante::from`]: apagar o título faz a
    /// estante voltar a mostrar o título derivado do arquivo — a opção que o
    /// pedido desta peça ofereceu como alternativa a recusar um título vazio.
    #[tokio::test]
    async fn erasing_the_title_makes_the_shelf_fall_back_to_the_file_derived_title() {
        let (pool, data_dir) = banco_temporario("metadados-apaga-volta-ao-arquivo").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Anatomia Humana.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;
        repo.definir_metadados_do_livro(livro.id, Some("Título Corrigido".into()), None).await.unwrap();
        assert_eq!(livro_na_estante(&repo, livro.id).await.titulo, "Título Corrigido");

        repo.definir_metadados_do_livro(livro.id, Some("".into()), None).await.unwrap();

        assert_eq!(
            livro_na_estante(&repo, livro.id).await.titulo,
            "Anatomia Humana",
            "título em branco precisa voltar ao nome derivado do arquivo"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_metadados_do_livro_rejects_text_past_the_length_cap() {
        let (pool, data_dir) = banco_temporario("metadados-titulo-longo").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let titulo_longo = "x".repeat(MAX_METADATA_TITLE_CHARS + 1);
        let result_titulo = repo.definir_metadados_do_livro(livro.id, Some(titulo_longo), None).await;
        assert!(matches!(result_titulo, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result_titulo:?}");

        let autor_longo = "x".repeat(MAX_METADATA_AUTHOR_CHARS + 1);
        let result_autor = repo.definir_metadados_do_livro(livro.id, None, Some(autor_longo)).await;
        assert!(matches!(result_autor, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result_autor:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_metadados_do_livro_of_an_unknown_book_reports_not_found() {
        let (pool, data_dir) = banco_temporario("metadados-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.definir_metadados_do_livro(Uuid::now_v7(), Some("Título".into()), None).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- mover_livro -----------------------------------------------------

    #[tokio::test]
    async fn mover_livro_to_the_start_when_apos_livro_id_is_none() {
        let (pool, data_dir) = banco_temporario("mover-para-inicio").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let um = escreve_arquivo_fonte(&data_dir, "Um.pdf", b"conteudo um");
        let dois = escreve_arquivo_fonte(&data_dir, "Dois.pdf", b"conteudo dois");
        let livro1 = repo.import(&media_dir, &um.to_string_lossy()).await.unwrap().livro;
        let livro2 = repo.import(&media_dir, &dois.to_string_lossy()).await.unwrap().livro;
        // Import entra no fim da fila: hoje `livro1` já vem antes de `livro2`.
        assert_eq!(repo.list_shelf().await.unwrap()[0].livro.id, livro1.id);

        repo.mover_livro(livro2.id, None).await.unwrap();

        let estante = repo.list_shelf().await.unwrap();
        assert_eq!(estante[0].livro.id, livro2.id, "mover para o início precisa colocar livro2 primeiro");
        assert_eq!(estante[1].livro.id, livro1.id);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_livro_after_a_specific_sibling() {
        let (pool, data_dir) = banco_temporario("mover-apos-irmao").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let a = repo.import(&media_dir, &escreve_arquivo_fonte(&data_dir, "A.pdf", b"a").to_string_lossy()).await.unwrap().livro;
        let b = repo.import(&media_dir, &escreve_arquivo_fonte(&data_dir, "B.pdf", b"b").to_string_lossy()).await.unwrap().livro;
        let c = repo.import(&media_dir, &escreve_arquivo_fonte(&data_dir, "C.pdf", b"c").to_string_lossy()).await.unwrap().livro;
        // Ordem de importação: A, B, C.

        // Move C para logo depois de A: A, C, B.
        repo.mover_livro(c.id, Some(a.id)).await.unwrap();

        let ids: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
        assert_eq!(ids, vec![a.id, c.id, b.id]);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL de segurança: mover um livro para depois DELE MESMO não
    /// pode quebrar nem embaralhar a estante — o livro sendo movido é
    /// excluído da lista de vizinhos antes da busca por `apos_livro_id`.
    #[tokio::test]
    async fn mover_livro_rejects_moving_after_itself() {
        let (pool, data_dir) = banco_temporario("mover-apos-si-mesmo").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let result = repo.mover_livro(livro.id, Some(livro.id)).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        // A estante não pode ter sido embaralhada pela tentativa recusada.
        let estante = repo.list_shelf().await.unwrap();
        assert_eq!(estante.len(), 1);
        assert_eq!(estante[0].livro.position, livro.position);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_livro_rejects_an_apos_livro_id_that_does_not_exist() {
        let (pool, data_dir) = banco_temporario("mover-apos-inexistente").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let origem = escreve_arquivo_fonte(&data_dir, "Livro.pdf", b"conteudo");
        let livro = repo.import(&media_dir, &origem.to_string_lossy()).await.unwrap().livro;

        let result = repo.mover_livro(livro.id, Some(Uuid::now_v7())).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_livro_of_an_unknown_id_reports_not_found() {
        let (pool, data_dir) = banco_temporario("mover-desconhecido").await;
        let repo = BibliotecaRepository::new(pool.clone());

        let result = repo.mover_livro(Uuid::now_v7(), None).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Um livro na lixeira não é vizinho válido: `apos_livro_id` apontando
    /// para ele é recusado, do mesmo jeito que um id que nunca existiu.
    #[tokio::test]
    async fn mover_livro_rejects_an_apos_livro_id_that_is_trashed() {
        let (pool, data_dir) = banco_temporario("mover-apos-lixeira").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let ativo = repo.import(&media_dir, &escreve_arquivo_fonte(&data_dir, "Ativo.pdf", b"a").to_string_lossy()).await.unwrap().livro;
        let na_lixeira =
            repo.import(&media_dir, &escreve_arquivo_fonte(&data_dir, "NaLixeira.pdf", b"b").to_string_lossy()).await.unwrap().livro;
        repo.move_to_trash(na_lixeira.id).await.unwrap();

        let result = repo.mover_livro(ativo.id, Some(na_lixeira.id)).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Reordena três livros e lê de volta na ordem EXATA — o cenário do
    /// pedido (dois "Percy Jackson" na ordem certa da série), com um terceiro
    /// livro para provar que a reordenação não perturba quem não foi movido.
    #[tokio::test]
    async fn reordering_three_books_round_trips_in_the_exact_order() {
        let (pool, data_dir) = banco_temporario("reordena-tres").await;
        let repo = BibliotecaRepository::new(pool.clone());
        let media_dir = data_dir.join("media");
        let ladrao = repo
            .import(&media_dir, &escreve_arquivo_fonte(&data_dir, "Percy-Jackson-1.pdf", b"o ladrao de raios").to_string_lossy())
            .await
            .unwrap()
            .livro;
        let mar = repo
            .import(&media_dir, &escreve_arquivo_fonte(&data_dir, "Percy-Jackson-2.pdf", b"o mar de monstros").to_string_lossy())
            .await
            .unwrap()
            .livro;
        let maldicao = repo
            .import(&media_dir, &escreve_arquivo_fonte(&data_dir, "Percy-Jackson-3.pdf", b"a maldicao do titan").to_string_lossy())
            .await
            .unwrap()
            .livro;
        // Ordem de importação: ladrão, mar, maldição — já a ordem certa por
        // acidente; embaralha primeiro para provar que `mover_livro` corrige.
        repo.mover_livro(maldicao.id, None).await.unwrap();
        repo.mover_livro(ladrao.id, None).await.unwrap();
        let embaralhada: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
        assert_eq!(embaralhada, vec![ladrao.id, maldicao.id, mar.id]);

        // Corrige para a ordem da série: ladrão, mar, maldição.
        repo.mover_livro(mar.id, Some(ladrao.id)).await.unwrap();
        repo.mover_livro(maldicao.id, Some(mar.id)).await.unwrap();

        // Duas leituras seguidas devolvem a MESMA ordem — a posição é dado
        // persistido, não recalculada a cada leitura.
        let primeira_leitura: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
        let segunda_leitura: Vec<Uuid> = repo.list_shelf().await.unwrap().into_iter().map(|e| e.livro.id).collect();
        assert_eq!(primeira_leitura, vec![ladrao.id, mar.id, maldicao.id]);
        assert_eq!(primeira_leitura, segunda_leitura, "duas leituras da estante precisam devolver a mesma ordem");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
