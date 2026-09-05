//! Os três comandos de fórmula da arquitetura §9 — `formula::core` faz o
//! trabalho puro (léxico, sintaxe, tipo, avaliação); este arquivo é só a
//! fronteira: busca o schema/valores em Postgres, monta o adaptador de
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

async fn load_properties(pool: &SqlitePool, database_id: Uuid) -> Result<HashMap<String, (PropertyId, Type)>> {
    let rows = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, name, property_type FROM database_properties WHERE database_id = $1",
    )
    .bind(database_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(id, name, property_type)| map_property_type(&property_type).map(|ty| (name, (id, ty))))
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

    let rows = sqlx::query_as::<_, (Uuid, serde_json::Value)>(
        "SELECT property_id, value FROM database_record_values WHERE record_id = $1 AND property_id = ANY($2)",
    )
    .bind(record_id)
    .bind(&scalar_ids)
    .fetch_all(pool)
    .await?;

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
    .bind(record_id)
    .fetch_optional(pool)
    .await?;

    let (title, created_at, updated_at) = row.ok_or_else(|| Error::NotFound(format!("página {record_id}")))?;
    Ok(PageMeta { id: record_id, title, created_at: format_local_i5(created_at), updated_at: format_local_i5(updated_at) })
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
}
