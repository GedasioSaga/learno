#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::cards::CardRepository` (Fase 4, Peça 3) contra
//! um banco SQLite real — mesmo padrão de `tests/db_blocks.rs`: cada teste
//! cria seu próprio arquivo descartável via `support::IsolatedDatabase`, já
//! migrado, então a suíte roda num `cargo test` limpo sem preparação nenhuma.
//!
//! Prova o efeito pedido pela tarefa desta peça, não a fórmula: responder
//! "good" três vezes tira um cartão de `new` e o deixa em `review` com `due`
//! no futuro; responder "again" numa revisão devolve para `relearning` e
//! incrementa `lapses`; e `review_log` ganha uma linha por resposta —
//! executado contra o agendador de verdade (`crate::srs`), não uma cópia.

mod support;

use chrono::Utc;
use learno_lib::db::{CardRepository, DeckRepository, GamificacaoRepository, NoteRepository, NoteTypeRepository, XP_POR_REVISAO_CARTAO};
use learno_lib::db::ids::{DbId, IdBind};
use learno_lib::srs::fsrs;
use learno_lib::srs::Avaliacao;
use learno_lib::Error;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

/// Grava `decks.options` diretamente por SQL — o mesmo JSON que
/// `set_deck_scheduling_options` (comando IPC) escreveria, sem depender do
/// tipo `OpcoesDeDeckJson` (que vive em `db::cards`, não reexportado por
/// `db::mod` para o resto do crate por nome curto). É o suficiente para
/// simular "alguém trocou o baralho para FSRS" sem testar a camada IPC aqui
/// — essa camada tem seu próprio teste dedicado em `ipc::deck_commands`.
async fn configurar_baralho_como_fsrs(pool: &SqlitePool, deck_id: Uuid) {
    sqlx::query(r#"UPDATE decks SET options = '{"agendador":"fsrs"}' WHERE id = ?"#)
        .bind(deck_id.db())
        .execute(pool)
        .await
        .unwrap();
}

/// Cria um baralho, garante o tipo de nota "Básico" (semeado por
/// `NoteTypeRepository::list`) e cria uma nota nele — o que, na mesma
/// transação de `NoteRepository::create`, gera exatamente um cartão novo.
/// Devolve o id desse cartão, lido direto da tabela: `NoteRepository::create`
/// devolve a `NoteRow`, não os cartões que ela gerou.
/// Os valores de campo do tipo de nota "Básico", por NOME — o contrato de
/// `NoteRepository::create` é um mapa, e não uma lista posicional, para que
/// renomear ou reordenar um campo do tipo de nota não desloque em silêncio o
/// conteúdo de toda nota já gravada.
fn campos_frente_verso(frente: &str, verso: &str) -> learno_lib::db::FieldValues {
    [("Frente".to_string(), frente.to_string()), ("Verso".to_string(), verso.to_string())]
        .into_iter()
        .collect()
}

async fn deck_com_um_cartao_novo(pool: &SqlitePool) -> Uuid {
    let deck = DeckRepository::new(pool.clone()).create(None, "Biologia").await.unwrap();
    let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note = NoteRepository::new(pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Mitocôndria", "Organela da célula"), vec![])
        .await
        .unwrap();

    sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(pool)
        .await
        .unwrap()
        .into()
}

async fn estado_do_cartao(pool: &SqlitePool, card_id: Uuid) -> (String, i64) {
    sqlx::query_as::<_, (String, i64)>("SELECT state, lapses FROM cards WHERE id = ?")
        .bind(card_id.db())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn um_cartao_novo_aparece_via_next_card_e_conta_em_deck_counts() {
    let db = IsolatedDatabase::setup("cards-novo").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());

    let counts = cards.deck_counts(None).await.unwrap();
    assert_eq!(counts.novos, 1, "um cartão novo recém-criado devia contar em `novos`");
    assert_eq!(counts.aprendendo, 0);
    assert_eq!(counts.revisar, 0);

    let proximo = cards.next_card(None).await.unwrap().expect("fila não devia estar vazia");
    assert_eq!(proximo.card.id, card_id);
    assert_eq!(proximo.card.state, "new");
    // `field_names` segue a ordem de `note_types.fields` ("Frente", "Verso"
    // no tipo "Básico") — não a ordem em que o objeto JSON por acaso guarda —
    // e `fields` dá o acesso por nome, que é como a tela de estudo lê.
    //
    // Eram uma coisa só, um `Vec<String>` de valores em ordem, e a tela
    // indexava por nome: `fields["Frente"]` num vetor devolve `undefined` em
    // JavaScript, sem erro, e o cartão aparecia como "(sem conteúdo)" com o
    // conteúdo íntegro no banco.
    assert_eq!(proximo.field_names, vec!["Frente".to_string(), "Verso".to_string()]);
    assert_eq!(proximo.fields.get("Frente").map(String::as_str), Some("Mitocôndria"));
    assert_eq!(proximo.fields.get("Verso").map(String::as_str), Some("Organela da célula"));
    assert!(
        proximo.field_names.iter().all(|nome| proximo.fields.contains_key(nome)),
        "todo nome anunciado na ordem precisa existir no mapa"
    );

    db.teardown().await;
}

/// O efeito central desta peça: três "good" a partir de `new` terminam em
/// `review` com `due` no futuro — não importa em quantos passos de
/// aprendizagem o preset padrão gradua, só que ele gradua e depois continua
/// avançando em `review`.
#[tokio::test]
async fn responder_good_tres_vezes_leva_o_cartao_de_novo_a_revisao_com_due_no_futuro() {
    let db = IsolatedDatabase::setup("cards-tres-good").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());
    let antes = Utc::now();

    for _ in 0..3 {
        cards.answer_card(card_id, "good").await.unwrap();
    }

    let (state, _lapses) = estado_do_cartao(&db.pool, card_id).await;
    assert_eq!(state, "review");

    let due: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT due FROM cards WHERE id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert!(due.is_some_and(|d| d > antes), "devido precisa estar no futuro, obtido {due:?}");

    // A fila avançou de verdade: o mesmo cartão, já agendado para o futuro,
    // não pode ser oferecido de novo — o defeito clássico que a tarefa nomeia
    // ("next_card devolvendo sempre o mesmo cartão").
    assert!(cards.next_card(None).await.unwrap().is_none(), "nada mais devia estar pronto para estudar agora");

    db.teardown().await;
}

/// "Again" numa revisão é um lapso: volta para `relearning` e incrementa
/// `lapses` — nunca fica em `review` respondendo errado.
#[tokio::test]
async fn responder_again_em_revisao_volta_para_relearning_e_incrementa_lapses() {
    let db = IsolatedDatabase::setup("cards-again-relapso").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());

    // Leva o cartão a `review` primeiro — "easy" gradua na hora, sem depender
    // de quantos passos de aprendizagem o preset padrão configura.
    cards.answer_card(card_id, "easy").await.unwrap();
    let (state_apos_easy, lapses_apos_easy) = estado_do_cartao(&db.pool, card_id).await;
    assert_eq!(state_apos_easy, "review", "'easy' devia graduar direto para revisão");
    assert_eq!(lapses_apos_easy, 0);

    cards.answer_card(card_id, "again").await.unwrap();

    let (state, lapses) = estado_do_cartao(&db.pool, card_id).await;
    assert_eq!(state, "relearning");
    assert_eq!(lapses, 1);

    db.teardown().await;
}

