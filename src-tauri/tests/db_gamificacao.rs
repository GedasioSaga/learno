#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::gamificacao::GamificacaoRepository` contra um
//! banco SQLite real — mesmo padrão de `tests/db_review_log.rs`: cada teste
//! cria seu próprio arquivo descartável via `support::IsolatedDatabase`, já
//! migrado, então a suíte roda num `cargo test` limpo sem preparação
//! nenhuma.
//!
//! Este arquivo prova as garantias que o pedido desta peça exige
//! explicitamente: idempotência no SCHEMA (não só no código), XP total como
//! soma das linhas, a curva de nível numa fronteira real, desafio
//! determinístico em duas leituras, progresso vindo do histórico real (não
//! de um contador à parte), a borda de fuso, e banco vazio sem pânico/NaN.

mod support;

use chrono::{DateTime, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use learno_lib::db::ids::{DbId, IdBind};
use learno_lib::db::{
    CronogramaRepository, DeckRepository, FieldValues, GamificacaoRepository, NoteRepository, NoteTypeRepository,
    PomodoroRepository, XP_POR_BLOCO_CRONOGRAMA, XP_POR_DESAFIO_DIARIO, XP_POR_POMODORO_CONCLUIDO, XP_POR_REVISAO_CARTAO,
};
use learno_lib::Error;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// ---- helpers ---------------------------------------------------------

fn campos_frente_verso(frente: &str, verso: &str) -> FieldValues {
    [("Frente".to_string(), frente.to_string()), ("Verso".to_string(), verso.to_string())].into_iter().collect()
}

/// Mesmo helper de `tests/db_review_log.rs`: cria um baralho + nota (e,
/// portanto, exatamente um cartão) e devolve o id do cartão.
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

/// Insere uma linha de `review_log` à mão com um id CONHECIDO, para os
/// testes poderem creditar XP sobre ela em seguida — mesma técnica de
/// `tests/db_review_log.rs::inserir_revisao`, devolvendo o id em vez de
/// descartá-lo.
async fn inserir_revisao(pool: &SqlitePool, card_id: Uuid, quando: DateTime<Utc>) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO review_log \
             (id, card_id, reviewed_at, rating, state_before, state_after, interval_before, interval_after, scheduler, duration_ms) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id.db())
    .bind(card_id.db())
    .bind(formatar(quando))
    .bind(3i64)
    .bind("review")
    .bind("review")
    .bind(0i64)
    .bind(1i64)
    .bind("sm2")
    .bind(1000i64)
    .execute(pool)
    .await
    .unwrap();
    id
}

/// O dia local de HOJE, exatamente como `db::gamificacao::now_local_date_and_offset`
/// (privado) o calcularia — necessário para criar blocos do cronograma e
/// lançamentos manuais que caiam no mesmo dia que `desafios_hoje()`/
/// `registrar_xp_desafio_diario` vão consultar.
fn hoje_local() -> String {
    Utc::now().with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string()
}

/// Lançamento manual de tempo (`study_time_entries`) ligado a um bloco —
/// a via mais direta de "cumprir" um bloco nos testes, sem precisar simular
/// uma sessão de pomodoro inteira.
async fn lancar_tempo_manual(pool: &SqlitePool, local_date: &str, minutes: i64, plan_block_id: Uuid) {
    sqlx::query("INSERT INTO study_time_entries (id, local_date, minutes, plan_block_id, activity) VALUES ($1, $2, $3, $4, 'other')")
        .bind(Uuid::now_v7().db())
        .bind(local_date)
        .bind(minutes)
        .bind(plan_block_id.db())
        .execute(pool)
        .await
        .unwrap();
}

