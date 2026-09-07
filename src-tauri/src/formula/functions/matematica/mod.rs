//! Categoria "matemática" (DBS-062): `add`/`subtract`/`multiply`/`divide`/
//! `mod`/`pow`/`abs`/`round`/`ceil`/`floor`/`sqrt`/`cbrt` — todas sobre
//! `Type::Number`, todas com `accepts_empty(_) = false` (vazio propaga de
//! graça, arquitetura §4).
//!
//! Decisões de borda, cada uma testada abaixo:
//! - **Divisão e módulo por zero devolvem `Value::Empty`**, o mesmo que
//!   `eval_arithmetic` (`core/eval.rs`) já faz para `/` e `%` infixos — `add`
//!   .. `pow` são só a forma de FUNÇÃO dos mesmos operadores (mais `pow`, que
//!   não tem forma infixa), então repetem a regra em vez de inventar outra.
//! - **`sqrt` de negativo devolve `Value::Empty`** (raiz não é real) em vez de
//!   `NaN` — a linguagem é TOTAL e `Value::Number` nunca carrega `NaN`
//!   (`core/types.rs`).
//! - **`finite_number`** é o guarda-chuva: qualquer resultado que escape de
//!   finito (overflow de `pow`, ou de `round` com casas absurdas) vira
//!   `Value::Empty` em vez de `Value::Number(f64::INFINITY)`.
//! - **`round` aceita 1 ou 2 argumentos** (`Arity::Range(1, 2)`) — o segundo
//!   (casas decimais) é OPCIONAL, default 0. Casas são clampadas para
//!   `[-100, 100]` antes de virar expoente de `10f64.powi` — ver o
//!   comentário de `eval_round` para o porquê desse número.
mod checks;

use crate::formula::core::{register, Arg, Arity, EvalCtx, FunctionDef, ParamKind, Value};

use checks::{
    check_abs, check_add, check_cbrt, check_ceil, check_divide, check_floor, check_modulo, check_multiply, check_pow,
    check_round, check_sqrt, check_subtract,
};

/// Extrai um `f64` do argumento de índice `index`, assumindo `ParamKind::Value`
/// (nunca `Lambda` — nenhuma função desta categoria usa `current`) e tipo
/// estático já validado como `Number` por `check`. `None` só de forma
/// DEFENSIVA (argumento ausente, ou uma variante que `check` não deveria ter
/// deixado passar) — nunca panic, sempre vira `Value::Empty` em quem chama.
fn number_arg(args: &[Arg], index: usize) -> Option<f64> {
    match args.get(index) {
        Some(Arg::Value(Value::Number(n))) => Some(*n),
        _ => None,
    }
}

/// `Value::Number` que NUNCA carrega `NaN`/`Infinity` (arquitetura §4,
/// `core/types.rs`: "jsonb não representa nenhum dos dois"). Toda função
/// desta categoria que pode produzir um resultado não-finito — overflow de
/// `pow`, ou de `round` com casas absurdas multiplicando por uma escala
/// enorme — passa por aqui antes de devolver.
fn finite_number(n: f64) -> Value {
    if n.is_finite() {
        Value::Number(n)
    } else {
        Value::Empty
    }
}

fn eval_add(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        (Some(a), Some(b)) => finite_number(a + b),
        _ => Value::Empty,
    }
}

fn eval_subtract(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        (Some(a), Some(b)) => finite_number(a - b),
        _ => Value::Empty,
    }
}

fn eval_multiply(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        (Some(a), Some(b)) => finite_number(a * b),
        _ => Value::Empty,
    }
}

/// Divisão por zero é `Value::Empty` — mesma regra de `BinaryOp::Div` em
/// `core/eval.rs::eval_arithmetic`.
fn eval_divide(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        (Some(_), Some(0.0)) => Value::Empty,
        (Some(a), Some(b)) => finite_number(a / b),
        _ => Value::Empty,
    }
}

/// Módulo por zero é `Value::Empty` — mesma regra de `BinaryOp::Mod`.
fn eval_modulo(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        (Some(_), Some(0.0)) => Value::Empty,
        (Some(a), Some(b)) => finite_number(a % b),
        _ => Value::Empty,
    }
}

fn eval_pow(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (number_arg(args, 0), number_arg(args, 1)) {
        // `powf` devolve NaN para base negativa com expoente fracionário
        // (raiz de índice par de negativo não é real) e `Infinity` para
        // overflow (`pow(10, 1000)`) — os dois casos convergem para
        // `Value::Empty` via `finite_number`, nunca um `NaN`/`Infinity`
        // disfarçado de número.
        (Some(base), Some(exp)) => finite_number(base.powf(exp)),
        _ => Value::Empty,
    }
}

fn eval_abs(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match number_arg(args, 0) {
        Some(n) => finite_number(n.abs()),
        None => Value::Empty,
    }
}

fn eval_ceil(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match number_arg(args, 0) {
        Some(n) => finite_number(n.ceil()),
        None => Value::Empty,
    }
}

