#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Testes de integração de `0027_prazos.sql` + `db::prazos` contra um banco
//! SQLite real.
//!
//! Cobre, nesta ordem: CRUD completo, o vínculo opcional com baralho e
//! página sobrevivendo à remoção do prazo, o `ON DELETE SET NULL` na direção
//! contrária (apagar o baralho/página ligados deixa o prazo vivo, só com a
//! ligação nula), a listagem separando vencidos de futuros por proximidade,
//! um prazo vencido não sumindo sozinho da listagem, e banco vazio devolvendo
//! lista vazia sem pânico.

mod support;

use chrono::{Duration, Local};
use learno_lib::db::{DeckRepository, PageRepository, PrazoPatchInput, PrazoRepository};
use learno_lib::error::Error;
use support::IsolatedDatabase;
use uuid::Uuid;

fn hoje() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn dias_a_partir_de_hoje(offset: i64) -> String {
    (Local::now().date_naive() + Duration::days(offset)).format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn criar_prazo_grava_os_valores_dados_e_nasce_ativo() {
    let db = IsolatedDatabase::setup("prazos-criar").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let prazo = prazos.criar("Prova de Biologia", "2026-09-20", None, None).await.unwrap();

    assert_eq!(prazo.title, "Prova de Biologia");
    assert_eq!(prazo.due_local_date, "2026-09-20");
    assert_eq!(prazo.deck_id, None);
    assert_eq!(prazo.page_id, None);
    assert_eq!(prazo.status, "ativo");

    db.teardown().await;
}

#[tokio::test]
async fn criar_prazo_rejects_empty_title_and_invalid_date() {
    let db = IsolatedDatabase::setup("prazos-criar-invalido").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    assert!(matches!(prazos.criar("   ", "2026-09-20", None, None).await, Err(Error::Invalid(_))));
    assert!(matches!(prazos.criar("Prova", "20/09/2026", None, None).await, Err(Error::Invalid(_))));

    db.teardown().await;
}

#[tokio::test]
async fn obter_prazo_of_an_unknown_id_reports_not_found() {
    let db = IsolatedDatabase::setup("prazos-obter-desconhecido").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    assert!(matches!(prazos.obter(Uuid::now_v7()).await, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_prazo_patches_only_the_given_fields_leaving_the_rest_untouched() {
    let db = IsolatedDatabase::setup("prazos-atualizar-parcial").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let criado = prazos.criar("Prova de Biologia", "2026-09-20", None, None).await.unwrap();

    let patch = PrazoPatchInput { due_local_date: Some("2026-09-25".into()), ..Default::default() };
    let atualizado = prazos.atualizar(criado.id, patch).await.unwrap();

    assert_eq!(atualizado.due_local_date, "2026-09-25");
    assert_eq!(atualizado.title, "Prova de Biologia", "não pedido no patch, continua igual");
    assert_eq!(atualizado.status, "ativo", "não pedido no patch, continua igual");

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_prazo_can_move_it_through_every_status() {
    let db = IsolatedDatabase::setup("prazos-status").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let criado = prazos.criar("Prova de Biologia", "2026-09-20", None, None).await.unwrap();

    let concluido =
        prazos.atualizar(criado.id, PrazoPatchInput { status: Some("concluido".into()), ..Default::default() }).await.unwrap();
    assert_eq!(concluido.status, "concluido");

    let arquivado =
        prazos.atualizar(criado.id, PrazoPatchInput { status: Some("arquivado".into()), ..Default::default() }).await.unwrap();
    assert_eq!(arquivado.status, "arquivado");

    // Reverter para ativo funciona — arquivar/concluir não é sem volta.
    let de_volta =
        prazos.atualizar(criado.id, PrazoPatchInput { status: Some("ativo".into()), ..Default::default() }).await.unwrap();
    assert_eq!(de_volta.status, "ativo");

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_prazo_rejects_an_invalid_status_without_touching_the_row() {
    let db = IsolatedDatabase::setup("prazos-status-invalido").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let criado = prazos.criar("Prova de Biologia", "2026-09-20", None, None).await.unwrap();
    let result = prazos.atualizar(criado.id, PrazoPatchInput { status: Some("vencido".into()), ..Default::default() }).await;
    assert!(matches!(result, Err(Error::Invalid(_))));

    let ainda_ativo = prazos.obter(criado.id).await.unwrap();
    assert_eq!(ainda_ativo.status, "ativo");

    db.teardown().await;
}

#[tokio::test]
async fn atualizar_prazo_of_an_unknown_id_reports_not_found() {
    let db = IsolatedDatabase::setup("prazos-atualizar-desconhecido").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let result = prazos.atualizar(Uuid::now_v7(), PrazoPatchInput::default()).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn remover_prazo_deletes_and_a_second_removal_reports_not_found() {
    let db = IsolatedDatabase::setup("prazos-remover").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let criado = prazos.criar("Descartável", "2026-09-20", None, None).await.unwrap();
    prazos.remover(criado.id).await.unwrap();

    assert!(matches!(prazos.obter(criado.id).await, Err(Error::NotFound(_))));
    assert!(matches!(prazos.remover(criado.id).await, Err(Error::NotFound(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// O vínculo com baralho/página, nos dois sentidos
// ---------------------------------------------------------------------------

/// Apagar um PRAZO ligado a um baralho não pode arrastar o baralho — a FK
/// aponta do prazo PARA o baralho, nunca o contrário, então não há caminho
/// no schema para isso acontecer; este teste prova que continua não
/// havendo.
#[tokio::test]
async fn remover_prazo_ligado_a_um_baralho_nao_apaga_o_baralho() {
    let db = IsolatedDatabase::setup("prazos-remove-nao-leva-baralho").await;
    let decks = DeckRepository::new(db.pool.clone());
    let prazos = PrazoRepository::new(db.pool.clone());

    let deck = decks.create(None, "Biologia").await.unwrap();
    let prazo = prazos.criar("Prova de Biologia", "2026-09-20", Some(deck.id), None).await.unwrap();

    prazos.remover(prazo.id).await.unwrap();

    let baralho_sobrevivente = decks.get(deck.id).await.unwrap();
    assert_eq!(baralho_sobrevivente.id, deck.id);
    assert!(baralho_sobrevivente.deleted_at.is_none());

    db.teardown().await;
}

/// A decisão que `0027_prazos.sql` toma para `deck_id`/`page_id`:
/// `ON DELETE SET NULL`. Apagar o baralho ou a página ligados não pode
/// apagar o PRAZO junto — o compromisso de data ("prova dia 20") é
/// informação própria do calendário da pessoa, independente de o material
/// de estudo ainda existir. Este teste apaga o baralho de verdade por SQL
/// direto (o `DeckRepository` só oferece `trash`, soft-delete, que nunca
/// dispara a FK) para provar o `ON DELETE` do schema em si.
#[tokio::test]
async fn apagar_o_baralho_ligado_deixa_o_prazo_vivo_com_a_ligacao_nula() {
    let db = IsolatedDatabase::setup("prazos-baralho-apagado").await;
    let decks = DeckRepository::new(db.pool.clone());
    let prazos = PrazoRepository::new(db.pool.clone());

    let deck = decks.create(None, "Biologia").await.unwrap();
    let prazo = prazos.criar("Prova de Biologia", "2026-09-20", Some(deck.id), None).await.unwrap();
    assert_eq!(prazo.deck_id, Some(deck.id));

    sqlx::query("DELETE FROM decks WHERE id = ?").bind(deck.id.hyphenated().to_string()).execute(&db.pool).await.unwrap();

    let sobrevivente = prazos.obter(prazo.id).await.unwrap();
    assert_eq!(sobrevivente.id, prazo.id, "o prazo continua existindo");
    assert_eq!(sobrevivente.deck_id, None, "a ligação com o baralho apagado vira nula");
    assert_eq!(sobrevivente.title, "Prova de Biologia", "o resto do prazo é preservado intacto");

    db.teardown().await;
}

/// Mesma decisão, mesmo teste, para `page_id` — a outra metade do vínculo
/// opcional.
#[tokio::test]
async fn apagar_a_pagina_ligada_deixa_o_prazo_vivo_com_a_ligacao_nula() {
    let db = IsolatedDatabase::setup("prazos-pagina-apagada").await;
    let pages = PageRepository::new(db.pool.clone());
    let prazos = PrazoRepository::new(db.pool.clone());

    let page = pages.create(None, "Resumo de Biologia").await.unwrap();
    let prazo = prazos.criar("Prova de Biologia", "2026-09-20", None, Some(page.id)).await.unwrap();
    assert_eq!(prazo.page_id, Some(page.id));

    // `permanently_delete` exige a página primeiro na lixeira (FUN-031) —
    // o caminho real de exclusão definitiva que o app expõe.
    pages.trash(page.id).await.unwrap();
    pages.permanently_delete(page.id).await.unwrap();

    let sobrevivente = prazos.obter(prazo.id).await.unwrap();
    assert_eq!(sobrevivente.id, prazo.id, "o prazo continua existindo");
    assert_eq!(sobrevivente.page_id, None, "a ligação com a página apagada vira nula");

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Listagem: contagem regressiva, vencidos separados de futuros
// ---------------------------------------------------------------------------

#[tokio::test]
async fn listar_prazos_on_an_empty_database_returns_empty_lists_without_panicking() {
    let db = IsolatedDatabase::setup("prazos-lista-vazia").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let lista = prazos.listar().await.unwrap();

    assert_eq!(lista.hoje, hoje());
    assert!(lista.vencidos.is_empty());
    assert!(lista.futuros.is_empty());

    db.teardown().await;
}

/// O caso central: um prazo no PASSADO não some sozinho da listagem — ele
/// aparece em `vencidos`, com `diasRestantes` negativo, até o usuário agir
/// (concluir, arquivar ou apagar). O calendário virar não é uma ação do
/// usuário.
#[tokio::test]
async fn um_prazo_no_passado_aparece_em_vencidos_e_nao_some_sozinho() {
    let db = IsolatedDatabase::setup("prazos-vencido-nao-some").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let vencido = prazos.criar("Prova que já passou", &dias_a_partir_de_hoje(-10), None, None).await.unwrap();

    let lista = prazos.listar().await.unwrap();

    assert_eq!(lista.futuros.len(), 0);
    assert_eq!(lista.vencidos.len(), 1);
    assert_eq!(lista.vencidos[0].prazo.id, vencido.id);
    assert_eq!(lista.vencidos[0].dias_restantes, -10);

    db.teardown().await;
}

/// O dia do prazo é HOJE: zero dias restantes, e isso entra em `futuros`,
/// nunca em `vencidos` — a distinção que o pedido original exige
/// explicitamente ("isso é diferente de vencido").
#[tokio::test]
async fn um_prazo_com_vencimento_hoje_tem_zero_dias_e_fica_em_futuros_nao_em_vencidos() {
    let db = IsolatedDatabase::setup("prazos-vence-hoje").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let de_hoje = prazos.criar("Prova hoje", &hoje(), None, None).await.unwrap();

    let lista = prazos.listar().await.unwrap();

    assert!(lista.vencidos.is_empty(), "hoje não é vencido");
    assert_eq!(lista.futuros.len(), 1);
    assert_eq!(lista.futuros[0].prazo.id, de_hoje.id);
    assert_eq!(lista.futuros[0].dias_restantes, 0);

    db.teardown().await;
}

/// A ordenação por proximidade nos dois grupos: em `futuros`, o mais
/// próximo primeiro; em `vencidos`, o que venceu mais recentemente primeiro
/// (também o "mais próximo de hoje").
#[tokio::test]
async fn listar_prazos_orders_each_group_by_proximity_to_today() {
    let db = IsolatedDatabase::setup("prazos-ordenacao").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let daqui_a_20 = prazos.criar("Daqui a 20 dias", &dias_a_partir_de_hoje(20), None, None).await.unwrap();
    let daqui_a_5 = prazos.criar("Daqui a 5 dias", &dias_a_partir_de_hoje(5), None, None).await.unwrap();
    let venceu_ha_1 = prazos.criar("Venceu ontem", &dias_a_partir_de_hoje(-1), None, None).await.unwrap();
    let venceu_ha_30 = prazos.criar("Venceu há um mês", &dias_a_partir_de_hoje(-30), None, None).await.unwrap();

    let lista = prazos.listar().await.unwrap();

    let ids_futuros: Vec<Uuid> = lista.futuros.iter().map(|item| item.prazo.id).collect();
    assert_eq!(ids_futuros, vec![daqui_a_5.id, daqui_a_20.id], "futuros: mais próximo primeiro");

    let ids_vencidos: Vec<Uuid> = lista.vencidos.iter().map(|item| item.prazo.id).collect();
    assert_eq!(ids_vencidos, vec![venceu_ha_1.id, venceu_ha_30.id], "vencidos: o mais recente primeiro");

    db.teardown().await;
}

/// `status` diferente de `ativo` sai da contagem regressiva sem sair da
/// tabela — `concluido`/`arquivado` continuam legíveis por `obter`, só não
/// aparecem em `listar`.
#[tokio::test]
async fn concluido_e_arquivado_saem_da_listagem_mas_continuam_legiveis_por_id() {
    let db = IsolatedDatabase::setup("prazos-status-fora-da-lista").await;
    let prazos = PrazoRepository::new(db.pool.clone());

    let concluido = prazos.criar("Já estudei tudo", &dias_a_partir_de_hoje(5), None, None).await.unwrap();
    prazos.atualizar(concluido.id, PrazoPatchInput { status: Some("concluido".into()), ..Default::default() }).await.unwrap();

    let arquivado = prazos.criar("Prova cancelada", &dias_a_partir_de_hoje(-3), None, None).await.unwrap();
    prazos.atualizar(arquivado.id, PrazoPatchInput { status: Some("arquivado".into()), ..Default::default() }).await.unwrap();

    let ativo = prazos.criar("Continua valendo", &dias_a_partir_de_hoje(2), None, None).await.unwrap();

    let lista = prazos.listar().await.unwrap();
    let todos_ids: Vec<Uuid> =
        lista.futuros.iter().chain(lista.vencidos.iter()).map(|item| item.prazo.id).collect();

    assert_eq!(todos_ids, vec![ativo.id], "só o prazo ativo entra na contagem regressiva");

    // Mas nenhum dos dois some da tabela — continuam legíveis por id.
    assert_eq!(prazos.obter(concluido.id).await.unwrap().status, "concluido");
    assert_eq!(prazos.obter(arquivado.id).await.unwrap().status, "arquivado");

    db.teardown().await;
}