async fn contar_xp_events(pool: &SqlitePool, origin: &str, reference_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM xp_events WHERE origin = $1 AND reference_id = $2")
        .bind(origin)
        .bind(reference_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ---- banco vazio -------------------------------------------------------

#[tokio::test]
async fn banco_vazio_devolve_tudo_zerado_sem_panico_e_sem_nan() {
    let db = IsolatedDatabase::setup("gamificacao-vazio").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    assert_eq!(repo.xp_total().await.unwrap(), 0);

    let nivel = repo.nivel_atual().await.unwrap();
    assert_eq!(nivel.nivel, 1);
    assert_eq!(nivel.xp_no_nivel_atual, 0);
    assert_eq!(nivel.xp_para_proximo_nivel, 100);
    assert_eq!(nivel.progresso, 0.0, "progresso tem que ser 0.0, nunca NaN, com XP zero");

    let desafios = repo.desafios_hoje().await.unwrap();
    assert_eq!(desafios.len(), 3);
    for desafio in &desafios {
        assert_eq!(desafio.progresso, 0);
        assert!(!desafio.concluido);
        assert!(!desafio.xp_creditado);
    }

    let recordes = repo.recordes_pessoais().await.unwrap();
    assert_eq!(recordes.melhor_dia, None);
    assert_eq!(recordes.maior_sequencia, 0);
    assert_eq!(recordes.melhor_semana, None);

    let agora = Utc::now();
    let resumo = repo.resumo_de_sessao(agora - chrono::Duration::hours(1), agora).await.unwrap();
    assert_eq!(resumo.cartoes_revisados, 0);
    assert_eq!(resumo.segundos_estudados, 0);
    assert_eq!(resumo.xp_ganho, 0);
    assert_eq!(resumo.cartoes_vencendo_amanha, 0);

    db.teardown().await;
}

// ---- idempotência ---------------------------------------------------

/// A prova "pelo schema", não só pelo código: um `INSERT` cru repetindo a
/// mesma `(origin, reference_id)` é rejeitado pela `UNIQUE` da migração —
/// sem passar pelo `ON CONFLICT DO NOTHING` que o repositório usa.
#[tokio::test]
async fn unique_do_schema_rejeita_origin_e_reference_id_repetidos() {
    let db = IsolatedDatabase::setup("gamificacao-unique-schema").await;

    sqlx::query("INSERT INTO xp_events (id, amount, origin, reference_id) VALUES ($1, $2, 'card_review', 'ref-fixa')")
        .bind(Uuid::now_v7().db())
        .bind(10i64)
        .execute(&db.pool)
        .await
        .unwrap();

    let segunda = sqlx::query("INSERT INTO xp_events (id, amount, origin, reference_id) VALUES ($1, $2, 'card_review', 'ref-fixa')")
        .bind(Uuid::now_v7().db())
        .bind(10i64)
        .execute(&db.pool)
        .await;

    assert!(segunda.is_err(), "a segunda linha com a mesma (origin, reference_id) tinha que ser rejeitada pela UNIQUE");

    db.teardown().await;
}

/// A mesma revisão creditada duas vezes (chamada duplicada do comando, por
/// exemplo) conta uma vez só — nem erro, nem duas linhas.
#[tokio::test]
async fn registrar_xp_revisao_cartao_duas_vezes_conta_uma_vez_so() {
    let db = IsolatedDatabase::setup("gamificacao-revisao-idempotente").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let review_id = inserir_revisao(&db.pool, card_id, Utc::now()).await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let primeiro = repo.registrar_xp_revisao_cartao(review_id).await.unwrap();
    assert!(!primeiro.ja_creditado);
    assert_eq!(primeiro.amount, XP_POR_REVISAO_CARTAO);

    let segundo = repo.registrar_xp_revisao_cartao(review_id).await.unwrap();
    assert!(segundo.ja_creditado, "a segunda chamada tem que reconhecer que já foi creditada");
    assert_eq!(segundo.id, primeiro.id, "é a MESMA linha, não uma nova");

    assert_eq!(contar_xp_events(&db.pool, "card_review", &review_id.hyphenated().to_string()).await, 1);
    assert_eq!(repo.xp_total().await.unwrap(), XP_POR_REVISAO_CARTAO, "XP não pode dobrar por causa da chamada repetida");

    db.teardown().await;
}

/// `registrar_xp_revisao_cartao` para um id que não existe em `review_log` é
/// `NotFound` — nunca credita XP para uma referência inventada.
#[tokio::test]
async fn registrar_xp_revisao_cartao_com_id_inexistente_e_not_found() {
    let db = IsolatedDatabase::setup("gamificacao-revisao-inexistente").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let result = repo.registrar_xp_revisao_cartao(Uuid::now_v7()).await;
    assert!(matches!(result, Err(Error::NotFound(_))), "esperava NotFound, obtido {result:?}");

    db.teardown().await;
}

// ---- xp_total é a soma das linhas ------------------------------------

#[tokio::test]
async fn xp_total_e_a_soma_das_linhas_e_muda_ao_apagar_um_evento() {
    let db = IsolatedDatabase::setup("gamificacao-soma").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let review_id = inserir_revisao(&db.pool, card_id, Utc::now()).await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    repo.registrar_xp_revisao_cartao(review_id).await.unwrap();

    let sessao = PomodoroRepository::new(db.pool.clone()).start("focus", 1500, None).await.unwrap();
    PomodoroRepository::new(db.pool.clone()).finish(sessao.id, true).await.unwrap();
    let evento_pomodoro = repo.registrar_xp_pomodoro_concluido(sessao.id).await.unwrap();

    assert_eq!(repo.xp_total().await.unwrap(), XP_POR_REVISAO_CARTAO + XP_POR_POMODORO_CONCLUIDO);

    sqlx::query("DELETE FROM xp_events WHERE id = $1").bind(evento_pomodoro.id.db()).execute(&db.pool).await.unwrap();

    assert_eq!(
        repo.xp_total().await.unwrap(),
        XP_POR_REVISAO_CARTAO,
        "apagar uma linha tem que mudar o total sozinho, sem nenhum outro lugar para corrigir"
    );

    db.teardown().await;
}

// ---- curva de nível ---------------------------------------------------

#[tokio::test]
async fn nivel_sobe_ao_cruzar_a_fronteira_real_de_100_xp() {
    let db = IsolatedDatabase::setup("gamificacao-nivel-fronteira").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    // XP_POR_REVISAO_CARTAO = 10; 9 revisões = 90 XP, ainda nível 1.
    for _ in 0..9 {
        let review_id = inserir_revisao(&db.pool, card_id, Utc::now()).await;
        repo.registrar_xp_revisao_cartao(review_id).await.unwrap();
    }
    assert_eq!(repo.xp_total().await.unwrap(), 90);
    assert_eq!(repo.nivel_atual().await.unwrap().nivel, 1);

    // A 10ª revisão fecha exatamente 100 XP — a fronteira do nível 2.
    let decima = inserir_revisao(&db.pool, card_id, Utc::now()).await;
    repo.registrar_xp_revisao_cartao(decima).await.unwrap();

    let nivel = repo.nivel_atual().await.unwrap();
    assert_eq!(nivel.nivel, 2);
    assert_eq!(nivel.xp_no_nivel_atual, 0);
    assert_eq!(nivel.xp_para_proximo_nivel, 200);

    db.teardown().await;
}

// ---- desafio diário: determinismo e progresso real --------------------

#[tokio::test]
async fn desafios_do_mesmo_dia_sao_identicos_em_duas_leituras_seguidas() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-determinismo").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let primeira = repo.desafios_hoje().await.unwrap();
    let segunda = repo.desafios_hoje().await.unwrap();

    assert_eq!(primeira, segunda, "abrir duas vezes no mesmo dia tem que mostrar os MESMOS desafios, não um sorteio novo");

    db.teardown().await;
}

#[tokio::test]
async fn progresso_de_revisar_cartoes_sai_do_historico_real_de_review_log() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-revisar").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let antes = repo.desafios_hoje().await.unwrap();
    let progresso_antes = antes.iter().find(|d| d.tipo == "revisar_cartoes").unwrap().progresso;
    assert_eq!(progresso_antes, 0);

    for _ in 0..3 {
        inserir_revisao(&db.pool, card_id, Utc::now()).await;
    }

    let depois = repo.desafios_hoje().await.unwrap();
    let progresso_depois = depois.iter().find(|d| d.tipo == "revisar_cartoes").unwrap().progresso;
    assert_eq!(progresso_depois, 3, "o progresso tem que vir do histórico real, não de um contador à parte");

    db.teardown().await;
}

