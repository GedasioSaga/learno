//! Tokeniza o texto da fórmula. Trabalha em BYTES UTF-8 do início ao fim —
//! um caractere acentuado ("Preço", "Número") ocupa mais de um byte, e é
//! exatamente essa diferença entre bytes e unidades UTF-16 que
//! `ipc::formula_commands` converte na fronteira (arquitetura §4). Fazer
//! essa conversão aqui seria o lugar errado: o núcleo nunca fala com o
//! cliente diretamente, então nunca deveria saber o que é UTF-16.

use crate::formula::core::diagnostics::{Diagnostic, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum TokenKind {
    Number(f64),
    /// `value` já com escapes decodidos (`\"`, `\\`, `\n`, `\t`).
    /// `content_span` é o intervalo de bytes ENTRE as aspas na fonte
    /// ORIGINAL (sem decodificar) — o que `ast::ExprKind::PropRef` precisa
    /// para o rename por substring reescrever exatamente o texto que estava
    /// lá, mesmo que o nome nunca tenha escape de verdade (o caso comum:
    /// nome de propriedade não costuma carregar `"` ou `\`).
    String { value: String, content_span: Span },
    Ident(String),
    True,
    False,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    EqEq,
    NotEq,
    Gt,
    GtEq,
    Lt,
    LtEq,
    AndAnd,
    OrOr,
    Bang,
    Question,
    Colon,
    Comma,
    Dot,
    LParen,
    RParen,
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

/// Tokeniza `src` inteiro de uma vez — expressão de fórmula é curta (uma
/// linha, tipicamente < 200 caracteres), então não há razão para um lexer
/// preguiçoso/streaming aqui. Erro é o PRIMEIRO caractere/token inválido
/// encontrado: suficiente para o editor sublinhar o ponto onde a digitação
/// quebrou, e evita a complexidade de "erro de léxico com recuperação" que
/// nenhum item do checklist pede.
pub fn lex(src: &str) -> Result<Vec<Token>, Diagnostic> {
    let bytes = src.as_bytes();
    let mut tokens = Vec::new();
    let mut pos = 0usize;

    while pos < bytes.len() {
        let c = bytes[pos];

        if c.is_ascii_whitespace() {
            pos += 1;
            continue;
        }

        if c == b'"' {
            let (token, next) = lex_string(src, pos)?;
            tokens.push(token);
            pos = next;
            continue;
        }

        if c.is_ascii_digit() {
            let (token, next) = lex_number(src, pos);
            tokens.push(token);
            pos = next;
            continue;
        }

        if c.is_ascii_alphabetic() || c == b'_' {
            let (token, next) = lex_ident(src, pos);
            tokens.push(token);
            pos = next;
            continue;
        }

        let (kind, len) = match (c, bytes.get(pos + 1)) {
            (b'=', Some(b'=')) => (TokenKind::EqEq, 2),
            (b'!', Some(b'=')) => (TokenKind::NotEq, 2),
            (b'>', Some(b'=')) => (TokenKind::GtEq, 2),
            (b'<', Some(b'=')) => (TokenKind::LtEq, 2),
            (b'&', Some(b'&')) => (TokenKind::AndAnd, 2),
            (b'|', Some(b'|')) => (TokenKind::OrOr, 2),
            (b'+', _) => (TokenKind::Plus, 1),
            (b'-', _) => (TokenKind::Minus, 1),
            (b'*', _) => (TokenKind::Star, 1),
            (b'/', _) => (TokenKind::Slash, 1),
            (b'%', _) => (TokenKind::Percent, 1),
            (b'>', _) => (TokenKind::Gt, 1),
            (b'<', _) => (TokenKind::Lt, 1),
            (b'!', _) => (TokenKind::Bang, 1),
            (b'?', _) => (TokenKind::Question, 1),
            (b':', _) => (TokenKind::Colon, 1),
            (b',', _) => (TokenKind::Comma, 1),
            (b'.', _) => (TokenKind::Dot, 1),
            (b'(', _) => (TokenKind::LParen, 1),
            (b')', _) => (TokenKind::RParen, 1),
            _ => {
                // `c` pode ser o primeiro byte de um caractere multi-byte
                // (acento, emoji); apontar o span só neste byte ainda dá uma
                // posição útil (o editor sublinha a partir daí), sem
                // arriscar decodificar um caractere inválido isolado.
                return Err(Diagnostic::error(
                    format!("caractere inesperado: \"{}\"", src[pos..].chars().next().unwrap_or('\u{FFFD}')),
                    Span::new(pos, pos + 1),
                ));
            }
        };
        tokens.push(Token { kind, span: Span::new(pos, pos + len) });
        pos += len;
    }

    tokens.push(Token { kind: TokenKind::Eof, span: Span::new(bytes.len(), bytes.len()) });
    Ok(tokens)
}

fn lex_number(src: &str, start: usize) -> (Token, usize) {
    let bytes = src.as_bytes();
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    // A fatia é só dígitos ASCII e no máximo um '.', então `parse` nunca
    // falha aqui — mas devolver 0.0 em vez de `unwrap()` custa zero e mantém
    // esta função total mesmo se a extração de dígitos acima um dia mudar.
    let value: f64 = src[start..end].parse().unwrap_or(0.0);
    (Token { kind: TokenKind::Number(value), span: Span::new(start, end) }, end)
}

fn lex_ident(src: &str, start: usize) -> (Token, usize) {
    let bytes = src.as_bytes();
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    let text = &src[start..end];
    let kind = match text {
        "true" => TokenKind::True,
        "false" => TokenKind::False,
        _ => TokenKind::Ident(text.to_string()),
    };
    (Token { kind, span: Span::new(start, end) }, end)
}

/// `start` aponta para a aspa de abertura. Decodifica `\"`, `\\`, `\n`, `\t`;
/// qualquer outro `\x` é mantido literal (`x`) em vez de erro — string de
/// fórmula não é o lugar para uma gramática de escape rica, e um usuário
/// que digitou `\d` por engano merece o caractere `d`, não um erro de
/// sintaxe obscuro no meio de uma expressão que por outro lado está certa.
fn lex_string(src: &str, start: usize) -> Result<(Token, usize), Diagnostic> {
    let bytes = src.as_bytes();
    let mut pos = start + 1; // depois da aspa de abertura
    let content_start = pos;
    let mut value = String::new();

    loop {
        match bytes.get(pos) {
            None => {
                return Err(Diagnostic::error("string sem aspa de fechamento", Span::new(start, pos)));
            }
            Some(b'"') => {
                let content_span = Span::new(content_start, pos);
                let end = pos + 1;
                return Ok((Token { kind: TokenKind::String { value, content_span }, span: Span::new(start, end) }, end));
            }
            Some(b'\\') => {
                match bytes.get(pos + 1) {
                    Some(b'"') => {
                        value.push('"');
                        pos += 2;
                    }
                    Some(b'\\') => {
                        value.push('\\');
                        pos += 2;
                    }
                    Some(b'n') => {
                        value.push('\n');
                        pos += 2;
                    }
                    Some(b't') => {
                        value.push('\t');
                        pos += 2;
                    }
                    Some(&other) if other.is_ascii() => {
                        value.push(other as char);
                        pos += 2;
                    }
                    _ => {
                        return Err(Diagnostic::error("escape inválido no fim da string", Span::new(pos, pos + 1)));
                    }
                }
            }
            Some(_) => {
                // Passo de um CARACTERE (não de um byte): um `\`/`"` nunca
                // aparece como byte de continuação UTF-8 (ambos são ASCII,
                // < 0x80), então isto nunca pula por cima de uma aspa real
                // escondida no meio de um caractere multi-byte.
                let ch = src[pos..].chars().next().unwrap_or('\u{FFFD}');
                value.push(ch);
                pos += ch.len_utf8();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn lexes_number_and_operators() {
        let tokens = lex("1 + 2.5 * 3").unwrap();
        let kinds: Vec<&TokenKind> = tokens.iter().map(|t| &t.kind).collect();
        assert_eq!(
            kinds,
            vec![
                &TokenKind::Number(1.0),
                &TokenKind::Plus,
                &TokenKind::Number(2.5),
                &TokenKind::Star,
                &TokenKind::Number(3.0),
                &TokenKind::Eof,
            ]
        );
    }

    #[test]
    fn two_char_operators_take_priority_over_one_char() {
        // Um `=` solto não é token válido nesta linguagem (não há
        // atribuição) — o teste usa só pares de dois caracteres válidos,
        // senão o próprio `lex` recusaria a fonte antes de chegar ao que
        // este teste quer provar (qual dos dois `match` vence).
        let tokens = lex(">= > == !=").unwrap();
        let kinds: Vec<&TokenKind> = tokens.iter().map(|t| &t.kind).collect();
        assert_eq!(kinds[0], &TokenKind::GtEq);
        assert_eq!(kinds[1], &TokenKind::Gt);
        assert_eq!(kinds[2], &TokenKind::EqEq);
        assert_eq!(kinds[3], &TokenKind::NotEq);
    }

    #[test]
    fn string_content_span_excludes_quotes() {
        let tokens = lex("\"Preço\"").unwrap();
        match &tokens[0].kind {
            TokenKind::String { value, content_span } => {
                assert_eq!(value, "Preço");
                // "Preço" abre aspas no byte 0; o conteúdo começa no byte 1.
                // "ç" ocupa 2 bytes em UTF-8, então o fim do conteúdo NÃO é
                // 1 + 5 (contagem de caracteres) — é 1 + 6 (contagem de
                // bytes). Se este teste um dia passar com `1 + 6` trocado
                // por `1 + 5`, o bug é exatamente o que a arquitetura avisa:
                // confundir unidade de caractere com unidade de byte.
                assert_eq!(*content_span, Span::new(1, 7));
            }
            other => panic!("esperava String, veio {other:?}"),
        }
    }

    #[test]
    fn unterminated_string_reports_error() {
        let err = lex("\"sem fim").unwrap_err();
        assert!(err.message.contains("fechamento"));
    }

    #[test]
    fn unknown_character_reports_its_own_span() {
        let err = lex("1 @ 2").unwrap_err();
        assert_eq!(err.span, Span::new(2, 3));
    }
}
