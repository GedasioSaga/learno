//! A TABELA DE FUNÇÕES — o ponto de extensão que F1..F6 preenchem em
//! paralelo (arquitetura §4/§11), cada categoria (matemática, agregação de
//! lista, texto, data, lógica/lista de ordem superior, página/pessoa) na sua
//! própria pasta sob `formula::functions`, chamando [`register`] a partir de
//! `formula::functions::register_all` (`functions/mod.rs`).
//!
//! ## Por que uma tabela GLOBAL, e não um parâmetro de `compile`/`eval`
//!
//! A arquitetura §9 CONGELA as assinaturas
//! `compile(src: &str, schema: &dyn ValueSource) -> Result<Compiled, Vec<Diagnostic>>`
//! e `eval(ast: &Expr, ctx: &mut EvalCtx) -> Value` — nenhuma das duas recebe
//! uma tabela de funções por parâmetro. Isso só funciona se a tabela for um
//! registro compartilhado de processo, populado por [`register`] antes do
//! primeiro `compile`. É o que faz "prove o núcleo com duas ou três funções
//! de teste registradas pelo próprio teste" (o pedido desta peça) literal:
//! um teste chama `register(minha_funcao_de_teste())` e ela passa a existir
//! para `compile`/`eval` do mesmo jeito que uma função de F1..F6 vai existir.
//!
//! **Custo aceito, nomeado:** `register` SOBRESCREVE em vez de recusar nome
//! duplicado (com um `tracing::warn!`, nunca em silêncio) — um `panic!` na
//! inicialização do processo por uma colisão de nome entre categorias
//! derrubaria o app inteiro por um erro de configuração, não de dado do
//! usuário, o que a regra 3 trata como pânico ilegítimo. Isso significa que
//! duas peças que escolherem o MESMO nome de função silenciosamente vencem
//! por ordem de registro — cabe à revisão do checklist final (não a este
//! arquivo) notar se F1..F6 colidiram em algum nome.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use crate::formula::core::ast::Expr;
use crate::formula::core::eval::{eval, EvalCtx};
use crate::formula::core::types::{Type, Value};

/// Quantos argumentos uma função aceita. `AtLeast` cobre variádicas como
/// `ifs(cond1, then1, cond2, then2, ..., else)` (DBS-075) e `join`/`concat`
/// (DBS-066/078) — o checklist tem várias dessas, então a forma fixa
/// `Exact`/`Range` sozinha deixaria F1..F6 reinventando "N ou mais" cada um
/// à sua moda.
#[derive(Debug, Clone, Copy)]
pub enum Arity {
    Exact(usize),
    /// Inclusive dos dois lados: `Range(1, 3)` aceita 1, 2 ou 3.
    Range(usize, usize),
    AtLeast(usize),
}

impl Arity {
    pub fn accepts(&self, n: usize) -> bool {
        match *self {
            Arity::Exact(k) => n == k,
            Arity::Range(min, max) => (min..=max).contains(&n),
            Arity::AtLeast(min) => n >= min,
        }
    }

    /// Frase pronta para o diagnóstico de aridade errada — em português,
    /// porque é isso que `validate_formula` devolve para a caixa de erro.
    pub fn describe(&self) -> String {
        match *self {
            Arity::Exact(1) => "exatamente 1 argumento".to_string(),
            Arity::Exact(k) => format!("exatamente {k} argumentos"),
            Arity::Range(min, max) => format!("entre {min} e {max} argumentos"),
            Arity::AtLeast(min) => format!("pelo menos {min} argumentos"),
        }
    }
}

/// Como o avaliador prepara o argumento de índice `i` ANTES de chamar
/// `FunctionDef::eval` — ver [`Arg`] para o que cada um vira na prática.
#[derive(Debug, Clone, Copy)]
pub enum ParamKind {
    /// Avaliado avidamente, da esquerda para a direita, antes da chamada —
    /// o caso comum, e o único que a maioria das funções de F1..F6 precisa.
    Value,
    /// NÃO avaliado antes da chamada. Só `map`/`filter`/`some`/`every`
    /// (DBS-078/080, F5) precisam disto: o corpo (ex.: `current.prop("X")`)
    /// tem que rodar UMA VEZ POR ITEM da lista, com `binds` (`"current"`)
    /// apontando para um item diferente a cada vez — não existe um único
    /// `Value` para calcular antes da chamada. `bind_type` computa, na
    /// CHECAGEM de tipo, o tipo que `binds` tem dentro do corpo, a partir
    /// dos tipos já checados dos argumentos ANTERIORES a este (ex.: para
    /// `map(lista, corpo)`, `bind_type` recebe `[list<T>]` e devolve `T`).
    Lambda { binds: &'static str, bind_type: fn(&[Type]) -> Type },
}

/// Um argumento já preparado para `FunctionDef::eval`, na forma que
/// [`ParamKind`] pediu.
pub enum Arg {
    Value(Value),
    Lambda(LambdaArg),
}

/// O corpo NÃO avaliado de um parâmetro `Lambda`, mais a única forma de
/// avaliá-lo: [`LambdaArg::call`]. Nenhuma outra rota chega ao corpo — é
/// isso que garante que o vínculo de `binds` nunca escapa da chamada que o
/// criou (empilha, avalia, desempilha, sempre nessa ordem).
pub struct LambdaArg {
    body: Expr,
}

impl LambdaArg {
    /// Só o avaliador (`eval.rs`, ao preparar os argumentos de um `Call`)
    /// constrói um `LambdaArg` — `body` nunca é exposto de outra forma, o
    /// que é o que garante que [`call`](Self::call) é a ÚNICA rota até ele.
    pub(crate) fn new(body: Expr) -> Self {
        Self { body }
    }

