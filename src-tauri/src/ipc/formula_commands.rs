//! Os três comandos de fórmula da arquitetura §9 — `formula::core` faz o
//! trabalho puro (léxico, sintaxe, tipo, avaliação); este arquivo é só a
//! fronteira: busca o schema/valores em SQLite, monta o adaptador de
//! `ValueSource` sobre esse instantâneo, e converte posição de erro de
//! bytes UTF-8 (o que o núcleo produz) para unidades UTF-16 (o que o
//! JavaScript usa) — "Preço" tem 6 bytes e 5 unidades UTF-16, e é essa
//! diferença que desloca o sublinhado quando alguém esquece a conversão
//! (arquitetura §4).
//!
//! ## Divergência da arquitetura, nomeada
//!
//! Nenhum repositório de `database_properties`/`database_record_values`
//! por NOME (o que `ValueSource::property_by_name` precisa) existe ainda em
//! `db/` — só `db::record_values` (I4, escrita) e as migrações. Como este
//! arquivo só pode escrever em `formula::core`, `formula::functions` e
//! aqui mesmo, o adaptador de `ValueSource` abaixo (`SchemaSnapshot`/
//! `RecordSnapshot`) consulta `database_properties`/`database_record_values`/
//! `pages` DIRETAMENTE com `sqlx::query_as`, em vez de delegar a um
//! repositório. Quando um repositório de schema/registro por nome existir
//! (provavelmente do dono de `db::properties` ou de N1, na integração
//! final), estas duas funções de carga (`load_properties`/
//! `load_record_values`/`load_page_meta`) deveriam ser substituídas por
//! chamadas a ele — a lógica pura (`build_validation`/`build_preview`,
//! `map_property_type`, `json_to_value`) não muda.
//!
//! **Limitação nomeada de `preview_formula`:** o adaptador é de UM
//! registro só, e `related()` sempre devolve lista vazia — uma fórmula que
//! atravessa uma relação de verdade (`prop("Relação").core_test_map(...)`,
//! DBS-078) mostra a relação como vazia na pré-visualização, nunca um erro.
//! Isto é aceitável para uma pré-visualização interativa (o `Value::Empty`/
//! lista-vazia resultante é exatamente o "TOTAL" que a linguagem já produz
//! para qualquer ausência), mas o avaliador de MATERIALIZAÇÃO que a cascata
//! de I4 vai precisar (o hook `cascade_formula_dependents`, hoje vazio em
//! `db/record_values.rs`) vai precisar de um `ValueSource` que pré-busque a
//! relação em lote de verdade — fora do escopo desta peça (F0: só o
//! núcleo).

use std::collections::HashMap;

use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;
use uuid::Uuid;

use crate::db::ids::{DbId, IdBind};
use crate::db::sql;
use crate::error::{Error, Result};
use crate::formula::core::{compile, eval, list_functions, Diagnostic, EvalCtx, PageMeta, PropertyId, Span, Type, Value, ValueSource};
use crate::formula::functions;
use crate::ipc::state::AppState;

