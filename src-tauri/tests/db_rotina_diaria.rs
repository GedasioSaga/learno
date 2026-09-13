#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Testes de integração de `0042_rotina_diaria.sql` + `db::cronograma`
//! (rotina/item/`aplicar_rotina`) contra um banco SQLite real.
//!
//! Cobre, nesta ordem: CRUD de rotina, CRUD de item (inclusive os CHECKs
//! novos da migração), `ON DELETE CASCADE` do item quando a rotina some, e
//! `aplicar_rotina` — dia vazio, idempotência, recusa de dia passado, e dia
//! com um bloco qualquer sendo pulado inteiro. A fixture de
//! `aplicar_rotina` é a rotina real do usuário (14 itens, 04:40 → 20:40,
//! 960 minutos) descrita no plano.

mod support;

use chrono::{Duration, Local};
use learno_lib::db::{CronogramaRepository, ItemDeRotinaPatchInput, ModoDeAplicacaoDeRotina, RotinaPatchInput};
use learno_lib::error::Error;
use support::IsolatedDatabase;
use uuid::Uuid;

fn hoje_local() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn dias_a_partir_de_hoje(offset: i64) -> String {
    (Local::now().date_naive() + Duration::days(offset)).format("%Y-%m-%d").to_string()
}

/// A rotina real do usuário (ver o plano): 14 itens, 04:40 às 20:40, 960
/// minutos, sem buraco e sem sobreposição. `(hora, minutos, título)`.
const ROTINA_DO_USUARIO: [(&str, i64, &str); 14] = [
    ("04:40", 20, "Higiene + água + acordar"),
    ("05:00", 120, "Estudo profundo"),
    ("07:00", 30, "Café + descanso"),
    ("07:30", 75, "Estudo/prática"),
    ("08:45", 15, "Pausa"),
    ("09:00", 20, "Banho + se arrumar"),
    ("09:20", 40, "Ir para o trabalho"),
    ("10:00", 360, "Trabalho"),
    ("16:00", 60, "Voltar para casa"),
    ("17:00", 30, "Comer + descansar"),
    ("17:30", 90, "RPG"),
    ("19:00", 45, "Leitura"),
    ("19:45", 30, "Preparar o próximo dia + higiene"),
    ("20:15", 25, "Desacelerar"),
];

/// Cria "Dia de semana" com os 14 itens da rotina real do usuário. Devolve
/// o id da rotina — os testes de `aplicar_rotina` não precisam dos ids de
/// item individuais.
async fn criar_rotina_do_usuario(repo: &CronogramaRepository) -> Uuid {
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();
    for (start, minutos, titulo) in ROTINA_DO_USUARIO {
        repo.criar_item_de_rotina(rotina.id, start, minutos, "other", None, Some(titulo.to_string()), None)
            .await
            .unwrap();
    }
    rotina.id
}

// ---------------------------------------------------------------------------
// CRUD de rotina
// ---------------------------------------------------------------------------

#[tokio::test]
async fn criar_rotina_grava_nome_e_cai_na_mascara_padrao_quando_ausente() {
    let db = IsolatedDatabase::setup("rotina-criar").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    assert_eq!(rotina.name, "Dia de semana");
    // Default da migração: 1111100 (segunda a sexta).
    assert_eq!(rotina.default_weekdays, "1111100");

    db.teardown().await;
}

#[tokio::test]
async fn criar_rotina_accepts_an_explicit_weekdays_mask() {
    let db = IsolatedDatabase::setup("rotina-mascara-explicita").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let rotina = repo.criar_rotina("Fim de semana", Some("0000011".into())).await.unwrap();

    assert_eq!(rotina.default_weekdays, "0000011");

    db.teardown().await;
}

