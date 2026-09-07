//! O núcleo da linguagem de fórmula (arquitetura §4/§9) — léxico, sintaxe,
//! sistema de tipos, checagem estática, avaliador e a tabela de funções como
//! ponto de extensão. Nada aqui faz I/O: quem lê SQLite é o adaptador de
//! [`eval::ValueSource`] que `ipc::formula_commands` monta.
//!
//! Um arquivo por responsabilidade, na ordem em que os dados fluem:
//! `lexer` -> `parser` (produz `ast::Expr`) -> `typecheck` -> `eval`, com
//! `compile` amarrando lexer+parser+typecheck na assinatura congelada da
//! arquitetura §9, `types` definindo `Type`/`Value` que todo o resto usa, e
//! `functions` sendo a tabela que F1..F6 preenchem.

mod ast;
mod compile;
mod diagnostics;
mod eval;
mod functions;
mod lexer;
mod parser;
mod typecheck;
mod types;

pub use ast::{BinaryOp, Expr, ExprKind, UnaryOp};
pub use compile::{compile, Compiled};
pub use diagnostics::{Diagnostic, Severity, Span};
pub use eval::{eval, EvalCtx, ValueSource};
pub use functions::{register, Arg, Arity, FunctionDef, LambdaArg, ParamKind};
pub use typecheck::PropNameSpan;
pub use types::{DateValue, PageMeta, PersonValue, PropertyId, Type, Value};

/// `list_formula_functions` (arquitetura §9) lê a tabela por aqui — nomeado
/// à parte de [`functions::register`]/[`functions::lookup`] (que ficam
/// `pub(crate)` via o módulo, exceto `register`, que F1..F6 chamam de fora
/// deste crate? Não: tudo isto é `learno_lib`, um único crate, então
/// `pub use` já basta — sem necessidade de reexportar `lookup` publicamente,
/// já que só `eval`/`typecheck` (dentro deste módulo) precisam dele.
pub fn list_functions() -> Vec<FunctionDef> {
    functions::list_all()
}

#[cfg(test)]
mod tests {
    //! Prova do núcleo inteiro, ponta a ponta: lexer -> parser -> checagem
    //! de tipo -> avaliador -> tabela de funções, com TRÊS funções de
    //! teste registradas AQUI (nunca em `functions/mod.rs` — aquele arquivo
    //! é de F1..F6, "não implemente as funções concretas"), cada uma
    //! provando um mecanismo distinto do contrato `FunctionDef`:
    //!
    //! - `core_test_add_one` — a forma comum: parâmetro `Value`, vazio
    //!   propaga de graça (não precisa de `accepts_empty`).
    //! - `core_test_is_present` — `accepts_empty(0) = true`: a MINORIA de
    //!   função que precisa observar vazio em vez de propagar (o mecanismo
    //!   que `empty()`, DBS-077, vai usar).
    //! - `core_test_map` — `ParamKind::Lambda`: o mecanismo de ordem
    //!   superior que `map`/`filter`/`some`/`every` (DBS-078/080, F5) vão
    //!   usar, aqui provado sobre uma relação de verdade (`prop()`
    //!   despachando para `related()`, `current.prop(...)` lendo de cada
    //!   página apontada) — não uma lista fabricada à mão, porque
    //!   `docs/ACHADOS-FASE-2.md` já pagou o preço de um teste que não
    //!   atravessa a fronteira que a feature atravessa.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use uuid::Uuid;

    fn add_one_check(args: &[Type]) -> std::result::Result<Type, String> {
        match args {
            [Type::Number] => Ok(Type::Number),
            other => Err(format!("core_test_add_one espera (número); recebeu {other:?}")),
        }
    }

    fn add_one_eval(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
        match &args[0] {
            Arg::Value(Value::Number(n)) => Value::Number(n + 1.0),
            // Sentinela DISTINTO de `Value::Empty`, de propósito: se este
            // braço rodar, é porque o curto-circuito de "vazio propaga"
            // (`accepts_empty(0) == false`, arquitetura §4) falhou e a
            // função recebeu um vazio que a tabela prometeu que ela nunca
            // veria. O teste `add_one_propagates_empty_without_the_function_ever_seeing_it`
            // depende de `-999.0` NUNCA aparecer.
            _ => Value::Number(-999.0),
        }
    }

