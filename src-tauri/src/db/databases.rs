//! Repository for the "Notion database" system's core scaffolding —
//! `databases`, `database_properties`, `database_views` (`0007_databases.sql`,
//! `0008_database_properties_views.sql`), plus the record (a page with
//! `database_id` set, `0009_database_record_values.sql`'s framing).
//!
//! Este é o pedaço que faltava entre o schema (nove migrações já aplicadas:
//! 0007..0009, 0017..0021, 0023) e tudo que já sabe LER esse schema —
//! `db::record_values` (valor), `db::relations` (aresta), `db::effects`
//! (motor de efeito) e `db::trilha` (view Trilha) todos assumem que uma
//! `databases`/`database_properties`/`database_views` já existe; nenhum
//! deles cria uma. Sem este arquivo, nenhuma tela consegue criar o primeiro
//! database, propriedade ou view — os únicos INSERTs contra essas três
//! tabelas, antes deste arquivo, eram fixture de teste (`db::pool`,
//! `db::relations::repository`, `ipc::formula_commands`,
//! `ipc::trilha_commands`).
//!
//! ## O que este arquivo NÃO faz
//!
//! - Não grava em `database_record_values` por SQL cru — o VALOR de um
//!   registro passa pelo caminho único de `db::record_values`
//!   (invariante I4), nunca por aqui. `list_records` só LÊ aquela tabela, o
//!   que é seguro (I4 restringe ESCRITA, e `db::trilha::fetch_step_bases`
//!   já lê a mesma tabela do mesmo jeito).
//! - Não cria `property_type = 'relation'`/`'rollup'`, nem muda um tipo
//!   existente de/para um dos dois — ver [`STRUCTURAL_PROPERTY_TYPES`] e o
//!   comentário de [`DatabaseRepository::change_property_type`] para o
//!   porquê: as duas têm tabela companheira (`database_relations`/
//!   `rollup_dependencies`) que só `db::relations::RelationRepository`
//!   (relation) ou o motor de rollup (D1, ainda não escrito neste crate)
//!   sabem manter consistente.
//! - Não escreve `trail_views` — criar a linha genérica em `database_views`
//!   com `view_type = 'trail'` é `create_view` deste arquivo; ligar essa
//!   view à configuração de raia é `TrilhaRepository::criar_trilha`
//!   (`db::trilha`), separado de propósito (o gatilho `BEFORE INSERT` de
//!   `0023` já exige que a view exista primeiro).
//! - Não apaga registro nem grava valor de célula por conta própria: um
//!   registro é uma página comum (`create_record` só chama
//!   `PageRepository::create_record`), então apagar um é
//!   `PageRepository::trash`/`permanently_delete`, já prontos.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::db::pages::{PageRepository, PageRow};
use crate::db::position;
use crate::db::record_values::RecordValueRow;
use crate::db::sql;
use crate::error::{Error, Result};

/// O conjunto fechado de `database_properties.property_type`.
/// `database_properties.property_type` é TEXT SEM CHECK — `0008` comenta
/// "Kept as text rather than an enum" de propósito, então a validação é só
/// aqui, e sem ela um typo grava um tipo que nenhuma tela sabe desenhar
/// (o mesmo risco que `0023` documenta para `view_type`).
///
/// A lista é a UNIÃO de duas fontes, porque nenhuma sozinha é o conjunto
/// completo:
/// - o comentário de `0008_database_properties_views.sql`: text, number,
///   select, multi_select, status, date, checkbox, url, files, formula,
///   relation, rollup, created_time, last_edited_time;
/// - os specs de fato registrados em `src/features/databases/properties/*`
///   (lido em 05/09/2026, `git grep "type: \""`), que acrescenta `person` —
///   ausente do comentário de `0008`.
///
/// `status` aparece no comentário de `0008` mas ainda não tem spec próprio
/// no frontend; fica no conjunto aceito porque o SCHEMA já o previu e
/// recusar um valor que a migração documenta seria mais surpreendente do
/// que aceitá-lo à toa.
pub const VALID_PROPERTY_TYPES: [&str; 15] = [
    "text",
    "number",
    "select",
    "multi_select",
    "status",
    "date",
    "checkbox",
    "url",
    "files",
    "person",
    "formula",
    "relation",
    "rollup",
    "created_time",
    "last_edited_time",
];