#[tokio::test]
async fn criar_rotina_rejects_a_blank_name() {
    let db = IsolatedDatabase::setup("rotina-nome-vazio").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let result = repo.criar_rotina("   ", None).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn criar_rotina_rejects_a_weekdays_mask_outside_the_seven_char_zero_one_pattern() {
    let db = IsolatedDatabase::setup("rotina-mascara-invalida").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    // Curta demais.
    let curta = repo.criar_rotina("Dia de semana", Some("1111".into())).await;
    assert!(matches!(curta, Err(Error::Invalid(_))));

    // Caractere fora de '0'/'1'.
    let invalida = repo.criar_rotina("Dia de semana", Some("111112x".into())).await;
    assert!(matches!(invalida, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn listar_rotinas_returns_them_sorted_by_name() {
    let db = IsolatedDatabase::setup("rotina-listar").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    repo.criar_rotina("Fim de semana", None).await.unwrap();
    repo.criar_rotina("Dia de semana", None).await.unwrap();

    let rotinas = repo.listar_rotinas().await.unwrap();
    let nomes: Vec<&str> = rotinas.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(nomes, vec!["Dia de semana", "Fim de semana"]);

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_rotina_patches_only_the_given_fields() {
    let db = IsolatedDatabase::setup("rotina-atualizar").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let rotina = repo.criar_rotina("Rascunho", None).await.unwrap();
    let patch = RotinaPatchInput { name: Some("Dia de semana".into()), ..Default::default() };
    let atualizada = repo.atualizar_rotina(rotina.id, patch).await.unwrap();

    assert_eq!(atualizada.name, "Dia de semana");
    // Não pedido no patch: continua o default.
    assert_eq!(atualizada.default_weekdays, "1111100");

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_rotina_of_an_unknown_id_reports_not_found() {
    let db = IsolatedDatabase::setup("rotina-atualizar-desconhecida").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let result = repo.atualizar_rotina(Uuid::now_v7(), RotinaPatchInput::default()).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn remover_rotina_deletes_it_and_cascades_to_its_items() {
    let db = IsolatedDatabase::setup("rotina-remover-cascata").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();
    let item = repo.criar_item_de_rotina(rotina.id, "05:00", 60, "other", None, None, None).await.unwrap();

    repo.remover_rotina(rotina.id).await.unwrap();

    // A rotina já era.
    let segunda_remocao = repo.remover_rotina(rotina.id).await;
    assert!(matches!(segunda_remocao, Err(Error::NotFound(_))));

    // O item não sobrevive à rotina — `ON DELETE CASCADE`, ao contrário de
    // `deck_id`/`subject_id` em `study_plan_blocks` (que sobrevivem com
    // `SET NULL`). Checado por SQL direto no id do item específico, para
    // provar que a LINHA sumiu, e não só que a listagem por rotina agora
    // não acha ninguém porque a rotina não existe mais.
    let sobrevive: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM study_routine_items WHERE id = $1")
        .bind(item.id.to_string())
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sobrevive, 0);

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// CRUD de item de rotina, e os CHECKs novos da migração
// ---------------------------------------------------------------------------

#[tokio::test]
async fn criar_item_de_rotina_grava_os_valores_dados() {
    let db = IsolatedDatabase::setup("item-criar").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    let item = repo
        .criar_item_de_rotina(rotina.id, "05:00", 120, "other", None, Some("Estudo profundo".into()), None)
        .await
        .unwrap();

    assert_eq!(item.routine_id, rotina.id);
    assert_eq!(item.start_local_time, "05:00");
    assert_eq!(item.planned_minutes, 120);
    assert_eq!(item.title, "Estudo profundo");
    assert!(item.pomodoro_cycles.is_none());

    db.teardown().await;
}

#[tokio::test]
async fn criar_item_de_rotina_accepts_a_matching_pomodoro_cycle_pair() {
    let db = IsolatedDatabase::setup("item-pomodoro-valido").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    // 50 minutos / 2 ciclos = 25 (o CHECK pareado de `0024:142` exige
    // divisão exata).
    let item = repo.criar_item_de_rotina(rotina.id, "05:00", 50, "pomodoro", Some(2), None, None).await.unwrap();
    assert_eq!(item.pomodoro_cycles, Some(2));

    db.teardown().await;
}

#[tokio::test]
async fn criar_item_de_rotina_rejects_zero_planned_minutes() {
    let db = IsolatedDatabase::setup("item-minutos-zero").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    let result = repo.criar_item_de_rotina(rotina.id, "05:00", 0, "other", None, None, None).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn criar_item_de_rotina_rejects_more_than_a_full_day() {
    let db = IsolatedDatabase::setup("item-minutos-excesso").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    let result = repo.criar_item_de_rotina(rotina.id, "05:00", 1441, "other", None, None, None).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn criar_item_de_rotina_rejects_a_start_local_time_outside_the_hh_mm_format() {
    let db = IsolatedDatabase::setup("item-hora-invalida").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    let hora_de_relogio_invalida = repo.criar_item_de_rotina(rotina.id, "25:00", 30, "other", None, None, None).await;
    assert!(matches!(hora_de_relogio_invalida, Err(Error::Invalid(_))));

    let texto_solto = repo.criar_item_de_rotina(rotina.id, "manhã", 30, "other", None, None, None).await;
    assert!(matches!(texto_solto, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn criar_item_de_rotina_rejects_an_invalid_activity() {
    let db = IsolatedDatabase::setup("item-atividade-invalida").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    let result = repo.criar_item_de_rotina(rotina.id, "05:00", 30, "almoço", None, None, None).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

/// O CHECK pareado (`0024:142`, espelhado na migração 0042): ciclos de
/// pomodoro só fazem sentido com `activity = 'pomodoro'` E dividindo os
/// minutos planejados exato. Nenhum dos dois lados é pré-validado em Rust
/// (mesma escolha de `atualizar_bloco`) — quem pega isso é o `CHECK` do
/// banco, então o erro esperado é `Error::Database`, não `Error::Invalid`.
#[tokio::test]
async fn criar_item_de_rotina_a_mismatched_pomodoro_cycle_pair_hits_the_database_check() {
    let db = IsolatedDatabase::setup("item-pomodoro-invalido").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    // 50 minutos não divide exato por 3 ciclos.
    let divisao_nao_exata = repo.criar_item_de_rotina(rotina.id, "05:00", 50, "pomodoro", Some(3), None, None).await;
    assert!(matches!(divisao_nao_exata, Err(Error::Database(_))));

    // Ciclos sem a atividade ser 'pomodoro'.
    let atividade_errada = repo.criar_item_de_rotina(rotina.id, "05:00", 50, "other", Some(2), None, None).await;
    assert!(matches!(atividade_errada, Err(Error::Database(_))));

    db.teardown().await;
}

#[tokio::test]
async fn listar_itens_de_rotina_returns_them_ordered_by_start_time_not_by_creation_order() {
    let db = IsolatedDatabase::setup("item-listar-ordenado").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();

    // Criados fora de ordem de propósito.
    repo.criar_item_de_rotina(rotina.id, "19:00", 45, "other", None, Some("Leitura".into()), None).await.unwrap();
    repo.criar_item_de_rotina(rotina.id, "04:40", 20, "other", None, Some("Higiene".into()), None).await.unwrap();

    let itens = repo.listar_itens_de_rotina(rotina.id).await.unwrap();
    let titulos: Vec<&str> = itens.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titulos, vec!["Higiene", "Leitura"]);

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_item_de_rotina_patches_only_the_given_fields() {
    let db = IsolatedDatabase::setup("item-atualizar").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();
    let item =
        repo.criar_item_de_rotina(rotina.id, "05:00", 60, "other", None, Some("Estudo".into()), None).await.unwrap();

    let patch = ItemDeRotinaPatchInput { planned_minutes: Some(90), ..Default::default() };
    let atualizado = repo.atualizar_item_de_rotina(item.id, patch).await.unwrap();

    assert_eq!(atualizado.planned_minutes, 90);
    // Não pedido no patch: continua como estava.
    assert_eq!(atualizado.start_local_time, "05:00");
    assert_eq!(atualizado.title, "Estudo");

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_item_de_rotina_of_an_unknown_id_reports_not_found() {
    let db = IsolatedDatabase::setup("item-atualizar-desconhecido").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let result = repo.atualizar_item_de_rotina(Uuid::now_v7(), ItemDeRotinaPatchInput::default()).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn remover_item_de_rotina_deletes_it_and_a_second_removal_reports_not_found() {
    let db = IsolatedDatabase::setup("item-remover").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Dia de semana", None).await.unwrap();
    let item = repo.criar_item_de_rotina(rotina.id, "05:00", 60, "other", None, None, None).await.unwrap();

    repo.remover_item_de_rotina(item.id).await.unwrap();
    assert!(repo.listar_itens_de_rotina(rotina.id).await.unwrap().is_empty());

    let segunda_remocao = repo.remover_item_de_rotina(item.id).await;
    assert!(matches!(segunda_remocao, Err(Error::NotFound(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// `aplicar_rotina`
// ---------------------------------------------------------------------------

/// O critério de aceite da fatia 1, ao pé da letra: 14 blocos, 960 minutos,
/// o primeiro às 04:40 e o último terminando às 20:40 — sem buraco e sem
/// sobreposição, porque os itens da fixture já são contíguos.
#[tokio::test]
async fn aplicar_rotina_to_an_empty_day_creates_exactly_the_fourteen_blocks_of_the_users_real_routine() {
    let db = IsolatedDatabase::setup("aplicar-dia-vazio").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();
    let alvo = dias_a_partir_de_hoje(1);

    let relatorio =
        repo.aplicar_rotina(rotina_id, &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await.unwrap();

    assert_eq!(relatorio.dias_aplicados, vec![alvo.clone()]);
    assert!(relatorio.dias_pulados.is_empty());
    assert_eq!(relatorio.total_blocos_criados, 14);

    let linhas: Vec<(String, i64)> = sqlx::query_as(
        "SELECT start_local_time, planned_minutes FROM study_plan_blocks WHERE local_date = $1 ORDER BY position",
    )
    .bind(&alvo)
    .fetch_all(&db.pool)
    .await
    .unwrap();

    assert_eq!(linhas.len(), 14, "exatamente 14 blocos, nem um a mais nem a menos");
    let soma_minutos: i64 = linhas.iter().map(|(_, m)| m).sum();
    assert_eq!(soma_minutos, 960, "16h00 no total");
    assert_eq!(linhas[0].0, "04:40", "primeiro bloco começa às 04:40");

    // Fim do último bloco, pela mesma aritmética de `db::cronograma::fim_local`
    // (início + duração): 20:15 + 25 min = 20:40.
    let (ultimo_inicio, ultimos_minutos) = &linhas[13];
    let inicio = chrono::NaiveTime::parse_from_str(ultimo_inicio, "%H:%M").unwrap();
    let fim = inicio + chrono::Duration::minutes(*ultimos_minutos);
    assert_eq!(fim.format("%H:%M").to_string(), "20:40", "último bloco termina às 20:40");

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_applied_twice_to_the_same_day_does_not_duplicate_and_reports_the_skip() {
    let db = IsolatedDatabase::setup("aplicar-idempotente").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();
    let alvo = dias_a_partir_de_hoje(1);

    let primeira =
        repo.aplicar_rotina(rotina_id, &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await.unwrap();
    assert_eq!(primeira.total_blocos_criados, 14);

    let segunda =
        repo.aplicar_rotina(rotina_id, &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await.unwrap();
    assert_eq!(segunda.total_blocos_criados, 0, "a segunda vez não cria bloco nenhum");
    assert!(segunda.dias_aplicados.is_empty());
    assert_eq!(segunda.dias_pulados.len(), 1);
    assert_eq!(segunda.dias_pulados[0].data, alvo);

    let total_no_banco: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM study_plan_blocks WHERE local_date = $1").bind(&alvo).fetch_one(&db.pool).await.unwrap();
    assert_eq!(total_no_banco, 14, "continuam sendo 14, não 28");

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_to_a_past_day_is_refused() {
    let db = IsolatedDatabase::setup("aplicar-dia-passado").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();
    let ontem = dias_a_partir_de_hoje(-1);

    let result = repo.aplicar_rotina(rotina_id, &ontem, &ontem, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    let criado: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM study_plan_blocks WHERE local_date = $1")
        .bind(&ontem)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(criado, 0, "nada foi gravado");

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_to_today_is_accepted_the_refusal_is_only_for_the_past() {
    let db = IsolatedDatabase::setup("aplicar-hoje").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();

    let relatorio =
        repo.aplicar_rotina(rotina_id, &hoje, &hoje, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await.unwrap();
    assert_eq!(relatorio.total_blocos_criados, 14);

    db.teardown().await;
}

/// Modo "preencher vazios": um dia com UM bloco qualquer — nem precisa ser
/// da rotina — pula o dia inteiro, sem misturar o bloco existente com os
/// 14 da rotina.
#[tokio::test]
async fn aplicar_rotina_skips_a_day_that_already_has_any_single_block() {
    let db = IsolatedDatabase::setup("aplicar-dia-ocupado").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();
    let alvo = dias_a_partir_de_hoje(1);

    // Um bloco qualquer, sem nenhuma relação com a rotina.
    repo.criar_bloco(&alvo, "reading", 30, None, None, Some("Bloco avulso".into()), None, None, None).await.unwrap();

    let relatorio =
        repo.aplicar_rotina(rotina_id, &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await.unwrap();

    assert!(relatorio.dias_aplicados.is_empty());
    assert_eq!(relatorio.dias_pulados.len(), 1);
    assert_eq!(relatorio.total_blocos_criados, 0);

    let total_no_banco: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM study_plan_blocks WHERE local_date = $1").bind(&alvo).fetch_one(&db.pool).await.unwrap();
    assert_eq!(total_no_banco, 1, "só o bloco avulso original, a rotina não entrou por cima");

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_rejects_a_multi_day_interval_in_this_slice() {
    let db = IsolatedDatabase::setup("aplicar-intervalo-nao-suportado").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina_id = criar_rotina_do_usuario(&repo).await;

    let hoje = hoje_local();
    let inicio = dias_a_partir_de_hoje(1);
    let fim = dias_a_partir_de_hoje(5);

    let result = repo.aplicar_rotina(rotina_id, &inicio, &fim, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_of_an_unknown_routine_reports_not_found() {
    let db = IsolatedDatabase::setup("aplicar-rotina-desconhecida").await;
    let repo = CronogramaRepository::new(db.pool.clone());

    let hoje = hoje_local();
    let alvo = dias_a_partir_de_hoje(1);

    let result =
        repo.aplicar_rotina(Uuid::now_v7(), &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn aplicar_rotina_of_a_routine_with_no_items_is_rejected() {
    let db = IsolatedDatabase::setup("aplicar-rotina-vazia").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let rotina = repo.criar_rotina("Rotina sem itens", None).await.unwrap();

    let hoje = hoje_local();
    let alvo = dias_a_partir_de_hoje(1);

    let result = repo.aplicar_rotina(rotina.id, &alvo, &alvo, ModoDeAplicacaoDeRotina::PreencherDiasVazios, &hoje).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// `criar_bloco` com `startLocalTime`/`pomodoroCycles` diretos (mudança de
// assinatura desta peça) — ver `CronogramaRepository::criar_bloco`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn criar_bloco_with_a_start_local_time_and_pomodoro_cycles_grava_os_dois_direto() {
    let db = IsolatedDatabase::setup("criar-bloco-com-horario").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let dia = dias_a_partir_de_hoje(1);

    let bloco = repo
        .criar_bloco(&dia, "pomodoro", 50, Some("05:00".into()), Some(2), Some("Foco".into()), None, None, None)
        .await
        .unwrap();

    assert_eq!(bloco.start_local_time, Some("05:00".into()));
    assert_eq!(bloco.pomodoro_cycles, Some(2));
    // Fim derivado a partir do horário já gravado no INSERT: 05:00 + 50min = 05:50.
    assert_eq!(bloco.end_local_time, Some("05:50".into()));

    db.teardown().await;
}

#[tokio::test]
async fn criar_bloco_without_a_start_local_time_still_defaults_to_none() {
    let db = IsolatedDatabase::setup("criar-bloco-sem-horario").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let dia = dias_a_partir_de_hoje(1);

    let bloco = repo.criar_bloco(&dia, "reading", 30, None, None, None, None, None, None).await.unwrap();

    assert!(bloco.start_local_time.is_none());
    assert!(bloco.pomodoro_cycles.is_none());
    assert!(bloco.end_local_time.is_none());

    db.teardown().await;
}

#[tokio::test]
async fn criar_bloco_rejects_a_pomodoro_cycle_count_of_zero() {
    let db = IsolatedDatabase::setup("criar-bloco-ciclos-zero").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let dia = dias_a_partir_de_hoje(1);

    let result = repo.criar_bloco(&dia, "pomodoro", 50, None, Some(0), None, None, None, None).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn criar_bloco_with_a_mismatched_pomodoro_cycle_pair_hits_the_database_check() {
    let db = IsolatedDatabase::setup("criar-bloco-ciclos-invalidos").await;
    let repo = CronogramaRepository::new(db.pool.clone());
    let dia = dias_a_partir_de_hoje(1);

    // 50 minutos não divide exato por 3 ciclos — mesmo CHECK pareado de
    // `0024:142`, agora alcançado direto pelo `INSERT` de `criar_bloco`.
    let result = repo.criar_bloco(&dia, "pomodoro", 50, None, Some(3), None, None, None, None).await;
    assert!(matches!(result, Err(Error::Database(_))));

    db.teardown().await;
}