#[tokio::test]
async fn progresso_de_focar_minutos_sai_do_historico_real_de_pomodoro_sessions() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-focar").await;
    let repo = GamificacaoRepository::new(db.pool.clone());
    let pomodoro = PomodoroRepository::new(db.pool.clone());

    let sessao = pomodoro.start("focus", 1500, None).await.unwrap(); // 25 minutos
    pomodoro.finish(sessao.id, true).await.unwrap();

    // Uma sessão CANCELADA não deve contar.
    let cancelada = pomodoro.start("focus", 600, None).await.unwrap();
    pomodoro.finish(cancelada.id, false).await.unwrap();

    let desafios = repo.desafios_hoje().await.unwrap();
    let progresso = desafios.iter().find(|d| d.tipo == "focar_minutos").unwrap().progresso;
    assert_eq!(progresso, 25, "só a sessão CONCLUÍDA conta, a cancelada não");

    db.teardown().await;
}

#[tokio::test]
async fn progresso_de_concluir_blocos_bate_com_o_criterio_de_bloco_cumprido() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-blocos").await;
    let dia = hoje_local();
    let bloco = CronogramaRepository::new(db.pool.clone())
        .criar_bloco(&dia, "reading", 30, None, None, None, None, None, None)
        .await
        .unwrap();
    let repo = GamificacaoRepository::new(db.pool.clone());

    let antes = repo.desafios_hoje().await.unwrap();
    assert_eq!(antes.iter().find(|d| d.tipo == "concluir_blocos").unwrap().progresso, 0);

    // Só metade do planejado: ainda não conta como cumprido.
    lancar_tempo_manual(&db.pool, &dia, 15, bloco.id).await;
    let meio = repo.desafios_hoje().await.unwrap();
    assert_eq!(meio.iter().find(|d| d.tipo == "concluir_blocos").unwrap().progresso, 0);

    // Completa o restante: agora o bloco está cumprido.
    lancar_tempo_manual(&db.pool, &dia, 15, bloco.id).await;
    let depois = repo.desafios_hoje().await.unwrap();
    assert_eq!(depois.iter().find(|d| d.tipo == "concluir_blocos").unwrap().progresso, 1);

    db.teardown().await;
}

