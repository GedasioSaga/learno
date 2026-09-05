//! Checagem estática de tipo (DBS-085): "editor mostra erro em vez de
//! salvar silenciosamente" — tudo que este arquivo devolve como `Err` é uma
//! frase pronta para aquela caixa de erro. Percorre a árvore UMA vez,
//! produzindo o tipo de cada nó a partir do tipo dos filhos (nunca do
//! `Value` de runtime — isso é `eval.rs`, que só roda depois de checar).
//!
//! Efeito colateral, de propósito: junto do tipo, acumula duas coisas que
//! `Compiled` (arquitetura §4/§9) precisa e só esta passagem pode calcular
//! sem repetir trabalho —
//! - `depends_on`: todo `PropertyId` que algum `prop()` referenciou, para a
//!   cascata (I4) e a detecção de ciclo entre propriedades (que roda POR
//!   CIMA de `depends_on` de todas as fórmulas da database, fora deste
//!   arquivo — aqui só existe UMA expressão).
//! - `prop_name_spans`: o span de CADA `prop("Nome")`, para o rename por
//!   substring (arquitetura §4) — nunca por regex.
//!
//! Para na PRIMEIRA falha de tipo (não junta uma lista de erros): nenhum
//! item do checklist pede mais de um sublinhado por vez, e continuar a
//! checar depois de um tipo já errado só produziria erros em cascata sem
//! relação com o que o usuário de fato digitou errado.

use crate::formula::core::ast::{BinaryOp, Expr, ExprKind, UnaryOp};
use crate::formula::core::diagnostics::{Diagnostic, Span};
use crate::formula::core::eval::ValueSource;
use crate::formula::core::functions::{self, ParamKind};
use crate::formula::core::types::{PropertyId, Type};

/// Uma ocorrência de `prop("Nome")` na fonte — `span` é o intervalo de
/// bytes do NOME em si (sem as aspas), o mesmo `content_span` que o lexer
/// mediu, pronto para `&src[..span.start] + novo_nome + &src[span.end..]`
/// reescrever no lugar certo quando a propriedade é renomeada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropNameSpan {
    pub property_id: PropertyId,
    pub span: Span,
}

/// Checa `expr` contra `schema` do zero — usado só por `compile.rs`; não é
/// pensado para checar sub-árvores soltas (o ambiente léxico sempre começa
/// vazio, então um `current` só é válido dentro do corpo de uma função de
/// ordem superior, nunca na raiz).
pub fn check_program(expr: &Expr, schema: &dyn ValueSource) -> Result<(Type, Vec<PropertyId>, Vec<PropNameSpan>), Diagnostic> {
    let mut checker = Checker { schema, env: Vec::new(), depends_on: Vec::new(), prop_name_spans: Vec::new() };
    let return_type = checker.check(expr)?;
    Ok((return_type, checker.depends_on, checker.prop_name_spans))
}

struct Checker<'a> {
    schema: &'a dyn ValueSource,
    /// Pilha de (nome, tipo) — hoje só `current` empilha aqui, mas é uma
    /// pilha genérica (não um `Option<(&str, Type)>` só para `current`)
    /// porque `map` dentro de `filter` dentro de `map` empilha três vezes o
    /// MESMO nome, e o de dentro tem que sombrear os de fora sem apagá-los.
    env: Vec<(String, Type)>,
    depends_on: Vec<PropertyId>,
    prop_name_spans: Vec<PropNameSpan>,
}