/// `answer_card` grava `cards` e `review_log` na MESMA transação — sem isso a
/// estatística mentiria na primeira queda de energia entre as duas escritas.
#[tokio::test]
async fn cada_resposta_grava_exatamente_uma_linha_em_review_log() {
    let db = IsolatedDatabase::setup("cards-review-log").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());

    for nota in ["good", "good", "again", "good"] {
        cards.answer_card(card_id, nota).await.unwrap();
    }

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM review_log WHERE card_id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(total, 4, "quatro respostas precisam produzir exatamente quatro linhas de histórico");

    let primeiro_rating: i64 = sqlx::query_scalar("SELECT rating FROM review_log WHERE card_id = ? ORDER BY rowid ASC LIMIT 1")
        .bind(card_id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(primeiro_rating, 3, "'good' precisa gravar rating=3 (convenção do Anki: 1=Again 2=Hard 3=Good 4=Easy)");

    let estados_iniciais: String =
        sqlx::query_scalar("SELECT state_before FROM review_log WHERE card_id = ? ORDER BY rowid ASC LIMIT 1")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(estados_iniciais, "new", "a primeira resposta parte de um cartão que ainda era 'new'");

    db.teardown().await;
}

/// Cartão suspenso não pode ser respondido — a checagem de
/// `CardRepository::answer_card`, não só a exclusão da fila.
#[tokio::test]
async fn responder_um_cartao_suspenso_e_rejeitado() {
    let db = IsolatedDatabase::setup("cards-suspenso").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    sqlx::query("UPDATE cards SET suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .bind(card_id.db())
        .execute(&db.pool)
        .await
        .unwrap();
    let cards = CardRepository::new(db.pool.clone());

    let resultado = cards.answer_card(card_id, "good").await;
    assert!(matches!(resultado, Err(learno_lib::Error::Invalid(_))));

    // E não aparece na fila.
    assert!(cards.next_card(None).await.unwrap().is_none());

    db.teardown().await;
}

/// `deck_forecast` soma um cartão agendado para daqui a alguns dias no balde
/// certo, e nenhum cartão `new` (sem `due`) aparece em previsão nenhuma.
#[tokio::test]
async fn deck_forecast_conta_um_cartao_agendado_e_ignora_cartoes_novos() {
    let db = IsolatedDatabase::setup("cards-forecast").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());

    cards.answer_card(card_id, "easy").await.unwrap(); // gradua direto para `review`

    let previsao = cards.deck_forecast(None, 30).await.unwrap();
    assert_eq!(previsao.len(), 30);

    let total: i64 = previsao.iter().map(|dia| dia.quantidade).sum();
    assert_eq!(total, 1, "o único cartão da suíte precisa aparecer em exatamente um dia da previsão");

    db.teardown().await;
}