#[tokio::test]
async fn registrar_xp_desafio_diario_so_credita_apos_a_meta_e_e_idempotente() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-credito").await;
    let dia = hoje_local();
    let cronograma = CronogramaRepository::new(db.pool.clone());
    let repo = GamificacaoRepository::new(db.pool.clone());

    // Metas de "concluir_blocos" são [1, 2] — dois blocos cumpridos sempre
    // fecham a maior meta possível, sem depender de qual meta o hash do dia
    // escolheu.
    for _ in 0..2 {
        let bloco = cronograma.criar_bloco(&dia, "reading", 20, None, None, None, None, None, None).await.unwrap();
        lancar_tempo_manual(&db.pool, &dia, 20, bloco.id).await;
    }

    let desafios = repo.desafios_hoje().await.unwrap();
    let desafio = desafios.iter().find(|d| d.tipo == "concluir_blocos").unwrap();
    assert!(desafio.concluido, "2 blocos cumpridos tem que satisfazer a maior meta candidata (2)");

    let primeiro = repo.registrar_xp_desafio_diario("concluir_blocos").await.unwrap();
    assert!(!primeiro.ja_creditado);
    assert_eq!(primeiro.amount, XP_POR_DESAFIO_DIARIO);

    let segundo = repo.registrar_xp_desafio_diario("concluir_blocos").await.unwrap();
    assert!(segundo.ja_creditado, "creditar o mesmo desafio do mesmo dia de novo não pode gerar um segundo evento");
    assert_eq!(segundo.id, primeiro.id);

    assert_eq!(
        contar_xp_events(&db.pool, "desafio_diario", &format!("{dia}:concluir_blocos")).await,
        1,
        "só uma linha de XP para este desafio, neste dia"
    );

    db.teardown().await;
}

#[tokio::test]
async fn registrar_xp_desafio_diario_rejeita_desafio_ainda_nao_cumprido() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-nao-cumprido").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let result = repo.registrar_xp_desafio_diario("revisar_cartoes").await;
    assert!(matches!(result, Err(Error::Invalid(_))), "esperava Invalid (progresso 0 < meta), obtido {result:?}");

    db.teardown().await;
}