    fn is_present_check(args: &[Type]) -> std::result::Result<Type, String> {
        if args.len() == 1 {
            Ok(Type::Boolean)
        } else {
            Err("core_test_is_present espera 1 argumento".to_string())
        }
    }

    fn is_present_eval(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
        match &args[0] {
            Arg::Value(Value::Empty) | Arg::Lambda(_) => Value::Boolean(false),
            Arg::Value(_) => Value::Boolean(true),
        }
    }

    fn map_params(index: usize) -> ParamKind {
        if index == 0 {
            ParamKind::Value
        } else {
            ParamKind::Lambda { binds: "current", bind_type: map_bind_type }
        }
    }

    fn map_bind_type(prefix: &[Type]) -> Type {
        match prefix {
            [Type::List(item)] => (**item).clone(),
            // Só alcançável com a chamada já mal tipada (primeiro argumento
            // não é lista) — `map_check` abaixo recusa isso de qualquer
            // jeito; este valor nunca chega a aparecer num diagnóstico.
            _ => Type::Number,
        }
    }

    fn map_check(args: &[Type]) -> std::result::Result<Type, String> {
        match args {
            [Type::List(_), body_type] => Ok(Type::List(Box::new(body_type.clone()))),
            other => Err(format!("core_test_map espera (lista<T>, corpo); recebeu {other:?}")),
        }
    }

    fn map_eval(args: &[Arg], ctx: &mut EvalCtx) -> Value {
        let (Arg::Value(Value::List(items)), Arg::Lambda(body)) = (&args[0], &args[1]) else {
            return Value::Empty;
        };
        Value::List(items.iter().map(|item| body.call(ctx, "current", item.clone())).collect())
    }

    fn register_test_functions() {
        register(FunctionDef {
            name: "core_test_add_one",
            category: "teste",
            doc: "soma 1 — só existe nos testes do núcleo",
            arity: Arity::Exact(1),
            params: |_| ParamKind::Value,
            check: add_one_check,
            accepts_empty: |_| false,
            eval: add_one_eval,
        });
        register(FunctionDef {
            name: "core_test_is_present",
            category: "teste",
            doc: "true se o argumento não é vazio — só existe nos testes do núcleo",
            arity: Arity::Exact(1),
            params: |_| ParamKind::Value,
            check: is_present_check,
            accepts_empty: |_| true,
            eval: is_present_eval,
        });
        register(FunctionDef {
            name: "core_test_map",
            category: "teste",
            doc: "map(lista, corpo) — só existe nos testes do núcleo",
            arity: Arity::Exact(2),
            params: map_params,
            check: map_check,
            accepts_empty: |_| false,
            eval: map_eval,
        });
    }

    /// Duas páginas relacionadas de verdade (`related()`), cada uma com sua
    /// própria propriedade "Valor" — o mesmo par (relação, prop do lado de
    /// dentro) que DBS-078/080 pedem, e a MESMA forma que `ACHADOS-FASE-2`
    /// aponta como o jeito certo de testar (fabricar o dado pela API real,
    /// não montar o resultado esperado à mão).
    struct RelationSchema {
        page_a: Uuid,
        page_b: Uuid,
    }

    /// Ids fixos das três propriedades que o fake conhece — usados tanto em
    /// `property_by_name` quanto em `value`, para que os dois lados
    /// concordem sobre qual propriedade é qual sem depender de `record`
    /// sozinho (que não identifica propriedade nenhuma).
    fn valor_property_id() -> Uuid {
        Uuid::from_u128(101)
    }
    fn vazio_property_id() -> Uuid {
        Uuid::from_u128(102)
    }

    impl ValueSource for RelationSchema {
        fn value(&self, record: Uuid, property: PropertyId) -> Value {
            if property == valor_property_id() {
                if record == self.page_a {
                    Value::Number(10.0)
                } else if record == self.page_b {
                    Value::Number(20.0)
                } else {
                    Value::Empty
                }
            } else {
                // "Vazio" (DBS-054/077: uma propriedade que existe no
                // schema mas não tem linha para este registro) e qualquer
                // outra propriedade desconhecida caem no mesmo lugar: I1 diz
                // que os dois casos são indistinguíveis por fora — vazio é
                // a AUSÊNCIA da linha, não um terceiro estado.
                Value::Empty
            }
        }

        fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
            vec![self.page_a, self.page_b]
        }

