//! Como um `Uuid` atravessa a fronteira do SQLite — e por que ele não pode
//! atravessá-la sozinho.
//!
//! `sqlx-sqlite` codifica `Uuid` como **BLOB** de 16 bytes
//! (`sqlx-sqlite/src/types/uuid.rs`: `SqliteArgumentValue::Blob`), e decodifica
//! chamando `Uuid::from_slice` sobre os bytes crus da coluna. O schema desta
//! aplicação guarda id como **TEXT** canônico com hífens — decisão registrada
//! na tabela de equivalências de `docs/MIGRACAO-SQLITE.md`, tomada para o
//! arquivo continuar legível no `sqlite3` na hora de depurar, e obrigatória
//! para os gatilhos que extraem id de dentro de JSON (`json_extract` devolve
//! TEXT, e uma coluna BLOB numa tabela `STRICT` recusaria).
//!
//! As duas escolhas juntas quebram nos dois sentidos, e não em silêncio:
//!
//! - gravar: `cannot store BLOB value in TEXT column pages.id` (código 3091,
//!   porque as tabelas são `STRICT`);
//! - ler: `ColumnDecode { source: ParseByteLength { len: 36 } }` — os 36 bytes
//!   do texto chegando onde `Uuid::from_slice` espera 16.
//!
//! Este módulo é a ponte: [`DbId`] e [`DbIdOpt`] são TEXT dos dois lados.
//! Toda escrita liga id por [`IdBind::db`], e toda struct de leitura declara
//! `#[sqlx(try_from = "DbId")]` no campo. Uma peça só para revisar, em vez de
//! 151 lugares lembrando de chamar `.hyphenated()`.

use sqlx::encode::IsNull;
use sqlx::error::BoxDynError;
use sqlx::sqlite::{SqliteArgumentValue, SqliteTypeInfo, SqliteValueRef};
use sqlx::{Decode, Encode, Sqlite, Type, ValueRef};
use uuid::Uuid;

/// Um id não nulo, como TEXT canônico minúsculo com hífens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbId(pub Uuid);

impl From<DbId> for Uuid {
    fn from(id: DbId) -> Self {
        id.0
    }
}

impl From<Uuid> for DbId {
    fn from(id: Uuid) -> Self {
        DbId(id)
    }
}

impl Type<Sqlite> for DbId {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &SqliteTypeInfo) -> bool {
        <String as Type<Sqlite>>::compatible(ty)
    }
}

impl<'q> Encode<'q, Sqlite> for DbId {
    fn encode_by_ref(&self, args: &mut Vec<SqliteArgumentValue<'q>>) -> Result<IsNull, BoxDynError> {
        args.push(SqliteArgumentValue::Text(self.0.hyphenated().to_string().into()));
        Ok(IsNull::No)
    }
}

impl Decode<'_, Sqlite> for DbId {
    fn decode(value: SqliteValueRef<'_>) -> Result<Self, BoxDynError> {
        let text = <&str as Decode<Sqlite>>::decode(value)?;
        Ok(DbId(Uuid::parse_str(text)?))
    }
}

/// Um id que pode ser nulo — `parent_id` de uma página raiz, `database_id` de
/// uma página que não é registro de base.
///
/// Existe como tipo próprio porque `#[sqlx(try_from = "...")]` decodifica o
/// tipo nomeado e só então converte, e `Option<DbId>` não serve ali: a
/// conversão de volta para `Option<Uuid>` precisaria de um
/// `impl From<Option<DbId>> for Option<Uuid>`, que a regra do órfão recusa
/// (o tipo local ficaria coberto por `Option`). Com um tipo próprio, o `impl`
/// é direto e legal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbIdOpt(pub Option<Uuid>);

impl From<DbIdOpt> for Option<Uuid> {
    fn from(id: DbIdOpt) -> Self {
        id.0
    }
}

impl From<Option<Uuid>> for DbIdOpt {
    fn from(id: Option<Uuid>) -> Self {
        DbIdOpt(id)
    }
}

