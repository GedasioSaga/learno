#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::review_log::ReviewLogRepository` contra um
//! banco SQLite real — mesmo padrão de `tests/db_cards.rs`: cada teste cria
//! seu próprio arquivo descartável via `support::IsolatedDatabase`, já
//! migrado, então a suíte roda num `cargo test` limpo sem preparação
//! nenhuma.
//!
//! `review_log` já é gravada por `CardRepository::answer_card`
//! (`tests/db_cards.rs` prova isso do lado da escrita); aqui as linhas são
//! inseridas diretamente por SQL, com `reviewed_at`/`duration_ms`/
//! `state_before`/`rating` controlados à mão — é o único jeito de testar a
//! borda de fuso e as sequências sem depender de cronômetro real.

mod support;

use chrono::{DateTime, Days, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use learno_lib::db::ids::{DbId, IdBind};
use learno_lib::db::{DeckRepository, FieldValues, NoteRepository, NoteTypeRepository, ReviewLogRepository};
use learno_lib::Error;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// ---- helpers --------------------------------------------------------------

fn campos_frente_verso(frente: &str, verso: &str) -> FieldValues {
    [("Frente".to_string(), frente.to_string()), ("Verso".to_string(), verso.to_string())].into_iter().collect()
}

/// Cria uma nota (e, na mesma transação de `NoteRepository::create`,
/// exatamente um cartão) no baralho `deck_id`, usando o tipo de nota
/// "Básico" semeado por `NoteTypeRepository::list`. Devolve o id do cartão,
/// lido direto da tabela — `NoteRepository::create` devolve a `NoteRow`, não
/// os cartões que ela gerou (mesmo padrão de `tests/db_cards.rs`).
async fn criar_cartao_no_baralho(pool: &SqlitePool, deck_id: Uuid, frente: &str) -> Uuid {
    let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note = NoteRepository::new(pool.clone())
        .create(deck_id, note_type.id, campos_frente_verso(frente, "verso"), vec![])
        .await
        .unwrap();

    sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(pool)
        .await
        .unwrap()
        .into()
}

fn formatar(instante: DateTime<Utc>) -> String {
    instante.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Meio-dia LOCAL de "hoje ± `deslocamento_dias`" (positivo = passado,
/// negativo = futuro), convertido para UTC — meio-dia em vez de meia-noite
/// de propósito, para os testes de sequência/retenção/agregação não
/// colidirem com a própria borda de fuso que é assunto de outro teste.
fn instante_ao_meio_dia_local(deslocamento_dias: i64) -> DateTime<Utc> {
    let hoje_local = Utc::now().with_timezone(&Local).date_naive();
    let dia = if deslocamento_dias >= 0 {
        hoje_local - Days::new(deslocamento_dias.unsigned_abs())
    } else {
        hoje_local + Days::new(deslocamento_dias.unsigned_abs())
    };
    let ingenuo = NaiveDateTime::new(dia, NaiveTime::from_hms_opt(12, 0, 0).unwrap());

    match Local.from_local_datetime(&ingenuo) {
        chrono::LocalResult::Single(instante) => instante.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(mais_cedo, _mais_tarde) => mais_cedo.with_timezone(&Utc),
        chrono::LocalResult::None => Utc.from_utc_datetime(&ingenuo),
    }
}

/// Insere uma linha de `review_log` à mão, com todo campo `NOT NULL` da
/// migração preenchido com um valor neutro — só `reviewed_at`, `rating`,
/// `state_before` e `duration_ms` variam entre os testes, que são o que
/// `ReviewLogRepository::stats` de fato lê.
async fn inserir_revisao(pool: &SqlitePool, card_id: Uuid, quando: DateTime<Utc>, rating: i64, state_before: &str, duration_ms: Option<i64>) {
    sqlx::query(
        "INSERT INTO review_log \
             (id, card_id, reviewed_at, rating, state_before, state_after, interval_before, interval_after, scheduler, duration_ms) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(Uuid::now_v7().db())
    .bind(card_id.db())
    .bind(formatar(quando))
    .bind(rating)
    .bind(state_before)
    .bind("review")
    .bind(0i64)
    .bind(1i64)
    .bind("sm2")
    .bind(duration_ms)
    .execute(pool)
    .await
    .unwrap();
}

// ---- testes -----------------------------------------------------------

#[tokio::test]
async fn banco_vazio_devolve_tudo_zerado_sem_panico() {
    let db = IsolatedDatabase::setup("review-log-vazio").await;
    let repo = ReviewLogRepository::new(db.pool.clone());

    let stats = repo.stats(None, 30).await.unwrap();

    assert!(stats.por_dia.is_empty());
    assert_eq!(stats.total_revisoes, 0);
    assert_eq!(stats.media_diaria, 0.0, "0.0, nunca NaN, quando dias_estudados é zero");
    assert_eq!(stats.dias_estudados, 0);
    assert_eq!(stats.maior_sequencia, 0);
    assert_eq!(stats.sequencia_atual, 0);
    assert_eq!(stats.retencao, None, "sem nenhuma revisão madura, retenção é None, nunca 0.0");

    db.teardown().await;
}

/// `dias <= 0` é rejeitado como erro de argumento — janela vazia disfarçaria
/// "nunca estudei" com um valor que a tela desenharia igual a "estudei zero".
#[tokio::test]
async fn dias_no_maximo_zero_e_rejeitado() {
    let db = IsolatedDatabase::setup("review-log-dias-invalido").await;
    let repo = ReviewLogRepository::new(db.pool.clone());

    assert!(matches!(repo.stats(None, 0).await, Err(Error::Invalid(_))));
    assert!(matches!(repo.stats(None, -1).await, Err(Error::Invalid(_))));

    db.teardown().await;
}

/// Soma certo `revisoes` e `segundos` no mesmo dia, com um `duration_ms`
/// `NULL` no meio da lista (tratado como zero, não como erro).
#[tokio::test]
async fn agregacao_por_dia_soma_revisoes_e_segundos_com_duration_ms_nulo_no_meio() {
    let db = IsolatedDatabase::setup("review-log-agregacao").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;

    let hoje = instante_ao_meio_dia_local(0);
    inserir_revisao(&db.pool, card_id, hoje, 3, "review", Some(1000)).await;
    inserir_revisao(&db.pool, card_id, hoje, 3, "review", None).await;
    inserir_revisao(&db.pool, card_id, hoje, 4, "review", Some(2000)).await;

    let repo = ReviewLogRepository::new(db.pool.clone());
    let stats = repo.stats(None, 5).await.unwrap();

    assert_eq!(stats.total_revisoes, 3);
    assert_eq!(stats.por_dia.len(), 1, "as três revisões caem no mesmo dia local");
    assert_eq!(stats.por_dia[0].revisoes, 3);
    assert_eq!(stats.por_dia[0].segundos, 3, "1000 + 0 (NULL) + 2000 ms = 3000ms = 3s");

    db.teardown().await;
}

/// O ponto central da tarefa: uma revisão gravada perto da meia-noite UTC
/// precisa cair no dia LOCAL certo, não no dia UTC — comparado contra o
/// mesmo mecanismo de conversão (`chrono::Local`) que a produção usa, então
/// o teste continua correto em qualquer fuso onde a suíte rodar.
#[tokio::test]
async fn revisao_perto_da_meia_noite_utc_cai_no_dia_local_certo() {
    let db = IsolatedDatabase::setup("review-log-fuso").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;

    // 23:30 UTC do dia UTC ANTERIOR, não do dia UTC de hoje. `stats` corta a
    // janela em `início do dia local de amanhã` (`db::review_log::stats`), e
    // num fuso atrás de UTC — o do usuário, UTC-3 — "23:30 UTC de hoje" é um
    // instante do FUTURO local durante as últimas horas do dia (entre 21:00
    // local e a meia-noite, o dia UTC já virou e o local não). O teste então
    // inseria uma revisão fora da janela e via zero, falhando por relógio de
    // parede, não por defeito. O dia UTC anterior é sempre passado, e cai em
    // hoje-local ou ontem-local — dentro da janela de 3 dias em qualquer fuso.
    let quase_meia_noite_utc = {
        let ontem_utc = Utc::now().date_naive().pred_opt().expect("data UTC de ontem sempre existe");
        let ingenuo = NaiveDateTime::new(ontem_utc, NaiveTime::from_hms_milli_opt(23, 30, 0, 0).unwrap());
        Utc.from_utc_datetime(&ingenuo)
    };
    let dia_local_esperado = quase_meia_noite_utc.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string();

    inserir_revisao(&db.pool, card_id, quase_meia_noite_utc, 3, "review", Some(1000)).await;

    let repo = ReviewLogRepository::new(db.pool.clone());
    // Janela de 3 dias: absorve o instante mesmo se o fuso do sistema
    // empurrar "23:30 UTC de hoje" para o dia local seguinte ou anterior.
    let stats = repo.stats(None, 3).await.unwrap();

    assert_eq!(stats.total_revisoes, 1);
    let dia = stats.por_dia.iter().find(|d| d.dia == dia_local_esperado);
    assert!(dia.is_some(), "esperava a revisão no dia local {dia_local_esperado}, obtido {:?}", stats.por_dia);
    assert_eq!(dia.unwrap().revisoes, 1);

    db.teardown().await;
}

/// `maior_sequencia` vem da corrida mais longa (3 dias, com um buraco antes
/// dela), não da última corrida da lista (2 dias, mais recente).
#[tokio::test]
async fn maior_sequencia_vem_da_corrida_mais_longa_nao_da_ultima() {
    let db = IsolatedDatabase::setup("review-log-sequencia-buraco").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;

    // Corrida antiga de 3 dias consecutivos (9, 8, 7 dias atrás).
    for dias_atras in [9, 8, 7] {
        inserir_revisao(&db.pool, card_id, instante_ao_meio_dia_local(dias_atras), 3, "review", None).await;
    }
    // Buraco (6..3 dias atrás sem revisão), depois uma corrida mais recente
    // de só 2 dias (2, 1 dias atrás — "ontem").
    for dias_atras in [2, 1] {
        inserir_revisao(&db.pool, card_id, instante_ao_meio_dia_local(dias_atras), 3, "review", None).await;
    }

    let repo = ReviewLogRepository::new(db.pool.clone());
    let stats = repo.stats(None, 15).await.unwrap();

    assert_eq!(stats.maior_sequencia, 3, "a corrida de 3 dias precisa vencer mesmo não sendo a mais recente");
    assert_eq!(stats.dias_estudados, 5);

    db.teardown().await;
}

/// `sequencia_atual` conta quando o último dia estudado foi ontem.
#[tokio::test]
async fn sequencia_atual_conta_quando_o_ultimo_estudo_foi_ontem() {
    let db = IsolatedDatabase::setup("review-log-sequencia-ontem").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;

    for dias_atras in [2, 1] {
        inserir_revisao(&db.pool, card_id, instante_ao_meio_dia_local(dias_atras), 3, "review", None).await;
    }

    let repo = ReviewLogRepository::new(db.pool.clone());
    let stats = repo.stats(None, 10).await.unwrap();

    assert_eq!(stats.sequencia_atual, 2);

    db.teardown().await;
}

/// `sequencia_atual` zera quando o último dia estudado foi há três dias —
/// mesmo que a corrida em si tivesse sido longa.
#[tokio::test]
async fn sequencia_atual_zera_quando_o_ultimo_estudo_foi_ha_tres_dias() {
    let db = IsolatedDatabase::setup("review-log-sequencia-parou").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;

    for dias_atras in [5, 4, 3] {
        inserir_revisao(&db.pool, card_id, instante_ao_meio_dia_local(dias_atras), 3, "review", None).await;
    }

    let repo = ReviewLogRepository::new(db.pool.clone());
    let stats = repo.stats(None, 10).await.unwrap();

    assert_eq!(stats.maior_sequencia, 3, "a corrida continua valendo 3 em maior_sequencia");
    assert_eq!(stats.sequencia_atual, 0, "parar há três dias precisa zerar a sequência atual");

    db.teardown().await;
}

/// True Retention: só revisões com `state_before = 'review'` entram — `new`
/// e `learning` são ignoradas, mesmo tendo `rating` baixo, para não diluir a
/// medida com o erro esperado de um cartão que ainda está sendo aprendido.
#[tokio::test]
async fn retencao_ignora_revisoes_de_cartao_novo_e_em_aprendizado() {
    let db = IsolatedDatabase::setup("review-log-retencao").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let hoje = instante_ao_meio_dia_local(0);

    // Fora da conta: novo errado, aprendizado errado.
    inserir_revisao(&db.pool, card_id, hoje, 1, "new", None).await;
    inserir_revisao(&db.pool, card_id, hoje, 1, "learning", None).await;
    // Dentro da conta: uma revisão madura errada, uma boa — 1 de 2 = 50%.
    inserir_revisao(&db.pool, card_id, hoje, 1, "review", None).await;
    inserir_revisao(&db.pool, card_id, hoje, 4, "review", None).await;

    let repo = ReviewLogRepository::new(db.pool.clone());
    let stats = repo.stats(None, 5).await.unwrap();

    assert_eq!(stats.total_revisoes, 4, "todas as quatro linhas contam para o total de revisões");
    assert_eq!(stats.retencao, Some(0.5), "só as duas revisões maduras entram na retenção: 1 boa de 2 = 50%");

    db.teardown().await;
}

/// Filtro por `deck_id` pega o baralho e seus descendentes ativos, e exclui
/// um baralho irmão — o mesmo critério de `CardRepository::deck_counts`
/// (`ESCOPO_BARALHOS_CTE`), aplicado aqui a `review_log` via `cards.deck_id`.
#[tokio::test]
async fn filtro_por_deck_pega_descendentes_e_exclui_irmaos() {
    let db = IsolatedDatabase::setup("review-log-escopo-deck").await;
    let decks = DeckRepository::new(db.pool.clone());
    let pai = decks.create(None, "Biologia").await.unwrap();
    let filho = decks.create(Some(pai.id), "Citologia").await.unwrap();
    let irmao = decks.create(None, "Química").await.unwrap();

    let card_no_filho = criar_cartao_no_baralho(&db.pool, filho.id, "Mitocôndria").await;
    let card_no_irmao = criar_cartao_no_baralho(&db.pool, irmao.id, "Mol").await;

    let hoje = instante_ao_meio_dia_local(0);
    inserir_revisao(&db.pool, card_no_filho, hoje, 3, "review", None).await;
    inserir_revisao(&db.pool, card_no_irmao, hoje, 3, "review", None).await;

    let repo = ReviewLogRepository::new(db.pool.clone());

    let stats_do_pai = repo.stats(Some(pai.id), 5).await.unwrap();
    assert_eq!(stats_do_pai.total_revisoes, 1, "o baralho irmão não pode entrar na consulta pelo id do pai");

    let stats_geral = repo.stats(None, 5).await.unwrap();
    assert_eq!(stats_geral.total_revisoes, 2, "sem deck_id, os dois baralhos entram");

    db.teardown().await;
}
