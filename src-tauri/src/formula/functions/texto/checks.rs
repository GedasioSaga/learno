//! Um `check` por função de `texto/mod.rs`, cada um citando o NOME da
//! função na mensagem de diagnóstico (DBS-085) — mesmo motivo do
//! `functions::matematica::checks`: `FunctionDef::check` é `fn` puro sem
//! captura, não dá para parametrizar por nome numa função compartilhada.

use crate::formula::core::Type;

pub(super) fn check_length(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String] => Ok(Type::Number),
        [a] => Err(format!("\"length\" espera (texto); recebeu ({a})")),
        other => Err(format!("\"length\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_substring(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String, Type::Number] => Ok(Type::String),
        [Type::String, Type::Number, Type::Number] => Ok(Type::String),
        other => Err(format!(
            "\"substring\" espera (texto, número) ou (texto, número, número); recebeu {} argumento(s)",
            other.len()
        )),
    }
}

pub(super) fn check_contains(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String, Type::String] => Ok(Type::Boolean),
        [a, b] => Err(format!("\"contains\" espera (texto, texto); recebeu ({a}, {b})")),
        other => Err(format!("\"contains\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_lower(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String] => Ok(Type::String),
        [a] => Err(format!("\"lower\" espera (texto); recebeu ({a})")),
        other => Err(format!("\"lower\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_upper(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String] => Ok(Type::String),
        [a] => Err(format!("\"upper\" espera (texto); recebeu ({a})")),
        other => Err(format!("\"upper\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_repeat(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String, Type::Number] => Ok(Type::String),
        [a, b] => Err(format!("\"repeat\" espera (texto, número); recebeu ({a}, {b})")),
        other => Err(format!("\"repeat\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_trim(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String] => Ok(Type::String),
        [a] => Err(format!("\"trim\" espera (texto); recebeu ({a})")),
        other => Err(format!("\"trim\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

/// `join(separador, ...textos)` — o `Arity::AtLeast(1)` do registro já
/// garante `types.len() >= 1` antes deste `check` rodar.
pub(super) fn check_join(types: &[Type]) -> Result<Type, String> {
    match types.split_first() {
        Some((Type::String, rest)) if rest.iter().all(|t| *t == Type::String) => Ok(Type::String),
        Some((first, _)) => Err(format!("\"join\" espera texto em todos os argumentos; o primeiro recebeu {first}")),
        None => Err("\"join\" espera pelo menos 1 argumento".to_string()),
    }
}

pub(super) fn check_split(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String, Type::String] => Ok(Type::List(Box::new(Type::String))),
        [a, b] => Err(format!("\"split\" espera (texto, texto); recebeu ({a}, {b})")),
        other => Err(format!("\"split\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}
