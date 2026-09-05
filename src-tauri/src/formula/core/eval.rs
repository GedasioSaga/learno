//! O avaliador. Roda sobre uma `Expr` que já passou por `typecheck::check`
//! com sucesso — por isso ele nunca "erra" no sentido de devolver
//! `Result`: uma forma que o checador não deveria ter deixado passar cai no
//! braço `_` de cada `match` e vira `Value::Empty`, a mesma saída que
//! qualquer outra causa de ausência produz. A linguagem é TOTAL (arquitetura
//! §4) — nada aqui `panic!`a por causa de um dado do usuário ou do schema.
//!
//! Três regras de vazio, e é isso que este arquivo impõe:
//! - **Propaga** em aritmética, texto e data (`eval_arithmetic`).
//! - **É falso** em contexto booleano (`truthy`, usado por `!`, `&&`, `||`
//!   e pelo `cond` de um ternário).
//! - **Comparação com vazio é SEMPRE `false`**, nunca vazio — `eval_ordering`
//!   e a igualdade em `eval_binary`.

use uuid::Uuid;

use crate::formula::core::ast::{BinaryOp, Expr, ExprKind, UnaryOp};
use crate::formula::core::functions::{self, Arg, LambdaArg, ParamKind};
use crate::formula::core::types::{PageMeta, PropertyId, Type, Value};

/// A fronteira congelada (arquitetura §9) entre o motor puro e onde os dados
/// realmente moram. `ipc::formula_commands` é quem implementa isto de
/// verdade, em cima de `state.pool()` — este módulo só CONSOME o trait,
/// nunca sabe que existe Postgres do outro lado.
///
/// Pré-buscado em lote é responsabilidade de QUEM IMPLEMENTA o trait, não
/// deste módulo: um `.map()` sobre uma relação de 5.000 itens chama
/// `related`/`value` uma vez por item, e é o adaptador (com um cache por
/// avaliação, por exemplo) que decide se isso vira uma consulta em lote ou
/// N consultas — o núcleo não tem opinião sobre isso, só sobre a semântica.
pub trait ValueSource {
    fn value(&self, record: Uuid, property: PropertyId) -> Value;
    fn related(&self, record: Uuid, property: PropertyId) -> Vec<Uuid>;
    fn page_meta(&self, record: Uuid) -> PageMeta;
    fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)>;
}

/// O estado que uma avaliação carrega: o schema, QUAL registro está sendo
/// avaliado (o que `prop()` sem receptor lê), um relógio FIXADO no início da
/// avaliação (não a hora real a cada chamada de `now()`/`today()` — duas
/// chamadas na MESMA fórmula, ou uma cascata de fórmulas dependentes, viriam
/// com instantes ligeiramente diferentes senão, o tipo de inconsistência que
/// ninguém consegue reproduzir depois) e a pilha de vínculos léxicos que
/// `current` (DBS-078/080) usa.
pub struct EvalCtx<'a> {
    schema: &'a dyn ValueSource,
    current_record: Uuid,
    now: chrono::DateTime<chrono::Utc>,
    bindings: Vec<(String, Value)>,
}

impl<'a> EvalCtx<'a> {
    pub fn new(schema: &'a dyn ValueSource, current_record: Uuid, now: chrono::DateTime<chrono::Utc>) -> Self {
        Self { schema, current_record, now, bindings: Vec::new() }
    }

    pub fn current_record(&self) -> Uuid {
        self.current_record
    }

    pub fn now(&self) -> chrono::DateTime<chrono::Utc> {
        self.now
    }

    /// Devolve a referência com o lifetime `'a` ORIGINAL (não o de `&self`)
    /// de propósito: assim um chamador pode segurar o resultado desta
    /// chamada e, em seguida, pedir um empréstimo `&mut` de `ctx` (para
    /// `push_binding`, por exemplo) sem os dois brigarem pelo mesmo
    /// empréstimo — são referências independentes para dados diferentes.
    pub fn schema(&self) -> &'a dyn ValueSource {
        self.schema
    }

    /// Usado por [`LambdaArg::call`] (via `push_binding`/`pop_binding`) e
    /// por `eval` (para ler `current`) — `pub(crate)` porque só o núcleo
    /// mexe na pilha de vínculos; nada fora de `formula::core` deveria
    /// poder empurrar um nome arbitrário nela.
    pub(crate) fn push_binding(&mut self, name: String, value: Value) {
        self.bindings.push((name, value));
    }

    pub(crate) fn pop_binding(&mut self) {
        self.bindings.pop();
    }

    fn lookup_binding(&self, name: &str) -> Option<&Value> {
        // De trás para frente: um vínculo mais interno (um `.map()` dentro
        // de outro `.map()`, hipoteticamente) sombreia o externo do mesmo
        // nome, como em qualquer linguagem com escopo léxico.
        self.bindings.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v)
    }
}