    /// Avalia o corpo com `binding` associado a `name` (o `binds` do
    /// `ParamKind::Lambda` que criou este argumento) só durante esta
    /// chamada — um `binds` que sombreia um vínculo externo do mesmo nome é
    /// restaurado ao original depois. Uma função de lista de ordem superior
    /// (F5) chama isto uma vez por item.
    pub fn call(&self, ctx: &mut EvalCtx, name: &str, binding: Value) -> Value {
        ctx.push_binding(name.to_string(), binding);
        let result = eval(&self.body, ctx);
        ctx.pop_binding();
        result
    }
}

/// Uma entrada da tabela de funções. Todo campo é `fn` puro (endereço de
/// função, `'static`, `Copy`) — nunca uma closure com captura — de propósito:
/// é isso que deixa `FunctionDef` inteiro `Copy`/`Clone` barato para o
/// registro global devolver por valor em cada consulta, sem `Arc` nem
/// `Box<dyn Fn>`.
#[derive(Clone, Copy)]
pub struct FunctionDef {
    pub name: &'static str,
    /// "matemática" | "agregação" | "texto" | "data" | "lógica" | "lista" |
    /// "página" — o que `list_formula_functions` agrupa na paleta do editor.
    pub category: &'static str,
    /// Frase curta em português para a paleta/autocompletar do editor.
    pub doc: &'static str,
    pub arity: Arity,
    /// Descreve o argumento de índice `i` (0-based). Chamado só para
    /// `i` em `0..args.len()` de uma chamada real, então uma função
    /// variádica (`Arity::AtLeast`) pode alternar o significado por
    /// paridade de índice (ex.: `ifs`: par = condição booleana, ímpar =
    /// resultado) sem precisar de um `Vec<ParamKind>` de tamanho fixo.
    pub params: fn(usize) -> ParamKind,
    /// Tipo estático da chamada a partir do tipo já checado de cada
    /// argumento (para um `Lambda`, o tipo do CORPO, não do vínculo) — ou a
    /// mensagem de diagnóstico (DBS-085) quando os tipos não combinam.
    pub check: fn(&[Type]) -> std::result::Result<Type, String>,
    /// Se `false` (o padrão que toda função NOVA de F1..F6 deveria escolher
    /// primeiro) e o argumento `i` avalia para `Value::Empty`, o avaliador
    /// curto-circuita a chamada INTEIRA para `Value::Empty` sem nunca
    /// invocar `eval` — "vazio propaga" (arquitetura §4) fica de graça para
    /// quem não precisa observar vazio. `true` é para a minoria que
    /// precisa (`empty()`/`isEmpty`, DBS-077): a própria função decide o
    /// que um `Value::Empty` naquele argumento significa.
    pub accepts_empty: fn(usize) -> bool,
    pub eval: fn(&[Arg], &mut EvalCtx) -> Value,
}

fn registry() -> &'static RwLock<HashMap<&'static str, FunctionDef>> {
    static REGISTRY: OnceLock<RwLock<HashMap<&'static str, FunctionDef>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Registra (ou substitui) uma função na tabela global. Chamado por
/// `formula::functions::register_all` (F1..F6, uma vez por função de cada
/// categoria) e por testes deste próprio módulo, sem distinção — os dois
/// caminhos são o mesmo mecanismo.
///
/// O `RwLock` é `.write()`-travado só durante a inserção, nunca durante uma
/// chamada de função: `lookup` devolve uma CÓPIA (`FunctionDef` é `Copy`),
/// então `compile`/`eval` nunca seguram o lock enquanto avaliam uma
/// expressão — inclusive uma que chame outras funções recursivamente via
/// `LambdaArg::call`, o que travando o lock de novo seria um deadlock.
pub fn register(def: FunctionDef) {
    // `unwrap_or_else(PoisonError::into_inner)` em vez de `.unwrap()`/`.expect()`
    // (regra 3): um lock envenenado por um pânico em OUTRA chamada de
    // `register`/`lookup` ainda deixa os dados internos utilizáveis para uma
    // operação tão simples quanto inserir uma entrada — recuperar é
    // estritamente melhor que propagar um segundo pânico por cima do
    // primeiro.
    let mut table = registry().write().unwrap_or_else(std::sync::PoisonError::into_inner);
    if table.contains_key(def.name) {
        tracing::warn!(function = def.name, "registro de função de fórmula duplicado — a última chamada de `register` vence");
    }
    table.insert(def.name, def);
}

/// Consulta a tabela global por nome — usado por `typecheck.rs` (checagem
/// estática) e `eval.rs` (a mesma consulta, em runtime, para o `Call` já
/// validado). Devolve uma cópia, nunca uma referência (ver a nota de
/// `register` sobre o lock).
pub fn lookup(name: &str) -> Option<FunctionDef> {
    let table = registry().read().unwrap_or_else(std::sync::PoisonError::into_inner);
    table.get(name).copied()
}

/// Todas as funções registradas agora, para `list_formula_functions`
/// (a paleta/autocompletar do editor) — ordenada por nome para que a saída
/// não dependa da ordem de registro (que, sendo `HashMap`, não é estável).
pub fn list_all() -> Vec<FunctionDef> {
    let table = registry().read().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut all: Vec<FunctionDef> = table.values().copied().collect();
    all.sort_by_key(|def| def.name);
    all
}
