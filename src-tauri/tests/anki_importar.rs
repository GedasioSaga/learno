#![allow(clippy::unwrap_used, clippy::expect_used)]

//! A importação de pacotes do Anki (`learno_lib::anki::importar`) contra um
//! banco isolado e pacotes sintéticos — nenhum dado real.

mod anki_fixture;
mod support;

use anki_fixture::{CartaoFixture, Fixture, NotaFixture, Pasta, TipoFixture, CRIADA_EM};
use chrono::{DateTime, Local, TimeZone, Timelike, Utc};
use learno_lib::anki::{gravar_colecao, importar_pacote, RelatorioDeImportacao};
use learno_lib::db::DeckRepository;
use learno_lib::Error;
use serde_json::json;
use sqlx::SqlitePool;
use support::IsolatedDatabase;

fn relatorio_do_exemplo() -> RelatorioDeImportacao {
    RelatorioDeImportacao {
        notas_importadas: 3,
        notas_ja_existentes: 0,
        notas_sem_cartao: 0,
        cartoes_importados: 5,
        revisoes_importadas: 2,
        revisoes_ignoradas: 1,
        baralhos_criados: 2,
        tipos_de_nota_criados: 1,
        midias_ignoradas: 2,
    }
}

async fn contar(pool: &SqlitePool, tabela: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {tabela}")).fetch_one(pool).await.unwrap()
}

/// `(estado, vencimento, intervalo, facilidade, repetições, lapsos, suspenso_em, baralho)` do cartão.
type LinhaDeCartao = (String, Option<String>, i64, i64, i64, i64, Option<String>, String);

/// `(revisada_em, resposta, estado_antes, estado_depois, intervalo_antes, intervalo_depois, facilidade_depois, duração)`.
type LinhaDeHistorico = (String, i64, String, String, i64, i64, Option<i64>, Option<i64>);