/// `Value::Empty` é falso; `Value::Boolean(false)` é falso; qualquer outra
/// coisa (inclusive uma forma que o checador não deveria ter deixado passar
/// até aqui) é tratada como falsa também — "é falso em contexto booleano"
/// só promete o lado vazio, mas TOTAL significa que este `match` nunca tem
/// um braço que falta.
fn truthy(value: &Value) -> bool {
    matches!(value, Value::Boolean(true))
}

fn is_non_empty(value: &Value) -> bool {
    !matches!(value, Value::Empty)
}

pub fn eval(ast: &Expr, ctx: &mut EvalCtx) -> Value {
    match &ast.kind {
        ExprKind::NumberLit(n) => Value::Number(*n),
        ExprKind::StringLit(s) => Value::String(s.clone()),
        ExprKind::BoolLit(b) => Value::Boolean(*b),
        ExprKind::Ident(name) => ctx.lookup_binding(name).cloned().unwrap_or(Value::Empty),
        ExprKind::PropRef { receiver, name, .. } => eval_prop_ref(receiver.as_deref(), name, ctx),
        ExprKind::Unary { op, expr } => {
            let value = eval(expr, ctx);
            eval_unary(*op, value)
        }
        ExprKind::Binary { op, left, right } => eval_binary(*op, left, right, ctx),
        ExprKind::Ternary { cond, then_branch, else_branch } => {
            if truthy(&eval(cond, ctx)) {
                eval(then_branch, ctx)
            } else {
                eval(else_branch, ctx)
            }
        }
        ExprKind::Call { name, args, .. } => eval_call(name, args, ctx),
    }
}

/// `prop("Nome")` (`receiver: None`) lê do registro sendo avaliado;
/// `algo.prop("Nome")` lê da página que `receiver` avalia — ver a doc de
/// `ast::ExprKind::PropRef` para o porquê deste nó ser dedicado. Despacha
/// para `related()` (nunca `value()`) quando o TIPO da propriedade é
/// `page`/`lista<página>`: arquitetura §5 — "Relação NÃO tem linha em
/// `database_record_values`", então a única forma de ter valor ali é ler a
/// aresta.
fn eval_prop_ref(receiver: Option<&Expr>, name: &str, ctx: &mut EvalCtx) -> Value {
    let record = match receiver {
        None => ctx.current_record(),
        Some(receiver_expr) => match eval(receiver_expr, ctx) {
            Value::Page(id) => id,
            // Vazio (a página de origem não existe) ou uma forma que o
            // checador não deveria ter deixado passar — os dois casos
            // convergem para vazio, nunca pânico.
            _ => return Value::Empty,
        },
    };

    let Some((property_id, property_type)) = ctx.schema().property_by_name(name) else {
        // A propriedade existia quando `compile()` rodou e sumiu (apagada,
        // renomeada) antes deste `eval()` — não deveria acontecer dentro de
        // uma única chamada de `apply_record_value_changes` (I4), mas entre
        // um `preview_formula` e a gravação real, sim. Vazio, não pânico.
        return Value::Empty;
    };

    match property_type {
        Type::Page => ctx.schema().related(record, property_id).first().copied().map(Value::Page).unwrap_or(Value::Empty),
        Type::List(inner) if *inner == Type::Page => {
            Value::List(ctx.schema().related(record, property_id).into_iter().map(Value::Page).collect())
        }
        _ => ctx.schema().value(record, property_id),
    }
}

fn eval_unary(op: UnaryOp, value: Value) -> Value {
    match op {
        UnaryOp::Neg => match value {
            Value::Empty => Value::Empty,
            Value::Number(n) => Value::Number(-n),
            _ => Value::Empty,
        },
        // "falso em contexto booleano": `!vazio` é `!false` é `true`, não
        // vazio — `Not` não está na lista de propagação da arquitetura §4
        // (só aritmética/texto/data propagam).
        UnaryOp::Not => Value::Boolean(!truthy(&value)),
    }
}

