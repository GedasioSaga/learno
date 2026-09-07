//! Onde F1..F6 registram as funções concretas da fórmula — matemática,
//! agregação de lista, texto, data, lógica/lista de ordem superior,
//! página/pessoa (arquitetura §4/§11) — cada categoria na sua própria pasta
//! sob `formula::functions::<categoria>`, chamando
//! `formula::core::register(FunctionDef { .. })` uma vez por função.
//!
//! **Esta peça (F0) não implementa nenhuma função concreta** — o pedido
//! explícito é provar o núcleo, não preencher a tabela. [`register_all`]
//! existe hoje só para dar a F1..F6 um lugar único a partir do qual chamar
//! o `register` de cada categoria (o padrão que `tauri::Builder::plugin`
//! já usa neste crate: um ponto central que soma efeitos de módulos
//! irmãos), e para dar a `ipc::formula_commands` uma função a chamar sem
//! precisar saber quantas categorias existem.
//!
//! Quando F1..F6 chegarem, cada uma acrescenta:
//! 1. Sua pasta (`formula/functions/matematica/`, `.../texto/`, ...) com
//!    `mod.rs` chamando `formula::core::register` para cada função da
//!    categoria — o mesmo padrão de `registerPropertySpec` do lado
//!    TypeScript (arquitetura §6), só que no Rust.
//! 2. Uma linha aqui: `mod matematica;` e `matematica::register_all();`
//!    dentro de [`register_all`].
//!
//! Nenhuma outra peça precisa tocar em `ipc::formula_commands` para isso —
//! aquele arquivo só chama [`register_all`] uma vez, sem saber o que foi
//! registrado.
//!
//! **Esta rodada acrescenta duas categorias**: `matematica` (DBS-062),
//! `agregacao` (DBS-063) e `texto` (DBS-066) já existiam; `data`
//! (DBS-070/071/073/074) e `logica` (DBS-075/076/077) são novas — ver o
//! `mod.rs` de cada uma para as funções e as decisões de borda. `lógica`
//! cobre só condicional/booleano/igualdade — a parte de LISTA de ordem
//! superior (`map`/`filter`/`some`/`every`, F5) e `pagina` ficam para
//! rodadas seguintes.

mod agregacao;
mod data;
mod logica;
mod matematica;
mod texto;

use std::sync::Once;

/// Idempotente por processo: `ipc::formula_commands` chama isto no início
/// de CADA comando (não há um "hook de inicialização do app" que todo
/// comando Tauri atravesse garantidamente antes de rodar), então precisa
/// ser seguro chamar mais de uma vez sem duplicar registro — daí o `Once`
/// em vez de, por exemplo, um `bool` estático simples (que teria uma
/// janela de corrida entre checar e marcar, em duas chamadas concorrentes
/// do primeiro comando disparado pelo cliente).
pub fn register_all() {
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        matematica::register_all();
        agregacao::register_all();
        texto::register_all();
        data::register_all();
        logica::register_all();
        // Categorias seguintes, ex.:
        //   logica_lista::register_all();
        //   pagina::register_all();
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::register_all;

    /// Não afirma nada sobre QUANTAS funções existem (zero é o valor certo
    /// hoje, e mudaria a cada categoria que F1..F6 acrescentar) — só que
    /// chamar duas vezes não trava nem duplica silenciosamente um `Vec`
    /// que uma implementação ingênua de "registra tudo" poderia crescer a
    /// cada chamada.
    #[test]
    fn register_all_is_safe_to_call_more_than_once() {
        register_all();
        register_all();
    }
}
