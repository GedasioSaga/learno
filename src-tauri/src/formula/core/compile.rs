//! `compile()` — a assinatura congelada da arquitetura §9. Junta léxico,
//! sintaxe e checagem de tipo numa única chamada, devolvendo o que o
//! restante do sistema precisa de uma expressão de fórmula: a árvore em si
//! (para `eval`), o tipo de retorno (para `database_properties.config`
//! saber que tipo a coluna tem sem reavaliar nada), `depends_on` (a
//! cascata, I4) e `prop_name_spans` (o rename por substring).

use crate::formula::core::ast::Expr;
use crate::formula::core::diagnostics::Diagnostic;
use crate::formula::core::eval::ValueSource;
use crate::formula::core::parser::parse;
use crate::formula::core::typecheck::{check_program, PropNameSpan};
use crate::formula::core::types::{PropertyId, Type};

#[derive(Debug)]
pub struct Compiled {
    pub expr: Expr,
    pub return_type: Type,
    /// Toda propriedade que este `expr` lê via `prop()`, sem repetição —
    /// a aresta de dependência que a cascata de F7 (arquitetura §4, hook
    /// `cascade_formula_dependents` de `db::record_values`) usa para saber
    /// quem recalcular quando UMA propriedade muda.
    ///
    /// **Fronteira documentada, não implementada aqui:** a detecção de
    /// CICLO entre propriedades (arquitetura §4 — DFS "incluindo a fórmula
    /// candidata", recusado com `Error::Invalid` nomeando o caminho) olha o
    /// grafo de TODAS as fórmulas de uma database, não uma expressão
    /// isolada. `compile()` só vê uma fórmula por chamada — não tem como
    /// fazer essa DFS sozinho. Quem salva uma propriedade de fórmula (F6)
    /// chama `compile()` uma vez por candidata e monta o grafo com
    /// `depends_on` de cada uma para rodar a DFS por cima.
    pub depends_on: Vec<PropertyId>,
    pub prop_name_spans: Vec<PropNameSpan>,
}

/// Assinatura congelada (arquitetura §9/§11: "Congelar `FunctionDef` em F0
/// antes de liberar F1..F6"). `schema` é consultado só durante a checagem de
/// tipo (`property_by_name`) — `compile()` nunca lê `value()`/`related()`,
/// então compilar uma fórmula nunca precisa de um registro concreto, só do
/// SCHEMA da database (o que `validate_formula`, arquitetura §9, chama sem
/// `record_id`).
pub fn compile(src: &str, schema: &dyn ValueSource) -> Result<Compiled, Vec<Diagnostic>> {
    let expr = parse(src).map_err(|diagnostic| vec![diagnostic])?;
    let (return_type, depends_on, prop_name_spans) = check_program(&expr, schema).map_err(|diagnostic| vec![diagnostic])?;
    Ok(Compiled { expr, return_type, depends_on, prop_name_spans })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::eval::EvalCtx;
    use crate::formula::core::functions::{self, Arg, Arity, FunctionDef, ParamKind};
    use crate::formula::core::types::{PageMeta, Value};
    use uuid::Uuid;

    struct FakeSchema;
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
            (name == "Preço").then(|| (Uuid::from_u128(7), Type::Number))
        }
    }

    fn dobro_check(args: &[Type]) -> std::result::Result<Type, String> {
        match args {
            [Type::Number] => Ok(Type::Number),
            other => Err(format!("dobro() espera (número); recebeu {other:?}")),
        }
    }

    fn dobro_eval(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
        match &args[0] {
            Arg::Value(Value::Number(n)) => Value::Number(n * 2.0),
            _ => Value::Empty,
        }
    }

    fn register_dobro() {
        functions::register(FunctionDef {
            name: "core_compile_test_dobro",
            category: "teste",
            doc: "dobra um número — só existe nos testes deste arquivo",
            arity: Arity::Exact(1),
            params: |_| ParamKind::Value,
            check: dobro_check,
            accepts_empty: |_| false,
            eval: dobro_eval,
        });
    }

    #[test]
    fn compile_then_eval_round_trip() {
        register_dobro();
        let compiled = compile("core_compile_test_dobro(prop(\"Preço\") + 1)", &FakeSchema).unwrap();
        assert_eq!(compiled.return_type, Type::Number);
        assert_eq!(compiled.depends_on, vec![Uuid::from_u128(7)]);

        struct SchemaComValor;
        impl ValueSource for SchemaComValor {
            fn value(&self, _record: Uuid, _property: PropertyId) -> Value {
                Value::Number(20.0)
            }
            fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
                Vec::new()
            }
            fn page_meta(&self, record: Uuid) -> PageMeta {
                PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
            }
            fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
                (name == "Preço").then(|| (Uuid::from_u128(7), Type::Number))
            }
        }

        let schema = SchemaComValor;
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        let value = crate::formula::core::eval::eval(&compiled.expr, &mut ctx);
        assert_eq!(value, Value::Number(42.0));
    }

    #[test]
    fn syntax_error_is_reported_as_a_single_diagnostic() {
        let errors = compile("1 +", &FakeSchema).unwrap_err();
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn type_error_is_reported_as_a_single_diagnostic() {
        let errors = compile("\"a\" + prop(\"Preço\")", &FakeSchema).unwrap_err();
        assert_eq!(errors.len(), 1);
    }
}
