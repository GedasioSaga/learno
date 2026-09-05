//! A árvore sintática que `parser.rs` produz e `typecheck.rs`/`eval.rs`
//! percorrem. Cada nó carrega seu [`Span`] em bytes — é o que dá posição a
//! todo diagnóstico (arquitetura §4, "a posição do erro vai para uma caixa
//! de texto no cliente").

use crate::formula::core::diagnostics::Span;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    /// `-x`. Exige `number`; propaga `Value::Empty` (arquitetura §4).
    Neg,
    /// `!x`. Exige `boolean`; `Value::Empty` é falso em contexto booleano,
    /// então `!vazio` avalia para `true` — ver `eval.rs`.
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    NotEq,
    Gt,
    GtEq,
    Lt,
    LtEq,
    /// `&&`. Curto-circuita no avaliador — nunca passa pela tabela de
    /// funções, porque avaliar o lado direito de propósito exigiria uma
    /// convenção de "argumento preguiçoso" que só esta e `Or` precisam.
    And,
    /// `||`. Mesma nota de `And`.
    Or,
}

/// Um nó da árvore, com o span de TODA a subexpressão que ele cobre — não só
/// do token que o introduziu. Um `Call` cobre do nome até o `)` de
/// fechamento; um `Binary` cobre do início do operando esquerdo até o fim do
/// direito. É o que permite sublinhar a expressão inteira quando o erro é
/// "os dois lados não combinam", em vez de só o operador.
#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub span: Span,
    pub kind: ExprKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    NumberLit(f64),
    StringLit(String),
    BoolLit(bool),
    /// Um nome solto — hoje só `current`, o item corrente dentro do corpo de
    /// `map`/`filter`/`some`/`every` (DBS-078/080, F5). Qualquer outro nome
    /// é "identificador desconhecido" no checador (`typecheck.rs`): a
    /// linguagem não tem variável definida pelo usuário.
    Ident(String),
    /// `prop("Nome")`, com ou sem receptor. Nó DEDICADO — não uma chamada de
    /// função comum — por dois motivos que só o núcleo pode garantir:
    ///
    /// 1. **Renomear propriedade** (arquitetura §4) precisa do span de CADA
    ///    ocorrência do NOME, para reescrever o texto da fórmula por
    ///    substring, nunca por regex. `Compiled::prop_name_spans` (em
    ///    `compile.rs`) é construído varrendo estes nós.
    /// 2. **Tipo estático** (DBS-085): o tipo de `prop("Nome")` depende do
    ///    VALOR do argumento (uma string literal), não só do seu tipo — algo
    ///    que nenhuma função da tabela comum faz. Resolver isso exige olhar
    ///    o schema (`ValueSource::property_by_name`) em tempo de checagem,
    ///    o que só um nó dedicado permite fazer sem inventar um mecanismo de
    ///    "função cujo tipo de retorno depende do valor do argumento" para
    ///    UMA função só.
    ///
    /// `receiver` é `None` para o `prop()` "solto" (lê o registro sendo
    /// avaliado); `Some` para `algumaPágina.prop("Nome")` — o encadeamento
    /// por ponto (ex.: `current.prop("Relação")` dentro de um `.map()`) lê a
    /// propriedade da página que `receiver` avalia, não do registro
    /// corrente. Ver `eval.rs`.
    PropRef { receiver: Option<Box<Expr>>, name: String, name_span: Span },
    Unary { op: UnaryOp, expr: Box<Expr> },
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
    /// `cond ? then : otherwise`. Right-associative (`a ? b : c ? d : e` é
    /// `a ? b : (c ? d : e)`) — o parser garante isso recursando à direita.
    Ternary { cond: Box<Expr>, then_branch: Box<Expr>, else_branch: Box<Expr> },
    /// `nome(args...)`, e também o alvo do açúcar de ponto:
    /// `a.nome(args...)` vira `Call { name: "nome", args: [a, ...args] }`
    /// no momento do parse (`parser.rs`) — `a` é só o primeiro argumento
    /// posicional, então a tabela de funções nunca precisa saber que a
    /// chamada veio com ponto.
    Call { name: String, name_span: Span, args: Vec<Expr> },
}

impl Expr {
    pub fn new(span: Span, kind: ExprKind) -> Self {
        Self { span, kind }
    }
}
