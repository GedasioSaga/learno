//! Ajudas para montar SQL que o SQLite aceita onde o Postgres aceitava
//! `= ANY($1)`.
//!
//! O Postgres liga uma lista inteira a um parâmetro só, porque tem tipo
//! array. O SQLite não tem array: uma lista vira `IN (?, ?, ?)` com um
//! placeholder por elemento, montados em tempo de execução e ligados um a um.
//!
//! Isso é a fonte de 8 dos 27 erros de compilação da migração de banco, e
//! existe aqui em vez de em cada arquivo por dois motivos. O primeiro é o
//! óbvio: oito soluções levemente diferentes para o mesmo problema envelhecem
//! mal. O segundo é o que importa de verdade — a lista de placeholders é
//! construída por concatenação de string, que é exatamente a forma de abrir
//! uma injeção de SQL. Aqui a concatenação produz SÓ `?` e vírgula, nunca um
//! valor; os valores vão por `bind`, sempre. Um lugar só para revisar.

/// Teto de parâmetros que este módulo aceita numa consulta.
///
/// O limite real do SQLite (`SQLITE_MAX_VARIABLE_NUMBER`) é 32766 nas versões
/// modernas e 999 nas antigas, e depende de como o binário foi compilado — o
/// `libsqlite3-sys` empacotado pode mudar entre versões sem aviso. 900 fica
/// abaixo do pior caso conhecido com folga, e o custo de fatiar em pedaços
/// menores é uma consulta a mais, não um erro em produção na máquina de
/// alguém.
///
/// Quem tem lista possivelmente maior que isto — apagar a subárvore de um
/// bloco, aplicar um lote do editor — fatia com `slice::chunks` e roda uma
/// consulta por pedaço, dentro da mesma transação.
pub const MAX_BIND_PARAMS: usize = 900;

/// A lista de placeholders para um `IN`: `"?, ?, ?"` para `n = 3`.
///
/// Devolve `NULL` para `n = 0`, e não string vazia: `IN ()` é erro de sintaxe
/// no SQLite, enquanto `IN (NULL)` é sintaticamente válido e não casa nada —
/// que é a semântica certa para "nenhum id". Isso evita que todo chamador
/// precise lembrar de tratar a lista vazia antes de montar a consulta, e o
/// esquecimento seria um erro de SQL em tempo de execução, não de compilação.
pub fn in_placeholders(n: usize) -> String {
    if n == 0 {
        return "NULL".to_string();
    }
    let mut out = String::with_capacity(n * 3);
    for i in 0..n {
        if i > 0 {
            out.push_str(", ");
        }
        out.push('?');
    }
    out
}

#[cfg(test)]
mod tests {
    // A regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn lista_vazia_vira_null_e_nao_parenteses_vazios() {
        // `IN ()` é erro de sintaxe no SQLite; `IN (NULL)` não casa nada, que
        // é o que "nenhum id" significa.
        assert_eq!(in_placeholders(0), "NULL");
    }

    #[test]
    fn um_placeholder_por_elemento() {
        assert_eq!(in_placeholders(1), "?");
        assert_eq!(in_placeholders(3), "?, ?, ?");
    }

    #[test]
    fn nunca_produz_nada_alem_de_placeholder_e_virgula() {
        // A garantia de segurança deste módulo, escrita como teste: o texto
        // gerado não pode conter nada que venha de fora. Se alguém um dia
        // acrescentar interpolação de valor aqui, este teste cai.
        let gerado = in_placeholders(50);
        assert!(gerado.chars().all(|c| c == '?' || c == ',' || c == ' '));
    }
}