async fn cartao(pool: &SqlitePool, guid: &str, ordinal: i64) -> LinhaDeCartao {
    sqlx::query_as(
        "SELECT c.state, c.due, c.interval_days, c.ease_factor, c.reps, c.lapses, c.suspended_at, d.name \
         FROM cards c JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = c.deck_id \
         WHERE n.anki_guid = ? AND c.template_ordinal = ?",
    )
    .bind(guid)
    .bind(ordinal)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn nota(pool: &SqlitePool, guid: &str) -> (String, serde_json::Value, serde_json::Value) {
    let (tipo, campos, tags): (String, String, String) = sqlx::query_as(
        "SELECT t.name, n.field_values, n.tags FROM notes n JOIN note_types t ON t.id = n.note_type_id \
         WHERE n.anki_guid = ?",
    )
    .bind(guid)
    .fetch_one(pool)
    .await
    .unwrap();
    (tipo, serde_json::from_str(&campos).unwrap(), serde_json::from_str(&tags).unwrap())
}

fn assert_meia_noite_local(vencimento: Option<&str>, dias_desde_a_criacao: i64) {
    let local = DateTime::parse_from_rfc3339(vencimento.unwrap()).unwrap().with_timezone(&Local);
    let esperado = Local.timestamp_opt(CRIADA_EM + dias_desde_a_criacao * 86_400, 0).single().unwrap().date_naive();
    assert_eq!(local.date_naive(), esperado);
    assert_eq!((local.hour(), local.minute()), (0, 0));
}

#[tokio::test]
async fn importa_o_formato_novo_com_conteudo_agendamento_e_historico() {
    let db = IsolatedDatabase::setup("anki-importar-novo").await;
    let pasta = Pasta::nova("importar-novo");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;

    let relatorio = importar_pacote(&db.pool, &caminho).await.unwrap();
    assert_eq!(relatorio, relatorio_do_exemplo());

    // Baralhos: a hierarquia do Anki, sem o «Default» vazio e sem o filtrado.
    let baralhos: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT d.name, p.name FROM decks d LEFT JOIN decks p ON p.id = d.parent_id ORDER BY d.name")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(baralhos, vec![("Medicina".to_string(), None), ("Rim".to_string(), Some("Medicina".to_string()))]);

    // Notas: HTML virou texto, e cada tipo foi resolvido.
    let (tipo, campos, tags) = nota(&db.pool, "g-basico").await;
    assert_eq!(tipo, "Básico");
    assert_eq!(campos, json!({ "Frente": "O que o rim filtra?", "Verso": "Sangue e plasma" }));
    assert_eq!(tags, json!(["rim", "fisiologia"]));

    let (tipo, campos, _) = nota(&db.pool, "g-invertido").await;
    assert_eq!(tipo, "Basic (and reversed card)");
    assert_eq!(campos, json!({ "Front": "Néfron", "Back": "Unidade funcional" }));

    let (tipo, campos, _) = nota(&db.pool, "g-cloze").await;
    assert_eq!(tipo, "Cloze");
    assert_eq!(campos, json!({ "Texto": "A {{c1::mitocôndria}} produz {{c2::ATP}}", "Extra": "[imagem: mito.png]" }));

    // Cartões: estado, vencimento e números do Anki.
    let (estado, vencimento, intervalo, facilidade, repeticoes, lapsos, suspenso, baralho) =
        cartao(&db.pool, "g-basico", 0).await;
    assert_eq!((estado.as_str(), intervalo, facilidade, repeticoes, lapsos), ("review", 10, 250, 5, 1));
    assert_meia_noite_local(vencimento.as_deref(), 900);
    assert_eq!((suspenso, baralho.as_str()), (None, "Rim"));

    let (estado, vencimento, ..) = cartao(&db.pool, "g-invertido", 0).await;
    assert_eq!((estado.as_str(), vencimento), ("new", None));

    let (estado, vencimento, intervalo, facilidade, _, _, _, baralho) = cartao(&db.pool, "g-invertido", 1).await;
    assert_eq!((estado.as_str(), intervalo, facilidade, baralho.as_str()), ("review", 3, 230, "Rim"));
    assert_meia_noite_local(vencimento.as_deref(), 950);

    // Cloze: c1 do Anki é o ordinal 0 lá e 1 aqui.
    let (estado, vencimento, ..) = cartao(&db.pool, "g-cloze", 1).await;
    assert_eq!(estado, "learning");
    let esperado = Utc.timestamp_opt(1_776_643_820, 0).single().unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    assert_eq!(vencimento.as_deref(), Some(esperado.as_str()));

    let (estado, _, intervalo, facilidade, _, lapsos, suspenso, _) = cartao(&db.pool, "g-cloze", 2).await;
    assert_eq!((estado.as_str(), intervalo, facilidade, lapsos), ("suspended", 20, 260, 2));
    assert!(suspenso.is_some());

    // Histórico: duas respostas; o reagendamento manual ficou de fora.
    let historico: Vec<LinhaDeHistorico> = sqlx::query_as(
        "SELECT r.reviewed_at, r.rating, r.state_before, r.state_after, r.interval_before, r.interval_after, \
         r.ease_factor_after, r.duration_ms FROM review_log r ORDER BY r.reviewed_at",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        historico,
        vec![
            (
                "2023-11-14T22:13:20.000Z".to_string(),
                3,
                "review".to_string(),
                "review".to_string(),
                4,
                10,
                Some(250),
                Some(8000)
            ),
            (
                "2023-11-14T22:16:40.000Z".to_string(),
                1,
                "new".to_string(),
                "learning".to_string(),
                0,
                0,
                None,
                Some(3000)
            ),
        ]
    );

    db.teardown().await;
}

#[tokio::test]
async fn o_formato_antigo_importa_igual() {
    let db = IsolatedDatabase::setup("anki-importar-antigo").await;
    let pasta = Pasta::nova("importar-antigo");
    let caminho = anki_fixture::pacote_antigo(&pasta.0, &[("collection.anki2", &Fixture::exemplo())]).await;

    assert_eq!(importar_pacote(&db.pool, &caminho).await.unwrap(), relatorio_do_exemplo());
    assert_eq!(nota(&db.pool, "g-basico").await.0, "Básico");

    db.teardown().await;
}

#[tokio::test]
async fn reimportar_pula_as_notas_e_nao_toca_no_progresso_feito_no_learno() {
    let db = IsolatedDatabase::setup("anki-reimportar").await;
    let pasta = Pasta::nova("reimportar");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;

    importar_pacote(&db.pool, &caminho).await.unwrap();
    sqlx::query("UPDATE cards SET reps = 99").execute(&db.pool).await.unwrap();
    let tipos_antes = contar(&db.pool, "note_types").await;

    let segunda = importar_pacote(&db.pool, &caminho).await.unwrap();

    assert_eq!(
        segunda,
        RelatorioDeImportacao { notas_ja_existentes: 3, midias_ignoradas: 2, ..RelatorioDeImportacao::default() }
    );
    assert_eq!(contar(&db.pool, "notes").await, 3);
    assert_eq!(contar(&db.pool, "cards").await, 5);
    assert_eq!(contar(&db.pool, "review_log").await, 2);
    assert_eq!(contar(&db.pool, "decks").await, 2);
    assert_eq!(contar(&db.pool, "note_types").await, tipos_antes);
    let repeticoes: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT reps FROM cards").fetch_all(&db.pool).await.unwrap();
    assert_eq!(repeticoes, vec![99]);

    db.teardown().await;
}

#[tokio::test]
async fn baralho_que_ja_existe_com_o_mesmo_caminho_recebe_os_cartoes() {
    let db = IsolatedDatabase::setup("anki-baralho-existente").await;
    let decks = DeckRepository::new(db.pool.clone());
    let medicina = decks.create(None, "Medicina").await.unwrap();
    let rim = decks.create(Some(medicina.id), "Rim").await.unwrap();
    let pasta = Pasta::nova("baralho-existente");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;

    let relatorio = importar_pacote(&db.pool, &caminho).await.unwrap();

    assert_eq!(relatorio.baralhos_criados, 0);
    let baralhos: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT deck_id FROM cards").fetch_all(&db.pool).await.unwrap();
    assert_eq!(baralhos, vec![rim.id.to_string()]);

    db.teardown().await;
}

fn fixture_de_ordem() -> Fixture {
    let nota = |id, guid| NotaFixture { id, guid, tipo: 1, tags: "", campos: vec!["pergunta", "resposta"] };
    Fixture {
        criada_em: CRIADA_EM,
        tipos: vec![TipoFixture {
            id: 1,
            nome: "Basic",
            cloze: false,
            campos: vec!["Front", "Back"],
            templates: vec![("Card 1", "{{Front}}", "{{Back}}")],
        }],
        baralhos: vec![(100, "Ordem", false)],
        notas: vec![nota(1, "ga"), nota(2, "gb"), nota(3, "gc"), nota(4, "sem-cartao")],
        cartoes: vec![
            CartaoFixture { due: 30, ..CartaoFixture::novo(11, 1, 100, 0) },
            CartaoFixture { due: 10, ..CartaoFixture::novo(12, 2, 100, 0) },
            CartaoFixture { due: 20, ..CartaoFixture::novo(13, 3, 100, 0) },
        ],
        revisoes: vec![],
        midias: 0,
    }
}

#[tokio::test]
async fn cartoes_novos_saem_na_ordem_da_fila_do_anki_e_nota_sem_cartao_fica_de_fora() {
    let db = IsolatedDatabase::setup("anki-ordem").await;
    let pasta = Pasta::nova("ordem");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &fixture_de_ordem()).await;

    let relatorio = importar_pacote(&db.pool, &caminho).await.unwrap();

    assert_eq!((relatorio.notas_importadas, relatorio.notas_sem_cartao), (3, 1));
    let ordem: Vec<String> = sqlx::query_scalar(
        "SELECT n.anki_guid FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.state = 'new' \
         ORDER BY c.created_at, c.id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(ordem, vec!["gb", "gc", "ga"]);

    db.teardown().await;
}

#[tokio::test]
async fn pacote_corrompido_no_meio_nao_deixa_nada_gravado() {
    let db = IsolatedDatabase::setup("anki-atomico").await;
    let pasta = Pasta::nova("atomico");
    let mut fixture = fixture_de_ordem();
    // A última nota aponta para um tipo que não existe: as anteriores já teriam
    // criado baralho, tipo e nota antes do erro.
    fixture.notas.push(NotaFixture { id: 5, guid: "orfa", tipo: 99, tags: "", campos: vec!["x", "y"] });
    fixture.cartoes.push(CartaoFixture::novo(15, 5, 100, 0));
    let caminho = anki_fixture::pacote_novo(&pasta.0, &fixture).await;
    let tipos_antes = {
        learno_lib::db::NoteTypeRepository::new(db.pool.clone()).list().await.unwrap();
        contar(&db.pool, "note_types").await
    };

    let Err(erro) = importar_pacote(&db.pool, &caminho).await else { panic!("importou um pacote corrompido") };

    assert!(matches!(erro, Error::Invalid(_)), "{erro}");
    assert_eq!(contar(&db.pool, "notes").await, 0);
    assert_eq!(contar(&db.pool, "cards").await, 0);
    assert_eq!(contar(&db.pool, "decks").await, 0);
    assert_eq!(contar(&db.pool, "note_types").await, tipos_antes);

    db.teardown().await;
}

#[tokio::test]
async fn gravar_colecao_aceita_colecao_ja_lida() {
    let db = IsolatedDatabase::setup("anki-gravar").await;
    let pasta = Pasta::nova("gravar");
    let caminho = anki_fixture::pacote_novo(&pasta.0, &Fixture::exemplo()).await;
    let pacote = learno_lib::anki::abrir_pacote(&caminho).unwrap();
    let colecao = learno_lib::anki::ler_colecao(pacote.caminho_da_colecao()).await.unwrap();

    let relatorio = gravar_colecao(&db.pool, &colecao, 0, Utc::now()).await.unwrap();

    assert_eq!(relatorio, RelatorioDeImportacao { midias_ignoradas: 0, ..relatorio_do_exemplo() });

    db.teardown().await;
}