fn eval_floor(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match number_arg(args, 0) {
        Some(n) => finite_number(n.floor()),
        None => Value::Empty,
    }
}

/// `sqrt` de negativo é `Value::Empty` (raiz não é real) em vez de `NaN`.
fn eval_sqrt(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match number_arg(args, 0) {
        Some(n) if n < 0.0 => Value::Empty,
        Some(n) => finite_number(n.sqrt()),
        None => Value::Empty,
    }
}

/// `cbrt` (raiz cúbica) é real para qualquer entrada, inclusive negativa —
/// diferente de `sqrt`, não precisa de guarda de domínio.
fn eval_cbrt(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match number_arg(args, 0) {
        Some(n) => finite_number(n.cbrt()),
        None => Value::Empty,
    }
}

/// Segundo argumento (casas decimais) é OPCIONAL — `round(x)` arredonda para
/// inteiro, `round(x, n)` para `n` casas.
fn eval_round(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(x) = number_arg(args, 0) else {
        return Value::Empty;
    };
    let decimals = if args.len() > 1 { number_arg(args, 1).unwrap_or(0.0) } else { 0.0 };

    // Clampa para [-100, 100]: além disso, 10^casas já ultrapassa a precisão
    // que um f64 consegue representar (~15-17 dígitos significativos) —
    // arredondar para mais que isso é um no-op sem sentido, e para menos
    // (casas muito negativas) já arredonda para uma escala maior que
    // qualquer número que caiba numa célula. O clamp evita que
    // `10f64.powi` receba um expoente absurdo vindo de entrada hostil
    // (`round(x, 999999999)`), sem overflow nem pânico — e mesmo sem o
    // clamp `powi` não entraria em pânico, mas o resultado seria
    // `Infinity`/subnormal sem utilidade nenhuma.
    let decimals_clamped = decimals.clamp(-100.0, 100.0);
    // `as i32` depois do clamp acima é seguro: o intervalo [-100, 100] cabe
    // com folga em `i32` (que vai a +/-2^31) — não há truncamento
    // escondido, só a conversão de tipo que `powi` exige.
    let decimals_i32 = decimals_clamped.round() as i32;
    let scale = 10f64.powi(decimals_i32);
    finite_number((x * scale).round() / scale)
}