impl Checker<'_> {
    fn push(&mut self, name: &str, ty: Type) {
        self.env.push((name.to_string(), ty));
    }

    fn pop(&mut self) {
        self.env.pop();
    }

    fn lookup(&self, name: &str) -> Option<Type> {
        self.env.iter().rev().find(|(n, _)| n == name).map(|(_, t)| t.clone())
    }

    fn check(&mut self, expr: &Expr) -> Result<Type, Diagnostic> {
        match &expr.kind {
            ExprKind::NumberLit(_) => Ok(Type::Number),
            ExprKind::StringLit(_) => Ok(Type::String),
            ExprKind::BoolLit(_) => Ok(Type::Boolean),
            ExprKind::Ident(name) => self
                .lookup(name)
                .ok_or_else(|| Diagnostic::error(format!("identificador desconhecido: \"{name}\""), expr.span)),
            ExprKind::PropRef { receiver, name, name_span } => {
                self.check_prop_ref(receiver.as_deref(), name, *name_span)
            }
            ExprKind::Unary { op, expr: inner } => self.check_unary(*op, inner, expr.span),
            ExprKind::Binary { op, left, right } => self.check_binary(*op, left, right, expr.span),
            ExprKind::Ternary { cond, then_branch, else_branch } => {
                self.check_ternary(cond, then_branch, else_branch, expr.span)
            }
            ExprKind::Call { name, name_span, args } => self.check_call(name, *name_span, args, expr.span),
        }
    }

    fn check_prop_ref(&mut self, receiver: Option<&Expr>, name: &str, name_span: Span) -> Result<Type, Diagnostic> {
        if let Some(receiver_expr) = receiver {
            let receiver_type = self.check(receiver_expr)?;
            if receiver_type != Type::Page {
                return Err(Diagnostic::error(
                    format!("prop() encadeado por ponto exige uma página do lado esquerdo; recebeu {receiver_type}"),
                    receiver_expr.span,
                ));
            }
        }

        let Some((property_id, property_type)) = self.schema.property_by_name(name) else {
            return Err(Diagnostic::error(format!("propriedade não encontrada: \"{name}\""), name_span));
        };

        if !self.depends_on.contains(&property_id) {
            self.depends_on.push(property_id);
        }
        self.prop_name_spans.push(PropNameSpan { property_id, span: name_span });

        Ok(property_type)
    }

    fn check_unary(&mut self, op: UnaryOp, inner: &Expr, span: Span) -> Result<Type, Diagnostic> {
        let inner_type = self.check(inner)?;
        match (op, &inner_type) {
            (UnaryOp::Neg, Type::Number) => Ok(Type::Number),
            (UnaryOp::Not, Type::Boolean) => Ok(Type::Boolean),
            (UnaryOp::Neg, other) => {
                Err(Diagnostic::error(format!("operador unário \"-\" espera número; recebeu {other}"), span))
            }
            (UnaryOp::Not, other) => {
                Err(Diagnostic::error(format!("operador unário \"!\" espera booleano; recebeu {other}"), span))
            }
        }
    }

    fn check_binary(&mut self, op: BinaryOp, left: &Expr, right: &Expr, span: Span) -> Result<Type, Diagnostic> {
        let left_type = self.check(left)?;
        let right_type = self.check(right)?;

        match op {
            BinaryOp::Add => match (&left_type, &right_type) {
                (Type::Number, Type::Number) => Ok(Type::Number),
                (Type::String, Type::String) => Ok(Type::String),
                _ => Err(Diagnostic::error(
                    format!("operador \"+\" espera (número, número) ou (texto, texto); recebeu ({left_type}, {right_type})"),
                    span,
                )),
            },
            BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
                if left_type == Type::Number && right_type == Type::Number {
                    Ok(Type::Number)
                } else {
                    Err(Diagnostic::error(
                        format!("operador aritmético espera (número, número); recebeu ({left_type}, {right_type})"),
                        span,
                    ))
                }
            }
            BinaryOp::Eq | BinaryOp::NotEq => {
                if left_type == right_type {
                    Ok(Type::Boolean)
                } else {
                    Err(Diagnostic::error(
                        format!("\"==\"/\"!=\" exigem os dois lados do mesmo tipo; recebeu {left_type} e {right_type}"),
                        span,
                    ))
                }
            }
            BinaryOp::Gt | BinaryOp::GtEq | BinaryOp::Lt | BinaryOp::LtEq => {
                let comparable = matches!(left_type, Type::Number | Type::String | Type::Date);
                if left_type == right_type && comparable {
                    Ok(Type::Boolean)
                } else {
                    Err(Diagnostic::error(
                        format!(
                            "operador relacional exige número, texto ou data dos dois lados, do mesmo tipo; recebeu {left_type} e {right_type}"
                        ),
                        span,
                    ))
                }
            }
            BinaryOp::And | BinaryOp::Or => {
                if left_type == Type::Boolean && right_type == Type::Boolean {
                    Ok(Type::Boolean)
                } else {
                    Err(Diagnostic::error(
                        format!("\"&&\"/\"||\" exigem booleano dos dois lados; recebeu {left_type} e {right_type}"),
                        span,
                    ))
                }
            }
        }
    }

    fn check_ternary(&mut self, cond: &Expr, then_branch: &Expr, else_branch: &Expr, span: Span) -> Result<Type, Diagnostic> {
        let cond_type = self.check(cond)?;
        if cond_type != Type::Boolean {
            return Err(Diagnostic::error(format!("condição do \"?:\" espera booleano; recebeu {cond_type}"), cond.span));
        }
        let then_type = self.check(then_branch)?;
        let else_type = self.check(else_branch)?;
        if then_type != else_type {
            return Err(Diagnostic::error(
                format!("os dois ramos do \"?:\" precisam do mesmo tipo; recebeu {then_type} e {else_type}"),
                span,
            ));
        }
        Ok(then_type)
    }

    fn check_call(&mut self, name: &str, name_span: Span, args: &[Expr], span: Span) -> Result<Type, Diagnostic> {
        let Some(def) = functions::lookup(name) else {
            return Err(Diagnostic::error(format!("função desconhecida: \"{name}\""), name_span));
        };

        if !def.arity.accepts(args.len()) {
            return Err(Diagnostic::error(
                format!("\"{name}\" espera {}; recebeu {}", def.arity.describe(), args.len()),
                span,
            ));
        }

        let mut checked: Vec<Type> = Vec::with_capacity(args.len());
        for (index, arg) in args.iter().enumerate() {
            match (def.params)(index) {
                ParamKind::Value => {
                    checked.push(self.check(arg)?);
                }
                ParamKind::Lambda { binds, bind_type } => {
                    // `bind_type` só vê os tipos JÁ checados (o prefixo
                    // antes deste argumento) — é assim que `map(lista,
                    // corpo)` liga `current` ao elemento do PRIMEIRO
                    // argumento sem precisar olhar o corpo primeiro.
                    let bound = bind_type(&checked);
                    self.push(binds, bound);
                    // `pop` roda SEMPRE, mesmo em erro (`result` só é
                    // propagado DEPOIS) — senão um corpo de lambda mal
                    // tipado deixaria `current` vazando para o resto da
                    // checagem desta chamada.
                    let result = self.check(arg);
                    self.pop();
                    checked.push(result?);
                }
            }
        }

        (def.check)(&checked).map_err(|message| Diagnostic::error(message, span))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::parser::parse;
    use crate::formula::core::types::PageMeta;
    use uuid::Uuid;

    /// Um schema falso mínimo: só as duas propriedades que os testes deste
    /// arquivo precisam, sem tocar em Postgres — `check_program` não faz
    /// I/O, então nenhum teste dele deveria precisar de um banco.
    struct FakeSchema;
    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, _property: PropertyId) -> crate::formula::core::types::Value {
            crate::formula::core::types::Value::Empty
        }
        fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
            Vec::new()
        }
        fn page_meta(&self, record: Uuid) -> PageMeta {
            PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
        }
        fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
            match name {
                "Preço" => Some((Uuid::nil(), Type::Number)),
                "Título" => Some((Uuid::from_u128(1), Type::String)),
                _ => None,
            }
        }
    }

    fn check(src: &str) -> Result<Type, Diagnostic> {
        let expr = parse(src).unwrap();
        check_program(&expr, &FakeSchema).map(|(ty, ..)| ty)
    }

    #[test]
    fn number_literal_checks_as_number() {
        assert_eq!(check("42").unwrap(), Type::Number);
    }

    #[test]
    fn prop_ref_resolves_to_the_property_type() {
        assert_eq!(check("prop(\"Preço\")").unwrap(), Type::Number);
    }

    #[test]
    fn unknown_property_is_a_diagnostic_at_the_name_span() {
        let expr = parse("prop(\"Não existe\")").unwrap();
        let err = check_program(&expr, &FakeSchema).unwrap_err();
        assert!(err.message.contains("Não existe"));
    }

    /// DBS-085, o exemplo exato do checklist: `prop("Texto")+prop("Número")`
    /// sem `toNumber()` tem que ser erro de tipo, não um resultado
    /// silenciosamente errado.
    #[test]
    fn adding_string_and_number_is_a_static_type_error() {
        let err = check("prop(\"Título\") + prop(\"Preço\")").unwrap_err();
        assert!(err.message.contains("+"));
    }

    #[test]
    fn ternary_branches_must_share_a_type() {
        let err = check("true ? 1 : \"a\"").unwrap_err();
        assert!(err.message.contains("?:"));
    }

    #[test]
    fn depends_on_collects_every_referenced_property_once() {
        let expr = parse("prop(\"Preço\") + prop(\"Preço\")").unwrap();
        let (_, depends_on, _) = check_program(&expr, &FakeSchema).unwrap();
        assert_eq!(depends_on.len(), 1);
    }

    #[test]
    fn prop_name_spans_collects_every_occurrence_even_repeated() {
        let expr = parse("prop(\"Preço\") + prop(\"Preço\")").unwrap();
        let (_, _, spans) = check_program(&expr, &FakeSchema).unwrap();
        assert_eq!(spans.len(), 2);
    }
}
