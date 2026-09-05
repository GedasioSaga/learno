//! Pratt parser — precedência de operador por nível de função recursiva
//! (a técnica clássica de "precedence climbing"), não por gramática livre de
//! contexto ambígua. Cada nível de precedência é uma função que chama o
//! nível de cima antes de olhar seu próprio operador; é isso que resolve
//! `1 + 2 * 3` para `1 + (2 * 3)` sem tabela de precedência separada do
//! código.
//!
//! Ordem de precedência, da mais baixa para a mais alta:
//! ternário < `||` < `&&` < igualdade < relacional < aditivo <
//! multiplicativo < unário < posfixo (chamada, encadeamento por ponto) <
//! primário.

use crate::formula::core::ast::{BinaryOp, Expr, ExprKind, UnaryOp};
use crate::formula::core::diagnostics::{Diagnostic, Span};
use crate::formula::core::lexer::{lex, Token, TokenKind};

pub fn parse(src: &str) -> Result<Expr, Diagnostic> {
    let tokens = lex(src)?;
    let mut parser = Parser { tokens, pos: 0 };
    let expr = parser.parse_expression()?;
    parser.expect_eof()?;
    Ok(expr)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        // `lex` sempre termina com `Eof`, e `pos` nunca avança além dele
        // (`advance` para de mover depois do último token) — então este
        // índice está sempre dentro dos limites, sem precisar de
        // `unwrap`/`expect` para provar isso ao compilador.
        self.tokens.get(self.pos).unwrap_or(&self.tokens[self.tokens.len() - 1])
    }

    fn advance(&mut self) -> Token {
        let token = self.peek().clone();
        if !matches!(token.kind, TokenKind::Eof) {
            self.pos += 1;
        }
        token
    }

    fn expect_eof(&mut self) -> Result<(), Diagnostic> {
        if matches!(self.peek().kind, TokenKind::Eof) {
            Ok(())
        } else {
            Err(Diagnostic::error("token inesperado depois do fim da expressão", self.peek().span))
        }
    }

    fn expect_lparen(&mut self) -> Result<(), Diagnostic> {
        if matches!(self.peek().kind, TokenKind::LParen) {
            self.advance();
            Ok(())
        } else {
            Err(Diagnostic::error("esperava \"(\"", self.peek().span))
        }
    }

    fn expect_rparen(&mut self) -> Result<Span, Diagnostic> {
        if matches!(self.peek().kind, TokenKind::RParen) {
            Ok(self.advance().span)
        } else {
            Err(Diagnostic::error("esperava \")\"", self.peek().span))
        }
    }

    fn parse_expression(&mut self) -> Result<Expr, Diagnostic> {
        self.parse_ternary()
    }

    fn parse_ternary(&mut self) -> Result<Expr, Diagnostic> {
        let cond = self.parse_or()?;
        if matches!(self.peek().kind, TokenKind::Question) {
            self.advance();
            let then_branch = self.parse_expression()?;
            if !matches!(self.peek().kind, TokenKind::Colon) {
                return Err(Diagnostic::error("esperava \":\" no operador ternário", self.peek().span));
            }
            self.advance();
            // Recursa em `parse_ternary` (não `parse_expression`) para o
            // ramo "senão": é isso que faz `a ? b : c ? d : e` associar à
            // direita como `a ? b : (c ? d : e)`, em vez de exigir
            // parênteses para encadear.
            let else_branch = self.parse_ternary()?;
            let span = cond.span.merge(else_branch.span);
            return Ok(Expr::new(
                span,
                ExprKind::Ternary { cond: Box::new(cond), then_branch: Box::new(then_branch), else_branch: Box::new(else_branch) },
            ));
        }
        Ok(cond)
    }

    fn parse_or(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_and()?;
        while matches!(self.peek().kind, TokenKind::OrOr) {
            self.advance();
            let right = self.parse_and()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op: BinaryOp::Or, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_equality()?;
        while matches!(self.peek().kind, TokenKind::AndAnd) {
            self.advance();
            let right = self.parse_equality()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op: BinaryOp::And, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_equality(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_relational()?;
        loop {
            let op = match self.peek().kind {
                TokenKind::EqEq => BinaryOp::Eq,
                TokenKind::NotEq => BinaryOp::NotEq,
                _ => break,
            };
            self.advance();
            let right = self.parse_relational()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_relational(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_additive()?;
        loop {
            let op = match self.peek().kind {
                TokenKind::Gt => BinaryOp::Gt,
                TokenKind::GtEq => BinaryOp::GtEq,
                TokenKind::Lt => BinaryOp::Lt,
                TokenKind::LtEq => BinaryOp::LtEq,
                _ => break,
            };
            self.advance();
            let right = self.parse_additive()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = match self.peek().kind {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.advance();
            let right = self.parse_multiplicative()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr, Diagnostic> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek().kind {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                TokenKind::Percent => BinaryOp::Mod,
                _ => break,
            };
            self.advance();
            let right = self.parse_unary()?;
            let span = left.span.merge(right.span);
            left = Expr::new(span, ExprKind::Binary { op, left: Box::new(left), right: Box::new(right) });
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, Diagnostic> {
        let op = match self.peek().kind {
            TokenKind::Minus => UnaryOp::Neg,
            TokenKind::Bang => UnaryOp::Not,
            _ => return self.parse_postfix(),
        };
        let op_span = self.advance().span;
        let operand = self.parse_unary()?;
        let span = op_span.merge(operand.span);
        Ok(Expr::new(span, ExprKind::Unary { op, expr: Box::new(operand) }))
    }

    fn parse_postfix(&mut self) -> Result<Expr, Diagnostic> {
        let mut expr = self.parse_primary()?;
        loop {
            if !matches!(self.peek().kind, TokenKind::Dot) {
                break;
            }
            self.advance();
            let (name, name_span) = self.expect_ident("nome de método")?;
            self.expect_lparen()?;
            let args = self.parse_call_args()?;
            let close_span = self.expect_rparen()?;
            let span = expr.span.merge(close_span);

            // `algo.prop("Nome")` é o MESMO nó especial que `prop("Nome")`
            // solto (ver `ast::ExprKind::PropRef`), só que lendo a
            // propriedade da página que `algo` avalia — é o caminho que
            // `current.prop("Relação")` usa dentro de `.map()`/`.filter()`.
            if name == "prop" {
                if let [Expr { kind: ExprKind::StringLit(prop_name), span: name_lit_span }] = args.as_slice() {
                    expr = Expr::new(
                        span,
                        ExprKind::PropRef {
                            receiver: Some(Box::new(expr)),
                            name: prop_name.clone(),
                            name_span: *name_lit_span,
                        },
                    );
                    continue;
                }
                return Err(Diagnostic::error(
                    "prop() espera exatamente um texto literal com o nome da propriedade, entre aspas",
                    span,
                ));
            }

            let mut call_args = Vec::with_capacity(args.len() + 1);
            call_args.push(expr);
            call_args.extend(args);
            expr = Expr::new(span, ExprKind::Call { name, name_span, args: call_args });
        }
        Ok(expr)
    }

    fn parse_call_args(&mut self) -> Result<Vec<Expr>, Diagnostic> {
        let mut args = Vec::new();
        if matches!(self.peek().kind, TokenKind::RParen) {
            return Ok(args);
        }
        loop {
            args.push(self.parse_expression()?);
            if matches!(self.peek().kind, TokenKind::Comma) {
                self.advance();
                continue;
            }
            break;
        }
        Ok(args)
    }

    fn expect_ident(&mut self, what: &str) -> Result<(String, Span), Diagnostic> {
        let token = self.peek().clone();
        match token.kind {
            TokenKind::Ident(name) => {
                self.advance();
                Ok((name, token.span))
            }
            _ => Err(Diagnostic::error(format!("esperava {what}"), token.span)),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, Diagnostic> {
        let token = self.peek().clone();
        match token.kind {
            TokenKind::Number(n) => {
                self.advance();
                Ok(Expr::new(token.span, ExprKind::NumberLit(n)))
            }
            TokenKind::String { value, .. } => {
                self.advance();
                Ok(Expr::new(token.span, ExprKind::StringLit(value)))
            }
            TokenKind::True => {
                self.advance();
                Ok(Expr::new(token.span, ExprKind::BoolLit(true)))
            }
            TokenKind::False => {
                self.advance();
                Ok(Expr::new(token.span, ExprKind::BoolLit(false)))
            }
            TokenKind::LParen => {
                self.advance();
                let mut inner = self.parse_expression()?;
                let close_span = self.expect_rparen()?;
                // Estica o span para cobrir os parênteses inteiros — um
                // diagnóstico sobre `(1 + 2)` sublinha do "(" ao ")", não só
                // do "1 + 2" de dentro.
                inner.span = token.span.merge(close_span);
                Ok(inner)
            }
            TokenKind::Ident(name) => {
                self.advance();
                if name == "prop" {
                    return self.parse_prop_ref(token.span);
                }
                if matches!(self.peek().kind, TokenKind::LParen) {
                    self.advance();
                    let args = self.parse_call_args()?;
                    let close_span = self.expect_rparen()?;
                    let span = token.span.merge(close_span);
                    return Ok(Expr::new(span, ExprKind::Call { name, name_span: token.span, args }));
                }
                Ok(Expr::new(token.span, ExprKind::Ident(name)))
            }
            _ => Err(Diagnostic::error("expressão inválida", token.span)),
        }
    }

    /// Já consumiu o identificador `prop`; espera `("Nome")` — exatamente
    /// uma string literal, nada mais. Compartilhado pelo `prop()` solto
    /// (aqui) e pelo encadeado por ponto (`parse_postfix`), que faz a MESMA
    /// exigência sobre os argumentos já coletados de uma chamada comum.
    fn parse_prop_ref(&mut self, prop_span: Span) -> Result<Expr, Diagnostic> {
        self.expect_lparen()?;
        let token = self.peek().clone();
        let (name, name_span) = match token.kind {
            TokenKind::String { value, content_span } => {
                self.advance();
                (value, content_span)
            }
            _ => {
                return Err(Diagnostic::error(
                    "prop() espera exatamente um texto literal com o nome da propriedade, entre aspas",
                    token.span,
                ));
            }
        };
        let close_span = self.expect_rparen()?;
        let span = prop_span.merge(close_span);
        Ok(Expr::new(span, ExprKind::PropRef { receiver: None, name, name_span }))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn precedence_multiplication_before_addition() {
        let expr = parse("1 + 2 * 3").unwrap();
        match expr.kind {
            ExprKind::Binary { op: BinaryOp::Add, right, .. } => {
                assert!(matches!(right.kind, ExprKind::Binary { op: BinaryOp::Mul, .. }));
            }
            other => panic!("esperava Add na raiz, veio {other:?}"),
        }
    }

    #[test]
    fn ternary_is_right_associative() {
        let expr = parse("true ? 1 : false ? 2 : 3").unwrap();
        match expr.kind {
            ExprKind::Ternary { else_branch, .. } => {
                assert!(matches!(else_branch.kind, ExprKind::Ternary { .. }));
            }
            other => panic!("esperava Ternary na raiz, veio {other:?}"),
        }
    }

    #[test]
    fn bare_prop_ref_captures_name_span() {
        let expr = parse("prop(\"Preço\")").unwrap();
        match expr.kind {
            ExprKind::PropRef { receiver, name, name_span } => {
                assert!(receiver.is_none());
                assert_eq!(name, "Preço");
                // byte 6 é logo depois de `prop("` (4 letras + 2 aspas/parên.)
                assert_eq!(name_span, Span::new(6, 6 + "Preço".len()));
            }
            other => panic!("esperava PropRef, veio {other:?}"),
        }
    }

    #[test]
    fn dot_chain_prepends_receiver_as_first_argument() {
        let expr = parse("current.first()").unwrap();
        match expr.kind {
            ExprKind::Call { name, args, .. } => {
                assert_eq!(name, "first");
                assert_eq!(args.len(), 1);
                assert!(matches!(args[0].kind, ExprKind::Ident(ref n) if n == "current"));
            }
            other => panic!("esperava Call, veio {other:?}"),
        }
    }

    #[test]
    fn dot_chained_prop_reads_from_receiver() {
        let expr = parse("current.prop(\"Valor\")").unwrap();
        match expr.kind {
            ExprKind::PropRef { receiver, name, .. } => {
                assert_eq!(name, "Valor");
                assert!(matches!(receiver.as_deref(), Some(Expr { kind: ExprKind::Ident(n), .. }) if n == "current"));
            }
            other => panic!("esperava PropRef, veio {other:?}"),
        }
    }

    #[test]
    fn prop_without_string_literal_is_a_diagnostic() {
        let err = parse("prop(1)").unwrap_err();
        assert!(err.message.contains("texto literal"));
    }

    #[test]
    fn unterminated_call_reports_expected_rparen() {
        let err = parse("soma(1, 2").unwrap_err();
        assert!(err.message.contains(")"));
    }

    #[test]
    fn trailing_garbage_after_expression_is_an_error() {
        let err = parse("1 + 1 2").unwrap_err();
        assert!(err.message.contains("inesperado"));
    }
}
