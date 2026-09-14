//! Pacotes do Anki (`.apkg` e `.colpkg`).
//!
//! [`abrir_pacote`] acha a coleção dentro do zip e a deixa num arquivo SQLite
//! temporário; [`ler_colecao`] tira dali tipos de nota, baralhos, notas,
//! cartões e revisões em structs que ainda falam a língua do Anki. Só
//! [`importar`] grava, e grava tudo numa transação.

pub mod colecao;
pub mod html;
pub mod importar;
pub mod pacote;
mod proto;

pub use colecao::{
    ler_colecao, BaralhoAnki, CartaoAnki, ColecaoAnki, NotaAnki, RevisaoAnki, TemplateAnki, TipoDeNotaAnki,
};
pub use html::html_para_texto;
pub use importar::{gravar_colecao, importar_pacote, RelatorioDeImportacao};
pub use pacote::{abrir_pacote, PacoteAberto};