// ---------------------------------------------------------------------
// DTOs da fronteira IPC — `camelCase`, como `BlockRow` (db/blocks.rs:52),
// nunca `snake_case`. Nenhuma forma exata foi congelada pela arquitetura
// além do NOME do comando e dos parâmetros (§9); os campos abaixo são a
// parte que este relatório publica em `contrato_publicado`.
// ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub message: String,
    /// Unidades UTF-16, não bytes — já convertido. Ver o comentário do
    /// módulo e [`byte_span_to_utf16`].
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaValidation {
    pub valid: bool,
    /// `Type::to_string()` em português ("número", "lista<página>", ...) —
    /// pronto para mostrar ao lado do nome da propriedade no editor.
    /// Ausente quando `valid` é `false`.
    pub return_type: Option<String>,
    pub diagnostics: Vec<DiagnosticDto>,
    /// Toda propriedade que a fórmula referencia via `prop()` — a aresta
    /// que a cascata de I4 e a detecção de ciclo entre propriedades (fora
    /// deste comando, ver `compile::Compiled::depends_on`) precisam.
    /// Vazio quando `valid` é `false`.
    pub depends_on: Vec<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaPreview {
    /// `Value::to_json()` — `null` para `Value::Empty`, a mesma convenção
    /// que uma célula ausente já usa no mapa `RecordRow.values`.
    pub value: serde_json::Value,
    pub diagnostics: Vec<DiagnosticDto>,
}

/// Um valor da coluna calculada, por registro — a saída de
/// `evaluate_formula_column`. Estrutura NOVA que atravessa a fronteira IPC:
/// o `contrato_ipc.test.ts` do frontend precisa conhecer este shape antes
/// de confiar nele (ver o relato desta peça).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaColumnValue {
    pub record_id: Uuid,
    /// `Value::to_json()` — `null` para `Value::Empty`, a mesma convenção
    /// de `FormulaPreview::value`.
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaFunctionDoc {
    pub name: String,
    pub category: String,
    pub doc: String,
    /// "exatamente 1 argumento" / "entre 1 e 3 argumentos" / "pelo menos 1
    /// argumento" — já em português, pronto para a paleta do editor.
    pub arity: String,
}

// ---------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------

/// `FormulaCommands.validate_formula` (arquitetura §9). `property_id` é a
/// propriedade que esta fórmula está SENDO SALVA para (`None` ao criar uma
/// nova propriedade de fórmula) — usado aqui só para recusar o caso mais
/// simples de ciclo, a auto-referência direta (`A: A + 1`). A DFS completa
/// entre TODAS as fórmulas de uma database (arquitetura §4) precisa do
/// `depends_on` de cada propriedade da database, não só desta expressão
/// isolada — fica para quem salva a propriedade de fórmula (F6), como o
/// comentário de `compile::Compiled::depends_on` já documenta.
#[tauri::command]
pub async fn validate_formula(
    state: State<'_, AppState>,
    database_id: Uuid,
    property_id: Option<Uuid>,
    expression: String,
) -> Result<FormulaValidation> {
    functions::register_all();
    let pool = state.pool()?;
    let properties = load_properties(&pool, database_id).await?;
    let schema = SchemaSnapshot { properties };
    Ok(build_validation(&expression, &schema, property_id))
}

/// `FormulaCommands.preview_formula`. Avalia `expression` como se já fosse
/// a fórmula de uma propriedade, contra os valores REAIS de `record_id` —
/// ver a limitação de relação nomeada no comentário do módulo.
#[tauri::command]
pub async fn preview_formula(
    state: State<'_, AppState>,
    database_id: Uuid,
    record_id: Uuid,
    expression: String,
) -> Result<FormulaPreview> {
    functions::register_all();
    let pool = state.pool()?;
    let properties = load_properties(&pool, database_id).await?;
    let values = load_record_values(&pool, record_id, &properties).await?;
    let page = load_page_meta(&pool, record_id).await?;
    let schema = RecordSnapshot { properties, values, page };
    Ok(build_preview(&expression, &schema, record_id))
}

/// O comando que faltava para uma COLUNA de fórmula numa tabela de
/// centenas de registros: `list_records` (`db::databases`) só devolve o que
/// já está gravado em `database_record_values`, e fórmula NÃO é gravada
/// ali (é calculada) — sem este comando, a única forma de mostrar uma
/// coluna de fórmula seria chamar `preview_formula` uma vez por linha, o
/// exato N+1 que o `//!` no topo deste arquivo já nomeava como dívida
/// ("`ValueSource` que pré-busque a leitura"). Aqui a leitura é UMA consulta
/// de propriedades, UMA de páginas e `ceil(registros / sql::MAX_BIND_PARAMS)`
/// consultas de valor — nunca uma consulta por registro — e a expressão é
/// `compile()`ada uma única vez para toda a coluna.
///
/// Uma fórmula que referencia outra propriedade de fórmula (DBS-084) fica
/// FORA desta rodada: `load_properties` já exclui `property_type =
/// "formula"` do schema (`map_property_type` não mapeia esse tipo), então
/// `prop("OutraFórmula")` falha a checagem de tipo como "propriedade não
/// encontrada" — [`build_column_values`] trata QUALQUER falha de
/// `compile()` (essa inclusive) devolvendo vazio (`null`) para todo
/// registro, nunca um erro que derruba o comando inteiro: "uma célula não
/// pode derrubar a view" vale para a coluna inteira aqui.
#[tauri::command]
pub async fn evaluate_formula_column(
    state: State<'_, AppState>,
    database_id: Uuid,
    property_id: Uuid,
) -> Result<Vec<FormulaColumnValue>> {
    functions::register_all();
    let pool = state.pool()?;

    let expression = load_formula_expression(&pool, database_id, property_id).await?;
    let properties = load_properties(&pool, database_id).await?;
    let pages = load_all_page_meta(&pool, database_id).await?;
    let record_ids: Vec<Uuid> = pages.iter().map(|meta| meta.id).collect();
    let values = load_all_record_values(&pool, &record_ids, &properties).await?;
    let pages_by_id: HashMap<Uuid, PageMeta> = pages.into_iter().map(|meta| (meta.id, meta)).collect();

    let schema = ColumnSnapshot { properties, values, pages: pages_by_id };
    Ok(build_column_values(&expression, &schema, &record_ids, Utc::now()))
}

/// `FormulaCommands.list_formula_functions` — a paleta/autocompletar do
/// editor. `_state` não é usado (a tabela é global, `formula::core::functions`)
/// mas fica no parâmetro porque a arquitetura §9 congela a assinatura com
/// ele; sublinhado evita o warning de variável não usada sob `-D warnings`.
#[tauri::command]
pub async fn list_formula_functions(_state: State<'_, AppState>) -> Result<Vec<FormulaFunctionDoc>> {
    functions::register_all();
    Ok(list_functions()
        .into_iter()
        .map(|def| FormulaFunctionDoc {
            name: def.name.to_string(),
            category: def.category.to_string(),
            doc: def.doc.to_string(),
            arity: def.arity.describe(),
        })
        .collect())
}

// ---------------------------------------------------------------------
// Lógica pura — testável sem Postgres (regra 6). Só as três funções
// `load_*` abaixo tocam `sqlx`.
// ---------------------------------------------------------------------

fn build_validation(expression: &str, schema: &dyn ValueSource, property_id: Option<Uuid>) -> FormulaValidation {
    match compile(expression, schema) {
        Ok(compiled) => {
            if let Some(this_property) = property_id {
                if compiled.depends_on.contains(&this_property) {
                    let diagnostic = Diagnostic::error(
                        "esta fórmula referencia a própria propriedade (ciclo)",
                        Span::new(0, expression.len()),
                    );
                    return FormulaValidation {
                        valid: false,
                        return_type: None,
                        diagnostics: vec![diagnostic_to_dto(expression, &diagnostic)],
                        depends_on: Vec::new(),
                    };
                }
            }
            FormulaValidation {
                valid: true,
                return_type: Some(compiled.return_type.to_string()),
                diagnostics: Vec::new(),
                depends_on: compiled.depends_on,
            }
        }
        Err(diagnostics) => FormulaValidation {
            valid: false,
            return_type: None,
            diagnostics: diagnostics.iter().map(|d| diagnostic_to_dto(expression, d)).collect(),
            depends_on: Vec::new(),
        },
    }
}

fn build_preview(expression: &str, schema: &dyn ValueSource, record_id: Uuid) -> FormulaPreview {
    match compile(expression, schema) {
        Ok(compiled) => {
            let mut ctx = EvalCtx::new(schema, record_id, Utc::now());
            let value = eval(&compiled.expr, &mut ctx);
            FormulaPreview { value: value.to_json(), diagnostics: Vec::new() }
        }
        Err(diagnostics) => FormulaPreview {
            value: serde_json::Value::Null,
            diagnostics: diagnostics.iter().map(|d| diagnostic_to_dto(expression, d)).collect(),
        },
    }
}

/// A lógica pura de `evaluate_formula_column` — testável sem SQLite.
/// Compila `expression` UMA VEZ contra `schema` e avalia contra cada
/// `record_id` de `record_ids`, reaproveitando o MESMO `Compiled` e o MESMO
/// `schema` para todos — nada aqui reabre conexão nem refaz `compile()`
/// por registro. `now` é fixado UMA vez pelo chamador (não um
/// `Utc::now()` por registro): a mesma razão de `EvalCtx::now()` já ser
/// fixado no início de uma única avaliação (arquitetura §4) — todos os
/// registros desta coluna, avaliados na mesma chamada, veem o MESMO
/// instante.
///
/// Se `expression` não compilar — ver o comentário de
/// `evaluate_formula_column` para a DBS-084 — todo registro recebe `null`,
/// nunca um `Err` que derruba o comando inteiro.
fn build_column_values(
    expression: &str,
    schema: &ColumnSnapshot,
    record_ids: &[Uuid],
    now: DateTime<Utc>,
) -> Vec<FormulaColumnValue> {
    match compile(expression, schema) {
        Ok(compiled) => record_ids
            .iter()
            .map(|&record_id| {
                let mut ctx = EvalCtx::new(schema, record_id, now);
                let value = eval(&compiled.expr, &mut ctx);
                FormulaColumnValue { record_id, value: value.to_json() }
            })
            .collect(),
        Err(_) => {
            record_ids.iter().map(|&record_id| FormulaColumnValue { record_id, value: serde_json::Value::Null }).collect()
        }
    }
}

/// Converte um [`Span`] em BYTES UTF-8 (o que `formula::core` produz) para
/// unidades UTF-16 (o que o JavaScript usa) — a conversão que a arquitetura
/// §4 pede explicitamente na fronteira. Conta unidades UTF-16 caractere a
/// caractere; um caractere acentuado (2 bytes UTF-8, 1 unidade UTF-16) ou
/// um emoji (4 bytes, 2 unidades) tornaria qualquer fórmula ingênua tipo
/// "divida por um fator fixo" errada.
fn byte_span_to_utf16(src: &str, span: Span) -> (u32, u32) {
    let mut utf16_pos: u32 = 0;
    let mut start = None;
    let mut end = None;
    for (byte_pos, ch) in src.char_indices() {
        if byte_pos == span.start {
            start = Some(utf16_pos);
        }
        if byte_pos == span.end {
            end = Some(utf16_pos);
        }
        utf16_pos += ch.len_utf16() as u32;
    }
    // `char_indices` nunca produz um índice "depois do último caractere";
    // cobre-se aqui o span cujo fim (ou início, para uma expressão vazia)
    // é exatamente o comprimento total em bytes.
    if span.start == src.len() {
        start = Some(utf16_pos);
    }
    if span.end == src.len() {
        end = Some(utf16_pos);
    }
    (start.unwrap_or(0), end.unwrap_or(utf16_pos))
}

fn diagnostic_to_dto(src: &str, diagnostic: &Diagnostic) -> DiagnosticDto {
    let (start, end) = byte_span_to_utf16(src, diagnostic.span);
    DiagnosticDto { message: diagnostic.message.clone(), start, end }
}

// ---------------------------------------------------------------------
// O adaptador de `ValueSource` — ver a divergência nomeada no topo do
// arquivo.
// ---------------------------------------------------------------------

/// Mapeia `database_properties.property_type` (texto livre, `0008`) para o
/// `Type` fechado da fórmula. Cobre os tipos escalares que já têm migração
/// nesta fase mais `relation` (sempre como `lista<página>` — não confere
/// cardinalidade; ver a limitação nomeada no topo do arquivo). Tipos que
/// outras peças desta fase ainda vão adicionar (`multi_select`, `person`,
/// `files`, `formula`, `rollup`, `created_time`/`last_edited_time`) voltam
/// `None`: `prop()` sobre eles reporta "propriedade não encontrada" em vez
/// de um tipo inventado — TOTAL no sentido certo, nunca fingir saber o que
/// não sabe.
fn map_property_type(property_type: &str) -> Option<Type> {
    match property_type {
        "number" => Some(Type::Number),
        "text" | "select" | "status" | "url" => Some(Type::String),
        "checkbox" => Some(Type::Boolean),
        "date" => Some(Type::Date),
        "relation" => Some(Type::List(Box::new(Type::Page))),
        _ => None,
    }
}

/// `raw` -> `Value`, guiado pelo `Type` já resolvido (não por
/// `jsonb_typeof` — o chamador já sabe o tipo esperado). Uma forma que não
/// bate (coluna corrompida, tipo mudou sem migração de dado) vira
/// `Value::Empty`: "uma célula não pode derrubar a view" (o mesmo raciocínio
/// de `PropertySpec.parse` na arquitetura §6), nunca um erro que interrompe
/// a pré-visualização inteira.
fn json_to_value(ty: &Type, raw: &serde_json::Value) -> Value {
    match (ty, raw) {
        (_, serde_json::Value::Null) => Value::Empty,
        (Type::Number, serde_json::Value::Number(n)) => n.as_f64().map(Value::Number).unwrap_or(Value::Empty),
        (Type::String, serde_json::Value::String(s)) => Value::String(s.clone()),
        (Type::Boolean, serde_json::Value::Bool(b)) => Value::Boolean(*b),
        (Type::Date, serde_json::Value::Object(fields)) => {
            let start = fields.get("start").and_then(|v| v.as_str());
            let end = fields.get("end").and_then(|v| v.as_str());
            match start {
                Some(start) => crate::formula::core::DateValue::parse(start, end).map(Value::Date).unwrap_or(Value::Empty),
                None => Value::Empty,
            }
        }
        _ => Value::Empty,
    }
}

fn format_local_i5(instant: DateTime<Utc>) -> String {
    // I5: "hora local de parede" — o app é local, de um usuário, sem
    // servidor e sem sync (arquitetura §2), então a hora local do SISTEMA
    // é a única que faz sentido aqui.
    instant.with_timezone(&Local).format("%Y-%m-%dT%H:%M").to_string()
}

/// Só schema — usado por `validate_formula`, que nunca chama `eval` (então
/// `value`/`related`/`page_meta` nunca rodam de verdade; devolvem o vazio
/// TOTAL em vez de, por exemplo, `unimplemented!()`, porque nada garante
/// que uma versão futura deste comando não passe a chamar `eval` também).
struct SchemaSnapshot {
    properties: HashMap<String, (PropertyId, Type)>,
}

impl ValueSource for SchemaSnapshot {
    fn value(&self, _record: Uuid, _property: PropertyId) -> Value {
        Value::Empty
    }
    fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
        Vec::new()
    }
    fn page_meta(&self, record: Uuid) -> PageMeta {
        PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
    }
    fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
        self.properties.get(name).cloned()
    }
}

