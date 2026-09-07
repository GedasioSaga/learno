//! Categoria "lógica" (DBS-075/076/077): `if`/`ifs` (condicional),
//! `and`/`or`/`not` (forma de FUNÇÃO dos operadores infixos `&&`/`||`/`!`,
//! que já existem em `core/eval.rs` — DBS-076 já está coberto por eles,
//! nada aqui duplica), `empty`/`equal`/`unequal` (DBS-077). Os comparadores
//! `==`/`>`/`>=`/`<`/`<=` TAMBÉM já são infixos em `core/eval.rs`
//! (`BinaryOp::Eq/NotEq/Gt/GtEq/Lt/LtEq`, com o parser aceitando a sintaxe
//! desde F0) — nada aqui os duplica; `equal`/`unequal` são só a forma de
//! FUNÇÃO de `==`/`!=`, replicando a MESMA regra de vazio (abaixo).
//!
//! ## `if`/`ifs` são de verdade PREGUIÇOSOS — a mesma decisão do ternário
//!
//! DBS-075 descreve o ternário como "atalho para if": as duas formas têm
//! que se comportar igual, e o ternário (`eval.rs::eval`, `Ternary`) só
//! avalia o ramo ESCOLHIDO, nunca os dois. Por isso os ramos de `if`/`ifs`
//! usam `ParamKind::Lambda` em vez de `ParamKind::Value` — o mecanismo que
//! `map`/`filter` (F5) vão usar para o corpo não-avaliado, aqui
//! reaproveitado sem nenhum `binds` de verdade (o nome que passamos para
//! `LambdaArg::call` nunca é referenciado pelo ramo, então a escolha do
//! nome não importa, contanto que não colida com `current`). Consequência
//! DIRETA e testada: `if(cond, a, b)` com `b` vazio devolve VAZIO quando a
//! condição escolhe `b` — o mesmo que `cond ? a : b` já faz — em vez de
//! curto-circuitar a chamada inteira, porque o mecanismo de "vazio
//! propaga" de `eval_call` (`core/eval.rs`) só se aplica a argumento
//! `ParamKind::Value`, nunca a um `Lambda`.
//!
//! A condição (`cond`, único argumento `ParamKind::Value` de `if`; os de
//! índice par de `ifs`) tem `accepts_empty = true`: precisa RECEBER o vazio
//! de verdade para tratá-lo como falso (a mesma regra do ternário — "vazio
//! é falso em contexto booleano"), em vez de propagar a chamada inteira
//! para vazio.
//!
//! ## `and`/`or`/`not`: mesma regra de vazio que `&&`/`||`/`!`
//!
//! Para a função nomeada se comportar EXATAMENTE como o operador infixo
//! (`not(x)` == `!x`), os três têm `accepts_empty(_) = true` em todo
//! argumento — vazio chega como `Value::Empty` de verdade e é tratado como
//! falso por [`is_truthy`], nunca propagado (o mesmo raciocínio do teste
//! `empty_is_false_in_boolean_context...` de `core/eval.rs`).
//!
//! ## `empty()`/`equal()`/`unequal()`
//!
//! `empty()` PRECISA observar o vazio (é o próprio ponto da função) —
//! `accepts_empty(0) = true`, a minoria nomeada no comentário de
//! `FunctionDef::accepts_empty`. `equal`/`unequal` replicam a regra I4 de
//! `core/eval.rs`: "comparação com vazio é SEMPRE `false`, nunca vazio" —
//! por isso também têm `accepts_empty = true` nos dois argumentos (senão o
//! vazio faria a chamada INTEIRA propagar para vazio, e não `false`).
mod checks;

use crate::formula::core::{register, Arg, Arity, EvalCtx, FunctionDef, ParamKind, Type, Value};

use checks::{check_and, check_empty, check_equal, check_if, check_ifs, check_not, check_or, check_unequal};

