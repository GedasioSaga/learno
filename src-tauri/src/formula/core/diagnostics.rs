//! Posição de erro, do jeito que o lexer/parser/checador de tipo produzem —
//! sempre em BYTES UTF-8, porque é assim que `&str` do Rust indexa. A
//! conversão para unidades UTF-16 (o que o JavaScript usa) acontece só na
//! fronteira IPC (`ipc::formula_commands`), nunca aqui — ver o comentário
//! daquele arquivo para o porquê e o teste com acento que prova a conversão.

/// Um intervalo de bytes `[start, end)` em UTF-8, dentro da string-fonte
/// original que `lex`/`parse` receberam. Meio-aberto para casar com o jeito
/// que `&src[span.start..span.end]` já funciona sem `+1`/`-1` em lugar
/// nenhum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        debug_assert!(start <= end, "span invertido: {start}..{end}");
        Self { start, end }
    }

    /// O span que cobre `self` e `other` inteiros — usado para dar ao nó de
    /// uma chamada de função o alcance de "do nome até o `)` de fechamento",
    /// em vez de só o nome.
    pub fn merge(self, other: Span) -> Span {
        Span::new(self.start.min(other.start), self.end.max(other.end))
    }
}

/// Só existe `Error` por enquanto — a linguagem não tem aviso hoje (nada no
/// checklist pede um formula "quase certa" que ainda salva). O enum existe
/// para não ter que mudar a forma pública de [`Diagnostic`] no dia em que
/// pedirem um.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
}

/// Um erro de sintaxe ou de tipo, com a posição em bytes de onde ele mora na
/// expressão original. `message` é a frase inteira pronta para a caixa de
/// texto do cliente (DBS-085) — em português, porque é o usuário final do
/// editor de fórmula que lê.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub message: String,
    pub span: Span,
    pub severity: Severity,
}

impl Diagnostic {
    pub fn error(message: impl Into<String>, span: Span) -> Self {
        Self { message: message.into(), span, severity: Severity::Error }
    }
}
