//! Repositório de categorias de livro — `library_categories` e a junção
//! `library_book_categories` (`0033_biblioteca_categoria_capitulo_vocabulario.sql`,
//! seção A).
//!
//! DECISÃO sobre nome duplicado (ignorando caixa e acento): a migração já
//! modela a checagem como gatilho `BEFORE INSERT`/`BEFORE UPDATE OF name`
//! com `RAISE(ABORT, 'library_categories.name duplicado (ignorando caixa e
//! acento)')` — a mesma técnica de `library_vocabulary.term`
//! (`db::vocabulario`). A diferença aqui é que o PEDIDO desta peça exige que
//! a mensagem de erro diga QUAL categoria já ocupa o nome, e a mensagem do
//! `RAISE(ABORT, ...)` não carrega esse dado (só o nome da coluna). Por
//! isso, ao contrário de `vocabulario::coletar` (que deixa a violação do
//! gatilho subir crua como `Error::Database`), `criar`/`renomear` fazem a
//! MESMA busca por frase no índice FTS5 auxiliar ANTES de escrever — a
//! técnica de duplicata continua sendo só uma (a do índice FTS5 e o `MATCH`
//! de frase entre aspas que a migração já usa no gatilho), só que executada
//! aqui em vez de deixada para o gatilho, para poder nomear a categoria
//! conflitante em `Error::Invalid`. O gatilho continua existindo e continua
//! sendo a garantia de verdade (ele pega qualquer escrita que não passe por
//! este repositório); esta pré-checagem só existe para dar uma mensagem
//! melhor no caminho normal.
//!
//! DECISÃO sobre "a estante precisa filtrar" (ver o pedido desta peça):
//! `listar_categorias_por_livro` devolve UMA lista com um item por livro que
//! tem ao menos uma categoria — a "forma à prova de N+1" que
//! `RelationRepository::list_relation_targets_bulk` já usa em
//! `db::relations` (`RecordTargets`: um item por `record_id`, um `JOIN` só) —
//! em vez de acrescentar campo a `LivroNaEstante`. Dois motivos: (1)
//! `LivroNaEstante`/`EstanteRow` (`db::biblioteca`) já são lidas por
//! `list_shelf`/`get_shelf_entry` com um `JOIN` fixo de duas tabelas: somar
//! categorias ali significaria um terceiro `JOIN` (1:N, ao contrário dos
//! dois primeiros que são 1:1) multiplicando linha por categoria, e
//! `sqlx::FromRow` não desduplica isso sozinho — exigiria reagrupar na volta
//! de qualquer forma, só que dentro de um método já grande e já bem
//! testado; (2) `LivroNaEstante` atravessa o contrato de IPC fixado
//! (`src/lib/contrato-ipc.test.ts`) que este agente NÃO pode editar
//! (`src/lib/ipc.ts` é proibido) — Acrescentar campo ali quebraria aquele
//! teste até quem registra os comandos atualizar o lado TypeScript à mão. Um
//! comando novo, aditivo, não corre esse risco.
//!
//! ## Categoria dentro de categoria (`0036_categoria_aninhada.sql`)
//!
//! DECISÃO D1 (filtrar por um pai alcança os livros dos filhos): a expansão
//! roda AQUI, em SQL, com `WITH RECURSIVE` (`Self::listar_livros_da_categoria`),
//! não na tela expandindo a árvore que já tem em memória. Este agente só
//! edita os três arquivos desta peça (migração, este repositório, o comando
//! IPC) — empurrar a expansão para o TypeScript exigiria tocar em código que
//! não está no escopo desta peça, e uma consulta que já devolve a resposta
//! certa não faz a próxima tela ter que reimplementar a mesma travessia.
//!
//! DECISÃO D3 (nome único entre IRMÃOS, não mais no banco inteiro): a técnica
//! de duplicata continua sendo UMA só — o índice FTS5 auxiliar e o `MATCH` de
//! frase entre aspas que a migração 0033 já usa — só que agora com um `JOIN`
//! de volta em `library_categories` filtrando por `parent_id IS $n` (ver o
//! comentário de `0036_categoria_aninhada.sql` para as duas técnicas
//! consideradas e por que o `JOIN` venceu). `Self::find_duplicate_by_name`
//! ganhou um parâmetro `parent_id` por isso; os gatilhos da migração
//! continuam sendo a garantia de verdade por baixo.
//!
//! DECISÃO D4 (apagar um pai que tem filho): RECUSAR, com a contagem de
//! filhos na mensagem — `Self::remover` checa isso ANTES de qualquer
//! `DELETE`. A alternativa (promover os filhos ao avô) foi descartada porque
//! colide com D3: o avô pode já ter uma categoria com o mesmo nome de uma
//! sendo promovida, e essa decisão não é algo que o usuário pediu nem teria
//! como prever antes de apagar. `ON DELETE RESTRICT` na coluna (migração) é
//! o segundo cinto, para o caso de um caminho de escrita futuro pular este
//! repositório.
//!
//! CICLO (mover "Fantasia" para dentro de "Épico", que já está dentro de
//! "Fantasia"): barrado em `Self::mover` via `Self::is_within_subtree`, com
//! teste. Ver o comentário daquela função para o porquê de uma `REFERENCES`
//! não conseguir enxergar (e portanto não conseguir barrar) um ciclo no
//! grafo que ela mesma referencia.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

/// Não vem da migração (que não limita comprimento de TEXT); existe porque
/// `criar_categoria`/`renomear_categoria` são comandos de IPC, alcançáveis
/// por script na WebView — entrada hostil por padrão, mesmo motivo do teto
/// de `vocabulario::MAX_TERM_CHARS`.
const MAX_NAME_CHARS: usize = 200;