#[tokio::test]
async fn deck_forecast_rejeita_dias_fora_do_intervalo_permitido() {
    let db = IsolatedDatabase::setup("cards-forecast-invalido").await;
    let cards = CardRepository::new(db.pool.clone());

    assert!(cards.deck_forecast(None, 0).await.is_err());
    assert!(cards.deck_forecast(None, -1).await.is_err());

    db.teardown().await;
}

// ---------------------------------------------------------------------
// XP de revisão: `answer_card` credita sozinho, na mesma transação — a
// peça que corrige o achado "revisar cartão nunca deu XP nenhum" (os três
// comandos `registrar_xp_*` existiam, mas nenhuma tela tinha como chamá-los).
// ---------------------------------------------------------------------

async fn contar_xp_events_de_revisao(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM xp_events WHERE origin = 'card_review'").fetch_one(pool).await.unwrap()
}

/// O id de `review_log` mais recente para `card_id` — usado para provar que
/// reprocessar a MESMA linha (via o comando de backfill) não dobra XP que
/// `answer_card` já creditou sozinho.
async fn ultima_revisao_do_cartao(pool: &SqlitePool, card_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, DbId>("SELECT id FROM review_log WHERE card_id = ? ORDER BY rowid DESC LIMIT 1")
        .bind(card_id.db())
        .fetch_one(pool)
        .await
        .unwrap()
        .into()
}

/// O efeito central desta peça: responder um cartão credita XP sozinho, sem
/// nenhuma chamada extra — e responder de NOVO o MESMO cartão credita de
/// NOVO (é uma revisão nova, com `review_log_id` novo, não a mesma linha
/// creditada duas vezes).
#[tokio::test]
async fn responder_um_cartao_credita_xp_e_responder_de_novo_credita_xp_novo() {
    let db = IsolatedDatabase::setup("cards-xp-revisao").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());
    let gamificacao = GamificacaoRepository::new(db.pool.clone());

    cards.answer_card(card_id, "good").await.unwrap();
    assert_eq!(gamificacao.xp_total().await.unwrap(), XP_POR_REVISAO_CARTAO, "a primeira resposta tem que creditar XP sozinha");
    assert_eq!(contar_xp_events_de_revisao(&db.pool).await, 1);

    cards.answer_card(card_id, "good").await.unwrap();
    assert_eq!(
        gamificacao.xp_total().await.unwrap(),
        XP_POR_REVISAO_CARTAO * 2,
        "responder de novo é uma revisão NOVA — precisa creditar XP de novo, não ficar preso na primeira"
    );
    assert_eq!(contar_xp_events_de_revisao(&db.pool).await, 2, "duas respostas, duas linhas de XP — o UNIQUE não pode rejeitar a segunda");

    db.teardown().await;
}

/// Reprocessar (via o comando de backfill `registrar_xp_revisao_cartao`) a
/// MESMA linha de `review_log` que `answer_card` já creditou sozinho não
/// dobra a XP — a `UNIQUE (origin, reference_id)` do schema cobre, e a
/// segunda chamada devolve `ja_creditado = true` sobre a MESMA linha.
#[tokio::test]
async fn reprocessar_a_mesma_linha_de_review_log_nao_dobra_a_xp() {
    let db = IsolatedDatabase::setup("cards-xp-reprocesso").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());
    let gamificacao = GamificacaoRepository::new(db.pool.clone());

    cards.answer_card(card_id, "good").await.unwrap();
    let review_log_id = ultima_revisao_do_cartao(&db.pool, card_id).await;
    assert_eq!(gamificacao.xp_total().await.unwrap(), XP_POR_REVISAO_CARTAO);

    let reprocessado = gamificacao.registrar_xp_revisao_cartao(review_log_id).await.unwrap();
    assert!(reprocessado.ja_creditado, "answer_card já tinha creditado esta linha — o reprocesso só devia ENXERGAR o evento existente");
    assert_eq!(
        gamificacao.xp_total().await.unwrap(),
        XP_POR_REVISAO_CARTAO,
        "reprocessar a mesma linha não pode dobrar o total"
    );
    assert_eq!(contar_xp_events_de_revisao(&db.pool).await, 1);

    db.teardown().await;
}