        fn page_meta(&self, record: Uuid) -> PageMeta {
            PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
        }

        fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
            match name {
                "Relação" => Some((Uuid::from_u128(100), Type::List(Box::new(Type::Page)))),
                "Valor" => Some((valor_property_id(), Type::Number)),
                "Vazio" => Some((vazio_property_id(), Type::Number)),
                _ => None,
            }
        }
    }

    #[test]
    fn add_one_computes_over_a_plain_number() {
        register_test_functions();
        let schema = RelationSchema { page_a: Uuid::new_v4(), page_b: Uuid::new_v4() };
        let compiled = compile("core_test_add_one(5)", &schema).unwrap();
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        assert_eq!(eval(&compiled.expr, &mut ctx), Value::Number(6.0));
    }

    /// `"Vazio"` é uma propriedade que EXISTE no schema (então `compile()`
    /// aceita a chamada e `depends_on` a registra) mas cujo `value()`
    /// sempre devolve `Value::Empty` — a mesma forma que uma célula
    /// realmente vazia (I1: a linha simplesmente não existe) chega ao
    /// avaliador. Prova que "vazio propaga" (arquitetura §4) acontece no
    /// CURTO-CIRCUITO de `eval_call`, sem que `core_test_add_one` precise
    /// de nenhuma lógica própria para isso: se o curto-circuito falhasse,
    /// `add_one_eval` receberia o vazio e devolveria o sentinela
    /// `-999.0`, não `Value::Empty`.
    #[test]
    fn add_one_propagates_empty_without_the_function_ever_seeing_it() {
        register_test_functions();
        let schema = RelationSchema { page_a: Uuid::new_v4(), page_b: Uuid::new_v4() };
        let compiled = compile("core_test_add_one(prop(\"Vazio\"))", &schema).unwrap();
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        assert_eq!(eval(&compiled.expr, &mut ctx), Value::Empty);
    }

    /// O espelho do teste acima: com `accepts_empty(0) == true`,
    /// `core_test_is_present` PRECISA receber o `Value::Empty` de verdade
    /// (não um curto-circuito) para devolver `false` em vez de propagar —
    /// se o mecanismo de `accepts_empty` estivesse quebrado, o resultado
    /// seria `Value::Empty`, nunca `Value::Boolean(false)`.
    #[test]
    fn is_present_true_for_a_value_false_for_empty() {
        register_test_functions();
        let schema = RelationSchema { page_a: Uuid::new_v4(), page_b: Uuid::new_v4() };

        let present = compile("core_test_is_present(1)", &schema).unwrap();
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        assert_eq!(eval(&present.expr, &mut ctx), Value::Boolean(true));

        let empty = compile("core_test_is_present(prop(\"Vazio\"))", &schema).unwrap();
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        assert_eq!(eval(&empty.expr, &mut ctx), Value::Boolean(false));
    }

    /// A prova principal: `prop("Relação")` despacha para `related()`
    /// (arquitetura §5 — relação não tem linha em `database_record_values`),
    /// produzindo `List<Page>`; `core_test_map` (mecanismo `Lambda`) chama o
    /// corpo `current.prop("Valor")` uma vez por página, cada vez lendo da
    /// página CORRETA — não uma lista fabricada à mão.
    #[test]
    fn map_over_a_real_relation_dispatches_prop_per_item() {
        register_test_functions();
        let schema = RelationSchema { page_a: Uuid::new_v4(), page_b: Uuid::new_v4() };
        let compiled = compile("prop(\"Relação\").core_test_map(current.prop(\"Valor\"))", &schema).unwrap();
        assert_eq!(compiled.return_type, Type::List(Box::new(Type::Number)));

        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        let result = eval(&compiled.expr, &mut ctx);
        assert_eq!(result, Value::List(vec![Value::Number(10.0), Value::Number(20.0)]));
    }

    #[test]
    fn depends_on_reaches_inside_the_lambda_body_too() {
        register_test_functions();
        let schema = RelationSchema { page_a: Uuid::new_v4(), page_b: Uuid::new_v4() };
        let compiled = compile("prop(\"Relação\").core_test_map(current.prop(\"Valor\"))", &schema).unwrap();
        assert_eq!(compiled.depends_on.len(), 2, "\"Relação\" e \"Valor\" — o de dentro do corpo do lambda também conta");
    }
}