fn eval_binary(op: BinaryOp, left: &Expr, right: &Expr, ctx: &mut EvalCtx) -> Value {
    // `&&`/`||` curto-circuitam ANTES de avaliar o lado direito — são os
    // dois únicos operadores com essa regra, então tratá-los à parte evita
    // que toda outra função deste arquivo precise saber sobre avaliação
    // preguiçosa.
    if matches!(op, BinaryOp::And) {
        let l = eval(left, ctx);
        if !truthy(&l) {
            return Value::Boolean(false);
        }
        return Value::Boolean(truthy(&eval(right, ctx)));
    }
    if matches!(op, BinaryOp::Or) {
        let l = eval(left, ctx);
        if truthy(&l) {
            return Value::Boolean(true);
        }
        return Value::Boolean(truthy(&eval(right, ctx)));
    }

    let l = eval(left, ctx);
    let r = eval(right, ctx);

    match op {
        BinaryOp::Eq => Value::Boolean(is_non_empty(&l) && is_non_empty(&r) && values_equal(&l, &r)),
        BinaryOp::NotEq => Value::Boolean(is_non_empty(&l) && is_non_empty(&r) && !values_equal(&l, &r)),
        BinaryOp::Gt | BinaryOp::GtEq | BinaryOp::Lt | BinaryOp::LtEq => eval_ordering(op, &l, &r),
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
            if is_non_empty(&l) && is_non_empty(&r) {
                eval_arithmetic(op, l, r)
            } else {
                Value::Empty
            }
        }
        // Inalcançável de verdade (os dois `if` acima já retornaram), mas
        // mantido como um resultado CORRETO em vez de `unreachable!()`: um
        // `match` exaustivo sobre `BinaryOp` não pode omitir estes dois
        // braços, e um valor certo — ainda que morto — nunca é pior que um
        // pânico (regra 3), mesmo um que "nunca" dispara.
        BinaryOp::And => Value::Boolean(truthy(&l) && truthy(&r)),
        BinaryOp::Or => Value::Boolean(truthy(&l) || truthy(&r)),
    }
}

fn values_equal(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Boolean(a), Value::Boolean(b)) => a == b,
        (Value::Date(a), Value::Date(b)) => a == b,
        (Value::Page(a), Value::Page(b)) => a == b,
        _ => false,
    }
}

fn compare_values(l: &Value, r: &Value) -> Option<std::cmp::Ordering> {
    match (l, r) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::String(a), Value::String(b)) => Some(a.cmp(b)),
        // I2: pelo INÍCIO, nunca pelo par inteiro — o mesmo raciocínio da
        // coluna gerada `sort_text` (0017) do lado SQL, aplicado aqui.
        (Value::Date(a), Value::Date(b)) => Some(a.start.cmp(&b.start)),
        _ => None,
    }
}

/// I4 do texto da arquitetura §4: "comparação com vazio é sempre `false`,
/// nunca vazio" — SEM exceção, mesmo `vazio <= vazio`. É a consequência
/// aceita e nomeada: `prop("Nota") > 5` e `prop("Nota") <= 5` são ambos
/// falsos com Nota vazia.
fn eval_ordering(op: BinaryOp, l: &Value, r: &Value) -> Value {
    if matches!(l, Value::Empty) || matches!(r, Value::Empty) {
        return Value::Boolean(false);
    }
    let Some(ordering) = compare_values(l, r) else {
        return Value::Boolean(false);
    };
    let result = match op {
        BinaryOp::Gt => ordering.is_gt(),
        BinaryOp::GtEq => ordering.is_ge(),
        BinaryOp::Lt => ordering.is_lt(),
        BinaryOp::LtEq => ordering.is_le(),
        _ => false,
    };
    Value::Boolean(result)
}

/// Chamado só quando `l` e `r` já são conhecidos não-vazios — a chamadora
/// (`eval_binary`) trata a propagação de vazio ANTES de chegar aqui.
/// Divisão/módulo por zero devolvem `Value::Empty` (a linguagem é TOTAL:
/// `NaN`/`Infinity` não são representáveis em jsonb).
fn eval_arithmetic(op: BinaryOp, l: Value, r: Value) -> Value {
    match (op, l, r) {
        (BinaryOp::Add, Value::String(a), Value::String(b)) => Value::String(a + &b),
        (BinaryOp::Add, Value::Number(a), Value::Number(b)) => Value::Number(a + b),
        (BinaryOp::Sub, Value::Number(a), Value::Number(b)) => Value::Number(a - b),
        (BinaryOp::Mul, Value::Number(a), Value::Number(b)) => Value::Number(a * b),
        (BinaryOp::Div, Value::Number(a), Value::Number(b)) => {
            if b == 0.0 {
                Value::Empty
            } else {
                Value::Number(a / b)
            }
        }
        (BinaryOp::Mod, Value::Number(a), Value::Number(b)) => {
            if b == 0.0 {
                Value::Empty
            } else {
                Value::Number(a % b)
            }
        }
        // Combinação de tipo que o checador não deveria ter deixado passar
        // (ex.: texto - texto). TOTAL mesmo assim.
        _ => Value::Empty,
    }
}