/// `relation` e `rollup` são os dois tipos com tabela companheira além de
/// `database_properties` — ver o comentário de topo do arquivo e
/// [`DatabaseRepository::change_property_type`].
const STRUCTURAL_PROPERTY_TYPES: [&str; 2] = ["relation", "rollup"];

/// O conjunto fechado de `database_views.view_type`.
///
/// `0008` comentava table/board/list/calendar/gallery/timeline — um
/// rascunho da versão Postgres. Duas fontes mais novas o substituem:
/// `src/features/databases/core/view-spec.ts` registra hoje só
/// table/board/list/calendar (comentário do próprio arquivo: "mesmo padrão
/// de `property-spec.ts` ... para `table`/`board`/`list`/`calendar`" —
/// nem gallery nem timeline aparecem), e `0023_trilha.sql` registra
/// `trail` como "o QUINTO tipo, ao lado de table/board/list/calendar"
/// (TRL-001) — não sexto, ao lado de seis. Este conjunto segue o que o
/// frontend hoje sabe desenhar, não o rascunho de `0008`.
pub const VALID_VIEW_TYPES: [&str; 5] = ["table", "board", "list", "calendar", "trail"];

fn validate_property_type(property_type: &str) -> Result<()> {
    if !VALID_PROPERTY_TYPES.contains(&property_type) {
        return Err(Error::Invalid(format!(
            "tipo de propriedade inválido: {property_type:?} (esperado um de {VALID_PROPERTY_TYPES:?})"
        )));
    }
    Ok(())
}

fn validate_view_type(view_type: &str) -> Result<()> {
    if !VALID_VIEW_TYPES.contains(&view_type) {
        return Err(Error::Invalid(format!(
            "tipo de view inválido: {view_type:?} (esperado um de {VALID_VIEW_TYPES:?})"
        )));
    }
    Ok(())
}

/// `databases` — o database em si (nome e estado de trava). `config` e
/// `data_version` só existem a partir de `0020`/`0017` respectivamente
/// (`ALTER TABLE`, ver os comentários lá); lidos aqui por completude, nunca
/// escritos por este arquivo (nenhum item do pedido pede editor de config
/// de database, e `data_version` é incrementado só por
/// `db::record_values` — ver o comentário de `0017` sobre por quê).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub container_page_id: Uuid,
    pub name: String,
    pub is_locked: bool,
    pub config: JsonValue,
    pub data_version: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `database_properties` — uma coluna do schema da database.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePropertyRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub database_id: Uuid,
    pub name: String,
    pub property_type: String,
    pub config: JsonValue,
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `database_views` — uma visão salva sobre a database.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseViewRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub database_id: Uuid,
    pub name: String,
    pub view_type: String,
    pub config: JsonValue,
    pub position: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Um registro pronto para a tela: a página (`db::pages::PageRow` — sem
/// `rename_all`, então seus campos serializam em snake_case, diferente do
/// resto deste arquivo; ver o relato desta peça) mais os valores que ela
/// tem hoje em `database_record_values`, via `db::record_values::RecordValueRow`
/// (reusado, não redefinido — mesma coluna, mesmo tipo). Um registro sem
/// nenhuma propriedade preenchida vem com `values: []`, nunca erro (I1: a
/// ausência de linha É o valor vazio).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRecord {
    pub page: PageRow,
    pub values: Vec<RecordValueRow>,
}

pub struct DatabaseRepository {
    pool: SqlitePool,
}