/// Schema + valores de UM registro só — usado por `preview_formula`. Ver a
/// limitação de `related()` no comentário do módulo.
struct RecordSnapshot {
    properties: HashMap<String, (PropertyId, Type)>,
    values: HashMap<PropertyId, Value>,
    page: PageMeta,
}

impl ValueSource for RecordSnapshot {
    fn value(&self, _record: Uuid, property: PropertyId) -> Value {
        self.values.get(&property).cloned().unwrap_or(Value::Empty)
    }
    fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
        Vec::new()
    }
    fn page_meta(&self, _record: Uuid) -> PageMeta {
        self.page.clone()
    }
    fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
        self.properties.get(name).cloned()
    }
}

/// Schema + valores de TODOS os registros de uma database — usado só por
/// `evaluate_formula_column`. Diferente de [`RecordSnapshot`] (um registro
/// só), aqui os valores de TODA a database já estão em memória, indexados
/// por `(record_id, property_id)`; `EvalCtx::new` troca só o
/// `current_record` a cada chamada de `eval`, então o MESMO `compile()` e
/// o MESMO `ColumnSnapshot` atendem a database inteira — é isto que torna
/// "uma consulta por database, nunca uma por registro" possível.
///
/// `related()` continua devolvendo lista vazia — a MESMA limitação nomeada
/// de [`RecordSnapshot`] (ver o comentário do módulo): relação vive em
/// `database_relation_edges`, outra tabela, fora do escopo desta peça.
struct ColumnSnapshot {
    properties: HashMap<String, (PropertyId, Type)>,
    values: HashMap<(Uuid, PropertyId), Value>,
    pages: HashMap<Uuid, PageMeta>,
}

