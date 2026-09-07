//! Categoria "texto" (DBS-066): `length`/`substring`/`contains`/`lower`/
//! `upper`/`repeat`/`trim`/`join`/`split`.
//!
//! ## A decisão que atravessa o módulo inteiro: o que conta como "um caractere"
//!
//! `length()` conta **caracteres Unicode** (`char`, um "scalar value"), não
//! BYTE nem GRAFEMA — e `substring`/`split` (com separador vazio) usam a
//! MESMA unidade, para as três ficarem consistentes entre si. O usuário é
//! brasileiro; título vai ter acento:
//!
//! - **Não byte**: "café" tem 4 caracteres mas 5 bytes em UTF-8 (o "é"
//!   pré-composto ocupa 2 bytes) — contar bytes mostraria 5 para um título
//!   de 4 letras, o que ninguém que olha a tela esperaria.
//! - **Não grafema**: um grafema (o que um olho humano vê como "um
//!   caractere") seria mais correto para emoji complexo (família com ZWJ,
//!   acento combinante separado da letra base), mas exige o crate
//!   `unicode-segmentation`, que não está no `Cargo.toml` — fora do escopo
//!   desta rodada de três categorias, e a regra 2 do projeto proíbe
//!   adicionar dependência por suposição. Efeito nomeado, testado abaixo:
//!   um emoji simples ("👍") conta 1; uma letra decomposta em NFD (base +
//!   acento combinante separados, ex.: "e" + "́" em vez de "é" pré-composto)
//!   conta 2, mesmo os dois formando visualmente "uma letra".
//!
//! `join`/`split` são a dupla de listas: `split(texto, separador)` produz
//! `lista<texto>`; `join(separador, ...textos)` é o inverso, variádico
//! (`Arity::AtLeast(1)` — só o separador é obrigatório; zero textos depois
//! dele é uma junção vazia, `""`).
mod checks;

use crate::formula::core::{register, Arg, Arity, EvalCtx, FunctionDef, ParamKind, Value};

use checks::{check_contains, check_join, check_length, check_lower, check_repeat, check_split, check_substring, check_trim, check_upper};

/// Teto de saída de `repeat`, em bytes — não pode alocar sem limite com uma
/// entrada hostil (`repeat("a", 999999999999)`). 10 MB é bem acima do que
/// qualquer célula precisa mostrar e bem abaixo de qualquer coisa que
/// arrisque estourar memória.
const MAX_REPEAT_OUTPUT_BYTES: usize = 10 * 1024 * 1024;

fn string_arg(args: &[Arg], index: usize) -> Option<&str> {
    match args.get(index) {
        Some(Arg::Value(Value::String(s))) => Some(s.as_str()),
        _ => None,
    }
}

fn number_arg(args: &[Arg], index: usize) -> Option<f64> {
    match args.get(index) {
        Some(Arg::Value(Value::Number(n))) => Some(*n),
        _ => None,
    }
}

/// Ver a doc do módulo: conta `char` (Unicode scalar value), não byte nem
/// grafema.
fn eval_length(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match string_arg(args, 0) {
        // Contagem de char de um texto de fórmula nunca chega perto de 2^53
        // (limite de precisão exata de f64) — sem perda ao converter.
        Some(s) => Value::Number(s.chars().count() as f64),
        None => Value::Empty,
    }
}

/// Índices contam CARACTERES (mesma unidade de `length()`), 0-based,
/// `[start, end)`. `end` omitido = até o fim. Índice negativo satura para 0
/// (não é "conta a partir do fim", como fatiamento Python); índice além do
/// comprimento satura para o comprimento. `start >= end` (depois de saturar
/// os dois) devolve texto vazio — nunca erro, nunca pânico.
fn eval_substring(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(text) = string_arg(args, 0) else {
        return Value::Empty;
    };
    let Some(start) = number_arg(args, 1) else {
        return Value::Empty;
    };
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();

    // `as usize` satura para 0 em entrada negativa e para `usize::MAX` em
    // entrada gigante (comportamento definido do cast float->int desde Rust
    // 1.45, sem UB) — o `.min(len)` logo depois já traz de volta para um
    // índice dentro da faixa válida, então a saturação nunca escapa como um
    // índice fora dos limites.
    let start_idx = (start.max(0.0) as usize).min(len);
    let end_idx = match number_arg(args, 2) {
        Some(end) => (end.max(0.0) as usize).min(len),
        None => len,
    };

    if start_idx >= end_idx {
        return Value::String(String::new());
    }
    // `0 <= start_idx < end_idx <= len`, garantido pelas duas linhas acima —
    // fatiar `chars[start_idx..end_idx]` nunca estoura.
    Value::String(chars[start_idx..end_idx].iter().collect())
}