/// O nome de vínculo que `if`/`ifs` empurram para `EvalCtx` ao chamar o
/// ramo escolhido — nunca referenciado pelo corpo (nem `if` nem `ifs` têm
/// uma variável tipo `current`), só existe porque `LambdaArg::call` exige
/// um nome. Prefixado com `_` e distinto de `"current"` para nunca colidir
/// com um vínculo de verdade de um `map`/`filter` externo.
const UNUSED_BRANCH_BINDING: &str = "_branch";

/// `Value::Boolean(true)` é verdadeiro; TUDO o mais — `Empty`, `Boolean(false)`
/// e qualquer forma que o checador não deveria ter deixado passar — é
/// falso. A MESMA regra de `eval.rs::truthy` (privada àquele módulo),
/// reimplementada aqui porque `core::eval` não a exporta — replicar esta
/// função de uma linha é mais simples que abrir mais uma exportação
/// pública só para isto.
fn is_truthy(value: &Value) -> bool {
    matches!(value, Value::Boolean(true))
}

fn is_present(value: &Value) -> bool {
    !matches!(value, Value::Empty)
}

/// Igualdade estrutural restrita — a MESMA lista de pares que
/// `eval.rs::values_equal` cobre (privada àquele módulo): número, texto,
/// booleano, data e página. Um par de listas ou de pessoas do MESMO tipo
/// estático ainda devolve `false` aqui, de propósito — é o comportamento
/// que já vale para `==`/`!=` infixo, e `equal()`/`unequal()` existem para
/// SER a mesma regra em forma de função, não uma regra nova.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Boolean(x), Value::Boolean(y)) => x == y,
        (Value::Date(x), Value::Date(y)) => x == y,
        (Value::Page(x), Value::Page(y)) => x == y,
        _ => false,
    }
}

fn eval_if(args: &[Arg], ctx: &mut EvalCtx) -> Value {
    let Some(Arg::Value(cond)) = args.first() else {
        return Value::Empty;
    };
    let chosen = if is_truthy(cond) { args.get(1) } else { args.get(2) };
    match chosen {
        Some(Arg::Lambda(body)) => body.call(ctx, UNUSED_BRANCH_BINDING, Value::Empty),
        // Defensivo: `branch_params` só marca os índices 1 e 2 como
        // `Lambda` — nunca deveria chegar aqui pós-`compile()` bem-sucedido.
        _ => Value::Empty,
    }
}

fn eval_ifs(args: &[Arg], ctx: &mut EvalCtx) -> Value {
    let mut index = 0;
    while index + 1 < args.len() {
        let condition_is_true = match args.get(index) {
            Some(Arg::Value(value)) => is_truthy(value),
            _ => false,
        };
        if condition_is_true {
            return match args.get(index + 1) {
                Some(Arg::Lambda(body)) => body.call(ctx, UNUSED_BRANCH_BINDING, Value::Empty),
                _ => Value::Empty,
            };
        }
        index += 2;
    }
    // Nenhum par casou — só alcançável se a ÚLTIMA condição (convenção:
    // `true` literal, DBS-075) também for falsa/vazia, o que o checador
    // permite (é só mais uma condição booleana comum). TOTAL: vazio, nunca
    // pânico.
    Value::Empty
}

fn eval_and(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    for arg in args {
        match arg {
            Arg::Value(value) if !is_truthy(value) => return Value::Boolean(false),
            Arg::Value(_) => {}
            // Defensivo: `and` só declara argumentos `Value` em `params`.
            Arg::Lambda(_) => return Value::Empty,
        }
    }
    Value::Boolean(true)
}

fn eval_or(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    for arg in args {
        match arg {
            Arg::Value(value) if is_truthy(value) => return Value::Boolean(true),
            Arg::Value(_) => {}
            Arg::Lambda(_) => return Value::Empty,
        }
    }
    Value::Boolean(false)
}

fn eval_not(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match args.first() {
        Some(Arg::Value(value)) => Value::Boolean(!is_truthy(value)),
        _ => Value::Empty,
    }
}

