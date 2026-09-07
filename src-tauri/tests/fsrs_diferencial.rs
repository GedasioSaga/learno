#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Teste diferencial do agendador FSRS-6 (`src/srs/fsrs.rs`) contra vetores
//! gerados rodando a implementação de referência `py-fsrs` de verdade
//! (`Scheduler(enable_fuzzing=False)`, padrões), não contra os três vetores
//! dourados manuais já cobertos em `src/srs/fsrs.rs`.
//!
//! Por quê este arquivo existe além daquele: os três vetores dourados
//! (`test_review_card`, `test_memo_state`, `test_repeated_correct_reviews`)
//! não exercitam o ramo `Hard` durante aprendizagem/reaprendizagem (nenhuma
//! das três sequências usa a nota `Hard`) nem uma variedade grande de
//! revisões no mesmo dia com retrievability baixa. O arquivo
//! `fixtures/fsrs-vetores-referencia.json` (gerado por
//! `fixtures/gerar-vetores-fsrs.py`, rodando o `py-fsrs` real) cobre isso:
//! 400 casos × 12 passos, avaliação sorteada entre as 4 notas, atraso entre
//! revisões sorteado entre 0s e 400 dias.
//!
//! Cada passo do JSON traz o `revisado_em_iso` **exato** que a referência
//! usou para aquela chamada — não recalculamos esse instante a partir do
//! `due` que o nosso `agendar()` devolveu no passo anterior. Isso importa:
//! o gerador soma um atraso aleatório por cima do `due` da referência antes
//! da próxima revisão, então usar o `due` do NOSSO resultado (em vez do
//! `revisado_em_iso` gravado) romperia o replay assim que houvesse a menor
//! divergência de um segundo.

use chrono::{DateTime, Utc};
use learno_lib::srs::fsrs::{agendar, EstadoCartao, Parametros};
use learno_lib::srs::{Avaliacao, Fase};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    #[allow(dead_code)]
    fonte: String,
    casos: Vec<Caso>,
}

#[derive(Debug, Deserialize)]
struct Caso {
    #[allow(dead_code)]
    inicio_iso: String,
    passos: Vec<PassoReferencia>,
}

#[derive(Debug, Deserialize)]
struct PassoReferencia {
    rating: i32,
    revisado_em_iso: String,
    estado: String,
    step: Option<u32>,
    estabilidade: f64,
    dificuldade: f64,
    intervalo_seg: i64,
}

fn nota_de_rating(rating: i32) -> Avaliacao {
    match rating {
        1 => Avaliacao::Again,
        2 => Avaliacao::Hard,
        3 => Avaliacao::Good,
        4 => Avaliacao::Easy,
        outro => panic!("rating fora do domínio 1..=4 na fixture: {outro}"),
    }
}

fn fase_de_estado(estado: &str) -> Fase {
    match estado {
        "learning" => Fase::Learning,
        "review" => Fase::Review,
        "relearning" => Fase::Relearning,
        outro => panic!("estado desconhecido na fixture: {outro}"),
    }
}

fn parse_instante(iso: &str) -> DateTime<Utc> {
    iso.parse::<DateTime<Utc>>()
        .unwrap_or_else(|erro| panic!("não consegui parsear datetime '{iso}': {erro}"))
}

/// Tolerância relativa: `1e-9 * max(|esperado|, 1.0)` — o piso de 1.0 evita
/// que um `esperado` perto de zero (não acontece aqui: estabilidade tem
/// piso 0.001, dificuldade tem piso 1.0) torne a tolerância absurdamente
/// apertada.
fn dentro_da_tolerancia_relativa(obtido: f64, esperado: f64, tol: f64) -> bool {
    (obtido - esperado).abs() <= tol * esperado.abs().max(1.0)
}

#[test]
fn agendar_reproduz_vetores_da_referencia_py_fsrs() {
    let bruto = include_str!("fixtures/fsrs-vetores-referencia.json");
    let fixture: Fixture =
        serde_json::from_str(bruto).expect("fixture fsrs-vetores-referencia.json malformada");

    assert!(!fixture.casos.is_empty(), "fixture sem nenhum caso — nada para testar");

    let parametros = Parametros {
        fuzz_habilitado: false,
        ..Parametros::default()
    };

    for (indice_caso, caso) in fixture.casos.iter().enumerate() {
        let mut estado = EstadoCartao::novo();

        for (indice_passo, passo) in caso.passos.iter().enumerate() {
            let nota = nota_de_rating(passo.rating);
            let agora = parse_instante(&passo.revisado_em_iso);

            let resultado = agendar(&estado, nota, &parametros, agora, 0);

            let fase_esperada = fase_de_estado(&passo.estado);
            assert_eq!(
                resultado.estado.fase, fase_esperada,
                "caso {indice_caso}, passo {indice_passo}: fase esperada {fase_esperada:?}, obtida {:?} (rating={:?}, agora={agora})",
                resultado.estado.fase, nota
            );

            assert_eq!(
                resultado.estado.step, passo.step,
                "caso {indice_caso}, passo {indice_passo}: step esperado {:?}, obtido {:?} (rating={:?}, agora={agora})",
                passo.step, resultado.estado.step, nota
            );

            let memoria = resultado.estado.memoria.unwrap_or_else(|| {
                panic!("caso {indice_caso}, passo {indice_passo}: resultado sem memória, impossível depois de uma revisão")
            });

            assert!(
                dentro_da_tolerancia_relativa(memoria.estabilidade, passo.estabilidade, 1e-9),
                "caso {indice_caso}, passo {indice_passo}: estabilidade esperada {}, obtida {} (rating={:?}, agora={agora})",
                passo.estabilidade, memoria.estabilidade, nota
            );

            assert!(
                dentro_da_tolerancia_relativa(memoria.dificuldade, passo.dificuldade, 1e-9),
                "caso {indice_caso}, passo {indice_passo}: dificuldade esperada {}, obtida {} (rating={:?}, agora={agora})",
                passo.dificuldade, memoria.dificuldade, nota
            );

            let intervalo_obtido_seg = (resultado.proxima_revisao - agora).num_seconds();
            assert_eq!(
                intervalo_obtido_seg, passo.intervalo_seg,
                "caso {indice_caso}, passo {indice_passo}: intervalo_seg esperado {}, obtido {} (rating={:?}, agora={agora}, due_obtido={})",
                passo.intervalo_seg, intervalo_obtido_seg, nota, resultado.proxima_revisao
            );

            // Próxima chamada usa o `agora` gravado no PRÓXIMO passo da
            // fixture, não o `proxima_revisao` que o nosso `agendar()`
            // acabou de devolver (ver doc do módulo) — só o estado avança.
            estado = resultado.estado;
        }
    }
}