/// Resolve `name` na tabela global ([`functions::lookup`]) e prepara cada
/// argumento como [`ParamKind`] pediu — ver a doc de `functions.rs` para o
/// porquê da tabela ser global em vez de um parâmetro.
fn eval_call(name: &str, arg_exprs: &[Expr], ctx: &mut EvalCtx) -> Value {
    let Some(def) = functions::lookup(name) else {
        // Não deveria acontecer pós-`compile()` bem-sucedido (o checador já
        // teria recusado uma chamada a função inexistente) — a menos que a
        // tabela tenha mudado entre `compile` e `eval` (um F1..F6 ainda
        // sendo escrito). Vazio, não pânico.
        return Value::Empty;
    };

    let mut args: Vec<Arg> = Vec::with_capacity(arg_exprs.len());
    for (index, arg_expr) in arg_exprs.iter().enumerate() {
        match (def.params)(index) {
            ParamKind::Value => {
                let value = eval(arg_expr, ctx);
                if matches!(value, Value::Empty) && !(def.accepts_empty)(index) {
                    // "Vazio propaga": a MAIORIA das funções nunca precisa
                    // escrever esta regra sozinha — só quem marca
                    // `accepts_empty(i) = true` (ex.: `empty()`) quer ver o
                    // vazio de verdade.
                    return Value::Empty;
                }
                args.push(Arg::Value(value));
            }
            ParamKind::Lambda { .. } => {
                args.push(Arg::Lambda(LambdaArg::new(arg_expr.clone())));
            }
        }
    }

    (def.eval)(&args, ctx)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::compile::compile;

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
            // Toda propriedade que este fake "conhece" é sempre vazia
            // (`value` acima devolve `Value::Empty` incondicionalmente) —
            // suficiente para os testes deste arquivo, que só olham a
            // REGRA de vazio, nunca um valor de verdade.
            match name {
                "Vazio" => Some((Uuid::from_u128(1), Type::Boolean)),
                "VazioNumero" => Some((Uuid::from_u128(2), Type::Number)),
                _ => None,
            }
        }
    }

    fn run(src: &str) -> Value {
        let compiled = compile(src, &FakeSchema).unwrap_or_else(|errors| {
            panic!("esperava compilar \"{src}\" sem erro, veio {errors:?}");
        });
        let mut ctx = EvalCtx::new(&FakeSchema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    #[test]
    fn division_by_zero_is_empty_not_a_panic() {
        assert_eq!(run("1 / 0"), Value::Empty);
    }

    #[test]
    fn modulo_by_zero_is_empty() {
        assert_eq!(run("5 % 0"), Value::Empty);
    }

    #[test]
    fn string_concatenation_with_plus() {
        assert_eq!(run("\"a\" + \"b\""), Value::String("ab".to_string()));
    }

    #[test]
    fn arithmetic_propagates_empty() {
        assert_eq!(run("1 + prop(\"VazioNumero\")"), Value::Empty);
        assert_eq!(run("-prop(\"VazioNumero\")"), Value::Empty);
    }

    /// A regra mais fácil de errar do arquivo inteiro: comparação com vazio
    /// é SEMPRE `false`, mesmo `!=` entre dois vazios — não é a negação
    /// lógica de `==` quando vazio está envolvido, é uma regra própria.
    #[test]
    fn comparison_with_empty_is_always_false_never_propagates() {
        assert_eq!(run("prop(\"VazioNumero\") > 5"), Value::Boolean(false));
        assert_eq!(run("prop(\"VazioNumero\") <= 5"), Value::Boolean(false));
        assert_eq!(run("prop(\"VazioNumero\") == 5"), Value::Boolean(false));
        assert_eq!(run("prop(\"VazioNumero\") != 5"), Value::Boolean(false));
        assert_eq!(run("prop(\"VazioNumero\") != prop(\"VazioNumero\")"), Value::Boolean(false));
    }

    #[test]
    fn empty_is_false_in_boolean_context_and_not_of_it_is_true() {
        assert_eq!(run("!prop(\"Vazio\")"), Value::Boolean(true));
        assert_eq!(run("prop(\"Vazio\") ? 1 : 2"), Value::Number(2.0));
        assert_eq!(run("prop(\"Vazio\") || true"), Value::Boolean(true));
        assert_eq!(run("prop(\"Vazio\") && true"), Value::Boolean(false));
    }

    #[test]
    fn and_short_circuits_without_evaluating_the_right_side() {
        // "1 / 0" avaliaria para `Value::Empty`, não um pânico — então este
        // teste não prova curto-circuito por efeito colateral observável;
        // prova a MESMA regra por outro ângulo: o `&&` já falso pela
        // esquerda produz `false`, nunca `Empty`, mesmo quando o lado
        // direito é uma expressão que TAMBÉM daria vazio.
        assert_eq!(run("false && (1 / 0 > 1)"), Value::Boolean(false));
    }
}