#[tokio::test]
async fn registrar_xp_desafio_diario_rejeita_tipo_desconhecido() {
    let db = IsolatedDatabase::setup("gamificacao-desafio-tipo-invalido").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let result = repo.registrar_xp_desafio_diario("almoco").await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

// ---- pomodoro / bloco: condição além de "existe" ----------------------

#[tokio::test]
async fn registrar_xp_pomodoro_concluido_rejeita_sessao_cancelada() {
    let db = IsolatedDatabase::setup("gamificacao-pomodoro-cancelado").await;
    let pomodoro = PomodoroRepository::new(db.pool.clone());
    let repo = GamificacaoRepository::new(db.pool.clone());

    let sessao = pomodoro.start("focus", 1500, None).await.unwrap();
    pomodoro.finish(sessao.id, false).await.unwrap();

    let result = repo.registrar_xp_pomodoro_concluido(sessao.id).await;
    assert!(matches!(result, Err(Error::Invalid(_))), "sessão cancelada não pode pagar XP, obtido {result:?}");

    db.teardown().await;
}

#[tokio::test]
async fn registrar_xp_bloco_cronograma_rejeita_bloco_incompleto_e_credita_apos_completar() {
    let db = IsolatedDatabase::setup("gamificacao-bloco-incompleto").await;
    let dia = hoje_local();
    let bloco = CronogramaRepository::new(db.pool.clone())
        .criar_bloco(&dia, "reading", 30, None, None, None, None, None, None)
        .await
        .unwrap();
    let repo = GamificacaoRepository::new(db.pool.clone());

    let incompleto = repo.registrar_xp_bloco_cronograma(bloco.id).await;
    assert!(matches!(incompleto, Err(Error::Invalid(_))), "0 de 30 minutos não pode ser creditado, obtido {incompleto:?}");

    lancar_tempo_manual(&db.pool, &dia, 30, bloco.id).await;
    let completo = repo.registrar_xp_bloco_cronograma(bloco.id).await.unwrap();
    assert_eq!(completo.amount, XP_POR_BLOCO_CRONOGRAMA);

    db.teardown().await;
}

#[tokio::test]
async fn registrar_xp_bloco_cronograma_com_id_inexistente_e_not_found() {
    let db = IsolatedDatabase::setup("gamificacao-bloco-inexistente").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let result = repo.registrar_xp_bloco_cronograma(Uuid::now_v7()).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    db.teardown().await;
}

// ---- borda de fuso ------------------------------------------------------

/// Mesma técnica de `tests/db_review_log.rs::revisao_perto_da_meia_noite_utc_cai_no_dia_local_certo`:
/// ancorar em `Utc::now()` e comparar contra o dia local que o PRÓPRIO
/// sistema em que o teste roda calcularia — assim o teste continua correto
/// em qualquer fuso onde a suíte rodar, sem fixar um offset arbitrário.
#[tokio::test]
async fn revisao_perto_da_meia_noite_utc_conta_no_desafio_do_dia_local_certo() {
    let db = IsolatedDatabase::setup("gamificacao-fuso").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let quase_meia_noite_utc = {
        let hoje_utc = Utc::now().date_naive();
        let ingenuo = NaiveDateTime::new(hoje_utc, NaiveTime::from_hms_milli_opt(23, 30, 0, 0).unwrap());
        Utc.from_utc_datetime(&ingenuo)
    };
    let dia_local_esperado = quase_meia_noite_utc.with_timezone(&Local).date_naive();
    let hoje_conforme_o_sistema = Utc::now().with_timezone(&Local).date_naive();

    inserir_revisao(&db.pool, card_id, quase_meia_noite_utc).await;

    let desafios = repo.desafios_hoje().await.unwrap();
    let progresso_hoje = desafios.iter().find(|d| d.tipo == "revisar_cartoes").unwrap().progresso;

    if dia_local_esperado == hoje_conforme_o_sistema {
        assert_eq!(progresso_hoje, 1, "23:30 UTC caiu no dia local de HOJE neste fuso — tem que contar");
    } else {
        // Fuso do sistema empurrou "23:30 UTC de hoje" para o dia local
        // seguinte (ainda não chegou) ou anterior (já passou) — em ambos os
        // casos não é "hoje" local, e não deve contar no desafio de hoje.
        assert_eq!(progresso_hoje, 0, "23:30 UTC não caiu no dia local de HOJE neste fuso — não pode contar");
    }

    db.teardown().await;
}

// ---- resumo de sessão --------------------------------------------------

#[tokio::test]
async fn resumo_de_sessao_soma_cartoes_tempo_e_xp_do_intervalo() {
    let db = IsolatedDatabase::setup("gamificacao-resumo").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let card_id = criar_cartao_no_baralho(&db.pool, deck.id, "Mitocôndria").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let inicio = Utc::now() - chrono::Duration::minutes(5);
    let review_id = inserir_revisao(&db.pool, card_id, Utc::now()).await;
    repo.registrar_xp_revisao_cartao(review_id).await.unwrap();
    let fim = Utc::now() + chrono::Duration::minutes(5);

    let resumo = repo.resumo_de_sessao(inicio, fim).await.unwrap();
    assert_eq!(resumo.cartoes_revisados, 1);
    assert_eq!(resumo.segundos_estudados, 1); // duration_ms = 1000 -> 1 s
    assert_eq!(resumo.xp_ganho, XP_POR_REVISAO_CARTAO);

    db.teardown().await;
}

#[tokio::test]
async fn resumo_de_sessao_rejeita_intervalo_com_fim_antes_do_inicio() {
    let db = IsolatedDatabase::setup("gamificacao-resumo-invertido").await;
    let repo = GamificacaoRepository::new(db.pool.clone());

    let agora = Utc::now();
    let result = repo.resumo_de_sessao(agora, agora - chrono::Duration::minutes(1)).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}
