//! Um `check` por função de `data/mod.rs` — mesmo padrão de
//! `functions::matematica::checks`: `FunctionDef::check` é `fn` puro sem
//! captura, então o nome da função precisa estar embutido em cada mensagem,
//! não injetado de fora.

use crate::formula::core::Type;

pub(super) fn check_now(types: &[Type]) -> Result<Type, String> {
    match types {
        [] => Ok(Type::Date),
        other => Err(format!("\"now\" não espera argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_today(types: &[Type]) -> Result<Type, String> {
    match types {
        [] => Ok(Type::Date),
        other => Err(format!("\"today\" não espera argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_date_add(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Date, Type::Number, Type::String] => Ok(Type::Date),
        [a, b, c] => Err(format!("\"dateAdd\" espera (data, número, texto); recebeu ({a}, {b}, {c})")),
        other => Err(format!("\"dateAdd\" espera exatamente 3 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_date_subtract(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Date, Type::Number, Type::String] => Ok(Type::Date),
        [a, b, c] => Err(format!("\"dateSubtract\" espera (data, número, texto); recebeu ({a}, {b}, {c})")),
        other => Err(format!("\"dateSubtract\" espera exatamente 3 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_date_between(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Date, Type::Date, Type::String] => Ok(Type::Number),
        [a, b, c] => Err(format!("\"dateBetween\" espera (data, data, texto); recebeu ({a}, {b}, {c})")),
        other => Err(format!("\"dateBetween\" espera exatamente 3 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_format_date(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Date, Type::String] => Ok(Type::String),
        [a, b] => Err(format!("\"formatDate\" espera (data, texto); recebeu ({a}, {b})")),
        other => Err(format!("\"formatDate\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_parse_date(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::String] => Ok(Type::Date),
        [a] => Err(format!("\"parseDate\" espera (texto); recebeu ({a})")),
        other => Err(format!("\"parseDate\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

/// Compartilhado pelas sete funções de extração de componente — todas têm
/// a MESMA forma (`data -> número`), só o nome na mensagem muda.
fn check_date_component(name: &str, types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Date] => Ok(Type::Number),
        [a] => Err(format!("\"{name}\" espera (data); recebeu ({a})")),
        other => Err(format!("\"{name}\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

pub(super) fn check_minute(types: &[Type]) -> Result<Type, String> {
    check_date_component("minute", types)
}

pub(super) fn check_hour(types: &[Type]) -> Result<Type, String> {
    check_date_component("hour", types)
}

pub(super) fn check_day(types: &[Type]) -> Result<Type, String> {
    check_date_component("day", types)
}

pub(super) fn check_date(types: &[Type]) -> Result<Type, String> {
    check_date_component("date", types)
}

pub(super) fn check_week(types: &[Type]) -> Result<Type, String> {
    check_date_component("week", types)
}

pub(super) fn check_month(types: &[Type]) -> Result<Type, String> {
    check_date_component("month", types)
}

pub(super) fn check_year(types: &[Type]) -> Result<Type, String> {
    check_date_component("year", types)
}
