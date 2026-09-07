//! Um `check` por função de `matematica/mod.rs`, cada um com a mensagem de
//! diagnóstico (DBS-085) já citando o NOME da função — motivo de existirem
//! 12 funções pequenas em vez de 2-3 genéricas: `FunctionDef::check` é um
//! `fn` puro sem captura (contrato de `core/functions.rs`), então não dá
//! para "injetar" o nome numa função de checagem compartilhada.

use crate::formula::core::Type;

pub(super) fn check_add(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"add\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"add\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_subtract(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"subtract\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"subtract\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_multiply(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"multiply\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"multiply\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_divide(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"divide\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"divide\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_modulo(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"mod\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"mod\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_pow(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a, b] => Err(format!("\"pow\" espera (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"pow\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_abs(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"abs\" espera (número); recebeu ({a})")),
        other => Err(format!("\"abs\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_ceil(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"ceil\" espera (número); recebeu ({a})")),
        other => Err(format!("\"ceil\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_floor(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"floor\" espera (número); recebeu ({a})")),
        other => Err(format!("\"floor\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_sqrt(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"sqrt\" espera (número); recebeu ({a})")),
        other => Err(format!("\"sqrt\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_cbrt(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"cbrt\" espera (número); recebeu ({a})")),
        other => Err(format!("\"cbrt\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

/// `round` aceita 1 ou 2 argumentos — o segundo (casas decimais) é opcional.
pub(super) fn check_round(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Number] => Ok(Type::Number),
        [Type::Number, Type::Number] => Ok(Type::Number),
        [a] => Err(format!("\"round\" espera (número) ou (número, número); recebeu ({a})")),
        [a, b] => Err(format!("\"round\" espera (número) ou (número, número); recebeu ({a}, {b})")),
        other => Err(format!("\"round\" espera 1 ou 2 argumentos; recebeu {}", other.len())),
    }
}
