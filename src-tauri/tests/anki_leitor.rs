#![allow(clippy::unwrap_used, clippy::expect_used)]

//! O leitor de pacotes do Anki (`learno_lib::anki`), contra pacotes
//! sintéticos nos dois formatos. Nada aqui grava no banco do Learno.

mod anki_fixture;

use anki_fixture::{Fixture, Pasta, CRIADA_EM};
use learno_lib::anki::{abrir_pacote, ler_colecao, ColecaoAnki};
use learno_lib::Error;

fn conferir_exemplo(colecao: &ColecaoAnki) {
    assert_eq!(colecao.criada_em, CRIADA_EM);

    assert_eq!(colecao.tipos_de_nota.len(), 3);
    let basico = &colecao.tipos_de_nota[0];
    assert_eq!((basico.id, basico.nome.as_str(), basico.cloze), (1, "Basic", false));
    assert_eq!(basico.campos, vec!["Front", "Back"]);
    let invertido = &colecao.tipos_de_nota[1];
    assert_eq!(invertido.templates.len(), 2);
    assert_eq!(invertido.templates[1].frente, "{{Back}}");
    assert_eq!(invertido.templates[1].verso, "{{FrontSide}}<hr id=answer>{{Front}}");
    let cloze = &colecao.tipos_de_nota[2];
    assert!(cloze.cloze);
    assert_eq!(cloze.campos, vec!["Text", "Back Extra"]);

    let baralho = |id| colecao.baralhos.iter().find(|b| b.id == id).unwrap();
    assert_eq!(baralho(100).caminho, vec!["Medicina", "Rim"]);
    assert!(!baralho(100).filtrado);
    assert!(baralho(200).filtrado);

    let basica = colecao.notas.iter().find(|n| n.id == 1).unwrap();
    assert_eq!(basica.guid, "g-basico");
    assert_eq!(basica.tags, vec!["rim", "fisiologia"]);
    assert_eq!(basica.campos, vec!["O que o <b>rim</b> filtra?", "Sangue&nbsp;e <i>plasma</i>"]);

    let cartao = |id| colecao.cartoes.iter().find(|c| c.id == id).unwrap();
    assert_eq!(cartao(11).intervalo_dias, 10);
    assert_eq!(cartao(11).fator, 2500);
    assert_eq!((cartao(13).baralho_id, cartao(13).vencimento), (100, 950), "cartão emprestado volta à origem");
    assert_eq!(cartao(14).vencimento, 1_776_643_820);
    assert_eq!(cartao(15).fila, -1);

    assert_eq!(colecao.revisoes.len(), 3);
    assert!(colecao.revisoes.iter().any(|r| r.resposta == 0 && r.tipo == 4));
}

#[tokio::test]
async fn le_o_formato_novo_e_ignora_o_aviso_em_collection_anki2() {
    let pasta = Pasta::nova("novo");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;

    let pacote = abrir_pacote(&caminho).unwrap();
    let colecao = ler_colecao(pacote.caminho_da_colecao()).await.unwrap();

    conferir_exemplo(&colecao);
    assert_eq!(pacote.midias, 2);
}

#[tokio::test]
async fn le_o_formato_antigo_com_tipos_e_baralhos_em_json() {
    let pasta = Pasta::nova("antigo");
    let caminho = anki_fixture::pacote_antigo(&pasta.0, &[("collection.anki2", &Fixture::exemplo())]).await;

    let pacote = abrir_pacote(&caminho).unwrap();
    let colecao = ler_colecao(pacote.caminho_da_colecao()).await.unwrap();

    conferir_exemplo(&colecao);
    assert_eq!(pacote.midias, 2);
}

#[tokio::test]
async fn no_formato_antigo_collection_anki21_vence_collection_anki2() {
    let pasta = Pasta::nova("anki21");
    let caminho = anki_fixture::pacote_antigo(
        &pasta.0,
        &[("collection.anki2", &Fixture::aviso_de_formato_novo()), ("collection.anki21", &Fixture::exemplo())],
    )
    .await;

    let pacote = abrir_pacote(&caminho).unwrap();
    let colecao = ler_colecao(pacote.caminho_da_colecao()).await.unwrap();

    assert_eq!(colecao.criada_em, CRIADA_EM);
}

#[tokio::test]
async fn o_arquivo_temporario_some_quando_o_pacote_e_solto() {
    let pasta = Pasta::nova("temporario");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;

    let pacote = abrir_pacote(&caminho).unwrap();
    let extraido = pacote.caminho_da_colecao().to_path_buf();
    ler_colecao(&extraido).await.unwrap();
    assert!(extraido.exists());

    drop(pacote);
    assert!(!extraido.exists());
}

#[test]
fn arquivo_que_nao_e_zip_e_invalido() {
    let pasta = Pasta::nova("nao-zip");
    let caminho = pasta.0.join("baralho.apkg");
    std::fs::write(&caminho, "isto não é um zip").unwrap();

    let Err(erro) = abrir_pacote(&caminho) else { panic!("aceitou um arquivo que não é zip") };
    assert!(matches!(&erro, Error::Invalid(msg) if msg.contains("baralho.apkg")), "{erro}");
}

#[test]
fn zip_sem_colecao_e_invalido() {
    let pasta = Pasta::nova("sem-colecao");
    let caminho = pasta.0.join("vazio.apkg");
    anki_fixture::escrever_zip(&caminho, &[], 0, zip::CompressionMethod::Stored);

    let Err(erro) = abrir_pacote(&caminho) else { panic!("aceitou um zip sem coleção") };
    assert!(matches!(&erro, Error::Invalid(msg) if msg.contains("não há coleção")), "{erro}");
}

#[test]
fn zstd_corrompido_e_invalido() {
    let pasta = Pasta::nova("zstd-corrompido");
    let caminho = pasta.0.join("corrompido.colpkg");
    anki_fixture::escrever_zip(
        &caminho,
        &[("collection.anki21b", b"nao e zstd".to_vec())],
        0,
        zip::CompressionMethod::Stored,
    );

    let Err(erro) = abrir_pacote(&caminho) else { panic!("aceitou zstd corrompido") };
    assert!(matches!(&erro, Error::Invalid(msg) if msg.contains("corrompida")), "{erro}");
}

#[tokio::test]
async fn sqlite_invalido_dentro_do_pacote_e_erro_de_entrada_e_nao_de_banco() {
    let pasta = Pasta::nova("sqlite-invalido");
    let caminho = pasta.0.join("ruim.apkg");
    anki_fixture::escrever_zip(
        &caminho,
        &[("collection.anki2", b"nao e sqlite".to_vec())],
        0,
        zip::CompressionMethod::Stored,
    );

    let pacote = abrir_pacote(&caminho).unwrap();
    let Err(erro) = ler_colecao(pacote.caminho_da_colecao()).await else { panic!("leu um SQLite inválido") };
    assert!(matches!(erro, Error::Invalid(_)), "{erro}");
}
