//! Um `check` por função de `logica/mod.rs` — mesmo padrão das outras
//! categorias: `FunctionDef::check` é `fn` puro sem captura, então cada
//! função embute seu próprio nome na mensagem de diagnóstico (DBS-085).

use crate::formula::core::Type;

fn describe_types(types: &[Type]) -> String {
    types.iter().map(Type::to_string).collect::<Vec<_>>().join(", ")
}

/// `if(cond, então, senão)`: cond booleana, os dois ramos do MESMO tipo —
/// a mesma regra que `?:` (ternário) já exige em `typecheck.rs`, porque
/// DBS-075 descreve o ternário como "atalho para if": os dois têm que
/// concordar.
pub(super) fn check_if(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Boolean, then_ty, else_ty] if then_ty == else_ty => Ok(then_ty.clone()),
        [Type::Boolean, then_ty, else_ty] => {
            Err(format!("\"if\" espera os dois ramos do mesmo tipo; recebeu ({then_ty}, {else_ty})"))
        }
        [cond_ty, _, _] => Err(format!("\"if\" espera booleano na condição; recebeu {cond_ty}")),
        other => Err(format!("\"if\" espera exatamente 3 argumentos; recebeu {}", other.len())),
    }
}

/// `ifs(cond1, resultado1, cond2, resultado2, ..., condN, resultadoN)`:
/// número PAR de argumentos (pares condição/resultado — o "senão" é só a
/// última condição escrita como `true`, DBS-075), condição em índice par
/// sempre booleana, resultado em índice ímpar todos do MESMO tipo entre si.
pub(super) fn check_ifs(types: &[Type]) -> Result<Type, String> {
    if !types.len().is_multiple_of(2) {
        return Err(format!(
            "\"ifs\" espera um número par de argumentos (pares condição/resultado); recebeu {}",
            types.len()
        ));
    }
    let mut result_type: Option<&Type> = None;
    for (index, ty) in types.iter().enumerate() {
        if index.is_multiple_of(2) {
            if *ty != Type::Boolean {
                return Err(format!("\"ifs\" espera booleano na condição de índice {index}; recebeu {ty}"));
            }
        } else {
            match result_type {
                None => result_type = Some(ty),
                Some(expected) if expected == ty => {}
                Some(expected) => {
                    return Err(format!(
                        "\"ifs\" espera que todos os resultados tenham o mesmo tipo; recebeu {expected} e {ty}"
                    ));
                }
            }
        }
    }
    result_type.cloned().ok_or_else(|| "\"ifs\" espera pelo menos um par condição/resultado".to_string())
}

/// `and`/`or`: variádicas, todo argumento booleano.
pub(super) fn check_and(types: &[Type]) -> Result<Type, String> {
    if types.iter().all(|t| *t == Type::Boolean) {
        Ok(Type::Boolean)
    } else {
        Err(format!("\"and\" espera todos os argumentos booleanos; recebeu ({})", describe_types(types)))
    }
}

pub(super) fn check_or(types: &[Type]) -> Result<Type, String> {
    if types.iter().all(|t| *t == Type::Boolean) {
        Ok(Type::Boolean)
    } else {
        Err(format!("\"or\" espera todos os argumentos booleanos; recebeu ({})", describe_types(types)))
    }
}

pub(super) fn check_not(types: &[Type]) -> Result<Type, String> {
    match types {
        [Type::Boolean] => Ok(Type::Boolean),
        [a] => Err(format!("\"not\" espera (booleano); recebeu ({a})")),
        other => Err(format!("\"not\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

/// `empty(x)`: aceita QUALQUER tipo — vazio habita todo tipo (arquitetura
/// §4), então não há tipo que `empty()` deveria recusar.
pub(super) fn check_empty(types: &[Type]) -> Result<Type, String> {
    match types {
        [_] => Ok(Type::Boolean),
        other => Err(format!("\"empty\" espera exatamente 1 argumento; recebeu {}", other.len())),
    }
}

fn check_same_type_pair(name: &str, types: &[Type]) -> Result<Type, String> {
    match types {
        [a, b] if a == b => Ok(Type::Boolean),
        [a, b] => Err(format!("\"{name}\" exige os dois lados do mesmo tipo; recebeu {a} e {b}")),
        other => Err(format!("\"{name}\" espera exatamente 2 argumentos; recebeu {}", other.len())),
    }
}

pub(super) fn check_equal(types: &[Type]) -> Result<Type, String> {
    check_same_type_pair("equal", types)
}

pub(super) fn check_unequal(types: &[Type]) -> Result<Type, String> {
    check_same_type_pair("unequal", types)
}