fn eval_empty(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match args.first() {
        Some(Arg::Value(value)) => Value::Boolean(!is_present(value)),
        _ => Value::Empty,
    }
}

fn eval_equal(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (args.first(), args.get(1)) {
        (Some(Arg::Value(a)), Some(Arg::Value(b))) => Value::Boolean(is_present(a) && is_present(b) && values_equal(a, b)),
        _ => Value::Empty,
    }
}

fn eval_unequal(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (args.first(), args.get(1)) {
        (Some(Arg::Value(a)), Some(Arg::Value(b))) => Value::Boolean(is_present(a) && is_present(b) && !values_equal(a, b)),
        _ => Value::Empty,
    }
}

/// O tipo do vínculo nunca é observado (ver a doc do módulo) — `Boolean` é
/// só um valor arbitrário para satisfazer a assinatura de `bind_type`.
fn unused_bind_type(_prefix: &[Type]) -> Type {
    Type::Boolean
}

fn branch_params(index: usize) -> ParamKind {
    if index == 0 {
        ParamKind::Value
    } else {
        ParamKind::Lambda { binds: UNUSED_BRANCH_BINDING, bind_type: unused_bind_type }
    }
}

fn ifs_params(index: usize) -> ParamKind {
    if index.is_multiple_of(2) {
        ParamKind::Value
    } else {
        ParamKind::Lambda { binds: UNUSED_BRANCH_BINDING, bind_type: unused_bind_type }
    }
}