impl Type<Sqlite> for DbIdOpt {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &SqliteTypeInfo) -> bool {
        // `Null` precisa entrar aqui: `sqlx` confere compatibilidade contra o
        // tipo da coluna JÁ NA LINHA, e uma coluna nula se apresenta como
        // `Null`, não como `Text`. Sem isto, ler um `parent_id` vazio falharia
        // com incompatibilidade de tipo em vez de devolver `None`.
        value_is_null_type(ty) || <String as Type<Sqlite>>::compatible(ty)
    }
}

impl<'q> Encode<'q, Sqlite> for DbIdOpt {
    fn encode_by_ref(&self, args: &mut Vec<SqliteArgumentValue<'q>>) -> Result<IsNull, BoxDynError> {
        match self.0 {
            Some(id) => {
                args.push(SqliteArgumentValue::Text(id.hyphenated().to_string().into()));
                Ok(IsNull::No)
            }
            // Devolver `IsNull::Yes` SEM empurrar nada é obrigatório: o
            // `SqliteArguments::add` do sqlx empurra o `Null` ele mesmo quando
            // recebe essa resposta (e não trunca o que o `encode` tiver
            // deixado). Empurrar aqui também produziria DOIS argumentos para
            // um placeholder só, deslocando todos os seguintes — o sintoma
            // observado foi `NOT NULL constraint failed: pages.title` num
            // INSERT cujo título estava perfeitamente preenchido.
            None => Ok(IsNull::Yes),
        }
    }
}

impl Decode<'_, Sqlite> for DbIdOpt {
    fn decode(value: SqliteValueRef<'_>) -> Result<Self, BoxDynError> {
        if value.is_null() {
            return Ok(DbIdOpt(None));
        }
        let text = <&str as Decode<Sqlite>>::decode(value)?;
        Ok(DbIdOpt(Some(Uuid::parse_str(text)?)))
    }
}

/// `SqliteTypeInfo` não expõe o discriminante, então a checagem de "é o tipo
/// nulo?" passa pelo `Display` que ele implementa — `NULL` para uma coluna
/// nula. Feio, e mais estável que replicar o enum interno do sqlx.
fn value_is_null_type(ty: &SqliteTypeInfo) -> bool {
    use sqlx::TypeInfo;
    ty.name().eq_ignore_ascii_case("null")
}

/// Açúcar para o lado da escrita: `.bind(page_id.db())`.
///
/// O nome é curto de propósito — ele aparece em toda ligação de id do projeto,
/// e um nome longo faria a linha do `bind` virar duas.
pub trait IdBind {
    type Bound;

    /// O id na forma que o banco guarda.
    fn db(&self) -> Self::Bound;
}

impl IdBind for Uuid {
    type Bound = DbId;

    fn db(&self) -> DbId {
        DbId(*self)
    }
}

impl IdBind for Option<Uuid> {
    type Bound = DbIdOpt;