/// Teto de profundidade para todo `WITH RECURSIVE` que sobe ou desce a
/// árvore de categorias (`Self::is_within_subtree`,
/// `Self::listar_livros_da_categoria`). Em uso normal a recursão termina
/// muito antes disso, pelo fim natural da árvore — este número não é uma
/// regra de produto (D2 é profundidade LIVRE), é uma rede de segurança para
/// o dia em que um ciclo entrar no banco por um caminho que não passa por
/// este repositório (edição direta em `sqlite3`, um bug futuro): sem teto,
/// `WITH RECURSIVE` sobre um grafo com ciclo nunca esgota a fronteira e
/// trava a conexão (e a UI esperando por ela) para sempre, em vez de só
/// devolver uma lista truncada que alguém consegue investigar.
const MAX_CATEGORY_DEPTH: i64 = 1000;

const CATEGORY_COLUMNS: &str = "id, name, parent_id, position, created_at, updated_at";

/// Uma categoria de livro — `library_categories`. `parent_id` nulo é
/// categoria de raiz (mesma convenção de `PageRow::parent_id`).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Categoria {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub name: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub parent_id: Option<Uuid>,
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Linha de junção privada para [`CategoriaRepository::listar_categorias_por_livro`]:
/// a mesma forma de [`Categoria`], com o `book_id` da linha de
/// `library_book_categories` grudado ao lado — existe só para o `JOIN` ler
/// de uma consulta só; [`CategoriaRepository::listar_categorias_por_livro`]
/// reagrupa por livro na volta.
#[derive(Debug, Clone, sqlx::FromRow)]
struct CategoriaPorLivroRow {
    #[sqlx(try_from = "DbId")]
    livro_id: Uuid,
    #[sqlx(try_from = "DbId")]
    id: Uuid,
    name: String,
    #[sqlx(try_from = "DbIdOpt")]
    parent_id: Option<Uuid>,
    position: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// A fatia de [`CategoriaRepository::listar_categorias_por_livro`] referente
/// a UM livro — ver o comentário do módulo para o porquê desta forma em vez
/// de um campo novo em `LivroNaEstante`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriasDoLivro {
    pub livro_id: Uuid,
    pub categorias: Vec<Categoria>,
}

pub struct CategoriaRepository {
    pool: SqlitePool,
}

