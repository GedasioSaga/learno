//! Categoria "agregação" (DBS-063): `min`/`max`/`sum`/`median`/`mean`,
//! todas reduzindo uma `lista<número>` — tipicamente vinda de
//! `prop("Relação").map(...)` quando F5 (lista de ordem superior) chegar,
//! mas qualquer expressão que produza `lista<número>` serve; os testes deste
//! arquivo usam uma lista construída direto por `ValueSource::value` (ver o
//! comentário de `dbs_063_sum_of_a_directly_constructed_list`).
//!
//! **Vazio DENTRO da lista é ignorado, não propaga a chamada inteira** — um
//! item `Value::Empty` (ex.: a propriedade "Valor" vazia numa das páginas
//! relacionadas) é descartado antes de agregar, o mesmo comportamento de
//! `SUM`/`AVERAGE` de planilha pulando célula em branco em vez de invalidar
//! o total. Isso é uma decisão sobre o CONTEÚDO da lista — a regra
//! `accepts_empty(_) = false` de `FunctionDef` continua valendo para o
//! ARGUMENTO em si (se `prop("Relação")` inteira avaliar para vazio, a
//! chamada toda vira vazio antes de chegar aqui).
//!
//! **Valores de agregação vazia, cada um documentado onde aparece:**
//! `sum([]) = 0` (elemento neutro da soma — mesma convenção de SUM vazio
//! numa planilha); `min`/`max`/`median`/`mean` de lista vazia (ou de lista
//! cujos itens são todos vazios, o que dá na mesma depois do filtro) não têm
//! resposta matemática — `Value::Empty`, nunca `NaN` de um `0.0/0.0`.

use crate::formula::core::{register, Arg, Arity, EvalCtx, FunctionDef, ParamKind, Type, Value};

fn is_list_of_number(ty: &Type) -> bool {
    if let Type::List(inner) = ty {
        **inner == Type::Number
    } else {
        false
    }
}

/// Extrai os números de uma `lista<número>`, descartando qualquer item vazio
/// (ver decisão do módulo, acima). `None` só de forma DEFENSIVA (argumento
/// ausente, ou não é lista) — não deveria acontecer pós-`compile()` bem
/// sucedido, mas nunca vira pânico, sempre `Value::Empty` em quem chama.
fn numbers_arg(args: &[Arg], index: usize) -> Option<Vec<f64>> {
    match args.get(index) {
        Some(Arg::Value(Value::List(items))) => {
            Some(items.iter().filter_map(|item| if let Value::Number(n) = item { Some(*n) } else { None }).collect())
        }
        _ => None,
    }
}

/// `Value::Number` que nunca carrega `NaN`/`Infinity` (mesma disciplina de
/// `functions::matematica::finite_number`) — só entra em jogo se a soma de
/// itens extremos escapar de finito, o que `finite_number` converte em
/// `Value::Empty` em vez de deixar passar.
fn finite_number(n: f64) -> Value {
    if n.is_finite() {
        Value::Number(n)
    } else {
        Value::Empty
    }
}