/// N revisões creditam exatamente N vezes a constante — sem depender de
/// quantas respostas o preset de agendamento levou para graduar o cartão.
#[tokio::test]
async fn xp_total_apos_n_revisoes_bate_com_n_vezes_a_constante() {
    let db = IsolatedDatabase::setup("cards-xp-n-revisoes").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());
    let gamificacao = GamificacaoRepository::new(db.pool.clone());

    const N: i64 = 5;
    for _ in 0..N {
        cards.answer_card(card_id, "good").await.unwrap();
    }

    assert_eq!(gamificacao.xp_total().await.unwrap(), XP_POR_REVISAO_CARTAO * N);
    assert_eq!(contar_xp_events_de_revisao(&db.pool).await, N);

    db.teardown().await;
}

/// A ARMADILHA CENTRAL: se a escrita de XP falhar de verdade, a transação
/// inteira reverte — o cartão NÃO fica reagendado sem a contrapartida de XP.
/// Simula a falha derrubando a tabela `xp_events` antes de responder: o
/// `INSERT` de XP dentro de `answer_card` esbarra em "no such table" (um erro
/// real de banco, não o caminho normal de `ON CONFLICT`), e a prova é que
/// NADA do que `answer_card` tentou gravar sobrevive — nem `cards`, nem
/// `review_log`.
#[tokio::test]
async fn falha_ao_creditar_xp_reverte_a_transacao_inteira_sem_perder_nem_reagendar_o_cartao() {
    let db = IsolatedDatabase::setup("cards-xp-falha").await;
    let card_id = deck_com_um_cartao_novo(&db.pool).await;
    let cards = CardRepository::new(db.pool.clone());

    sqlx::query("DROP TABLE xp_events").execute(&db.pool).await.unwrap();

    let resultado = cards.answer_card(card_id, "good").await;
    assert!(resultado.is_err(), "sem a tabela de XP o crédito tem que falhar, e o erro tem que subir");
    assert!(!matches!(resultado, Err(Error::Invalid(_))), "a falha aqui é de banco, não de validação de entrada");

    let (state, reps) = estado_do_cartao(&db.pool, card_id).await;
    assert_eq!(state, "new", "a transação revertida não pode deixar o cartão reagendado");
    assert_eq!(reps, 0, "reps não pode ter avançado se a transação reverteu");

    let due: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT due FROM cards WHERE id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(due, None, "due não pode ter sido gravado se a transação reverteu");

    let revisoes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM review_log WHERE card_id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(revisoes, 0, "nenhuma linha de review_log pode sobreviver a uma transação revertida");

    db.teardown().await;
}

// ---------------------------------------------------------------------
// FSRS: o caminho ponta a ponta que esta peça liga — baralho configurado
// como FSRS, cartão nascendo com esse `scheduler`, `answer_card` despachando
// para `crate::srs::fsrs::agendar` de verdade (não uma cópia), e a decisão
// de migração SM-2 → FSRS documentada em `CardRepository::answer_card`.
// ---------------------------------------------------------------------