impl ValueSource for ColumnSnapshot {
    fn value(&self, record: Uuid, property: PropertyId) -> Value {
        self.values.get(&(record, property)).cloned().unwrap_or(Value::Empty)
    }
    fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
        Vec::new()
    }
    fn page_meta(&self, record: Uuid) -> PageMeta {
        self.pages
            .get(&record)
            .cloned()
            .unwrap_or_else(|| PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() })
    }
    fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
        self.properties.get(name).cloned()
    }
}

/// A expressão de UMA propriedade de fórmula, lida de
/// `database_properties.config` — `0008_database_properties_views.sql`
/// documenta "formula expression" como o que aquele blob guarda para
/// `property_type = 'formula'`, mas não nomeia a CHAVE. Nenhuma peça do
/// frontend gravou uma fórmula ainda (`src/features/databases` não tem
/// nenhum uso de uma chave de config de fórmula — conferido antes de
/// escrever esta função), então `"expression"` é a escolha desta peça,
/// alinhada ao parâmetro `expression` que `validate_formula`/
/// `preview_formula` já usam (ver o relato desta peça).
///
/// Recusa (`Error::NotFound`/`Error::Invalid`) quando a propriedade não
/// existe, não é do tipo `formula`, ou não tem `"expression"` como texto em
/// `config` — são erros de CONFIGURAÇÃO da coluna, não de célula, então
/// aqui é apropriado propagar `Err` (diferente de `build_column_values`,
/// que nunca falha o comando por uma fórmula que não compila).
async fn load_formula_expression(pool: &SqlitePool, database_id: Uuid, property_id: Uuid) -> Result<String> {
    let row = sqlx::query_as::<_, (String, serde_json::Value)>(
        "SELECT property_type, config FROM database_properties WHERE id = $1 AND database_id = $2",
    )
    .bind(property_id.db())
    .bind(database_id.db())
    .fetch_optional(pool)
    .await?;

    let (property_type, config) = row.ok_or_else(|| Error::NotFound(format!("propriedade {property_id}")))?;
    if property_type != "formula" {
        return Err(Error::Invalid(format!("propriedade {property_id} não é do tipo formula (é {property_type:?})")));
    }
    config
        .get("expression")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| Error::Invalid(format!("propriedade {property_id} não tem \"expression\" configurada em config")))
}

async fn load_properties(pool: &SqlitePool, database_id: Uuid) -> Result<HashMap<String, (PropertyId, Type)>> {
    // `DbId` nos dois lados — no bind e no decode — e aqui isso não é
    // formalidade. Ligar um `Uuid` cru contra uma coluna TEXT não dá erro
    // nenhum: o SQLite compara um BLOB com um texto, não casa, e a consulta
    // devolve ZERO linha. O sintoma seria uma database sem propriedade
    // nenhuma, e toda fórmula rejeitada como "propriedade desconhecida", sem
    // uma única mensagem de erro apontando para o banco.
    let rows = sqlx::query_as::<_, (DbId, String, String)>(
        "SELECT id, name, property_type FROM database_properties WHERE database_id = $1",
    )
    .bind(database_id.db())
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(id, name, property_type)| {
            map_property_type(&property_type).map(|ty| (name, (Uuid::from(id), ty)))
        })
        .collect())
}

async fn load_record_values(
    pool: &SqlitePool,
    record_id: Uuid,
    properties: &HashMap<String, (PropertyId, Type)>,
) -> Result<HashMap<PropertyId, Value>> {
    // Relação nunca tem linha em `database_record_values` (arquitetura §5)
    // — filtrar aqui deixa essa exclusão explícita em vez de depender só
    // de a consulta devolver zero linha para essas ids.
    let scalar_ids: Vec<Uuid> = properties
        .values()
        .filter(|(_, ty)| !matches!(ty, Type::List(inner) if **inner == Type::Page))
        .map(|(id, _)| *id)
        .collect();
    if scalar_ids.is_empty() {
        return Ok(HashMap::new());
    }

    // `IN (?, ?, ...)` no lugar de `= ANY($2)`: o SQLite não tem tipo array,
    // então a lista vira um placeholder por elemento, montados por
    // `db::sql::in_placeholders` (que só produz `?` e vírgula) e ligados um a
    // um logo abaixo.
    let lista = crate::db::sql::in_placeholders(scalar_ids.len());
    let sql = format!(
        "SELECT property_id, value FROM database_record_values WHERE record_id = ? AND property_id IN ({lista})"
    );
    let mut query = sqlx::query_as::<_, (DbId, serde_json::Value)>(&sql).bind(record_id.db());
    for id in &scalar_ids {
        query = query.bind(id.db());
    }
    let rows: Vec<(Uuid, serde_json::Value)> =
        query.fetch_all(pool).await?.into_iter().map(|(id, value)| (Uuid::from(id), value)).collect();

    let type_by_id: HashMap<Uuid, &Type> = properties.values().map(|(id, ty)| (*id, ty)).collect();
    Ok(rows
        .into_iter()
        .filter_map(|(property_id, raw)| type_by_id.get(&property_id).map(|ty| (property_id, json_to_value(ty, &raw))))
        .collect())
}

async fn load_page_meta(pool: &SqlitePool, record_id: Uuid) -> Result<PageMeta> {
    let row = sqlx::query_as::<_, (String, DateTime<Utc>, DateTime<Utc>)>(
        "SELECT title, created_at, updated_at FROM pages WHERE id = $1",
    )
    .bind(record_id.db())
    .fetch_optional(pool)
    .await?;

    let (title, created_at, updated_at) = row.ok_or_else(|| Error::NotFound(format!("página {record_id}")))?;
    Ok(PageMeta { id: record_id, title, created_at: format_local_i5(created_at), updated_at: format_local_i5(updated_at) })
}

/// Página + metadado de TODO registro ativo de uma database — o mesmo
/// filtro (`is_template = 0 AND deleted_at IS NULL`) que
/// `DatabaseRepository::list_records` usa, mas só as colunas que
/// [`PageMeta`] precisa. Usado só por `evaluate_formula_column`, que
/// precisa da lista INTEIRA de registros de uma vez (para saber por quais
/// avaliar a fórmula), não de um registro isolado como `load_page_meta`.
async fn load_all_page_meta(pool: &SqlitePool, database_id: Uuid) -> Result<Vec<PageMeta>> {
    let rows = sqlx::query_as::<_, (DbId, String, DateTime<Utc>, DateTime<Utc>)>(
        "SELECT id, title, created_at, updated_at FROM pages \
         WHERE database_id = $1 AND is_template = 0 AND deleted_at IS NULL ORDER BY position",
    )
    .bind(database_id.db())
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, title, created_at, updated_at)| PageMeta {
            id: Uuid::from(id),
            title,
            created_at: format_local_i5(created_at),
            updated_at: format_local_i5(updated_at),
        })
        .collect())
}