fn eval_contains(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match (string_arg(args, 0), string_arg(args, 1)) {
        (Some(text), Some(needle)) => Value::Boolean(text.contains(needle)),
        _ => Value::Empty,
    }
}

/// `to_lowercase`/`to_uppercase` da std são cientes de Unicode — "É" vira
/// "é", não fica intocado como um `to_ascii_lowercase` deixaria.
fn eval_lower(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match string_arg(args, 0) {
        Some(s) => Value::String(s.to_lowercase()),
        None => Value::Empty,
    }
}

fn eval_upper(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match string_arg(args, 0) {
        Some(s) => Value::String(s.to_uppercase()),
        None => Value::Empty,
    }
}

/// Contagem negativa satura para 0 repetições (texto vazio). Teto de saída
/// em `MAX_REPEAT_OUTPUT_BYTES` evita alocação sem limite.
fn eval_repeat(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(text) = string_arg(args, 0) else {
        return Value::Empty;
    };
    let Some(count) = number_arg(args, 1) else {
        return Value::Empty;
    };
    if text.is_empty() {
        // Repetir uma string vazia qualquer número de vezes é sempre vazio —
        // resolve antes do cálculo de teto abaixo, que dividiria por
        // `text.len() == 0`.
        return Value::String(String::new());
    }
    // Satura negativo para 0 e gigante para `usize::MAX` (cast float->int
    // definido desde Rust 1.45); o `.min(max_reps)` seguinte traz de volta
    // para dentro do teto de alocação.
    let requested = count.max(0.0) as usize;
    let max_reps = MAX_REPEAT_OUTPUT_BYTES / text.len();
    let capped = requested.min(max_reps);
    Value::String(text.repeat(capped))
}

/// `str::trim()` da std remove espaço em branco Unicode dos dois lados, não
/// só ASCII.
fn eval_trim(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    match string_arg(args, 0) {
        Some(s) => Value::String(s.trim().to_string()),
        None => Value::Empty,
    }
}

/// `join(separador, ...textos)` — variádico, só o separador é obrigatório.
/// Zero textos depois dele é uma junção vazia (`""`); um texto só devolve
/// esse texto sem o separador aparecer.
fn eval_join(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(separator) = string_arg(args, 0) else {
        return Value::Empty;
    };
    let mut items: Vec<&str> = Vec::with_capacity(args.len().saturating_sub(1));
    for index in 1..args.len() {
        match string_arg(args, index) {
            Some(s) => items.push(s),
            // Defensivo: não deveria acontecer pós-`compile()` bem-sucedido
            // (`check_join` já exige texto em todo argumento).
            None => return Value::Empty,
        }
    }
    Value::String(items.join(separator))
}

/// Separador vazio: divide por CARACTERE (mesma unidade de `length()`), não
/// por byte — "café".split("") nunca parte o "é" ao meio. Separador não
/// encontrado no texto: devolve uma lista de um item só, o texto inteiro
/// (mesmo comportamento de `String.prototype.split` em JS).
fn eval_split(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(text) = string_arg(args, 0) else {
        return Value::Empty;
    };
    let Some(separator) = string_arg(args, 1) else {
        return Value::Empty;
    };
    let items: Vec<Value> = if separator.is_empty() {
        text.chars().map(|c| Value::String(c.to_string())).collect()
    } else {
        text.split(separator).map(|s| Value::String(s.to_string())).collect()
    };
    Value::List(items)
}