fn check_min(types: &[Type]) -> Result<Type, String> {
    match types {
        [t] if is_list_of_number(t) => Ok(Type::Number),
        [t] => Err(format!("\"min\" espera lista<número>; recebeu {t}")),
        other => Err(format!("\"min\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn check_max(types: &[Type]) -> Result<Type, String> {
    match types {
        [t] if is_list_of_number(t) => Ok(Type::Number),
        [t] => Err(format!("\"max\" espera lista<número>; recebeu {t}")),
        other => Err(format!("\"max\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn check_sum(types: &[Type]) -> Result<Type, String> {
    match types {
        [t] if is_list_of_number(t) => Ok(Type::Number),
        [t] => Err(format!("\"sum\" espera lista<número>; recebeu {t}")),
        other => Err(format!("\"sum\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn check_median(types: &[Type]) -> Result<Type, String> {
    match types {
        [t] if is_list_of_number(t) => Ok(Type::Number),
        [t] => Err(format!("\"median\" espera lista<número>; recebeu {t}")),
        other => Err(format!("\"median\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn check_mean(types: &[Type]) -> Result<Type, String> {
    match types {
        [t] if is_list_of_number(t) => Ok(Type::Number),
        [t] => Err(format!("\"mean\" espera lista<número>; recebeu {t}")),
        other => Err(format!("\"mean\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn eval_min(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match numbers_arg(args, 0) {
        Some(numbers) => numbers.into_iter().reduce(f64::min).map(finite_number).unwrap_or(Value::Empty),
        None => Value::Empty,
    }
}

fn eval_max(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match numbers_arg(args, 0) {
        Some(numbers) => numbers.into_iter().reduce(f64::max).map(finite_number).unwrap_or(Value::Empty),
        None => Value::Empty,
    }
}

/// `sum([]) = 0` — elemento neutro, não vazio (ver decisão do módulo).
fn eval_sum(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match numbers_arg(args, 0) {
        Some(numbers) => finite_number(numbers.iter().sum()),
        None => Value::Empty,
    }
}

fn eval_mean(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match numbers_arg(args, 0) {
        Some(numbers) if !numbers.is_empty() => {
            let total: f64 = numbers.iter().sum();
            // `len()` de uma lista de fórmula nunca chega perto de 2^53 (o
            // maior inteiro que um f64 representa sem perda) — não há erro
            // de precisão em converter a contagem para f64 aqui.
            finite_number(total / numbers.len() as f64)
        }
        _ => Value::Empty,
    }
}

fn eval_median(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match numbers_arg(args, 0) {
        Some(mut numbers) if !numbers.is_empty() => {
            numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let len = numbers.len();
            let mid = len / 2;
            if len % 2 == 1 {
                numbers.get(mid).copied().map(finite_number).unwrap_or(Value::Empty)
            } else {
                // `len` par e `>= 2` (senão teria caído no ramo ímpar com
                // `len == 1`, ou já teria voltado vazio com `len == 0`):
                // `mid >= 1` e `mid <= len - 1`, então `mid - 1` e `mid`
                // sempre endereçam um item válido — `.get()` ainda assim,
                // nunca indexação direta, então mesmo se este raciocínio
                // estiver errado o pior caso é `Value::Empty`, nunca pânico.
                match (numbers.get(mid - 1), numbers.get(mid)) {
                    (Some(a), Some(b)) => finite_number((a + b) / 2.0),
                    _ => Value::Empty,
                }
            }
        }
        _ => Value::Empty,
    }
}

pub fn register_all() {
    register(FunctionDef {
        name: "min",
        category: "agregação",
        doc: "Menor valor de uma lista de números; lista vazia retorna vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_min,
        accepts_empty: |_| false,
        eval: eval_min,
    });
    register(FunctionDef {
        name: "max",
        category: "agregação",
        doc: "Maior valor de uma lista de números; lista vazia retorna vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_max,
        accepts_empty: |_| false,
        eval: eval_max,
    });
    register(FunctionDef {
        name: "sum",
        category: "agregação",
        doc: "Soma os números de uma lista; lista vazia retorna 0.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_sum,
        accepts_empty: |_| false,
        eval: eval_sum,
    });
    register(FunctionDef {
        name: "median",
        category: "agregação",
        doc: "Mediana de uma lista de números; lista vazia retorna vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_median,
        accepts_empty: |_| false,
        eval: eval_median,
    });
    register(FunctionDef {
        name: "mean",
        category: "agregação",
        doc: "Média dos números de uma lista; lista vazia retorna vazio.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_mean,
        accepts_empty: |_| false,
        eval: eval_mean,
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::{compile, eval, PageMeta, PropertyId, ValueSource};
    use uuid::Uuid;

    /// Schema falso com UMA propriedade "Valores", tipada `lista<número>`,
    /// cujo conteúdo o teste escolhe por construção — a "lista construída
    /// direto" que o pedido pede no lugar do exemplo com `.map()` de
    /// DBS-063 (que só existe de verdade quando F5 registrar `map`).
    struct FakeSchema {
        valores: Vec<Value>,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, property: PropertyId) -> Value {
            if property == Uuid::from_u128(1) {
                Value::List(self.valores.clone())
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
            (name == "Valores").then(|| (Uuid::from_u128(1), Type::List(Box::new(Type::Number))))
        }
    }

    fn run(valores: Vec<Value>, src: &str) -> Value {
        crate::formula::functions::register_all();
        let schema = FakeSchema { valores };
        let compiled = compile(src, &schema).unwrap_or_else(|errors| panic!("esperava compilar \"{src}\", veio {errors:?}"));
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    fn numbers(values: &[f64]) -> Vec<Value> {
        values.iter().map(|n| Value::Number(*n)).collect()
    }

    #[test]
    fn min_max_sum_mean_happy_path() {
        let list = numbers(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(run(list.clone(), "min(prop(\"Valores\"))"), Value::Number(1.0));
        assert_eq!(run(list.clone(), "max(prop(\"Valores\"))"), Value::Number(5.0));
        assert_eq!(run(list.clone(), "sum(prop(\"Valores\"))"), Value::Number(15.0));
        assert_eq!(run(list, "mean(prop(\"Valores\"))"), Value::Number(3.0));
    }

    #[test]
    fn median_of_odd_and_even_length_lists() {
        assert_eq!(run(numbers(&[3.0, 1.0, 2.0]), "median(prop(\"Valores\"))"), Value::Number(2.0));
        assert_eq!(run(numbers(&[1.0, 2.0, 3.0, 4.0]), "median(prop(\"Valores\"))"), Value::Number(2.5));
    }

    #[test]
    fn sum_and_mean_of_empty_list() {
        assert_eq!(run(Vec::new(), "sum(prop(\"Valores\"))"), Value::Number(0.0));
        assert_eq!(run(Vec::new(), "mean(prop(\"Valores\"))"), Value::Empty);
    }

    #[test]
    fn min_max_median_of_empty_list_is_empty() {
        assert_eq!(run(Vec::new(), "min(prop(\"Valores\"))"), Value::Empty);
        assert_eq!(run(Vec::new(), "max(prop(\"Valores\"))"), Value::Empty);
        assert_eq!(run(Vec::new(), "median(prop(\"Valores\"))"), Value::Empty);
    }

    /// Um item vazio no meio da lista (a propriedade "Valor" de uma das
    /// páginas relacionadas está em branco) é IGNORADO, não derruba a
    /// agregação inteira nem conta como zero.
    #[test]
    fn empty_items_inside_the_list_are_ignored_not_counted() {
        let list = vec![Value::Number(1.0), Value::Empty, Value::Number(3.0)];
        assert_eq!(run(list.clone(), "sum(prop(\"Valores\"))"), Value::Number(4.0));
        // Média sobre os DOIS itens presentes (não sobre os três da lista).
        assert_eq!(run(list, "mean(prop(\"Valores\"))"), Value::Number(2.0));
    }

    /// DBS-063, adaptado: a forma exata do checklist usa
    /// `sum(prop("Relação").map(current.prop("Valor")))`, que só compila
    /// quando F5 (lista de ordem superior, `map`) registrar — fora do
    /// escopo desta rodada. Aqui a MESMA regra (soma de uma lista<número>
    /// recalcula quando a lista muda) é provada sobre uma lista construída
    /// direto pelo `FakeSchema`, sem `map`.
    #[test]
    fn dbs_063_sum_of_a_directly_constructed_list_reflects_the_new_total_when_the_list_changes() {
        assert_eq!(run(numbers(&[10.0, 20.0]), "sum(prop(\"Valores\"))"), Value::Number(30.0));
        assert_eq!(run(numbers(&[10.0, 20.0, 30.0]), "sum(prop(\"Valores\"))"), Value::Number(60.0));
    }
}