impl CategoriaRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `criar_categoria`. Nome vazio (ou só espaço) é recusado aqui, antes de
    /// qualquer consulta — o `CHECK` da migração pegaria o mesmo caso, mas
    /// só depois de uma viagem ao banco. `parent_id`, quando informado,
    /// precisa apontar para uma categoria que existe (checado aqui, com
    /// `Error::NotFound`, em vez de deixar subir cru o `Error::Database` da
    /// FK). Nome duplicado (ignorando caixa/acento) é recusado com o nome de
    /// QUEM já ocupa o nome ENTRE OS IRMÃOS do mesmo `parent_id` (D3) — ver o
    /// comentário do módulo.
    pub async fn criar(&self, name: &str, parent_id: Option<Uuid>) -> Result<Categoria> {
        validate_name(name)?;
        if let Some(parent_id) = parent_id {
            self.ensure_category_exists(parent_id).await?;
        }
        self.reject_if_duplicate_name(name, parent_id, None).await?;

        let new_position = self.next_position(parent_id).await?;
        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, Categoria>(&format!(
            "INSERT INTO library_categories (id, name, parent_id, position) VALUES ($1, $2, $3, $4) \
             RETURNING {CATEGORY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(name)
        .bind(parent_id.db())
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_categorias`, em ordem de `position`.
    pub async fn listar(&self) -> Result<Vec<Categoria>> {
        let rows = sqlx::query_as::<_, Categoria>(&format!(
            "SELECT {CATEGORY_COLUMNS} FROM library_categories ORDER BY position"
        ))
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// `renomear_categoria`. Mesma checagem de duplicata de [`Self::criar`],
    /// escopada ao `parent_id` ATUAL da categoria (renomear não move) e
    /// excluindo a própria linha (renomear só a caixa, ex. "Ficção" ->
    /// "ficção", não pode colidir consigo mesma).
    pub async fn renomear(&self, id: Uuid, name: &str) -> Result<Categoria> {
        validate_name(name)?;
        let atual = self.find_by_id(id).await?.ok_or_else(|| Error::NotFound(format!("categoria {id}")))?;
        self.reject_if_duplicate_name(name, atual.parent_id, Some(id)).await?;

        sqlx::query_as::<_, Categoria>(&format!(
            "UPDATE library_categories SET name = $2 WHERE id = $1 RETURNING {CATEGORY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("categoria {id}")))
    }

    /// `mover_categoria`. `novo_parent_id` nulo move para a raiz. Barra
    /// ciclo (mover para dentro de si mesma ou de sua própria subárvore) —
    /// ver [`Self::is_within_subtree`] para o porquê disso não dar para
    /// travar só com a `REFERENCES` da migração. A checagem de nome
    /// duplicado (D3) é refeita para o NOVO pai, pelo mesmo motivo de
    /// [`Self::renomear`]: mover para um pai que já tem um filho com este
    /// nome é a mesma colisão de nome, só que causada por trocar de pai em
    /// vez de trocar de nome.
    pub async fn mover(&self, id: Uuid, novo_parent_id: Option<Uuid>) -> Result<Categoria> {
        let categoria = self.find_by_id(id).await?.ok_or_else(|| Error::NotFound(format!("categoria {id}")))?;

        if let Some(candidato) = novo_parent_id {
            if candidato == id {
                return Err(Error::Invalid("não é possível mover uma categoria para dentro de si mesma".into()));
            }
            self.ensure_category_exists(candidato).await?;
            if self.is_within_subtree(id, candidato).await? {
                return Err(Error::Invalid(
                    "não é possível mover uma categoria para dentro de sua própria subárvore".into(),
                ));
            }
        }

        self.reject_if_duplicate_name(&categoria.name, novo_parent_id, Some(id)).await?;

        let new_position = self.next_position(novo_parent_id).await?;

        let row = sqlx::query_as::<_, Categoria>(&format!(
            "UPDATE library_categories SET parent_id = $2, position = $3 WHERE id = $1 RETURNING {CATEGORY_COLUMNS}"
        ))
        .bind(id.db())
        .bind(novo_parent_id.db())
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `remover_categoria`. D4: RECUSA enquanto a categoria tiver
    /// subcategoria — ver o comentário do módulo para o porquê (promover ao
    /// avô colidiria com D3). Só depois dessa checagem a linha da categoria e
    /// suas ligações em `library_book_categories` caem (`ON DELETE CASCADE`,
    /// seção A da migração 0033) — nenhum livro é apagado, porque a FK dali
    /// corre na direção oposta (a junção referencia o livro, não o
    /// contrário).
    pub async fn remover(&self, id: Uuid) -> Result<()> {
        let filhos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_categories WHERE parent_id = $1")
            .bind(id.db())
            .fetch_one(&self.pool)
            .await?;
        if filhos > 0 {
            return Err(Error::Invalid(format!(
                "não é possível remover: esta categoria tem {filhos} subcategoria(s); mova-as ou remova-as primeiro"
            )));
        }

        let result =
            sqlx::query("DELETE FROM library_categories WHERE id = $1").bind(id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("categoria {id}")));
        }
        Ok(())
    }

    /// `definir_categorias_do_livro`. Substitui o conjunto INTEIRO numa
    /// transação só: apaga as ligações atuais e insere as novas. Um
    /// `category_id` que não existe surge como o `Error::Database` da FK de
    /// `library_book_categories.category_id` — e, por estar dentro da
    /// transação, faz a função inteira retornar antes de `tx.commit()`, o
    /// que descarta TAMBÉM o `DELETE` e qualquer `INSERT` anterior a ele já
    /// executado nesta mesma transação (um `sqlx::Transaction` que sai de
    /// escopo sem `commit()` faz `ROLLBACK` sozinho) — por isso um segundo
    /// id inválido numa lista de dois invalida o primeiro também, e as
    /// ligações antigas continuam de pé.
    ///
    /// `livro_id` que não existe é recusado ANTES de tocar qualquer ligação
    /// (`Self::ensure_book_exists`): sem essa checagem, uma lista vazia para
    /// um livro inexistente faria `DELETE ... WHERE book_id = $1` afetar
    /// zero linhas silenciosamente e a função devolveria sucesso para um
    /// livro que não existe.
    pub async fn definir_categorias_do_livro(&self, livro_id: Uuid, category_ids: &[Uuid]) -> Result<()> {
        self.ensure_book_exists(livro_id).await?;

        let mut tx = self.pool.begin().await?;

        sqlx::query("DELETE FROM library_book_categories WHERE book_id = $1")
            .bind(livro_id.db())
            .execute(&mut *tx)
            .await?;

        for category_id in category_ids {
            sqlx::query("INSERT INTO library_book_categories (book_id, category_id) VALUES ($1, $2)")
                .bind(livro_id.db())
                .bind(category_id.db())
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    /// `listar_categorias_do_livro`, em ordem de `position`. Um `livro_id`
    /// desconhecido devolve lista vazia, não erro — mesma escolha de
    /// `VocabularioRepository::listar_do_livro` para o mesmo formato de
    /// consulta (um `SELECT ... WHERE` simples não tem como distinguir "livro
    /// existe mas está sem categoria" de "livro não existe", e a tela de
    /// categorias de um livro não precisa dessa distinção — quem precisa
    /// saber se o livro existe é a tela de abrir o livro, `abrir_livro`).
    pub async fn listar_categorias_do_livro(&self, livro_id: Uuid) -> Result<Vec<Categoria>> {
        let rows = sqlx::query_as::<_, Categoria>(
            "SELECT c.id, c.name, c.parent_id, c.position, c.created_at, c.updated_at \
             FROM library_categories c \
             JOIN library_book_categories bc ON bc.category_id = c.id \
             WHERE bc.book_id = $1 \
             ORDER BY c.position",
        )
        .bind(livro_id.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// A consulta que alimenta a estante sem uma consulta por livro — ver o
    /// comentário do módulo. Só livros com AO MENOS uma categoria aparecem
    /// no resultado; a tela trata ausência como "sem categoria", exatamente
    /// como trataria uma lista vazia.
    pub async fn listar_categorias_por_livro(&self) -> Result<Vec<CategoriasDoLivro>> {
        let rows = sqlx::query_as::<_, CategoriaPorLivroRow>(
            "SELECT bc.book_id AS livro_id, c.id, c.name, c.parent_id, c.position, c.created_at, c.updated_at \
             FROM library_book_categories bc \
             JOIN library_categories c ON c.id = bc.category_id \
             ORDER BY bc.book_id, c.position",
        )
        .fetch_all(&self.pool)
        .await?;

        // As linhas já chegam ordenadas por `livro_id`, então agrupar é só
        // olhar se a última entrada aberta é do mesmo livro da linha atual —
        // sem precisar de um `HashMap` intermediário nem de reordenar nada.
        let mut agrupado: Vec<CategoriasDoLivro> = Vec::new();
        for row in rows {
            let categoria = Categoria {
                id: row.id,
                name: row.name,
                parent_id: row.parent_id,
                position: row.position,
                created_at: row.created_at,
                updated_at: row.updated_at,
            };
            match agrupado.last_mut() {
                Some(atual) if atual.livro_id == row.livro_id => atual.categorias.push(categoria),
                _ => agrupado.push(CategoriasDoLivro { livro_id: row.livro_id, categorias: vec![categoria] }),
            }
        }

        Ok(agrupado)
    }

    async fn ensure_book_exists(&self, livro_id: Uuid) -> Result<()> {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM library_books WHERE id = $1").bind(livro_id.db()).fetch_optional(&self.pool).await?;

        if exists.is_none() {
            return Err(Error::NotFound(format!("livro {livro_id}")));
        }
        Ok(())
    }

    /// Categoria-pai inexistente é recusada com `Error::NotFound` ANTES de
    /// tocar o banco de escrita — sem isso, o `INSERT`/`UPDATE` ainda seria
    /// recusado (a `REFERENCES` da migração garante isso), só que como um
    /// `Error::Database` cru em vez de uma mensagem que nomeia o problema.
    async fn ensure_category_exists(&self, id: Uuid) -> Result<()> {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM library_categories WHERE id = $1").bind(id.db()).fetch_optional(&self.pool).await?;

        if exists.is_none() {
            return Err(Error::NotFound(format!("categoria pai {id}")));
        }
        Ok(())
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Categoria>> {
        let row =
            sqlx::query_as::<_, Categoria>(&format!("SELECT {CATEGORY_COLUMNS} FROM library_categories WHERE id = $1"))
                .bind(id.db())
                .fetch_optional(&self.pool)
                .await?;
        Ok(row)
    }

    /// Verdadeiro se `candidate` é `ancestor` ou está na subárvore de
    /// `ancestor` — a checagem de ciclo por trás de [`Self::mover`].
    ///
    /// POR QUE O SCHEMA SOZINHO NÃO BARRA ISSO: `parent_id REFERENCES
    /// library_categories(id)` garante que todo pai referenciado EXISTE, mas
    /// uma foreign key não enxerga o grafo formado pela própria coluna que
    /// ela referencia — nada na declaração da tabela impede que A aponte
    /// para B e B aponte de volta para A (ou para qualquer ancestral de A).
    /// É exatamente esse o caso que travaria a árvore: mover "Fantasia" para
    /// dentro de "Épico", que já está dentro de "Fantasia", produziria um
    /// `parent_id` circular, e qualquer consulta recursiva subindo ou
    /// descendo essa cadeia nunca acharia uma raiz (`parent_id IS NULL`)
    /// para parar — giraria para sempre. Por isso a checagem entra aqui, no
    /// caminho de escrita, ANTES do `UPDATE` que criaria o ciclo.
    ///
    /// `MAX_CATEGORY_DEPTH` como teto de `depth`: ver o comentário da
    /// constante — esta consulta só roda quando ainda não existe ciclo
    /// nenhum (é o guarda que impede o primeiro), então em uso normal ela
    /// termina bem antes do teto, pelo fim natural da árvore.
    async fn is_within_subtree(&self, ancestor: Uuid, candidate: Uuid) -> Result<bool> {
        let exists: bool = sqlx::query_scalar(
            "WITH RECURSIVE descendentes(id, depth) AS ( \
                 SELECT id, 0 FROM library_categories WHERE id = $1 \
                 UNION ALL \
                 SELECT c.id, d.depth + 1 FROM library_categories c \
                 JOIN descendentes d ON c.parent_id = d.id \
                 WHERE d.depth < $3 \
             ) \
             SELECT EXISTS (SELECT 1 FROM descendentes WHERE id = $2)",
        )
        .bind(ancestor.db())
        .bind(candidate.db())
        .bind(MAX_CATEGORY_DEPTH)
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    /// D1: filtrar a estante por `category_id` precisa alcançar os livros
    /// guardados em qualquer descendente dela, não só nos filhos diretos —
    /// sem isso, um pai com todo livro guardado um nível abaixo apareceria
    /// como uma pasta vazia. `category_id` desconhecido devolve lista vazia
    /// (mesma convenção de [`Self::listar_categorias_do_livro`] para um
    /// `livro_id` desconhecido) — a âncora do `WITH RECURSIVE` simplesmente
    /// não acha linha nenhuma para começar. Teto de profundidade: ver o
    /// comentário de [`Self::is_within_subtree`], mesmo motivo, mesma
    /// constante.
    pub async fn listar_livros_da_categoria(&self, category_id: Uuid) -> Result<Vec<Uuid>> {
        let rows: Vec<DbId> = sqlx::query_scalar(
            "WITH RECURSIVE categoria_e_descendentes(id, depth) AS ( \
                 SELECT id, 0 FROM library_categories WHERE id = $1 \
                 UNION ALL \
                 SELECT c.id, cd.depth + 1 FROM library_categories c \
                 JOIN categoria_e_descendentes cd ON c.parent_id = cd.id \
                 WHERE cd.depth < $2 \
             ) \
             SELECT DISTINCT bc.book_id \
             FROM library_book_categories bc \
             JOIN categoria_e_descendentes cd ON cd.id = bc.category_id",
        )
        .bind(category_id.db())
        .bind(MAX_CATEGORY_DEPTH)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(Uuid::from).collect())
    }

    /// Acha a categoria que já ocupa `name` (ignorando caixa e acento) ENTRE
    /// OS IRMÃOS de `parent_id` (D3), excluindo `excluding_id` (a própria
    /// linha, ao renomear/mover). Usa o MESMO índice FTS5 auxiliar e a MESMA
    /// sintaxe de frase entre aspas que o gatilho
    /// `library_categories_name_unico_insert`/`_update` da migração usa —
    /// não é uma segunda técnica de duplicata, é a mesma consulta, com o
    /// mesmo `JOIN` de volta em `library_categories` que a migração 0036
    /// documenta, só executada aqui em vez de dentro do gatilho, para poder
    /// devolver o nome de quem já ocupa o lugar em vez de só um
    /// `RAISE(ABORT, ...)` genérico.
    async fn find_duplicate_by_name(
        &self,
        name: &str,
        parent_id: Option<Uuid>,
        excluding_id: Option<Uuid>,
    ) -> Result<Option<Categoria>> {
        let phrase = fts_match_phrase(name);

        let found_id: Option<DbId> = match excluding_id {
            Some(excluding_id) => {
                sqlx::query_scalar(
                    "SELECT library_categories_name_fts.id FROM library_categories_name_fts \
                     JOIN library_categories c ON c.id = library_categories_name_fts.id \
                     WHERE library_categories_name_fts MATCH $1 \
                       AND c.parent_id IS $2 \
                       AND library_categories_name_fts.id != $3",
                )
                .bind(&phrase)
                .bind(parent_id.db())
                .bind(excluding_id.db())
                .fetch_optional(&self.pool)
                .await?
            }
            None => {
                sqlx::query_scalar(
                    "SELECT library_categories_name_fts.id FROM library_categories_name_fts \
                     JOIN library_categories c ON c.id = library_categories_name_fts.id \
                     WHERE library_categories_name_fts MATCH $1 \
                       AND c.parent_id IS $2",
                )
                .bind(&phrase)
                .bind(parent_id.db())
                .fetch_optional(&self.pool)
                .await?
            }
        };

        match found_id {
            Some(id) => {
                let categoria = sqlx::query_as::<_, Categoria>(&format!(
                    "SELECT {CATEGORY_COLUMNS} FROM library_categories WHERE id = $1"
                ))
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| Error::NotFound(format!("categoria {}", Uuid::from(id))))?;
                Ok(Some(categoria))
            }
            None => Ok(None),
        }
    }

    async fn reject_if_duplicate_name(&self, name: &str, parent_id: Option<Uuid>, excluding_id: Option<Uuid>) -> Result<()> {
        if let Some(existing) = self.find_duplicate_by_name(name, parent_id, excluding_id).await? {
            return Err(Error::Invalid(format!(
                "já existe uma categoria com este nome (ignorando caixa e acento) neste nível: {:?}",
                existing.name
            )));
        }
        Ok(())
    }

    /// Posição entre os IRMÃOS de `parent_id` — cada grupo de irmãos tem sua
    /// própria fila de posição, mesma técnica de `PageRepository::next_position_under`.
    /// Toda categoria hoje já tem `parent_id` nulo (categoria de raiz), então
    /// para o banco existente isso é exatamente a mesma fila global de antes.
    async fn next_position(&self, parent_id: Option<Uuid>) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT position FROM library_categories WHERE parent_id IS $1 ORDER BY position DESC LIMIT 1",
        )
        .bind(parent_id.db())
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(Error::Invalid("nome da categoria não pode ser vazio".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::Invalid(format!(
            "nome da categoria não pode passar de {MAX_NAME_CHARS} caracteres (recebido: {})",
            name.chars().count()
        )));
    }
    Ok(())
}