pub fn register_all() {
    register(FunctionDef {
        name: "length",
        category: "texto",
        doc: "Número de caracteres de um texto.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_length,
        accepts_empty: |_| false,
        eval: eval_length,
    });
    register(FunctionDef {
        name: "substring",
        category: "texto",
        doc: "Recorta um trecho do texto por posição de caractere; terceiro argumento (fim) é opcional.",
        arity: Arity::Range(2, 3),
        params: |_| ParamKind::Value,
        check: check_substring,
        accepts_empty: |_| false,
        eval: eval_substring,
    });
    register(FunctionDef {
        name: "contains",
        category: "texto",
        doc: "Verifica se um texto contém outro.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_contains,
        accepts_empty: |_| false,
        eval: eval_contains,
    });
    register(FunctionDef {
        name: "lower",
        category: "texto",
        doc: "Converte o texto para minúsculas.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_lower,
        accepts_empty: |_| false,
        eval: eval_lower,
    });
    register(FunctionDef {
        name: "upper",
        category: "texto",
        doc: "Converte o texto para maiúsculas.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_upper,
        accepts_empty: |_| false,
        eval: eval_upper,
    });
    register(FunctionDef {
        name: "repeat",
        category: "texto",
        doc: "Repete um texto N vezes.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_repeat,
        accepts_empty: |_| false,
        eval: eval_repeat,
    });
    register(FunctionDef {
        name: "trim",
        category: "texto",
        doc: "Remove espaços em branco do início e do fim do texto.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_trim,
        accepts_empty: |_| false,
        eval: eval_trim,
    });
    register(FunctionDef {
        name: "join",
        category: "texto",
        doc: "Junta dois ou mais textos usando o primeiro argumento como separador.",
        arity: Arity::AtLeast(1),
        params: |_| ParamKind::Value,
        check: check_join,
        accepts_empty: |_| false,
        eval: eval_join,
    });
    register(FunctionDef {
        name: "split",
        category: "texto",
        doc: "Divide um texto em uma lista, usando o segundo argumento como separador.",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_split,
        accepts_empty: |_| false,
        eval: eval_split,
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::{compile, eval, PageMeta, PropertyId, Type, ValueSource};
    use uuid::Uuid;

    /// Schema falso com "Título" configurável — o exemplo literal de
    /// DBS-066 (`prop("Título").length()>50`) precisa dele.
    struct FakeSchema {
        titulo: String,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, property: PropertyId) -> Value {
            if property == Uuid::from_u128(1) {
                Value::String(self.titulo.clone())
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
            (name == "Título").then(|| (Uuid::from_u128(1), Type::String))
        }
    }

    fn run_with_titulo(titulo: &str, src: &str) -> Value {
        crate::formula::functions::register_all();
        let schema = FakeSchema { titulo: titulo.to_string() };
        let compiled = compile(src, &schema).unwrap_or_else(|errors| panic!("esperava compilar \"{src}\", veio {errors:?}"));
        let mut ctx = EvalCtx::new(&schema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    fn run(src: &str) -> Value {
        run_with_titulo("", src)
    }

    /// O exemplo LITERAL de DBS-066: `prop("Título").length()>50`.
    #[test]
    fn dbs_066_length_over_fifty_characters() {
        let curto = "a".repeat(50);
        let longo = "a".repeat(51);
        assert_eq!(run_with_titulo(&curto, "prop(\"Título\").length()>50"), Value::Boolean(false));
        assert_eq!(run_with_titulo(&longo, "prop(\"Título\").length()>50"), Value::Boolean(true));
    }

    /// A decisão de unidade, documentada e testada: "café" tem 5 BYTES ("é"
    /// pré-composto ocupa 2) mas 4 CARACTERES — `length()` devolve 4.
    #[test]
    fn length_counts_chars_not_bytes() {
        assert_eq!("café".len(), 5); // bytes, para contraste
        assert_eq!(run("length(\"café\")"), Value::Number(4.0));
    }

    /// Emoji simples (um scalar value só) conta 1 — o caso comum.
    #[test]
    fn length_of_a_simple_emoji_is_one() {
        assert_eq!(run("length(\"👍\")"), Value::Number(1.0));
    }

    /// Limite nomeado da decisão: um acento combinante SEPARADO da letra
    /// base (forma NFD, "e" + U+0301) conta 2 caracteres, mesmo formando
    /// visualmente "uma letra só" — um grafema contaria 1. É o preço de não
    /// trazer `unicode-segmentation` nesta rodada (ver doc do módulo).
    #[test]
    fn length_counts_a_combining_accent_as_a_separate_character() {
        let e_com_acento_combinante = "e\u{0301}";
        assert_eq!(run(&format!("length(\"{e_com_acento_combinante}\")")), Value::Number(2.0));
    }

    #[test]
    fn substring_happy_path() {
        assert_eq!(run("substring(\"café com leite\", 0, 4)"), Value::String("café".to_string()));
        assert_eq!(run("substring(\"café com leite\", 5)"), Value::String("com leite".to_string()));
    }

    #[test]
    fn substring_out_of_range_negative_and_inverted_indices_never_panic() {
        // Fim além do comprimento satura no comprimento.
        assert_eq!(run("substring(\"abc\", 1, 999)"), Value::String("bc".to_string()));
        // Início negativo satura em 0.
        assert_eq!(run("substring(\"abc\", -5, 2)"), Value::String("ab".to_string()));
        // Início além do comprimento: string vazia, não erro.
        assert_eq!(run("substring(\"abc\", 10, 20)"), Value::String(String::new()));
        // Início > fim (depois de saturar os dois): string vazia.
        assert_eq!(run("substring(\"abc\", 2, 1)"), Value::String(String::new()));
    }

    #[test]
    fn contains_happy_path_with_accent_and_empty_needle() {
        assert_eq!(run("contains(\"café com leite\", \"café\")"), Value::Boolean(true));
        assert_eq!(run("contains(\"café\", \"chá\")"), Value::Boolean(false));
        assert_eq!(run("contains(\"qualquer coisa\", \"\")"), Value::Boolean(true));
    }

    #[test]
    fn lower_and_upper_are_unicode_aware() {
        assert_eq!(run("lower(\"CAFÉ\")"), Value::String("café".to_string()));
        assert_eq!(run("upper(\"café\")"), Value::String("CAFÉ".to_string()));
    }

    #[test]
    fn repeat_happy_path_and_negative_count_is_empty_string() {
        assert_eq!(run("repeat(\"ab\", 3)"), Value::String("ababab".to_string()));
        assert_eq!(run("repeat(\"ab\", -5)"), Value::String(String::new()));
        assert_eq!(run("repeat(\"\", 1000000)"), Value::String(String::new()));
    }

    /// Contagem enorme não aloca gigabytes nem trava — é capada.
    #[test]
    fn repeat_with_huge_count_is_capped_not_allocated_unbounded() {
        let result = run("repeat(\"a\", 999999999999)");
        match result {
            Value::String(s) => assert!(s.len() <= MAX_REPEAT_OUTPUT_BYTES),
            other => panic!("esperava String, veio {other:?}"),
        }
    }

    #[test]
    fn trim_removes_surrounding_whitespace() {
        assert_eq!(run("trim(\"  café  \")"), Value::String("café".to_string()));
    }

    #[test]
    fn join_of_empty_list_and_of_a_single_item() {
        // Só o separador, zero textos depois: junção vazia.
        assert_eq!(run("join(\",\")"), Value::String(String::new()));
        // Um texto só: devolve ele mesmo, sem separador aparecendo.
        assert_eq!(run("join(\",\", \"a\")"), Value::String("a".to_string()));
        assert_eq!(run("join(\",\", \"a\", \"b\", \"c\")"), Value::String("a,b,c".to_string()));
    }

    #[test]
    fn split_happy_path() {
        assert_eq!(
            run("split(\"a,b,c\", \",\")"),
            Value::List(vec![Value::String("a".to_string()), Value::String("b".to_string()), Value::String("c".to_string())])
        );
    }

    #[test]
    fn split_with_empty_separator_splits_by_character() {
        assert_eq!(
            run("split(\"café\", \"\")"),
            Value::List(vec![
                Value::String("c".to_string()),
                Value::String("a".to_string()),
                Value::String("f".to_string()),
                Value::String("é".to_string()),
            ])
        );
    }

    #[test]
    fn split_separator_not_found_returns_a_single_item_list() {
        assert_eq!(run("split(\"abc\", \";\")"), Value::List(vec![Value::String("abc".to_string())]));
    }
}