impl DatabaseRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // -- database -----------------------------------------------------------

    /// Cria a database dentro da página `container_page_id` (0007: "it
    /// lives inline in a page or as that page's whole content ... via
    /// `container_page_id`"). Não há checagem prévia de que a página
    /// exista — mesma escolha que `TrilhaRepository::anexar_material_etapa`
    /// já documenta para FK de alvo: a constraint (`REFERENCES pages(id)`)
    /// já reporta com clareza suficiente, e pré-checar duplicaria a mesma
    /// pergunta que o banco já vai responder.
    pub async fn create_database(&self, container_page_id: Uuid, name: &str) -> Result<DatabaseRow> {
        let id = Uuid::now_v7();
        sqlx::query_as::<_, DatabaseRow>(
            "INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, $3) \
             RETURNING id, container_page_id, name, is_locked, config, data_version, created_at, updated_at",
        )
        .bind(id.db())
        .bind(container_page_id.db())
        .bind(name)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn get_database(&self, id: Uuid) -> Result<DatabaseRow> {
        sqlx::query_as::<_, DatabaseRow>(
            "SELECT id, container_page_id, name, is_locked, config, data_version, created_at, updated_at \
             FROM databases WHERE id = $1",
        )
        .bind(id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("database {id}")))
    }

    /// Todas as databases que vivem dentro de uma página — `container_page_id`
    /// não é `UNIQUE` (verificado em `0007_databases.sql`: só índice, não
    /// constraint), então mais de uma database inline pode compartilhar a
    /// mesma página-container, e é essa a pergunta que uma tela de página
    /// faz para saber quantos blocos de database desenhar.
    pub async fn list_databases_in_page(&self, container_page_id: Uuid) -> Result<Vec<DatabaseRow>> {
        sqlx::query_as::<_, DatabaseRow>(
            "SELECT id, container_page_id, name, is_locked, config, data_version, created_at, updated_at \
             FROM databases WHERE container_page_id = $1 ORDER BY created_at",
        )
        .bind(container_page_id.db())
        .fetch_all(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn rename_database(&self, id: Uuid, name: &str) -> Result<DatabaseRow> {
        sqlx::query_as::<_, DatabaseRow>(
            "UPDATE databases SET name = $2 WHERE id = $1 \
             RETURNING id, container_page_id, name, is_locked, config, data_version, created_at, updated_at",
        )
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("database {id}")))
    }

    /// Apaga a database. Tudo o mais some por CASCADE do próprio schema, não
    /// por lógica escrita aqui — `database_properties.database_id`,
    /// `database_views.database_id` e `pages.database_id` são todos
    /// `REFERENCES databases(id) ON DELETE CASCADE` (`0007`/`0008`/`0003`).
    /// Um registro apagado por essa cascata é uma linha de `pages` inteira
    /// desaparecendo, o que por sua vez cascade-apaga
    /// `database_record_values.record_id` (`0009`) — e cada propriedade
    /// apagada cascade-apaga `database_record_values.property_id` de novo,
    /// pelo outro lado. Nenhum dos dois caminhos depende do outro rodar
    /// primeiro: SQLite resolve a ordem, e o teste desta peça prova o
    /// resultado, não a ordem.
    pub async fn delete_database(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM databases WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("database {id}")));
        }
        Ok(())
    }

    // -- propriedade ----------------------------------------------------------

    /// Cria a propriedade como a última coluna da database. `config` ausente
    /// vira `{}` (o `DEFAULT` da coluna, `0008`) — aceitar `config` aqui é
    /// parte do verbo "criar" (uma propriedade `select` sem opção nenhuma é
    /// tecnicamente válida mas inútil), e não confundir com uma edição de
    /// config depois de criada, que este arquivo não oferece para
    /// propriedade (só para view — ver o comentário de topo do arquivo e
    /// `set_view_config`; o pedido desta peça lista os verbos de
    /// propriedade sem incluir "editar config").
    ///
    /// Recusa `relation`/`rollup` — ver [`STRUCTURAL_PROPERTY_TYPES`] e
    /// [`change_property_type`](Self::change_property_type).
    pub async fn create_property(
        &self,
        database_id: Uuid,
        name: &str,
        property_type: &str,
        config: Option<JsonValue>,
    ) -> Result<DatabasePropertyRow> {
        validate_property_type(property_type)?;
        reject_structural_type(property_type, "criar")?;

        let new_position = next_property_position(&self.pool, database_id).await?;
        let config = config.unwrap_or_else(|| serde_json::json!({}));
        let id = Uuid::now_v7();

        sqlx::query_as::<_, DatabasePropertyRow>(
            "INSERT INTO database_properties (id, database_id, name, property_type, config, position) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             RETURNING id, database_id, name, property_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(database_id.db())
        .bind(name)
        .bind(property_type)
        .bind(&config)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn list_properties(&self, database_id: Uuid) -> Result<Vec<DatabasePropertyRow>> {
        sqlx::query_as::<_, DatabasePropertyRow>(
            "SELECT id, database_id, name, property_type, config, position, created_at, updated_at \
             FROM database_properties WHERE database_id = $1 ORDER BY position",
        )
        .bind(database_id.db())
        .fetch_all(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn rename_property(&self, id: Uuid, name: &str) -> Result<DatabasePropertyRow> {
        sqlx::query_as::<_, DatabasePropertyRow>(
            "UPDATE database_properties SET name = $2 WHERE id = $1 \
             RETURNING id, database_id, name, property_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("propriedade {id}")))
    }

    /// Muda `property_type`. Recusado quando o tipo ATUAL ou o NOVO é
    /// `relation`/`rollup` — os dois têm tabela companheira que este método
    /// genérico não sabe montar nem desmontar:
    ///
    /// - `relation`: sair do tipo por aqui deixaria `database_relations` (e
    ///   as arestas em `database_relation_edges`) órfã — o gatilho de
    ///   `0018_database_relations.sql` que faz essa limpeza só dispara em
    ///   `AFTER DELETE ON database_properties`, nunca em `UPDATE`. Entrar no
    ///   tipo por aqui criaria uma propriedade `relation` sem
    ///   `config.relationId`, que nenhuma tela de relação reconheceria como
    ///   sua. O caminho certo para os dois sentidos é
    ///   `db::relations::RelationRepository`.
    /// - `rollup`: mesma forma de problema com `rollup_dependencies`
    ///   (`0019_database_derived.sql`), cujo dono é o motor de rollup (D1) —
    ///   ainda não escrito neste crate.
    pub async fn change_property_type(&self, id: Uuid, new_type: &str) -> Result<DatabasePropertyRow> {
        validate_property_type(new_type)?;

        let current_type: String = sqlx::query_scalar("SELECT property_type FROM database_properties WHERE id = $1")
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("propriedade {id}")))?;

        if STRUCTURAL_PROPERTY_TYPES.contains(&current_type.as_str()) {
            return Err(Error::Invalid(format!(
                "propriedade {id} é do tipo {current_type:?}: mudar de tipo por aqui deixaria \
                 sua tabela companheira (database_relations/rollup_dependencies) órfã — use o \
                 repositório dono desse tipo (RelationRepository para relation)"
            )));
        }
        reject_structural_type(new_type, "mudar para")?;

        sqlx::query_as::<_, DatabasePropertyRow>(
            "UPDATE database_properties SET property_type = $2 WHERE id = $1 \
             RETURNING id, database_id, name, property_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(new_type)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Substitui `config` inteiro de uma propriedade já existente — o
    /// comando que faltava: `create_property` aceita `config` na criação,
    /// mas antes deste método não havia NENHUM caminho para mudá-lo depois.
    /// Efeito concreto que motivou esta peça: uma propriedade Fórmula criada
    /// com uma expressão ficava com aquela expressão para sempre, porque
    /// `src/features/databases/properties/formula/FormulaConfigForm.tsx` já
    /// sabe desenhar o modo "editar existente" mas não tinha para onde
    /// mandar o resultado.
    ///
    /// Três decisões, coladas ao pedido desta peça:
    ///
    /// 1. **Recusa `config` que não seja objeto JSON.** `parse_opcoes_de_deck`
    ///    (`db::cards`) resolve uma pergunta parecida caindo para um default
    ///    em vez de falhar — mas ali o dado já estava GRAVADO (release
    ///    antigo, JSON mudou de forma) e a alternativa era derrubar o
    ///    agendamento de um cartão por causa de uma coluna que ninguém pediu
    ///    para ler agora. Aqui é o oposto: entrada NOVA, vinda direto de um
    ///    formulário da UI, no mesmo instante em que é escrita. Cair para
    ///    `{}` em silêncio decepcionaria quem mandou `"oops"` ou `42`
    ///    achando que estava mandando `{"expression": "..."}`  — o erro
    ///    ficaria invisível até a propriedade se comportar de forma
    ///    estranha bem mais tarde. Recusar na fronteira é a mesma escolha
    ///    que `validate_property_type`/`validate_view_type` já fazem para
    ///    string fora do conjunto aceito.
    /// 2. **Recusa propriedade estrutural.** `relation`/`rollup` têm tabela
    ///    companheira (`database_relations`/`rollup_dependencies`) cujo
    ///    `config` é gerido por `RelationRepository`/pelo motor de rollup —
    ///    ver [`reject_structural_type`] e o comentário de
    ///    [`change_property_type`](Self::change_property_type). Deixar este
    ///    método genérico sobrescrever esse `config` destruiria a referência
    ///    que só o dono do tipo sabe reconstruir (ex.: `config.relationId`).
    ///    Mesma checagem de tipo ATUAL que `change_property_type` já faz.
    /// 3. **`change_property_type` deixa `config` órfão — verificado, não
    ///    corrigido aqui.** Trocar `number` → `text` não limpa
    ///    `{"format": "plain"}"` nem nenhuma outra chave específica do tipo
    ///    antigo; a propriedade fica com um `config` que não corresponde
    ///    mais ao novo tipo. Isso já era verdade antes deste método existir
    ///    (`change_property_type` nunca tocou `config`) — não é consertado
    ///    de contrabando aqui, é reportado no relato desta peça.
    pub async fn set_property_config(&self, id: Uuid, config: JsonValue) -> Result<DatabasePropertyRow> {
        if !config.is_object() {
            return Err(Error::Invalid(format!(
                "config de propriedade precisa ser um objeto JSON, recebido: {config}"
            )));
        }

        let current_type: String = sqlx::query_scalar("SELECT property_type FROM database_properties WHERE id = $1")
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("propriedade {id}")))?;
        reject_structural_type(&current_type, "mudar o config de")?;

        sqlx::query_as::<_, DatabasePropertyRow>(
            "UPDATE database_properties SET config = $2 WHERE id = $1 \
             RETURNING id, database_id, name, property_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(&config)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Reposiciona a propriedade entre duas vizinhas DA MESMA database —
    /// `after_property_id = None` significa "primeira da lista". Mesmo
    /// desenho de `TrilhaRepository::reordenar_raia`, com a segurança extra
    /// de checar `database_id` no `UPDATE` final: sem ela, um `id` de
    /// propriedade de OUTRA database passaria a checagem de existência mas
    /// receberia uma posição sem sentido no escopo errado.
    pub async fn reorder_property(
        &self,
        database_id: Uuid,
        id: Uuid,
        after_property_id: Option<Uuid>,
    ) -> Result<DatabasePropertyRow> {
        let mut tx = self.pool.begin().await?;

        let siblings = property_siblings_tx(&mut tx, database_id, id).await?;
        let new_position = position_after(&siblings, after_property_id)?;

        let row = sqlx::query_as::<_, DatabasePropertyRow>(
            "UPDATE database_properties SET position = $2 WHERE id = $1 AND database_id = $3 \
             RETURNING id, database_id, name, property_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(&new_position)
        .bind(database_id.db())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("propriedade {id} na database {database_id}")))?;

        tx.commit().await?;
        Ok(row)
    }

    /// Apaga a propriedade. Todo o resto some por CASCADE/SET NULL do
    /// próprio schema — nenhum deles precisa de lógica escrita aqui:
    ///
    /// - `database_record_values.property_id` — `ON DELETE CASCADE`
    ///   (`0009`): todo valor gravado desta propriedade some junto.
    /// - `rollup_dependencies.rollup_property_id` — `ON DELETE CASCADE`;
    ///   `rollup_dependencies.target_property_id` — `ON DELETE SET NULL`
    ///   (`0019`).
    /// - `trail_views.group_property_id` — `ON DELETE SET NULL` (`0023`):
    ///   apagar a propriedade de agrupamento de uma Trilha degrada a view
    ///   para a raia única (TRL-014, estado válido), nunca apaga a view.
    /// - Se `property_type = 'relation'`, o gatilho
    ///   `database_properties_cleanup_relation` (`0018`) apaga
    ///   `database_relations` (e por cascata `database_relation_edges`)
    ///   quando esta era a ÚLTIMA propriedade a apontar para aquela
    ///   relação — não antes.
    pub async fn delete_property(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM database_properties WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("propriedade {id}")));
        }
        Ok(())
    }

    // -- view -----------------------------------------------------------------

    /// Cria a view como a última da database. `config` ausente vira `{}`
    /// (`0008`'s `DEFAULT`) — mesma razão de aceitar `config` já na criação
    /// que [`create_property`](Self::create_property) documenta.
    ///
    /// Criar uma view `trail` aqui NÃO cria a linha de `trail_views` — ver o
    /// comentário de topo do arquivo. O gatilho `trail_views_require_trail_view_type`
    /// (`0023`) só entra em jogo quando alguém tentar inserir em
    /// `trail_views` para uma view que não seja `trail`; criar a view em si
    /// não passa por ele.
    pub async fn create_view(
        &self,
        database_id: Uuid,
        name: &str,
        view_type: &str,
        config: Option<JsonValue>,
    ) -> Result<DatabaseViewRow> {
        validate_view_type(view_type)?;

        let new_position = next_view_position(&self.pool, database_id).await?;
        let config = config.unwrap_or_else(|| serde_json::json!({}));
        let id = Uuid::now_v7();

        sqlx::query_as::<_, DatabaseViewRow>(
            "INSERT INTO database_views (id, database_id, name, view_type, config, position) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             RETURNING id, database_id, name, view_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(database_id.db())
        .bind(name)
        .bind(view_type)
        .bind(&config)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn list_views(&self, database_id: Uuid) -> Result<Vec<DatabaseViewRow>> {
        sqlx::query_as::<_, DatabaseViewRow>(
            "SELECT id, database_id, name, view_type, config, position, created_at, updated_at \
             FROM database_views WHERE database_id = $1 ORDER BY position",
        )
        .bind(database_id.db())
        .fetch_all(&self.pool)
        .await
        .map_err(Error::from)
    }

    pub async fn rename_view(&self, id: Uuid, name: &str) -> Result<DatabaseViewRow> {
        sqlx::query_as::<_, DatabaseViewRow>(
            "UPDATE database_views SET name = $2 WHERE id = $1 \
             RETURNING id, database_id, name, view_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("view {id}")))
    }

    /// Substitui `config` inteiro (DBS-053: filtro/ordenação/colunas
    /// visíveis são sempre lidos e escritos como uma unidade só — ver
    /// `0008`). Quem chama já leu o valor atual via `list_views` e manda de
    /// volta o objeto inteiro com o campo que mudou — este método não faz
    /// merge parcial.
    pub async fn set_view_config(&self, id: Uuid, config: JsonValue) -> Result<DatabaseViewRow> {
        sqlx::query_as::<_, DatabaseViewRow>(
            "UPDATE database_views SET config = $2 WHERE id = $1 \
             RETURNING id, database_id, name, view_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(&config)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("view {id}")))
    }

    /// Mesmo desenho de [`reorder_property`](Self::reorder_property), outra
    /// tabela.
    pub async fn reorder_view(&self, database_id: Uuid, id: Uuid, after_view_id: Option<Uuid>) -> Result<DatabaseViewRow> {
        let mut tx = self.pool.begin().await?;

        let siblings = view_siblings_tx(&mut tx, database_id, id).await?;
        let new_position = position_after(&siblings, after_view_id)?;

        let row = sqlx::query_as::<_, DatabaseViewRow>(
            "UPDATE database_views SET position = $2 WHERE id = $1 AND database_id = $3 \
             RETURNING id, database_id, name, view_type, config, position, created_at, updated_at",
        )
        .bind(id.db())
        .bind(&new_position)
        .bind(database_id.db())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("view {id} na database {database_id}")))?;

        tx.commit().await?;
        Ok(row)
    }

    /// Apaga a view. `trail_views.view_id` é `ON DELETE CASCADE` (`0023`),
    /// então apagar uma view Trilha leva a raia junto (e por cascata,
    /// `trail_lanes.view_id`, também `ON DELETE CASCADE`). Não apaga
    /// propriedade nem registro — uma view é só uma forma de olhar para
    /// eles.
    pub async fn delete_view(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM database_views WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("view {id}")));
        }
        Ok(())
    }

    // -- registro ---------------------------------------------------------

    /// Cria o registro — delega inteiramente a `PageRepository::create_record`
    /// (ver o comentário lá para por que a peça mora em `db::pages`, não
    /// aqui).
    pub async fn create_record(&self, database_id: Uuid, title: &str) -> Result<PageRow> {
        PageRepository::new(self.pool.clone()).create_record(database_id, title).await
    }

    /// Todo registro ativo (não-lixeira, não-template — `0021`'s
    /// `is_template`) de uma database, na ordem da tela, com os valores que
    /// cada um tem hoje. Database vazia (nenhum registro) devolve `[]`, não
    /// erro — mesmo estado válido que `TrilhaRepository::obter_trilha`
    /// documenta para uma trilha sem etapa.
    ///
    /// Os VALORES em si reusam `db::record_values::RecordValueRow` — este
    /// método só lê `database_record_values` (permitido: I4 restringe
    /// ESCRITA, e `db::trilha::fetch_step_bases` já lê a mesma tabela do
    /// mesmo jeito), nunca duplica a forma da linha.
    pub async fn list_records(&self, database_id: Uuid) -> Result<Vec<DatabaseRecord>> {
        let pages = sqlx::query_as::<_, PageRow>(
            "SELECT id, parent_id, database_id, title, icon, position, is_favorite, deleted_at, created_at, updated_at \
             FROM pages WHERE database_id = $1 AND is_template = 0 AND deleted_at IS NULL ORDER BY position",
        )
        .bind(database_id.db())
        .fetch_all(&self.pool)
        .await?;

        let ids: Vec<Uuid> = pages.iter().map(|page| page.id).collect();
        let mut values_by_record: HashMap<Uuid, Vec<RecordValueRow>> = HashMap::new();

        // Fatiado por `sql::MAX_BIND_PARAMS` — mesma convenção de
        // `db::trilha::fetch_dependencies_into` para lista possivelmente
        // grande de ids.
        for chunk in ids.chunks(sql::MAX_BIND_PARAMS) {
            let placeholders = sql::in_placeholders(chunk.len());
            let query_sql = format!(
                "SELECT record_id, property_id, value, sort_num, sort_text, updated_at \
                 FROM database_record_values WHERE record_id IN ({placeholders})"
            );
            let mut query = sqlx::query_as::<_, RecordValueRow>(&query_sql);
            for id in chunk {
                query = query.bind(id.db());
            }
            for row in query.fetch_all(&self.pool).await? {
                values_by_record.entry(row.record_id).or_default().push(row);
            }
        }

        Ok(pages
            .into_iter()
            .map(|page| {
                let values = values_by_record.remove(&page.id).unwrap_or_default();
                DatabaseRecord { page, values }
            })
            .collect())
    }
}