/// Todo valor de `database_record_values` para os registros de
/// `record_ids`, indexado por `(record_id, property_id)` — o carregamento
/// em LOTE que `evaluate_formula_column` existe para fazer. Fatiado por
/// `sql::MAX_BIND_PARAMS` (mesma convenção de
/// `DatabaseRepository::list_records`): `ceil(record_ids.len() /
/// MAX_BIND_PARAMS)` consultas, nunca uma por registro — o ponto de
/// performance inteiro deste comando. Uma linha cujo `property_id` não
/// está em `properties` (uma propriedade `relation`/`formula`/outro tipo
/// não-escalar, ou uma propriedade apagada entre a leitura do schema e
/// esta consulta) é descartada, não vira erro — mesma tolerância de
/// `load_record_values`.
async fn load_all_record_values(
    pool: &SqlitePool,
    record_ids: &[Uuid],
    properties: &HashMap<String, (PropertyId, Type)>,
) -> Result<HashMap<(Uuid, PropertyId), Value>> {
    let type_by_id: HashMap<Uuid, &Type> = properties.values().map(|(id, ty)| (*id, ty)).collect();
    let mut values: HashMap<(Uuid, PropertyId), Value> = HashMap::new();

    for chunk in record_ids.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql =
            format!("SELECT record_id, property_id, value FROM database_record_values WHERE record_id IN ({placeholders})");
        let mut query = sqlx::query_as::<_, (DbId, DbId, serde_json::Value)>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        for (record_id, property_id, raw) in query.fetch_all(pool).await? {
            let record_id = Uuid::from(record_id);
            let property_id = Uuid::from(property_id);
            if let Some(ty) = type_by_id.get(&property_id) {
                values.insert((record_id, property_id), json_to_value(ty, &raw));
            }
        }
    }

    Ok(values)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    struct FakeSchema {
        properties: HashMap<&'static str, (PropertyId, Type)>,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, _property: PropertyId) -> Value {
            Value::Empty
        }
        fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
            Vec::new()
        }
        fn page_meta(&self, record: Uuid) -> PageMeta {
            PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
        }
        fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
            self.properties.get(name).cloned()
        }
    }

    fn schema_with_preco() -> FakeSchema {
        let mut properties = HashMap::new();
        properties.insert("Preço", (Uuid::from_u128(1), Type::Number));
        FakeSchema { properties }
    }

    /// A trava contra o defeito mais repetido deste projeto, aplicada à
    /// linguagem de fórmula: código correto, testado, e **desconectado do
    /// caminho real**. `formula::functions::register_all()` ficou VAZIO por
    /// rodadas — o núcleo (lexer, parser, checagem de tipo, avaliador) tinha
    /// testes próprios e passava, e a linguagem inteira não sabia somar dois
    /// números, porque nenhuma categoria estava registrada.
    ///
    /// O sintoma seria uma paleta de fórmulas em branco e todo `round(...)`
    /// virando "função desconhecida", com a suíte inteira verde: cada teste do
    /// núcleo prova a PEÇA, e o que faltava era a LIGAÇÃO.
    ///
    /// Este teste atravessa a ligação de propósito — ele chama o mesmo
    /// `register_all()` que o comando IPC chama, e depois consulta a mesma
    /// tabela global que a paleta consulta. Não afirma um número exato de
    /// funções (isso quebraria a cada categoria nova, sem defeito nenhum);
    /// afirma que cada categoria já implementada chegou lá, e que uma função
    /// nomeada de cada uma é encontrável pelo nome.
    #[test]
    fn register_all_liga_as_categorias_a_tabela_que_a_paleta_consulta() {
        functions::register_all();
        let todas = list_functions();

        for categoria in ["matemática", "agregação", "texto", "data", "lógica"] {
            assert!(
                todas.iter().any(|def| def.category == categoria),
                "categoria {categoria:?} não chegou à tabela global; \
                 register_all() provavelmente não a registra"
            );
        }

        for nome in ["round", "sum", "length", "now", "if"] {
            assert!(
                todas.iter().any(|def| def.name == nome),
                "função {nome:?} não é encontrável pela paleta"
            );
        }
    }

    /// A outra metade da mesma ligação: registrar não basta se o CHECADOR DE
    /// TIPO não alcançar a função. Uma expressão que usa as três categorias
    /// de uma vez, pelo mesmo caminho que `validate_formula` usa.
    ///
    /// A lista vem de uma PROPRIEDADE, não de um literal: a linguagem não tem
    /// sintaxe de lista literal — `[1, 2, 3]` morre no lexer com
    /// `caractere inesperado: "["`. Isso não é defeito das funções de
    /// agregação; é o formato da linguagem, e é como o Notion também se
    /// comporta (uma lista nasce de uma relação ou de `split`, nunca escrita à
    /// mão). Fica registrado aqui porque a alternativa — descobrir isso de
    /// novo daqui a três rodadas — custa mais que o comentário.
    #[test]
    fn uma_formula_que_usa_as_tres_categorias_passa_na_checagem_de_tipo() {
        functions::register_all();

        let mut properties = HashMap::new();
        properties.insert("Notas", (Uuid::from_u128(7), Type::List(Box::new(Type::Number))));
        let schema = FakeSchema { properties };

        let resultado = build_validation("round(sum(prop(\"Notas\")) / length(\"café\"), 2)", &schema, None);

        assert!(resultado.valid, "esperava fórmula válida, obtido {:?}", resultado.diagnostics);
        assert_eq!(resultado.return_type.as_deref(), Some("número"));
        assert_eq!(resultado.depends_on, vec![Uuid::from_u128(7)]);
    }

    #[test]
    fn valid_formula_reports_type_and_dependencies() {
        let schema = schema_with_preco();
        let result = build_validation("prop(\"Preço\") + 1", &schema, None);
        assert!(result.valid);
        assert_eq!(result.return_type.as_deref(), Some("número"));
        assert_eq!(result.depends_on, vec![Uuid::from_u128(1)]);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn syntax_error_is_reported_as_invalid_with_a_diagnostic() {
        let schema = schema_with_preco();
        let result = build_validation("1 +", &schema, None);
        assert!(!result.valid);
        assert_eq!(result.diagnostics.len(), 1);
        assert!(result.return_type.is_none());
    }

    #[test]
    fn self_reference_is_rejected_as_a_cycle() {
        let schema = schema_with_preco();
        let this_property = Uuid::from_u128(1);
        let result = build_validation("prop(\"Preço\") + 1", &schema, Some(this_property));
        assert!(!result.valid);
        assert!(result.diagnostics[0].message.contains("ciclo"));
    }

    #[test]
    fn preview_evaluates_against_the_given_record() {
        let mut properties = HashMap::new();
        properties.insert("Preço".to_string(), (Uuid::from_u128(1), Type::Number));
        let mut values = HashMap::new();
        values.insert(Uuid::from_u128(1), Value::Number(20.0));
        let schema = RecordSnapshot {
            properties,
            values,
            page: PageMeta { id: Uuid::nil(), title: String::new(), created_at: String::new(), updated_at: String::new() },
        };

        let preview = build_preview("prop(\"Preço\") * 2", &schema, Uuid::nil());
        assert_eq!(preview.value, serde_json::json!(40.0));
        assert!(preview.diagnostics.is_empty());
    }

    #[test]
    fn preview_reports_diagnostics_instead_of_a_value_on_type_error() {
        let schema = schema_with_preco();
        let preview = build_preview("\"a\" + prop(\"Preço\")", &schema, Uuid::nil());
        assert_eq!(preview.value, serde_json::Value::Null);
        assert_eq!(preview.diagnostics.len(), 1);
    }

    #[test]
    fn map_property_type_covers_the_scalar_types_this_phase_has() {
        assert_eq!(map_property_type("number"), Some(Type::Number));
        assert_eq!(map_property_type("checkbox"), Some(Type::Boolean));
        assert_eq!(map_property_type("date"), Some(Type::Date));
        assert_eq!(map_property_type("relation"), Some(Type::List(Box::new(Type::Page))));
        assert_eq!(map_property_type("multi_select"), None);
    }

    #[test]
    fn json_to_value_turns_null_into_empty_for_every_type() {
        assert_eq!(json_to_value(&Type::Number, &serde_json::Value::Null), Value::Empty);
        assert_eq!(json_to_value(&Type::Date, &serde_json::Value::Null), Value::Empty);
    }

    #[test]
    fn json_to_value_parses_a_date_with_and_without_end() {
        let with_end = serde_json::json!({ "start": "2026-03-15", "end": "2026-03-16" });
        assert_eq!(
            json_to_value(&Type::Date, &with_end),
            Value::Date(crate::formula::core::DateValue { start: "2026-03-15".to_string(), end: Some("2026-03-16".to_string()) })
        );
        let start_only = serde_json::json!({ "start": "2026-03-15" });
        assert_eq!(
            json_to_value(&Type::Date, &start_only),
            Value::Date(crate::formula::core::DateValue { start: "2026-03-15".to_string(), end: None })
        );
    }

    /// O teste que a arquitetura §4 pede por nome: uma expressão com ACENTO
    /// ANTES do ponto do erro, para provar que a conversão byte -> UTF-16
    /// não desloca o sublinhado. "café" é 6 bytes UTF-8 (aspas + c+a+f + 2
    /// bytes de "é") mas só 5 unidades UTF-16 (aspas + c+a+f+é, "é" conta
    /// como 1) — se a conversão fosse ingênua (ex.: "conta bytes"), a
    /// posição de "naoexiste" sairia um a mais do que devia.
    #[test]
    fn accented_text_before_the_error_shifts_byte_and_utf16_offsets_differently() {
        let src = "\"café\" + naoexiste";
        let byte_start = src.find("naoexiste").expect("o teste depende deste texto existir na fonte");
        assert_eq!(byte_start, 10, "premissa do teste: \"é\" ocupa 2 bytes, deslocando \"naoexiste\" para o byte 10");

        let span = Span::new(byte_start, byte_start + "naoexiste".len());
        let (utf16_start, _utf16_end) = byte_span_to_utf16(src, span);

        assert_eq!(utf16_start, 9, "\"é\" é 1 unidade UTF-16, não 2 — a posição correta é 1 a menos que o byte");
        assert_ne!(
            byte_start as u32, utf16_start,
            "byte e UTF-16 coincidindo aqui não provaria nada: o ponto do teste é que ELES DIVERGEM"
        );
    }

    /// A mesma prova, mas atravessando o pipeline inteiro (`build_validation`
    /// -> diagnóstico real do checador, não um `Span` montado à mão) —
    /// `naoexiste` aqui é a mesma armadilha que "identificador desconhecido"
    /// dispara de verdade.
    #[test]
    fn end_to_end_diagnostic_position_survives_an_accented_property_name() {
        let mut properties = HashMap::new();
        properties.insert("café", (Uuid::from_u128(9), Type::String));
        let schema = FakeSchema { properties };

        let src = "prop(\"café\") == naoexiste";
        let result = build_validation(src, &schema, None);
        assert!(!result.valid);
        let diagnostic = &result.diagnostics[0];
        let byte_start = src.find("naoexiste").expect("premissa do teste");
        assert_eq!(byte_start, 17, "premissa do teste: \"é\" desloca \"naoexiste\" para o byte 17");
        // UTF-16 é 1 A MENOS que o byte (o "é" de "café" é 2 bytes e 1
        // unidade UTF-16) — se a fronteira devolvesse o byte cru em vez de
        // converter, este teste pegaria: 17 != 16.
        assert_eq!(diagnostic.start, 16);
    }

    /// As tres funcoes de carga deste arquivo, contra um banco de verdade.
    ///
    /// Este modulo existe por causa de um bug que passou por revisao de
    /// codigo, por `cargo test`, por `clippy` e por `tsc` sem ser notado:
    /// `load_properties` e `load_page_meta` ligavam um `Uuid` cru contra
    /// coluna TEXT. Ligar `Uuid` cru NAO da erro — o `sqlx` manda um BLOB, o
    /// SQLite compara BLOB com texto, nao casa, e a consulta devolve zero
    /// linha. Na pratica: toda database aparecia sem propriedade nenhuma
    /// (e portanto toda formula era rejeitada como "propriedade
    /// desconhecida"), e `preview_formula` respondia `NotFound` para
    /// qualquer pagina existente.
    ///
    /// Nenhum teste de logica pura pegaria isso, porque o defeito esta
    /// exatamente na fronteira com o banco. Estes tres pegam.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use super::*;
        use crate::db::ids::IdBind;

        struct Cenario {
            pool: SqlitePool,
            caminho: std::path::PathBuf,
            database_id: Uuid,
            record_id: Uuid,
            property_id: Uuid,
        }

        async fn montar() -> Cenario {
            let caminho =
                std::env::temp_dir().join(format!("learno-formula-test-{}.sqlite", Uuid::new_v4()));
            let pool = crate::db::connect_and_migrate(&caminho).await.unwrap();

            let container_id = Uuid::now_v7();
            let database_id = Uuid::now_v7();
            let property_id = Uuid::now_v7();
            let record_id = Uuid::now_v7();

            sqlx::query("INSERT INTO pages (id, title, position) VALUES (?, ?, ?)")
                .bind(container_id.db())
                .bind("Materias")
                .bind("a0")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES (?, ?, ?)")
                .bind(database_id.db())
                .bind(container_id.db())
                .bind("Materias")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO database_properties (id, database_id, name, property_type, position) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(property_id.db())
            .bind(database_id.db())
            .bind("Preco")
            .bind("number")
            .bind("a0")
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES (?, ?, ?, ?)")
                .bind(record_id.db())
                .bind(database_id.db())
                .bind("Mitocondria")
                .bind("a1")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO database_record_values (record_id, property_id, value) VALUES (?, ?, ?)",
            )
            .bind(record_id.db())
            .bind(property_id.db())
            .bind("42.5")
            .execute(&pool)
            .await
            .unwrap();

            Cenario { pool, caminho, database_id, record_id, property_id }
        }

        async fn desmontar(cenario: Cenario) {
            cenario.pool.close().await;
            let _ = std::fs::remove_file(&cenario.caminho);
            for sufixo in ["-wal", "-shm"] {
                let mut com_sufixo = cenario.caminho.clone().into_os_string();
                com_sufixo.push(sufixo);
                let _ = std::fs::remove_file(std::path::PathBuf::from(com_sufixo));
            }
        }

        #[tokio::test]
        async fn load_properties_enxerga_as_propriedades_da_database() {
            let cenario = montar().await;

            let propriedades = load_properties(&cenario.pool, cenario.database_id).await.unwrap();

            assert_eq!(propriedades.len(), 1, "a database tem uma propriedade e ela precisa aparecer");
            let (id, tipo) = propriedades.get("Preco").expect("propriedade `Preco` precisa estar no schema");
            assert_eq!(*id, cenario.property_id);
            assert_eq!(*tipo, Type::Number);

            desmontar(cenario).await;
        }

        #[tokio::test]
        async fn load_record_values_le_o_valor_gravado() {
            let cenario = montar().await;
            let propriedades = load_properties(&cenario.pool, cenario.database_id).await.unwrap();

            let valores = load_record_values(&cenario.pool, cenario.record_id, &propriedades).await.unwrap();

            assert_eq!(valores.get(&cenario.property_id), Some(&Value::Number(42.5)));

            desmontar(cenario).await;
        }

        #[tokio::test]
        async fn load_page_meta_acha_a_pagina_em_vez_de_responder_nao_encontrada() {
            let cenario = montar().await;

            let meta = load_page_meta(&cenario.pool, cenario.record_id).await.unwrap();

            assert_eq!(meta.id, cenario.record_id);
            assert_eq!(meta.title, "Mitocondria");

            desmontar(cenario).await;
        }

        /// O caminho completo do comando, sem `State`: schema mais valores
        /// mais pagina, e a formula avaliando em cima disso. E o que
        /// `preview_formula` faz depois de resolver o pool.
        #[tokio::test]
        async fn a_previa_de_formula_avalia_contra_o_valor_real_do_registro() {
            let cenario = montar().await;
            functions::register_all();

            let properties = load_properties(&cenario.pool, cenario.database_id).await.unwrap();
            let values = load_record_values(&cenario.pool, cenario.record_id, &properties).await.unwrap();
            let page = load_page_meta(&cenario.pool, cenario.record_id).await.unwrap();
            let schema = RecordSnapshot { properties, values, page };

            let previa = build_preview("prop(\"Preco\") * 2", &schema, cenario.record_id);

            assert!(previa.diagnostics.is_empty(), "esperava formula valida, obtido {:?}", previa.diagnostics);
            assert_eq!(previa.value, serde_json::json!(85.0));

            desmontar(cenario).await;
        }

        /// Insere uma propriedade `formula` com `config.expression` — a
        /// chave que `load_formula_expression` lê.
        async fn criar_propriedade_formula(pool: &SqlitePool, database_id: Uuid, name: &str, expression: &str, position: &str) -> Uuid {
            let id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO database_properties (id, database_id, name, property_type, config, position) \
                 VALUES (?, ?, ?, 'formula', ?, ?)",
            )
            .bind(id.db())
            .bind(database_id.db())
            .bind(name)
            .bind(serde_json::json!({ "expression": expression }))
            .bind(position)
            .execute(pool)
            .await
            .unwrap();
            id
        }

        /// Monta o schema + valores + páginas da database inteira, do mesmo
        /// jeito que `evaluate_formula_column` faz depois de resolver o
        /// pool — sem passar por `State`, mesmo padrão de
        /// `a_previa_de_formula_avalia_contra_o_valor_real_do_registro`.
        async fn avaliar_coluna(pool: &SqlitePool, database_id: Uuid, expression: &str) -> Vec<FormulaColumnValue> {
            let properties = load_properties(pool, database_id).await.unwrap();
            let pages = load_all_page_meta(pool, database_id).await.unwrap();
            let record_ids: Vec<Uuid> = pages.iter().map(|meta| meta.id).collect();
            let values = load_all_record_values(pool, &record_ids, &properties).await.unwrap();
            let pages_by_id: HashMap<Uuid, PageMeta> = pages.into_iter().map(|meta| (meta.id, meta)).collect();
            let schema = ColumnSnapshot { properties, values, pages: pages_by_id };
            build_column_values(expression, &schema, &record_ids, Utc::now())
        }

        /// Entrega 2: a coluna inteira avalia o valor certo por registro —
        /// inclusive um registro SEM valor de "Preco" (recebe `null`, não
        /// derruba a coluna toda).
        #[tokio::test]
        async fn evaluate_formula_column_computes_the_right_value_per_record() {
            let cenario = montar().await;
            functions::register_all();

            let dobro_id = criar_propriedade_formula(&cenario.pool, cenario.database_id, "Dobro", "prop(\"Preco\") * 2", "a1").await;

            let record_sem_valor = Uuid::now_v7();
            sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES (?, ?, ?, ?)")
                .bind(record_sem_valor.db())
                .bind(cenario.database_id.db())
                .bind("Sem preco")
                .bind("a2")
                .execute(&cenario.pool)
                .await
                .unwrap();

            let expression = load_formula_expression(&cenario.pool, cenario.database_id, dobro_id).await.unwrap();
            let resultados = avaliar_coluna(&cenario.pool, cenario.database_id, &expression).await;

            let por_registro: HashMap<Uuid, serde_json::Value> = resultados.into_iter().map(|r| (r.record_id, r.value)).collect();
            assert_eq!(por_registro.get(&cenario.record_id), Some(&serde_json::json!(85.0)), "Preco=42.5 * 2 = 85.0");
            assert_eq!(
                por_registro.get(&record_sem_valor),
                Some(&serde_json::Value::Null),
                "registro sem Preco não pode derrubar a coluna inteira — recebe null"
            );

            desmontar(cenario).await;
        }

        /// DBS-084, fora do escopo desta rodada: uma fórmula que referencia
        /// OUTRA propriedade de fórmula não é resolvida — `load_properties`
        /// já exclui `property_type = "formula"` do schema, então
        /// `prop("Dobro")` (também uma fórmula) falha a checagem de tipo, e
        /// TODO registro da coluna recebe `null`, nunca um erro que
        /// derrubaria o comando inteiro.
        #[tokio::test]
        async fn evaluate_formula_column_referencing_another_formula_is_null_for_every_record() {
            let cenario = montar().await;
            functions::register_all();

            criar_propriedade_formula(&cenario.pool, cenario.database_id, "Dobro", "prop(\"Preco\") * 2", "a1").await;
            let quadruplo_id =
                criar_propriedade_formula(&cenario.pool, cenario.database_id, "Quadruplo", "prop(\"Dobro\") * 2", "a2").await;

            let expression = load_formula_expression(&cenario.pool, cenario.database_id, quadruplo_id).await.unwrap();
            let resultados = avaliar_coluna(&cenario.pool, cenario.database_id, &expression).await;

            assert!(!resultados.is_empty());
            assert!(
                resultados.iter().all(|r| r.value == serde_json::Value::Null),
                "referenciar outra fórmula devia dar null para todo registro, não um erro nem um valor resolvido: {resultados:?}"
            );

            desmontar(cenario).await;
        }

        #[tokio::test]
        async fn load_formula_expression_rejects_a_non_formula_property() {
            let cenario = montar().await;

            let err = load_formula_expression(&cenario.pool, cenario.database_id, cenario.property_id).await.unwrap_err();
            assert!(matches!(err, Error::Invalid(_)), "esperava Error::Invalid, obtido {err:?}");

            desmontar(cenario).await;
        }

        #[tokio::test]
        async fn load_formula_expression_rejects_a_missing_expression_key() {
            let cenario = montar().await;
            let sem_expressao_id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO database_properties (id, database_id, name, property_type, config, position) \
                 VALUES (?, ?, ?, 'formula', ?, ?)",
            )
            .bind(sem_expressao_id.db())
            .bind(cenario.database_id.db())
            .bind("SemExpressao")
            .bind(serde_json::json!({}))
            .bind("a9")
            .execute(&cenario.pool)
            .await
            .unwrap();

            let err = load_formula_expression(&cenario.pool, cenario.database_id, sem_expressao_id).await.unwrap_err();
            assert!(matches!(err, Error::Invalid(_)), "esperava Error::Invalid, obtido {err:?}");

            desmontar(cenario).await;
        }

        #[tokio::test]
        async fn load_formula_expression_reports_not_found_for_a_missing_property() {
            let cenario = montar().await;

            let err = load_formula_expression(&cenario.pool, cenario.database_id, Uuid::now_v7()).await.unwrap_err();
            assert!(matches!(err, Error::NotFound(_)), "esperava Error::NotFound, obtido {err:?}");

            desmontar(cenario).await;
        }

        /// O ponto de performance desta entrega, provado: mais de
        /// `sql::MAX_BIND_PARAMS` registros força `load_all_record_values` a
        /// rodar em MAIS de um chunk — e ainda assim devolve o valor certo
        /// por registro, sem nenhuma consulta por registro (só
        /// `ceil(n / MAX_BIND_PARAMS)` consultas de valor, não `n`).
        #[tokio::test]
        async fn evaluate_formula_column_across_more_than_one_max_bind_params_chunk() {
            let cenario = montar().await;
            functions::register_all();

            let dobro_id = criar_propriedade_formula(&cenario.pool, cenario.database_id, "Dobro", "prop(\"Preco\") * 2", "a1").await;

            let total_extra = sql::MAX_BIND_PARAMS + 5; // força pelo menos 2 chunks
            let mut ids_criados: Vec<Uuid> = Vec::with_capacity(total_extra);
            let mut tx = cenario.pool.begin().await.unwrap();
            for i in 0..total_extra {
                let record_id = Uuid::now_v7();
                sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES (?, ?, ?, ?)")
                    .bind(record_id.db())
                    .bind(cenario.database_id.db())
                    .bind(format!("Registro {i}"))
                    .bind(format!("b{i:05}"))
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO database_record_values (record_id, property_id, value) VALUES (?, ?, ?)")
                    .bind(record_id.db())
                    .bind(cenario.property_id.db())
                    .bind(i.to_string())
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                ids_criados.push(record_id);
            }
            tx.commit().await.unwrap();

            let expression = load_formula_expression(&cenario.pool, cenario.database_id, dobro_id).await.unwrap();
            let properties = load_properties(&cenario.pool, cenario.database_id).await.unwrap();
            let pages = load_all_page_meta(&cenario.pool, cenario.database_id).await.unwrap();
            let record_ids: Vec<Uuid> = pages.iter().map(|meta| meta.id).collect();
            assert!(
                record_ids.len() > sql::MAX_BIND_PARAMS,
                "o teste precisa de mais registros que MAX_BIND_PARAMS para provar o chunking: tem {}",
                record_ids.len()
            );

            let values = load_all_record_values(&cenario.pool, &record_ids, &properties).await.unwrap();
            let pages_by_id: HashMap<Uuid, PageMeta> = pages.into_iter().map(|meta| (meta.id, meta)).collect();
            let schema = ColumnSnapshot { properties, values, pages: pages_by_id };

            let resultados = build_column_values(&expression, &schema, &record_ids, Utc::now());
            assert_eq!(resultados.len(), record_ids.len());

            let por_registro: HashMap<Uuid, serde_json::Value> = resultados.into_iter().map(|r| (r.record_id, r.value)).collect();
            // O registro original do cenário (Preco=42.5) continua correto no
            // meio de centenas de outros.
            assert_eq!(por_registro.get(&cenario.record_id), Some(&serde_json::json!(85.0)));
            // Um registro do meio do lote de mais de 900 — prova que o
            // chunking não perde nem embaralha valor de nenhum registro.
            assert_eq!(por_registro.get(&ids_criados[500]), Some(&serde_json::json!(1000.0)), "Preco=500 * 2 = 1000");

            desmontar(cenario).await;
        }
    }
}
