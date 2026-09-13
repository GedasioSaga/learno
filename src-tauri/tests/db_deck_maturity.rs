#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `CardRepository::deck_maturity` — a peça que a
//! Trilha vai usar para responder "o baralho anexado a esta etapa já foi de
//! fato aprendido" (ver o comentário de módulo de `db::cards::DeckMaturity`).
//! Mesmo padrão de `tests/db_cards.rs`: cada teste cria seu próprio banco
//! descartável via `support::IsolatedDatabase`.
//!
//! O que se prova aqui, e não em teste unitário puro (não há SQL para
//! verificar sem um banco real): a fronteira EXATA de 21 dias — 20 ainda é
//! jovem, 21 e 22 já são maduros, o off-by-one clássico deste tipo de corte —
//! e que a fração de maduros exclui suspenso do denominador, como
//! documentado em `CardRepository::deck_maturity`.

mod support;

use learno_lib::db::ids::{DbId, IdBind};
use learno_lib::db::{CardRepository, DeckRepository, FieldValues, NoteRepository, NoteTypeRepository};
use learno_lib::Error;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

fn campos(frente: &str, verso: &str) -> FieldValues {
    [("Frente".to_string(), frente.to_string()), ("Verso".to_string(), verso.to_string())].into_iter().collect()
}

/// Cria um cartão novo no baralho `deck_id` — uma nota "Básico" gera
/// exatamente um cartão, mesma mecânica de `deck_com_um_cartao_novo` em
/// `tests/db_cards.rs` — e devolve o id do cartão.
async fn criar_cartao(pool: &SqlitePool, deck_id: Uuid) -> Uuid {
    let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note =
        NoteRepository::new(pool.clone()).create(deck_id, note_type.id, campos("frente", "verso"), vec![]).await.unwrap();

    sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(pool)
        .await
        .unwrap()
        .into()
}

/// Grava `state`/`interval_days` direto por SQL — o jeito mais simples de
/// simular um cartão com um histórico de revisão específico sem depender do
/// agendador de verdade (`crate::srs`) produzir por acaso o intervalo exato
/// que o teste quer. Mesmo padrão de `tests/db_cards.rs`, que já grava
/// `suspended_at` direto por SQL pelo mesmo motivo (ver
/// `responder_um_cartao_suspenso_e_rejeitado`).
async fn forcar_estado(pool: &SqlitePool, card_id: Uuid, state: &str, interval_days: i64) {
    sqlx::query("UPDATE cards SET state = ?, interval_days = ? WHERE id = ?")
        .bind(state)
        .bind(interval_days)
        .bind(card_id.db())
        .execute(pool)
        .await
        .unwrap();
}

async fn suspender(pool: &SqlitePool, card_id: Uuid) {
    sqlx::query("UPDATE cards SET state = 'suspended', suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .bind(card_id.db())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn baralho_vazio_devolve_tudo_zero_e_fracao_zero_sem_dividir_por_zero() {
    let db = IsolatedDatabase::setup("maturity-vazio").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Vazio").await.unwrap();
    let cards = CardRepository::new(db.pool.clone());

    let maturidade = cards.deck_maturity(deck.id).await.unwrap();

    assert_eq!(maturidade.total, 0);
    assert_eq!(maturidade.maduros, 0);
    assert_eq!(maturidade.jovens, 0);
    assert_eq!(maturidade.novos, 0);
    assert_eq!(maturidade.suspensos, 0);
    assert_eq!(maturidade.fracao_maduros, 0.0, "denominador zero precisa devolver 0.0, nunca NaN");

    db.teardown().await;
}

#[tokio::test]
async fn baralho_so_com_cartoes_novos_nao_tem_nenhum_maduro() {
    let db = IsolatedDatabase::setup("maturity-so-novos").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Só novos").await.unwrap();
    criar_cartao(&db.pool, deck.id).await;
    criar_cartao(&db.pool, deck.id).await;
    let cards = CardRepository::new(db.pool.clone());

    let maturidade = cards.deck_maturity(deck.id).await.unwrap();

    assert_eq!(maturidade.total, 2);
    assert_eq!(maturidade.novos, 2);
    assert_eq!(maturidade.maduros, 0);
    assert_eq!(maturidade.jovens, 0);
    assert_eq!(maturidade.suspensos, 0);
    assert_eq!(maturidade.fracao_maduros, 0.0, "nenhum cartão em revisão ainda, a fração precisa ser 0");

    db.teardown().await;
}

#[tokio::test]
async fn mistura_de_maduro_jovem_novo_e_suspenso_conta_cada_um_no_balde_certo() {
    let db = IsolatedDatabase::setup("maturity-mistura").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Mistura").await.unwrap();
    let cards = CardRepository::new(db.pool.clone());

    let maduro = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, maduro, "review", 30).await;

    let jovem_review = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, jovem_review, "review", 5).await;

    let jovem_relearning = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, jovem_relearning, "relearning", 0).await;

    criar_cartao(&db.pool, deck.id).await; // fica 'new' por padrão

    let suspenso = criar_cartao(&db.pool, deck.id).await;
    suspender(&db.pool, suspenso).await;

    let maturidade = cards.deck_maturity(deck.id).await.unwrap();

    assert_eq!(maturidade.total, 5);
    assert_eq!(maturidade.maduros, 1);
    assert_eq!(maturidade.jovens, 2, "review<21 e relearning entram juntos em jovens");
    assert_eq!(maturidade.novos, 1);
    assert_eq!(maturidade.suspensos, 1);
    // Denominador = total - suspensos = 4; maduros = 1 -> 0.25 exato (1/4 é
    // representável sem perda em ponto flutuante binário).
    assert!(
        (maturidade.fracao_maduros - 0.25).abs() < 1e-9,
        "fração esperada 0.25, obtida {}",
        maturidade.fracao_maduros
    );

    db.teardown().await;
}

/// A fronteira que a tarefa nomeia como o erro provável: 20 dias abaixo do
/// corte, 21 e 22 no corte e acima.
#[tokio::test]
async fn fronteira_exata_de_21_dias_20_e_jovem_21_e_22_sao_maduros() {
    let db = IsolatedDatabase::setup("maturity-fronteira").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Fronteira").await.unwrap();
    let cards = CardRepository::new(db.pool.clone());

    let vinte = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, vinte, "review", 20).await;

    let vinte_um = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, vinte_um, "review", 21).await;

    let vinte_dois = criar_cartao(&db.pool, deck.id).await;
    forcar_estado(&db.pool, vinte_dois, "review", 22).await;

    let maturidade = cards.deck_maturity(deck.id).await.unwrap();

    assert_eq!(maturidade.jovens, 1, "20 dias ainda é jovem");
    assert_eq!(maturidade.maduros, 2, "21 e 22 dias já são maduros");

    db.teardown().await;
}

#[tokio::test]
async fn baralho_inexistente_e_rejeitado_com_not_found() {
    let db = IsolatedDatabase::setup("maturity-inexistente").await;
    let cards = CardRepository::new(db.pool.clone());

    let resultado = cards.deck_maturity(Uuid::now_v7()).await;

    assert!(matches!(&resultado, Err(Error::NotFound(_))), "esperado NotFound, obtido {resultado:?}");

    db.teardown().await;
}