pub fn register_all() {
    register(FunctionDef {
        name: "if",
        category: "lógica",
        doc: "if(condição, então, senão) — atalho de função para o ternário \"?:\".",
        arity: Arity::Exact(3),
        params: branch_params,
        check: check_if,
        accepts_empty: |_| true,
        eval: eval_if,
    });
    register(FunctionDef {
        name: "ifs",
        category: "lógica",
        doc: "ifs(cond1, resultado1, ..., condN, resultadoN) — encadeia condições, a primeira verdadeira vence.",
        arity: Arity::AtLeast(2),
        params: ifs_params,
        check: check_ifs,
        accepts_empty: |_| true,
        eval: eval_ifs,
    });
    register(FunctionDef {
        name: "and",
        category: "lógica",
        doc: "Verdadeiro se todos os argumentos forem verdadeiros — forma de função de \"&&\".",
        arity: Arity::AtLeast(1),
        params: |_| ParamKind::Value,
        check: check_and,
        accepts_empty: |_| true,
        eval: eval_and,
    });
    register(FunctionDef {
        name: "or",
        category: "lógica",
        doc: "Verdadeiro se algum argumento for verdadeiro — forma de função de \"||\".",
        arity: Arity::AtLeast(1),
        params: |_| ParamKind::Value,
        check: check_or,
        accepts_empty: |_| true,
        eval: eval_or,
    });
    register(FunctionDef {
        name: "not",
        category: "lógica",
        doc: "Nega um booleano — forma de função de \"!\".",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_not,
        accepts_empty: |_| true,
        eval: eval_not,
    });
    register(FunctionDef {
        name: "empty",
        category: "lógica",
        doc: "Verdadeiro se o argumento for vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_empty,
        accepts_empty: |_| true,
        eval: eval_empty,
    });
    register(FunctionDef {
        name: "equal",
        category: "lógica",
        doc: "Igualdade entre dois valores do mesmo tipo — forma de função de \"==\".",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_equal,
        accepts_empty: |_| true,
        eval: eval_equal,
    });
    register(FunctionDef {
        name: "unequal",
        category: "lógica",
        doc: "Diferença entre dois valores do mesmo tipo — forma de função de \"!=\".",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_unequal,
        accepts_empty: |_| true,
        eval: eval_unequal,
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::{compile, eval, PageMeta, PropertyId, ValueSource};
    use uuid::Uuid;

    /// Schema falso com "Nota" (número) e "Ativo" (booleano) configuráveis —
    /// o par que o exemplo literal de DBS-076 e os testes de `ifs`/DBS-075
    /// precisam.
    struct FakeSchema {
        nota: Option<f64>,
        ativo: Option<bool>,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, property: PropertyId) -> Value {
            if property == Uuid::from_u128(1) {
                self.nota.map(Value::Number).unwrap_or(Value::Empty)
            } else if property == Uuid::from_u128(2) {
                self.ativo.map(Value::Boolean).unwrap_or(Value::Empty)
            } else {
                Value::Empty
            }
        }
        fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
            Vec::new()
        }
        fn page_meta(&self, record: Uuid) -> PageMeta {
            PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
        }
        fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
            match name {
                "Nota" => Some((Uuid::from_u128(1), Type::Number)),
                "Ativo" => Some((Uuid::from_u128(2), Type::Boolean)),
                _ => None,
            }
        }
    }

    fn run_with(nota: Option<f64>, ativo: Option<bool>, src: &str) -> Value {
        crate::formula::functions::register_all();
        let schema = FakeSchema { nota, ativo };
        let compiled = compile(src, &schema).unwrap_or_else(|errors| panic!("esperava compilar \"{src}\", veio {errors:?}"));
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    fn run(src: &str) -> Value {
        run_with(None, None, src)
    }

    #[test]
    fn if_happy_path_picks_the_right_branch() {
        assert_eq!(run("if(true, 1, 2)"), Value::Number(1.0));
        assert_eq!(run("if(false, 1, 2)"), Value::Number(2.0));
    }

    /// A resposta escolhida para a pergunta que o pedido levanta: `b` vazio
    /// devolve VAZIO quando a condição escolhe `b`, o mesmo que `cond ? a :
    /// b` já faz — não curto-circuita a chamada inteira.
    #[test]
    fn if_returns_empty_when_the_chosen_branch_is_empty_matching_the_ternary() {
        assert_eq!(run_with(None, None, "if(false, 1, prop(\"Nota\"))"), Value::Empty);
        assert_eq!(run_with(None, None, "false ? 1 : prop(\"Nota\")"), Value::Empty);
    }

    /// A condição vazia é tratada como falsa — a mesma regra do ternário.
    #[test]
    fn if_with_an_empty_condition_takes_the_else_branch() {
        assert_eq!(run_with(None, None, "if(prop(\"Ativo\"), 1, 2)"), Value::Number(2.0));
    }

    /// O exemplo LITERAL de DBS-075: `ifs(Nota>=7,"Aprovado",Nota>=5,
    /// "Recuperação",true,"Reprovado")` com Nota=6 retorna "Recuperação".
    #[test]
    fn dbs_075_ifs_literal_example() {
        let src = "ifs(prop(\"Nota\")>=7,\"Aprovado\",prop(\"Nota\")>=5,\"Recuperação\",true,\"Reprovado\")";
        assert_eq!(run_with(Some(6.0), None, src), Value::String("Recuperação".to_string()));
        assert_eq!(run_with(Some(8.0), None, src), Value::String("Aprovado".to_string()));
        assert_eq!(run_with(Some(2.0), None, src), Value::String("Reprovado".to_string()));
    }

    /// `ifs` só avalia o ramo ESCOLHIDO — um ramo depois do vencedor pode
    /// referenciar uma propriedade vazia sem afetar o resultado.
    #[test]
    fn ifs_only_evaluates_the_chosen_branch() {
        let src = "ifs(true, 1, true, prop(\"Nota\"))";
        assert_eq!(run_with(None, None, src), Value::Number(1.0));
    }

    /// Borda pedida pela regra 6: número ÍMPAR de argumentos é recusado na
    /// checagem de tipo, nunca num pânico em runtime.
    #[test]
    fn ifs_with_an_odd_number_of_arguments_is_a_compile_error() {
        let schema = FakeSchema { nota: None, ativo: None };
        let err = compile("ifs(true, 1, false)", &schema).unwrap_err();
        assert!(err[0].message.contains("par"), "mensagem devia citar o número par esperado: {:?}", err[0].message);
    }

    /// O exemplo LITERAL de DBS-076: `prop("Ativo") && prop("Nota")>5` —
    /// confirma que o operador infixo já cobre o caso sem nenhuma função
    /// desta categoria (nada aqui duplica `&&`).
    #[test]
    fn dbs_076_infix_and_already_works_without_a_named_function() {
        assert_eq!(run_with(Some(8.0), Some(true), "prop(\"Ativo\") && prop(\"Nota\")>5"), Value::Boolean(true));
        assert_eq!(run_with(Some(8.0), Some(false), "prop(\"Ativo\") && prop(\"Nota\")>5"), Value::Boolean(false));
    }

    #[test]
    fn and_or_not_named_functions_match_the_infix_operators() {
        assert_eq!(run("and(true, true)"), run("true && true"));
        assert_eq!(run("and(true, false)"), run("true && false"));
        assert_eq!(run("or(false, true)"), run("false || true"));
        assert_eq!(run("not(true)"), run("!true"));
    }

    #[test]
    fn and_or_treat_empty_as_false_same_as_the_infix_operators() {
        assert_eq!(run_with(None, None, "and(true, prop(\"Ativo\"))"), Value::Boolean(false));
        assert_eq!(run_with(None, None, "true && prop(\"Ativo\")"), Value::Boolean(false));
        assert_eq!(run_with(None, None, "or(false, prop(\"Ativo\"))"), Value::Boolean(false));
        assert_eq!(run_with(None, None, "not(prop(\"Ativo\"))"), Value::Boolean(true));
    }

    /// `and`/`or` com um único argumento são só a truthiness dele.
    #[test]
    fn and_or_with_a_single_argument() {
        assert_eq!(run("and(true)"), Value::Boolean(true));
        assert_eq!(run("or(false)"), Value::Boolean(false));
    }

    /// Borda pedida pela regra 6: `and`/`or` com ZERO argumentos são
    /// recusados na checagem de tipo (`Arity::AtLeast(1)`), nunca num
    /// pânico em runtime.
    #[test]
    fn and_or_with_zero_arguments_is_a_compile_error() {
        let schema = FakeSchema { nota: None, ativo: None };
        assert!(compile("and()", &schema).is_err());
        assert!(compile("or()", &schema).is_err());
    }

    /// O exemplo LITERAL de DBS-077: `empty(prop("Notas"))` com o campo em
    /// branco retorna `true`.
    #[test]
    fn dbs_077_empty_of_a_blank_field_is_true() {
        assert_eq!(run_with(None, None, "empty(prop(\"Nota\"))"), Value::Boolean(true));
        assert_eq!(run_with(Some(5.0), None, "empty(prop(\"Nota\"))"), Value::Boolean(false));
    }

    #[test]
    fn equal_and_unequal_happy_path() {
        assert_eq!(run("equal(1, 1)"), Value::Boolean(true));
        assert_eq!(run("equal(1, 2)"), Value::Boolean(false));
        assert_eq!(run("unequal(1, 2)"), Value::Boolean(true));
        assert_eq!(run("unequal(1, 1)"), Value::Boolean(false));
    }

    /// `equal`/`unequal` replicam a I4 de `core/eval.rs`: comparação com
    /// vazio é SEMPRE `false`, nunca vazio — mesmo `unequal` entre dois
    /// vazios.
    #[test]
    fn equal_and_unequal_of_empty_is_always_false_never_empty() {
        assert_eq!(run_with(None, None, "equal(prop(\"Nota\"), 5)"), Value::Boolean(false));
        assert_eq!(run_with(None, None, "unequal(prop(\"Nota\"), 5)"), Value::Boolean(false));
        assert_eq!(run_with(None, None, "unequal(prop(\"Nota\"), prop(\"Nota\"))"), Value::Boolean(false));
    }
}