/// O efeito central desta peça: um baralho configurado FSRS produz um
/// cartão `scheduler = 'fsrs'`, e responder esse cartão grava `due`,
/// `fsrs_stability` e `fsrs_difficulty` com os MESMOS valores que
/// `crate::srs::fsrs::agendar` (chamado aqui, de fora, contra o mesmo
/// estado inicial) devolve para "cartão novo + nota good" — nunca uma
/// aproximação, nunca "não deu erro".
#[tokio::test]
async fn cartao_fsrs_criado_em_baralho_fsrs_e_agendado_pelo_nucleo_fsrs_de_verdade() {
    let db = IsolatedDatabase::setup("cards-fsrs-e2e").await;

    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia (FSRS)").await.unwrap();
    // Configura o baralho como FSRS ANTES de criar a nota — item 3 desta
    // peça: o cartão precisa nascer com o `scheduler` que o baralho tem
    // NESTE instante, não com o default `sm2` da coluna.
    configurar_baralho_como_fsrs(&db.pool, deck.id).await;

    let note_type = NoteTypeRepository::new(db.pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note = NoteRepository::new(db.pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Mitocôndria", "Organela da célula"), vec![])
        .await
        .unwrap();
    let card_id: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .into();

    let scheduler_no_nascimento: String =
        sqlx::query_scalar("SELECT scheduler FROM cards WHERE id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(scheduler_no_nascimento, "fsrs", "cartão criado num baralho FSRS precisa nascer 'fsrs', não o default 'sm2' da coluna");

    let cards = CardRepository::new(db.pool.clone());
    let antes = Utc::now();
    cards.answer_card(card_id, "good").await.unwrap();
    let depois = Utc::now();

    let (state, due, fsrs_stability, fsrs_difficulty): (String, Option<chrono::DateTime<Utc>>, Option<f64>, Option<f64>) =
        sqlx::query_as("SELECT state, due, fsrs_stability, fsrs_difficulty FROM cards WHERE id = ?")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();

    // Preset padrão (`learning_steps_min: [1, 10]`, em minutos = [60, 600]
    // segundos): "good" no primeiro passo de aprendizagem avança para o
    // segundo passo, não gradua ainda — fica em `learning`.
    assert_eq!(state, "learning", "'good' no primeiro passo de aprendizagem não gradua com o preset padrão (dois passos)");

    // Recalcula, de fora, o que `crate::srs::fsrs::agendar` deveria ter
    // produzido para ESTA MESMA transição (cartão novo, nota "good", pesos
    // e passos padrão — o baralho só mudou `agendador`, o resto ficou
    // default). Nem `agora` nem a semente do fuzz importam para o valor de
    // `estabilidade`/`dificuldade` aqui: memória de um cartão SEM histórico
    // não depende de nenhum dos dois (só de `pesos` e da nota) — e esta
    // transição não gradua, então o fuzz (que só entra ao graduar) também
    // não entra em jogo.
    let esperado = fsrs::agendar(&fsrs::EstadoCartao::novo(), Avaliacao::Good, &fsrs::Parametros::default(), antes, 0);
    let memoria_esperada = esperado.estado.memoria.expect("primeira resposta sempre grava memória");

    let stability = fsrs_stability.expect("cartão fsrs respondido precisa gravar fsrs_stability");
    let difficulty = fsrs_difficulty.expect("cartão fsrs respondido precisa gravar fsrs_difficulty");
    assert!(
        (stability - memoria_esperada.estabilidade).abs() < 1e-9,
        "fsrs_stability gravada {stability} != esperada {}",
        memoria_esperada.estabilidade
    );
    assert!(
        (difficulty - memoria_esperada.dificuldade).abs() < 1e-9,
        "fsrs_difficulty gravada {difficulty} != esperada {}",
        memoria_esperada.dificuldade
    );

    // `due`: o atraso do segundo passo (600s) somado a `agora` — não
    // depende de qual `agora` exato `answer_card` usou por dentro (só do
    // deslocamento fixo), então basta provar que `due` cai entre
    // `antes + deslocamento` e `depois + deslocamento` (a janela real de
    // execução deste teste). Folga de 2ms na borda inferior:
    // `formatar_timestamp` grava só 3 casas decimais de segundo
    // (truncando, não arredondando — `db::cards::formatar_timestamp`), então
    // o valor lido do banco pode ser até ~1ms MENOR que o instante exato
    // calculado em memória, mesmo sem nenhum erro de agendamento.
    let deslocamento_esperado = esperado.proxima_revisao - antes;
    let due = due.expect("cartão respondido precisa ter due gravado");
    assert!(
        due >= antes + deslocamento_esperado - chrono::Duration::milliseconds(2),
        "devido {due} não pode ser antes de {}",
        antes + deslocamento_esperado
    );
    assert!(
        due <= depois + deslocamento_esperado + chrono::Duration::seconds(1),
        "devido {due} muito depois do esperado (folga de execução do teste estourada)"
    );

    // E `review_log` grava o agendador VERDADEIRO desta resposta, não um
    // valor fixo "sm2" — a lacuna que o item 2 desta peça fecha.
    let scheduler_no_log: String =
        sqlx::query_scalar("SELECT scheduler FROM review_log WHERE card_id = ? ORDER BY rowid DESC LIMIT 1")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(scheduler_no_log, "fsrs");
    let ease_no_log: Option<i64> =
        sqlx::query_scalar("SELECT ease_factor_after FROM review_log WHERE card_id = ? ORDER BY rowid DESC LIMIT 1")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(ease_no_log, None, "revisão sob FSRS não tem 'ease depois' — a coluna precisa ficar NULL, não um número que não significa nada");

    db.teardown().await;
}

/// A DECISÃO DE MIGRAÇÃO desta peça (documentada no braço "fsrs" de
/// `CardRepository::answer_card`): um cartão SM-2 que já existe continua em
/// SM-2 até o fim da vida dele, mesmo depois que o baralho passa a ser
/// configurado como FSRS — só cartão criado DAQUI PRA FRENTE nasce sob o
/// novo agendador. Nenhum cartão em circulação é reinterpretado em
/// silêncio.
#[tokio::test]
async fn trocar_o_baralho_para_fsrs_nao_migra_cartao_sm2_existente_so_afeta_o_novo() {
    let db = IsolatedDatabase::setup("cards-migracao-fsrs").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia").await.unwrap();
    let note_type = NoteTypeRepository::new(db.pool.clone()).list().await.unwrap().into_iter().next().unwrap();

    // Cartão criado ENQUANTO o baralho ainda é SM-2 (default de fábrica).
    let nota_antiga = NoteRepository::new(db.pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Mitocôndria", "Organela"), vec![])
        .await
        .unwrap();
    let card_id_antigo: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(nota_antiga.id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .into();

    // Agora o baralho passa a ser configurado como FSRS.
    configurar_baralho_como_fsrs(&db.pool, deck.id).await;

    // Cartão NOVO, criado DEPOIS da troca.
    let nota_nova = NoteRepository::new(db.pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Ribossomo", "Organela"), vec![])
        .await
        .unwrap();
    let card_id_novo: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(nota_nova.id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .into();

    let scheduler_antigo: String =
        sqlx::query_scalar("SELECT scheduler FROM cards WHERE id = ?").bind(card_id_antigo.db()).fetch_one(&db.pool).await.unwrap();
    let scheduler_novo: String =
        sqlx::query_scalar("SELECT scheduler FROM cards WHERE id = ?").bind(card_id_novo.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(scheduler_antigo, "sm2", "cartão criado antes da troca precisa continuar sm2 para sempre");
    assert_eq!(scheduler_novo, "fsrs", "cartão criado depois da troca precisa nascer fsrs");

    let cards = CardRepository::new(db.pool.clone());
    cards.answer_card(card_id_antigo, "good").await.unwrap();

    // Responder o cartão ANTIGO continua usando SM-2 de verdade: o
    // `scheduler` dele não muda sozinho, e `fsrs_stability` continua NULL —
    // nunca escrito por um cartão que nunca foi FSRS.
    let (scheduler_apos, ease_factor, fsrs_stability): (String, i64, Option<f64>) =
        sqlx::query_as("SELECT scheduler, ease_factor, fsrs_stability FROM cards WHERE id = ?")
            .bind(card_id_antigo.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(scheduler_apos, "sm2", "responder um cartão não pode migrar o agendador dele sozinho");
    assert_eq!(ease_factor, 250, "sm2 com 'good' no primeiro passo de aprendizagem mantém o ease (só muda em Review)");
    assert_eq!(fsrs_stability, None, "cartão sm2 nunca escreve fsrs_stability, mesmo depois do baralho virar fsrs");

    let scheduler_no_log: String =
        sqlx::query_scalar("SELECT scheduler FROM review_log WHERE card_id = ? ORDER BY rowid DESC LIMIT 1")
            .bind(card_id_antigo.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(scheduler_no_log, "sm2", "review_log precisa gravar o agendador verdadeiro da resposta, não o do baralho hoje");

    db.teardown().await;
}

// ---------------------------------------------------------------------
// Achado de revisão adversarial sobre a costura FSRS: `Memoria::ultima_revisao`
// precisa vir de uma fonte de verdade DEDICADA (`cards.fsrs_last_review_at`,
// `0039_cards_fsrs_last_review_at.sql`), nunca de `cards.updated_at` — essa
// coluna é tocada pelo trigger `cards_set_updated_at` em QUALQUER `UPDATE`
// na tabela, não só numa revisão de verdade.
// ---------------------------------------------------------------------

/// A PROVA que faltava: duas respostas de verdade num cartão FSRS,
/// atravessando o banco, com um TOQUE ESPÚRIO na linha entre as duas (um
/// `UPDATE` que não é uma revisão — a preocupação real do achado: "enterrar
/// cartão", mover de baralho, ou qualquer outro `UPDATE` futuro). O trigger
/// bate `updated_at` para AGORA nesse toque; a coluna dedicada
/// `fsrs_last_review_at` continua apontando para a PRIMEIRA revisão real,
/// dez dias atrás (simulados por backdate, já que o teste não pode esperar
/// dez dias de verdade). A segunda resposta precisa calcular
/// `elapsed_days` a partir da primeira revisão real, não do toque espúrio —
/// as duas leituras produzem estabilidade/dificuldade MATERIALMENTE
/// diferentes (fórmula de longo prazo vs. fórmula de curto prazo), então a
/// asserção final discrimina de verdade, não por coincidência de ponto
/// flutuante.
#[tokio::test]
async fn responder_um_cartao_fsrs_duas_vezes_usa_a_ultima_revisao_real_nao_um_toque_qualquer_na_linha() {
    let db = IsolatedDatabase::setup("cards-fsrs-ultima-revisao-real").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia (FSRS)").await.unwrap();
    configurar_baralho_como_fsrs(&db.pool, deck.id).await;

    let note_type = NoteTypeRepository::new(db.pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note = NoteRepository::new(db.pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Ribossomo", "Organela"), vec![])
        .await
        .unwrap();
    let card_id: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .into();

    let cards = CardRepository::new(db.pool.clone());

    // Primeira resposta REAL: "easy" gradua na hora para `review` sob
    // qualquer preset (pula os passos de aprendizagem inteiros) — garante
    // que a segunda resposta cai no braço de `Review` (`atualizar_memoria`
    // com `dias_desde` calculado de verdade), não mais um passo de
    // aprendizagem.
    cards.answer_card(card_id, "easy").await.unwrap();

    let (estabilidade_1, dificuldade_1, ultima_revisao_1): (f64, f64, chrono::DateTime<Utc>) =
        sqlx::query_as("SELECT fsrs_stability, fsrs_difficulty, fsrs_last_review_at FROM cards WHERE id = ?")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();

    // Simula "dez dias se passaram desde a revisão real": backdate SÓ a
    // coluna dedicada — é exatamente o que uma revisão de verdade, dez dias
    // atrás, teria gravado.
    let dez_dias_atras = ultima_revisao_1 - chrono::Duration::days(10);
    sqlx::query("UPDATE cards SET fsrs_last_review_at = ? WHERE id = ?")
        .bind(dez_dias_atras.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .bind(card_id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    // O TOQUE ESPÚRIO: um `UPDATE` na linha que NÃO é uma revisão. Bate
    // `updated_at` para agora (o trigger `cards_set_updated_at` não filtra
    // por coluna) — bem longe do backdate acima.
    sqlx::query("UPDATE cards SET flags = flags WHERE id = ?").bind(card_id.db()).execute(&db.pool).await.unwrap();

    let (updated_at_apos_toque, ultima_revisao_apos_toque): (chrono::DateTime<Utc>, chrono::DateTime<Utc>) =
        sqlx::query_as("SELECT updated_at, fsrs_last_review_at FROM cards WHERE id = ?")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(
        (Utc::now() - updated_at_apos_toque).num_seconds() < 10,
        "pré-condição do teste: o toque espúrio precisa ter batido `updated_at` para AGORA"
    );
    assert!(
        (updated_at_apos_toque - ultima_revisao_apos_toque).num_days() >= 9,
        "pré-condição do teste: `updated_at` e `fsrs_last_review_at` precisam DIVERGIR por vários dias, \
         senão o teste não discrimina nada"
    );

    // Segunda resposta REAL.
    cards.answer_card(card_id, "good").await.unwrap();

    let (estabilidade_2, dificuldade_2): (f64, f64) =
        sqlx::query_as("SELECT fsrs_stability, fsrs_difficulty FROM cards WHERE id = ?")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();

    // O valor CORRETO: `elapsed_days` medido a partir da PRIMEIRA revisão
    // real (dez dias atrás) — calculado aqui de fora com `crate::srs::fsrs`
    // diretamente, não uma cópia da fórmula.
    let agora_do_calculo = Utc::now();
    let memoria_correta =
        fsrs::Memoria { estabilidade: estabilidade_1, dificuldade: dificuldade_1, ultima_revisao: dez_dias_atras };
    let esperado_correto = fsrs::agendar(
        &fsrs::EstadoCartao { fase: learno_lib::srs::Fase::Review, step: None, memoria: Some(memoria_correta) },
        Avaliacao::Good,
        &fsrs::Parametros::default(),
        agora_do_calculo,
        0,
    );
    let memoria_esperada_correta = esperado_correto.estado.memoria.expect("segunda resposta sempre grava memória");

    // O valor ERRADO que o defeito do achado 1 produziria: a mesma chamada,
    // só trocando `ultima_revisao` pelo instante do TOQUE ESPÚRIO — a
    // fórmula de curto prazo (`dias_desde < 1`) em vez da de longo prazo.
    let memoria_errada = fsrs::Memoria {
        estabilidade: estabilidade_1,
        dificuldade: dificuldade_1,
        ultima_revisao: updated_at_apos_toque,
    };
    let esperado_errado = fsrs::agendar(
        &fsrs::EstadoCartao { fase: learno_lib::srs::Fase::Review, step: None, memoria: Some(memoria_errada) },
        Avaliacao::Good,
        &fsrs::Parametros::default(),
        agora_do_calculo,
        0,
    );
    let memoria_esperada_errada = esperado_errado.estado.memoria.expect("segunda resposta sempre grava memória");

    // As duas fórmulas de fato divergem o bastante para o teste discriminar
    // — senão a asserção final passaria por coincidência de ponto
    // flutuante, não por provar a fonte de verdade certa.
    assert!(
        (memoria_esperada_correta.estabilidade - memoria_esperada_errada.estabilidade).abs() > 0.01,
        "o teste não discrimina: elapsed_days=10 e elapsed_days~0 produziram estabilidades quase iguais \
         ({} vs {})",
        memoria_esperada_correta.estabilidade,
        memoria_esperada_errada.estabilidade
    );

    assert!(
        (estabilidade_2 - memoria_esperada_correta.estabilidade).abs() < 1e-6,
        "fsrs_stability da segunda resposta ({estabilidade_2}) precisa bater com elapsed_days medido da \
         PRIMEIRA revisão real ({}), não do toque espúrio",
        memoria_esperada_correta.estabilidade
    );
    assert!(
        (dificuldade_2 - memoria_esperada_correta.dificuldade).abs() < 1e-6,
        "fsrs_difficulty da segunda resposta ({dificuldade_2}) precisa bater com elapsed_days medido da \
         PRIMEIRA revisão real ({}), não do toque espúrio",
        memoria_esperada_correta.dificuldade
    );
    assert!(
        (estabilidade_2 - memoria_esperada_errada.estabilidade).abs() > 0.01,
        "fsrs_stability da segunda resposta bateu com o valor que `updated_at` (o toque espúrio) produziria \
         — a regressão do achado 1 voltou"
    );

    db.teardown().await;
}

/// Achado 2 (baixo): no braço FSRS, `interval_dias` precisa ser `0` enquanto
/// o cartão continua num passo de aprendizagem/reaprendizagem — o atraso ali
/// é em SEGUNDOS, não em dias, e o braço SM-2 já grava `0` explicitamente
/// nessa fase (`agendar_em_aprendizagem`/`agendar_em_reaprendizagem` em
/// `crate::srs`). Um `learning_steps_min` configurado acima de 1440 (nada
/// impede) faria `(proxima_revisao - agora).num_days()` mostrar um número de
/// dias positivo para um cartão que nem saiu de `learning` — este teste
/// cobre exatamente esse caso de borda, não o caminho feliz (onde o atraso
/// de minutos nunca cruzaria um dia inteiro por acidente).
#[tokio::test]
async fn cartao_fsrs_com_passo_de_aprendizagem_acima_de_um_dia_grava_interval_dias_zero() {
    let db = IsolatedDatabase::setup("cards-fsrs-interval-zero-em-learning").await;
    let deck = DeckRepository::new(db.pool.clone()).create(None, "Biologia (FSRS)").await.unwrap();
    // `learning_steps_min: [2000]` (2000 min = 33h20 > 1 dia) e
    // `fuzz_habilitado: false` (irrelevante aqui, mas deixa o teste livre de
    // qualquer jitter) — configurado por SQL direto, o mesmo padrão de
    // `configurar_baralho_como_fsrs`.
    sqlx::query(r#"UPDATE decks SET options = '{"agendador":"fsrs","learning_steps_min":[2000],"fuzz_habilitado":false}' WHERE id = ?"#)
        .bind(deck.id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let note_type = NoteTypeRepository::new(db.pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    let note = NoteRepository::new(db.pool.clone())
        .create(deck.id, note_type.id, campos_frente_verso("Complexo de Golgi", "Organela"), vec![])
        .await
        .unwrap();
    let card_id: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
        .bind(note.id.db())
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .into();

    let cards = CardRepository::new(db.pool.clone());
    // "hard" no primeiro (e único) passo de aprendizagem: repete o mesmo
    // passo (2000 min de atraso), não gradua — continua em `learning`.
    let resultado = cards.answer_card(card_id, "hard").await.unwrap();

    assert_eq!(resultado.estado, "learning", "com um único passo de 2000min, 'hard' não gradua");
    assert_eq!(
        resultado.intervalo_dias, 0,
        "cartão ainda em 'learning' não pode reportar dias de intervalo, mesmo com um passo > 1440min"
    );

    let (state, interval_days): (String, i64) =
        sqlx::query_as("SELECT state, interval_days FROM cards WHERE id = ?").bind(card_id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(state, "learning");
    assert_eq!(interval_days, 0, "cards.interval_days gravado precisa ser 0 enquanto o cartão está em learning/relearning");

    let interval_after_no_log: i64 =
        sqlx::query_scalar("SELECT interval_after FROM review_log WHERE card_id = ? ORDER BY rowid DESC LIMIT 1")
            .bind(card_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(interval_after_no_log, 0);

    db.teardown().await;
}