fn reject_structural_type(property_type: &str, verbo: &str) -> Result<()> {
    if STRUCTURAL_PROPERTY_TYPES.contains(&property_type) {
        return Err(Error::Invalid(format!(
            "não é possível {verbo} uma propriedade {property_type:?} por aqui — ela precisa de uma \
             tabela companheira (database_relations/rollup_dependencies) que só o repositório dono \
             desse tipo sabe montar (RelationRepository para relation)"
        )));
    }
    Ok(())
}

async fn next_property_position(pool: &SqlitePool, database_id: Uuid) -> Result<String> {
    let last: Option<String> =
        sqlx::query_scalar("SELECT position FROM database_properties WHERE database_id = $1 ORDER BY position DESC LIMIT 1")
            .bind(database_id.db())
            .fetch_optional(pool)
            .await?;
    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

async fn next_view_position(pool: &SqlitePool, database_id: Uuid) -> Result<String> {
    let last: Option<String> =
        sqlx::query_scalar("SELECT position FROM database_views WHERE database_id = $1 ORDER BY position DESC LIMIT 1")
            .bind(database_id.db())
            .fetch_optional(pool)
            .await?;
    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

async fn property_siblings_tx(tx: &mut Transaction<'_, Sqlite>, database_id: Uuid, exclude_id: Uuid) -> Result<Vec<(Uuid, String)>> {
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM database_properties WHERE database_id = $1 AND id <> $2 ORDER BY position",
    )
    .bind(database_id.db())
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

async fn view_siblings_tx(tx: &mut Transaction<'_, Sqlite>, database_id: Uuid, exclude_id: Uuid) -> Result<Vec<(Uuid, String)>> {
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM database_views WHERE database_id = $1 AND id <> $2 ORDER BY position",
    )
    .bind(database_id.db())
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

/// A posição entre os dois vizinhos de `after_id` numa lista de irmãos já
/// ordenada (o item que está sendo movido já foi excluído dela por quem
/// chama). `after_id = None` é "primeiro da lista". Mesma forma de
/// `db::trilha`'s `lane_neighbours`/`position_between_lanes`, generalizada
/// para uma chave `Uuid` em vez de `String` — reusada por
/// `reorder_property` e `reorder_view`, as duas únicas listas deste arquivo
/// que usam índice fracionário.
fn position_after(siblings: &[(Uuid, String)], after_id: Option<Uuid>) -> Result<String> {
    match after_id {
        None => {
            let after = siblings.first().map(|(_, pos)| pos.as_str()).map(position::parse).transpose()?;
            position::between(None, after.as_ref())
        }
        Some(after_id) => {
            let index = siblings
                .iter()
                .position(|(id, _)| *id == after_id)
                .ok_or_else(|| Error::Invalid("posição de referência não existe nesta database".into()))?;
            let before = position::parse(&siblings[index].1)?;
            let after = siblings.get(index + 1).map(|(_, pos)| pos.as_str()).map(position::parse).transpose()?;
            position::between(Some(&before), after.as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa isenção, então ela é escrita aqui — mesmo
    // padrão de `db::position`/`db::trilha`.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn validate_property_type_aceita_o_conjunto_e_recusa_o_resto() {
        for tipo in VALID_PROPERTY_TYPES {
            assert!(validate_property_type(tipo).is_ok(), "{tipo} deveria ser aceito");
        }
        assert!(matches!(validate_property_type("video"), Err(Error::Invalid(_))));
        assert!(matches!(validate_property_type(""), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_view_type_aceita_o_conjunto_e_recusa_gallery_e_timeline() {
        for tipo in VALID_VIEW_TYPES {
            assert!(validate_view_type(tipo).is_ok(), "{tipo} deveria ser aceito");
        }
        // Rascunho de `0008`, nunca implementado — ver o comentário de
        // `VALID_VIEW_TYPES`.
        assert!(matches!(validate_view_type("gallery"), Err(Error::Invalid(_))));
        assert!(matches!(validate_view_type("timeline"), Err(Error::Invalid(_))));
    }

    #[test]
    fn reject_structural_type_recusa_so_relation_e_rollup() {
        assert!(reject_structural_type("relation", "criar").is_err());
        assert!(reject_structural_type("rollup", "criar").is_err());
        assert!(reject_structural_type("text", "criar").is_ok());
        assert!(reject_structural_type("formula", "criar").is_ok());
    }

    #[test]
    fn position_after_none_fica_antes_do_primeiro() {
        let a = Uuid::now_v7();
        let siblings = vec![(a, position::first())];
        let novo = position_after(&siblings, None).unwrap();
        assert!(position::parse(&novo).unwrap() < position::parse(&siblings[0].1).unwrap());
    }

    #[test]
    fn position_after_recusa_referencia_desconhecida() {
        let a = Uuid::now_v7();
        let desconhecido = Uuid::now_v7();
        let siblings = vec![(a, position::first())];
        assert!(matches!(position_after(&siblings, Some(desconhecido)), Err(Error::Invalid(_))));
    }
}