pub fn register_all() {
    register(FunctionDef {
        name: "add",
        category: "matemática",
        doc: "Soma dois números.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_add,
        accepts_empty: |_| false,
        eval: eval_add,
    });
    register(FunctionDef {
        name: "subtract",
        category: "matemática",
        doc: "Subtrai o segundo número do primeiro.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_subtract,
        accepts_empty: |_| false,
        eval: eval_subtract,
    });
    register(FunctionDef {
        name: "multiply",
        category: "matemática",
        doc: "Multiplica dois números.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_multiply,
        accepts_empty: |_| false,
        eval: eval_multiply,
    });
    register(FunctionDef {
        name: "divide",
        category: "matemática",
        doc: "Divide o primeiro número pelo segundo; divisão por zero retorna vazio.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_divide,
        accepts_empty: |_| false,
        eval: eval_divide,
    });
    register(FunctionDef {
        name: "mod",
        category: "matemática",
        doc: "Resto da divisão do primeiro número pelo segundo; divisor zero retorna vazio.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_modulo,
        accepts_empty: |_| false,
        eval: eval_modulo,
    });
    register(FunctionDef {
        name: "pow",
        category: "matemática",
        doc: "Eleva o primeiro número à potência do segundo.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_pow,
        accepts_empty: |_| false,
        eval: eval_pow,
    });
    register(FunctionDef {
        name: "abs",
        category: "matemática",
        doc: "Valor absoluto de um número.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_abs,
        accepts_empty: |_| false,
        eval: eval_abs,
    });
    register(FunctionDef {
        name: "round",
        category: "matemática",
        doc: "Arredonda um número; segundo argumento opcional define as casas decimais.",
        arity: Arity::Range(1, 2),
        params: |_| ParamKind::Value,
        check: check_round,
        accepts_empty: |_| false,
        eval: eval_round,
    });
    register(FunctionDef {
        name: "ceil",
        category: "matemática",
        doc: "Arredonda um número para cima.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_ceil,
        accepts_empty: |_| false,
        eval: eval_ceil,
    });
    register(FunctionDef {
        name: "floor",
        category: "matemática",
        doc: "Arredonda um número para baixo.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_floor,
        accepts_empty: |_| false,
        eval: eval_floor,
    });
    register(FunctionDef {
        name: "sqrt",
        category: "matemática",
        doc: "Raiz quadrada; de um número negativo retorna vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_sqrt,
        accepts_empty: |_| false,
        eval: eval_sqrt,
    });
    register(FunctionDef {
        name: "cbrt",
        category: "matemática",
        doc: "Raiz cúbica de um número.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_cbrt,
        accepts_empty: |_| false,
        eval: eval_cbrt,
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::{compile, eval, PageMeta, PropertyId, Type, ValueSource};
    use uuid::Uuid;

    /// Schema falso com "Preço" e "Qtd" configuráveis — o exemplo literal de
    /// DBS-062 (`round(prop("Preço")/prop("Qtd"),2)`) precisa dos dois.
    struct FakeSchema {
        preco: f64,
        qtd: f64,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, property: PropertyId) -> Value {
            if property == Uuid::from_u128(1) {
                Value::Number(self.preco)
            } else if property == Uuid::from_u128(2) {
                Value::Number(self.qtd)
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
                "Preço" => Some((Uuid::from_u128(1), Type::Number)),
                "Qtd" => Some((Uuid::from_u128(2), Type::Number)),
                _ => None,
            }
        }
    }

    fn run_with(schema: &FakeSchema, src: &str) -> Value {
        crate::formula::functions::register_all();
        let compiled = compile(src, schema).unwrap_or_else(|errors| panic!("esperava compilar \"{src}\", veio {errors:?}"));
        let mut ctx = EvalCtx::new(schema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    fn run(src: &str) -> Value {
        run_with(&FakeSchema { preco: 0.0, qtd: 0.0 }, src)
    }

    #[test]
    fn add_subtract_multiply_happy_path() {
        assert_eq!(run("add(2, 3)"), Value::Number(5.0));
        assert_eq!(run("subtract(5, 3)"), Value::Number(2.0));
        assert_eq!(run("multiply(4, 3)"), Value::Number(12.0));
    }

    #[test]
    fn divide_happy_path_and_by_zero_is_empty() {
        assert_eq!(run("divide(10, 2)"), Value::Number(5.0));
        assert_eq!(run("divide(10, 0)"), Value::Empty);
    }

    #[test]
    fn modulo_happy_path_and_by_zero_is_empty() {
        assert_eq!(run("mod(10, 3)"), Value::Number(1.0));
        assert_eq!(run("mod(10, 0)"), Value::Empty);
    }

    #[test]
    fn pow_happy_path_and_overflow_is_empty() {
        assert_eq!(run("pow(2, 10)"), Value::Number(1024.0));
        assert_eq!(run("pow(10, 1000)"), Value::Empty);
    }

    #[test]
    fn abs_ceil_floor() {
        assert_eq!(run("abs(-5)"), Value::Number(5.0));
        assert_eq!(run("ceil(1.2)"), Value::Number(2.0));
        assert_eq!(run("floor(1.8)"), Value::Number(1.0));
    }

    #[test]
    fn sqrt_happy_path_and_negative_is_empty() {
        assert_eq!(run("sqrt(9)"), Value::Number(3.0));
        assert_eq!(run("sqrt(-1)"), Value::Empty);
    }

    #[test]
    fn cbrt_handles_negative_input_as_a_real_number() {
        assert_eq!(run("cbrt(-8)"), Value::Number(-2.0));
    }

    /// O exemplo LITERAL de DBS-062: `round(prop("Preço")/prop("Qtd"),2)`,
    /// recalculando quando Preço ou Qtd muda.
    #[test]
    fn dbs_062_round_of_price_over_quantity_recalculates_on_change() {
        let schema_a = FakeSchema { preco: 10.0, qtd: 3.0 };
        assert_eq!(run_with(&schema_a, "round(prop(\"Preço\")/prop(\"Qtd\"),2)"), Value::Number(3.33));

        let schema_b = FakeSchema { preco: 10.0, qtd: 4.0 };
        assert_eq!(run_with(&schema_b, "round(prop(\"Preço\")/prop(\"Qtd\"),2)"), Value::Number(2.5));
    }

    #[test]
    fn round_without_decimals_argument_rounds_to_integer() {
        assert_eq!(run("round(1.6)"), Value::Number(2.0));
    }

    #[test]
    fn round_negative_decimals_rounds_to_a_power_of_ten() {
        assert_eq!(run("round(1234.5, -2)"), Value::Number(1200.0));
    }

    /// Casas absurdas não travam nem estouram — só saturam no clamp interno.
    #[test]
    fn round_absurd_decimals_does_not_panic_and_stays_finite() {
        let big_decimals = run("round(1.23456789, 999999999)");
        assert!(matches!(big_decimals, Value::Number(n) if n.is_finite()));

        // Casas negativas absurdas arredondam para uma escala tão grande que
        // qualquer número pequeno vira zero — ainda finito, nunca pânico.
        assert_eq!(run("round(5, -999999999)"), Value::Number(0.0));
    }

    #[test]
    fn division_by_zero_through_the_named_function_matches_the_infix_operator() {
        // Mesma regra que `core/eval.rs::division_by_zero_is_empty_not_a_panic`
        // já prova para `1 / 0` infixo — aqui pela forma de função nomeada.
        assert_eq!(run("divide(1, 0)"), run("1 / 0"));
    }
}
