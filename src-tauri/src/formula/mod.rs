//! A linguagem de fórmula da Fase 3 (arquitetura §4) — motor ÚNICO, em Rust,
//! puro. `core` é o núcleo (léxico, sintaxe, tipos, avaliador, tabela de
//! funções); `functions` é onde F1..F6 registram as funções concretas
//! (matemática, texto, data, lógica, lista, página) na tabela que `core`
//! expõe como ponto de extensão.
//!
//! Nada aqui faz I/O. Quem lê/escreve `database_record_values` ou
//! `database_properties` é o adaptador de `ValueSource` que a fronteira IPC
//! (`ipc::formula_commands`) monta em cima de `state.pool()`.

pub mod core;
pub mod functions;