    fn db(&self) -> DbIdOpt {
        DbIdOpt(*self)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;

    async fn banco_em_memoria() -> sqlx::SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().in_memory(true).foreign_keys(true))
            .await
            .unwrap()
    }

    /// A prova do problema e da solução na mesma tabela `STRICT` que o schema
    /// de verdade usa: `Uuid` cru é recusado, `DbId` entra.
    #[tokio::test]
    async fn uuid_cru_e_recusado_por_uma_coluna_text_strict_e_dbid_nao() {
        let pool = banco_em_memoria().await;
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT").execute(&pool).await.unwrap();

        let id = Uuid::now_v7();

        let cru = sqlx::query("INSERT INTO t (id) VALUES (?)").bind(id).execute(&pool).await;
        let mensagem = format!("{:?}", cru.unwrap_err());
        assert!(mensagem.contains("BLOB"), "esperava a recusa de BLOB em coluna TEXT, obtido: {mensagem}");

        sqlx::query("INSERT INTO t (id) VALUES (?)").bind(id.db()).execute(&pool).await.unwrap();

        // E o texto gravado é a forma canônica com hífens, não outra
        // representação qualquer que por acaso volte igual no round-trip.
        let bruto: String = sqlx::query_scalar("SELECT id FROM t").fetch_one(&pool).await.unwrap();
        assert_eq!(bruto, id.hyphenated().to_string());
    }

    #[tokio::test]
    async fn dbid_volta_igual_ao_que_entrou() {
        let pool = banco_em_memoria().await;
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT").execute(&pool).await.unwrap();

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO t (id) VALUES (?)").bind(id.db()).execute(&pool).await.unwrap();

        let lido: DbId = sqlx::query_scalar("SELECT id FROM t").fetch_one(&pool).await.unwrap();
        assert_eq!(Uuid::from(lido), id);
    }

    /// Um `DbIdOpt` vazio precisa consumir EXATAMENTE um placeholder. O sqlx
    /// empurra o `Null` por conta própria quando o `encode` responde
    /// `IsNull::Yes`, então um `encode` que também empurrasse produziria dois
    /// argumentos para um placeholder só e deslocaria todos os seguintes —
    /// falha que aparece longe da causa, como uma coluna NOT NULL reclamando
    /// de um valor que o chamador preencheu direito.
    #[tokio::test]
    async fn id_nulo_consome_um_placeholder_so_e_nao_desloca_os_seguintes() {
        let pool = banco_em_memoria().await;
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, pai TEXT, titulo TEXT NOT NULL) STRICT")
            .execute(&pool)
            .await
            .unwrap();

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO t (id, pai, titulo) VALUES (?, ?, ?)")
            .bind(id.db())
            .bind(None::<Uuid>.db())
            .bind("Mitocôndria")
            .execute(&pool)
            .await
            .unwrap();

        let titulo: String = sqlx::query_scalar("SELECT titulo FROM t").fetch_one(&pool).await.unwrap();
        assert_eq!(titulo, "Mitocôndria");
    }

    #[tokio::test]
    async fn dbidopt_grava_e_le_nulo_como_none() {
        let pool = banco_em_memoria().await;
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, pai TEXT) STRICT").execute(&pool).await.unwrap();

        let filho = Uuid::now_v7();
        let pai = Uuid::now_v7();
        sqlx::query("INSERT INTO t (id, pai) VALUES (?, ?)").bind(pai.db()).bind(None::<Uuid>.db()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO t (id, pai) VALUES (?, ?)").bind(filho.db()).bind(Some(pai).db()).execute(&pool).await.unwrap();

        let linhas = sqlx::query("SELECT id, pai FROM t ORDER BY pai IS NULL DESC").fetch_all(&pool).await.unwrap();
        let raiz: DbIdOpt = linhas[0].try_get("pai").unwrap();
        let com_pai: DbIdOpt = linhas[1].try_get("pai").unwrap();

        assert_eq!(Option::<Uuid>::from(raiz), None);
        assert_eq!(Option::<Uuid>::from(com_pai), Some(pai));
    }

    /// A ligação por igualdade tem que casar com o que o gatilho de JSON
    /// grava: os dois lados são o mesmo TEXT. Se um dia alguém trocar o
    /// `Encode` por BLOB "só para gravar", esta busca deixa de achar a linha.
    #[tokio::test]
    async fn id_ligado_casa_com_o_mesmo_id_gravado_como_texto_puro() {
        let pool = banco_em_memoria().await;
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL) STRICT").execute(&pool).await.unwrap();

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO t (id) VALUES (?)")
            .bind(id.hyphenated().to_string())
            .execute(&pool)
            .await
            .unwrap();

        let achou: Option<DbId> =
            sqlx::query_scalar("SELECT id FROM t WHERE id = ?").bind(id.db()).fetch_optional(&pool).await.unwrap();
        assert_eq!(achou.map(Uuid::from), Some(id));
    }
}