/// A mesma expressão de frase entre aspas que a migração usa dentro do
/// `RAISE(ABORT, ...)`: `'"' || replace(NEW.name, '"', '""') || '"'`, só que
/// montada em Rust para ligar como parâmetro em vez de concatenada em SQL.
/// Aspas internas do nome são escapadas dobrando (convenção de frase do
/// próprio FTS5), não removidas — mesma regra da migração.
fn fts_match_phrase(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
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
        std::env::temp_dir().join(format!("learno-categorias-test-{rotulo}-{}", Uuid::new_v4()))
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

    // --- criar -----------------------------------------------------------

    #[tokio::test]
    async fn criar_categoria_cria_com_posicao_de_primeiro_item() {
        let (pool, data_dir) = banco_temporario("criar-basico").await;
        let repo = CategoriaRepository::new(pool.clone());

        let categoria = repo.criar("Ficção", None).await.unwrap();

        assert_eq!(categoria.name, "Ficção");
        assert_eq!(categoria.position, position::first());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn criar_categoria_encadeia_posicao_apos_a_ultima() {
        let (pool, data_dir) = banco_temporario("criar-encadeado").await;
        let repo = CategoriaRepository::new(pool.clone());

        let primeira = repo.criar("Ficção", None).await.unwrap();
        let segunda = repo.criar("Não Ficção", None).await.unwrap();

        assert!(
            position::parse(&primeira.position).unwrap() < position::parse(&segunda.position).unwrap(),
            "a segunda categoria criada precisa ordenar depois da primeira"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn criar_categoria_rejects_a_blank_name() {
        let (pool, data_dir) = banco_temporario("criar-nome-vazio").await;
        let repo = CategoriaRepository::new(pool.clone());

        let vazio = repo.criar("", None).await;
        assert!(matches!(vazio, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {vazio:?}");

        let so_espaco = repo.criar("   ", None).await;
        assert!(matches!(so_espaco, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {so_espaco:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL do pedido: nome duplicado ignorando caixa/acento é
    /// recusado, e a mensagem diz QUAL categoria já ocupa o nome.
    #[tokio::test]
    async fn criar_categoria_rejects_a_duplicate_name_and_names_the_existing_category() {
        let (pool, data_dir) = banco_temporario("criar-duplicado").await;
        let repo = CategoriaRepository::new(pool.clone());

        repo.criar("Ficção Científica", None).await.unwrap();
        let segunda = repo.criar("ficcao cientifica", None).await;

        assert!(matches!(segunda, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {segunda:?}");
        let mensagem = format!("{}", segunda.unwrap_err());
        assert!(
            mensagem.contains("Ficção Científica"),
            "a mensagem precisa nomear a categoria que já ocupa o nome, obtido: {mensagem}"
        );

        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_categories").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 1, "a segunda criação não pode ter gravado nada");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- listar ------------------------------------------------------------

    #[tokio::test]
    async fn listar_categorias_returns_in_position_order() {
        let (pool, data_dir) = banco_temporario("listar-ordem").await;
        let repo = CategoriaRepository::new(pool.clone());

        repo.criar("Zoologia", None).await.unwrap();
        repo.criar("Anatomia", None).await.unwrap();

        let lista = repo.listar().await.unwrap();
        assert_eq!(lista.len(), 2);
        assert_eq!(lista[0].name, "Zoologia", "ordem é de posição de criação, não alfabética");
        assert_eq!(lista[1].name, "Anatomia");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- renomear ------------------------------------------------------------

    #[tokio::test]
    async fn renomear_categoria_changes_the_name() {
        let (pool, data_dir) = banco_temporario("renomear-basico").await;
        let repo = CategoriaRepository::new(pool.clone());

        let categoria = repo.criar("Ficção", None).await.unwrap();
        let renomeada = repo.renomear(categoria.id, "Ficção Científica").await.unwrap();

        assert_eq!(renomeada.name, "Ficção Científica");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn renomear_categoria_allows_changing_only_case_of_its_own_name() {
        let (pool, data_dir) = banco_temporario("renomear-propria-caixa").await;
        let repo = CategoriaRepository::new(pool.clone());

        let categoria = repo.criar("mitocôndria", None).await.unwrap();
        let renomeada = repo.renomear(categoria.id, "Mitocôndria").await;

        assert!(renomeada.is_ok(), "renomear só a caixa da própria categoria não pode colidir consigo mesma");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn renomear_categoria_rejects_colliding_with_another_categorys_name() {
        let (pool, data_dir) = banco_temporario("renomear-colide").await;
        let repo = CategoriaRepository::new(pool.clone());

        repo.criar("Ficção", None).await.unwrap();
        let outra = repo.criar("Biografia", None).await.unwrap();

        let result = repo.renomear(outra.id, "ficção").await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn renomear_categoria_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("renomear-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let result = repo.renomear(Uuid::now_v7(), "Nome Novo").await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- remover ------------------------------------------------------------

    #[tokio::test]
    async fn remover_categoria_deletes_the_link_but_not_the_book() {
        let (pool, data_dir) = banco_temporario("remover-cascata").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        let categoria = repo.criar("Ficção", None).await.unwrap();
        repo.definir_categorias_do_livro(livro_id, &[categoria.id]).await.unwrap();

        repo.remover(categoria.id).await.unwrap();

        let ligacoes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_book_categories").fetch_one(&pool).await.unwrap();
        assert_eq!(ligacoes, 0, "a ligação precisa cair com a categoria");

        let livro_ainda_existe: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_books WHERE id = $1").bind(livro_id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(livro_ainda_existe, 1, "remover categoria não pode apagar o livro");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn remover_categoria_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("remover-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let result = repo.remover(Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- definir_categorias_do_livro -----------------------------------

    #[tokio::test]
    async fn definir_categorias_do_livro_replaces_the_whole_set_atomically() {
        let (pool, data_dir) = banco_temporario("definir-substitui").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        let a = repo.criar("Ficção", None).await.unwrap();
        let b = repo.criar("Biografia", None).await.unwrap();
        let c = repo.criar("Ciência", None).await.unwrap();

        repo.definir_categorias_do_livro(livro_id, &[a.id, b.id]).await.unwrap();
        let primeiro_conjunto = repo.listar_categorias_do_livro(livro_id).await.unwrap();
        assert_eq!(primeiro_conjunto.len(), 2);

        repo.definir_categorias_do_livro(livro_id, &[c.id]).await.unwrap();
        let segundo_conjunto = repo.listar_categorias_do_livro(livro_id).await.unwrap();
        assert_eq!(segundo_conjunto.len(), 1);
        assert_eq!(segundo_conjunto[0].id, c.id, "o conjunto anterior precisa ter sido totalmente substituído");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL do pedido: numa lista de dois onde o SEGUNDO é
    /// inválido, o PRIMEIRO também não entra — a transação inteira é
    /// descartada, e o conjunto anterior de ligações continua de pé.
    #[tokio::test]
    async fn definir_categorias_do_livro_rejects_the_whole_list_when_the_second_id_is_invalid() {
        let (pool, data_dir) = banco_temporario("definir-segundo-invalido").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        let existente = repo.criar("Existente", None).await.unwrap();
        repo.definir_categorias_do_livro(livro_id, &[existente.id]).await.unwrap();

        let valida = repo.criar("Válida", None).await.unwrap();
        let invalida = Uuid::now_v7();

        let result = repo.definir_categorias_do_livro(livro_id, &[valida.id, invalida]).await;
        assert!(matches!(result, Err(Error::Database(_))), "esperava Error::Database (violação de FK), obtido {result:?}");

        // Prova que nem a PRIMEIRA (válida) entrou: o conjunto continua
        // sendo exatamente o de antes da chamada que falhou.
        let apos_falha = repo.listar_categorias_do_livro(livro_id).await.unwrap();
        assert_eq!(apos_falha.len(), 1);
        assert_eq!(apos_falha[0].id, existente.id, "o conjunto anterior precisa ter sobrevivido intacto");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_categorias_do_livro_rejects_an_unknown_book() {
        let (pool, data_dir) = banco_temporario("definir-livro-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let result = repo.definir_categorias_do_livro(Uuid::now_v7(), &[]).await;
        assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn definir_categorias_do_livro_with_an_empty_list_clears_all_links() {
        let (pool, data_dir) = banco_temporario("definir-lista-vazia").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_id = livro_de_teste(&pool, &data_dir, "Livro.pdf").await;

        let categoria = repo.criar("Ficção", None).await.unwrap();
        repo.definir_categorias_do_livro(livro_id, &[categoria.id]).await.unwrap();
        repo.definir_categorias_do_livro(livro_id, &[]).await.unwrap();

        let lista = repo.listar_categorias_do_livro(livro_id).await.unwrap();
        assert!(lista.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- listar_categorias_do_livro / listar_categorias_por_livro -------

    #[tokio::test]
    async fn listar_categorias_do_livro_of_an_unknown_book_returns_an_empty_list() {
        let (pool, data_dir) = banco_temporario("listar-do-livro-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let lista = repo.listar_categorias_do_livro(Uuid::now_v7()).await.unwrap();
        assert!(lista.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_categorias_por_livro_groups_by_book_and_omits_books_without_categories() {
        let (pool, data_dir) = banco_temporario("listar-por-livro").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_a = livro_de_teste(&pool, &data_dir, "Livro A.pdf").await;
        let livro_b = livro_de_teste(&pool, &data_dir, "Livro B.pdf").await;
        let _livro_sem_categoria = livro_de_teste(&pool, &data_dir, "Livro C.pdf").await;

        let ficcao = repo.criar("Ficção", None).await.unwrap();
        let biografia = repo.criar("Biografia", None).await.unwrap();
        repo.definir_categorias_do_livro(livro_a, &[ficcao.id, biografia.id]).await.unwrap();
        repo.definir_categorias_do_livro(livro_b, &[ficcao.id]).await.unwrap();

        let mapa = repo.listar_categorias_por_livro().await.unwrap();
        assert_eq!(mapa.len(), 2, "só livros com categoria aparecem no resultado");

        let entrada_a = mapa.iter().find(|entrada| entrada.livro_id == livro_a).unwrap();
        assert_eq!(entrada_a.categorias.len(), 2);

        let entrada_b = mapa.iter().find(|entrada| entrada.livro_id == livro_b).unwrap();
        assert_eq!(entrada_b.categorias.len(), 1);
        assert_eq!(entrada_b.categorias[0].id, ficcao.id);

        assert!(
            !mapa.iter().any(|entrada| entrada.livro_id == _livro_sem_categoria),
            "livro sem categoria não deve aparecer"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- categoria aninhada: pai, D3 (nome único por irmão) ---------------

    #[tokio::test]
    async fn criar_categoria_with_a_nonexistent_parent_is_rejected() {
        let (pool, data_dir) = banco_temporario("criar-pai-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let result = repo.criar("Épico", Some(Uuid::now_v7())).await;
        assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn criar_categoria_rejects_a_duplicate_name_among_siblings_varying_case_and_accent() {
        let (pool, data_dir) = banco_temporario("criar-duplicado-entre-irmaos").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        repo.criar("Épico", Some(fantasia.id)).await.unwrap();

        let segundo = repo.criar("epico", Some(fantasia.id)).await;
        assert!(matches!(segundo, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {segundo:?}");
        let mensagem = format!("{}", segundo.unwrap_err());
        assert!(mensagem.contains("Épico"), "a mensagem precisa nomear a subcategoria conflitante, obtido: {mensagem}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL de D3: o MESMO nome sob PAIS DIFERENTES é aceito — a
    /// prova de que a trava de nome único foi afrouxada exatamente no lugar
    /// certo (de "único no banco inteiro" para "único entre irmãos").
    #[tokio::test]
    async fn criar_categoria_allows_the_same_name_under_different_parents() {
        let (pool, data_dir) = banco_temporario("criar-mesmo-nome-pais-diferentes").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        let ficcao = repo.criar("Ficção", None).await.unwrap();

        let epico_em_fantasia = repo.criar("Épico", Some(fantasia.id)).await;
        assert!(epico_em_fantasia.is_ok(), "obtido: {epico_em_fantasia:?}");

        let epico_em_ficcao = repo.criar("Épico", Some(ficcao.id)).await;
        assert!(
            epico_em_ficcao.is_ok(),
            "o mesmo nome sob um pai DIFERENTE não pode colidir, obtido: {epico_em_ficcao:?}"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- mover -------------------------------------------------------------

    #[tokio::test]
    async fn mover_categoria_to_root_works() {
        let (pool, data_dir) = banco_temporario("mover-para-raiz").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        let epico = repo.criar("Épico", Some(fantasia.id)).await.unwrap();

        let movida = repo.mover(epico.id, None).await.unwrap();
        assert_eq!(movida.parent_id, None);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_categoria_rejects_moving_into_itself() {
        let (pool, data_dir) = banco_temporario("mover-para-si-mesma").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();

        let result = repo.mover(fantasia.id, Some(fantasia.id)).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O CASO CENTRAL do ciclo: mover "Fantasia" para dentro de "Épico", que
    /// já está dentro de "Fantasia", precisa ser recusado.
    #[tokio::test]
    async fn mover_categoria_rejects_moving_into_its_own_descendant() {
        let (pool, data_dir) = banco_temporario("mover-para-descendente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        let epico = repo.criar("Épico", Some(fantasia.id)).await.unwrap();

        let result = repo.mover(fantasia.id, Some(epico.id)).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        // A árvore precisa ter sobrevivido intacta: "Épico" continua onde
        // estava, não dentro de si mesmo nem em nenhum outro lugar.
        let recarregada = repo.listar().await.unwrap();
        let epico_apos = recarregada.iter().find(|c| c.id == epico.id).unwrap();
        assert_eq!(epico_apos.parent_id, Some(fantasia.id));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_categoria_rejects_an_unknown_new_parent() {
        let (pool, data_dir) = banco_temporario("mover-pai-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let fantasia = repo.criar("Fantasia", None).await.unwrap();

        let result = repo.mover(fantasia.id, Some(Uuid::now_v7())).await;
        assert!(matches!(result, Err(Error::NotFound(_))), "esperava Error::NotFound, obtido {result:?}");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn mover_categoria_reports_not_found_for_an_unknown_id() {
        let (pool, data_dir) = banco_temporario("mover-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let result = repo.mover(Uuid::now_v7(), None).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- remover com subcategoria (D4) --------------------------------------

    /// O CASO CENTRAL de D4: apagar um pai com filho é RECUSADO, e nenhum
    /// livro (do pai OU do filho) some.
    #[tokio::test]
    async fn remover_categoria_with_a_child_is_rejected_and_no_book_is_lost() {
        let (pool, data_dir) = banco_temporario("remover-com-filho").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_pai = livro_de_teste(&pool, &data_dir, "Pai.pdf").await;
        let livro_filho = livro_de_teste(&pool, &data_dir, "Filho.pdf").await;

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        let epico = repo.criar("Épico", Some(fantasia.id)).await.unwrap();
        repo.definir_categorias_do_livro(livro_pai, &[fantasia.id]).await.unwrap();
        repo.definir_categorias_do_livro(livro_filho, &[epico.id]).await.unwrap();

        let result = repo.remover(fantasia.id).await;
        assert!(matches!(result, Err(Error::Invalid(_))), "esperava Error::Invalid, obtido {result:?}");

        let ainda_existe: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_categories WHERE id = $1")
            .bind(fantasia.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ainda_existe, 1, "a categoria-pai recusada não pode ter sido apagada");

        let livros: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_books").fetch_one(&pool).await.unwrap();
        assert_eq!(livros, 2, "nenhum livro pode ter sumido");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // --- listar_livros_da_categoria (D1) -------------------------------

    /// O CASO CENTRAL de D1: filtrar por um pai alcança livro guardado só no
    /// NETO (dois níveis abaixo), não só no filho direto.
    #[tokio::test]
    async fn listar_livros_da_categoria_reaches_a_grandchild_books() {
        let (pool, data_dir) = banco_temporario("filtro-alcanca-neto").await;
        let repo = CategoriaRepository::new(pool.clone());
        let livro_no_neto = livro_de_teste(&pool, &data_dir, "NoNeto.pdf").await;
        let livro_fora = livro_de_teste(&pool, &data_dir, "Fora.pdf").await;

        let fantasia = repo.criar("Fantasia", None).await.unwrap();
        let epico = repo.criar("Épico", Some(fantasia.id)).await.unwrap();
        let alta_fantasia = repo.criar("Alta Fantasia", Some(epico.id)).await.unwrap();

        repo.definir_categorias_do_livro(livro_no_neto, &[alta_fantasia.id]).await.unwrap();
        repo.definir_categorias_do_livro(livro_fora, &[]).await.unwrap();

        let livros = repo.listar_livros_da_categoria(fantasia.id).await.unwrap();
        assert_eq!(livros, vec![livro_no_neto], "o filtro pelo avô precisa alcançar o livro do neto");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O teto de profundidade existindo no código não prova que ele funciona.
    ///
    /// `mover` recusa criar um ciclo, então o único jeito de exercitar a rede
    /// de segurança é fechar o ciclo POR FORA do repositório — que é
    /// exatamente o cenário para o qual ela foi escrita (uma edição direta no
    /// banco, um caminho de escrita futuro que não passe por aqui). A
    /// `REFERENCES` não impede: ela só exige que o id referenciado exista, e
    /// ele existe.
    ///
    /// Sem o teto, esta consulta gira para sempre e a tela do usuário TRAVA —
    /// não é um desenho estranho como o ciclo do mapa mental, é o app parando.
    /// Por isso o `timeout`: um teste que só afirmasse o valor de retorno
    /// ficaria pendurado junto com a consulta, e a suíte inteira morreria sem
    /// dizer o motivo.
    #[tokio::test]
    async fn um_ciclo_gravado_por_fora_nao_trava_a_consulta_recursiva() {
        let (pool, data_dir) = banco_temporario("ciclo-por-fora").await;
        let repo = CategoriaRepository::new(pool.clone());

        let a = repo.criar("A", None).await.unwrap();
        let b = repo.criar("B", Some(a.id)).await.unwrap();

        // O livro NÃO é decoração deste teste: sem nenhuma linha em
        // `library_book_categories`, o `JOIN` final não tem o que casar e o
        // SQLite nem chega a percorrer a recursão — o teste terminava rápido
        // por não exercitar nada, e passava mesmo com o teto de profundidade
        // removido. Medido: com um livro ligado e o teto em 100 milhões, a
        // consulta leva ~58s; com o teto real, 0,1s.
        let livro = livro_de_teste(&pool, &data_dir, "NoCiclo.pdf").await;
        repo.definir_categorias_do_livro(livro, &[b.id]).await.unwrap();

        // Fecha o ciclo: A passa a ser filha da própria filha.
        sqlx::query("UPDATE library_categories SET parent_id = $1 WHERE id = $2")
            .bind(b.id.db())
            .bind(a.id.db())
            .execute(&pool)
            .await
            .unwrap();

        let resultado = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            repo.listar_livros_da_categoria(a.id),
        )
        .await;

        assert!(resultado.is_ok(), "a consulta girou para sempre num ciclo — o teto de profundidade não está segurando");
        assert!(resultado.unwrap().is_ok(), "terminar é o que importa aqui; erro de SQL também seria uma falha de contrato");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[tokio::test]
    async fn listar_livros_da_categoria_of_an_unknown_category_returns_an_empty_list() {
        let (pool, data_dir) = banco_temporario("filtro-categoria-inexistente").await;
        let repo = CategoriaRepository::new(pool.clone());

        let livros = repo.listar_livros_da_categoria(Uuid::now_v7()).await.unwrap();
        assert!(livros.is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
