#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Testes de integração de `0043_financas.sql` + `db::financas` contra um banco
//! SQLite real.
//!
//! Cobre: seed de categorias, histórico de valor dos recorrentes (virada de
//! ano, mudança sem sobreposição, encerramento com fim inclusivo), confirmação
//! única por mês, o limite de mês por `data_local`, previsto vs realizado sem
//! contar o fixo confirmado duas vezes, remover recorrente preservando o
//! lançamento confirmado, e as recusas de entrada inválida.

mod support;

use learno_lib::db::financas::valor_vigente;
use learno_lib::db::{FinancasRepository, VigenciaRow};
use learno_lib::error::Error;
use support::IsolatedDatabase;
use uuid::Uuid;

/// `(inicio, fim, valor)` de cada vigência, para comparar sem id/created_at.
fn intervalos(vigencias: &[VigenciaRow]) -> Vec<(String, Option<String>, i64)> {
    vigencias.iter().map(|v| (v.inicio_mes.clone(), v.fim_mes.clone(), v.valor_centavos)).collect()
}

fn vig(inicio: &str, fim: Option<&str>, valor: i64) -> (String, Option<String>, i64) {
    (inicio.to_string(), fim.map(str::to_string), valor)
}

/// Vigências em ordem de início nunca se sobrepõem: cada uma termina antes da
/// próxima começar, e só a última pode ficar aberta.
fn assert_sem_sobreposicao(vigencias: &[VigenciaRow]) {
    for par in vigencias.windows(2) {
        let fim = par[0].fim_mes.as_deref().expect("só a última vigência pode ficar aberta");
        assert!(fim < par[1].inicio_mes.as_str(), "sobreposição: {:?}", intervalos(vigencias));
    }
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

#[tokio::test]
async fn seed_cria_as_13_categorias() {
    let db = IsolatedDatabase::setup("financas-seed").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let categorias = financas.listar_categorias().await.unwrap();
    assert_eq!(categorias.len(), 13);
    assert_eq!(categorias.iter().filter(|c| c.tipo == "entrada").count(), 2);
    assert_eq!(categorias.iter().filter(|c| c.tipo == "saida").count(), 11);
    assert_eq!(categorias[0].nome, "Salário");
    assert!(categorias.iter().any(|c| c.nome == "Alimentação" && !c.arquivada));

    db.teardown().await;
}

#[tokio::test]
async fn criar_categoria_entra_no_fim_e_nome_repetido_e_recusado() {
    let db = IsolatedDatabase::setup("financas-categoria").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let pets = financas.criar_categoria("  Pets ", "saida").await.unwrap();
    assert_eq!(pets.nome, "Pets");
    assert_eq!(pets.ordem, 12);

    assert!(matches!(financas.criar_categoria("Pets", "saida").await, Err(Error::Invalid(_))));
    assert!(matches!(financas.criar_categoria("Bônus", "saída").await, Err(Error::Invalid(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Recorrentes e vigências
// ---------------------------------------------------------------------------

#[tokio::test]
async fn valor_vigente_atravessa_a_virada_de_ano() {
    let db = IsolatedDatabase::setup("financas-virada-ano").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let aluguel = financas.criar_recorrente("Aluguel", "saida", None, 150_000, "2026-12").await.unwrap();
    assert_eq!(intervalos(&aluguel.vigencias), vec![vig("2026-12", None, 150_000)]);

    let aluguel = financas.mudar_valor_a_partir_de(aluguel.recorrente.id, 160_000, "2027-01").await.unwrap();
    assert_eq!(
        intervalos(&aluguel.vigencias),
        vec![vig("2026-12", Some("2026-12"), 150_000), vig("2027-01", None, 160_000)]
    );

    assert_eq!(valor_vigente(&aluguel.vigencias, "2026-11"), None);
    assert_eq!(valor_vigente(&aluguel.vigencias, "2026-12"), Some(150_000));
    assert_eq!(valor_vigente(&aluguel.vigencias, "2027-01"), Some(160_000));

    assert_eq!(financas.resumo_do_mes("2026-12").await.unwrap().saidas_previstas, 150_000);
    assert_eq!(financas.resumo_do_mes("2027-01").await.unwrap().saidas_previstas, 160_000);

    db.teardown().await;
}

#[tokio::test]
async fn mudar_valor_fecha_a_anterior_e_nunca_sobrepoe() {
    let db = IsolatedDatabase::setup("financas-mudar-valor").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let criado = financas.criar_recorrente("Internet", "saida", None, 100, "2026-01").await.unwrap();
    let id = criado.recorrente.id;

    let r = financas.mudar_valor_a_partir_de(id, 200, "2026-06").await.unwrap();
    assert_eq!(intervalos(&r.vigencias), vec![vig("2026-01", Some("2026-05"), 100), vig("2026-06", None, 200)]);
    assert_sem_sobreposicao(&r.vigencias);

    // `mes` igual ao início da vigência atual: atualiza ela, não cria outra.
    let r = financas.mudar_valor_a_partir_de(id, 250, "2026-06").await.unwrap();
    assert_eq!(intervalos(&r.vigencias), vec![vig("2026-01", Some("2026-05"), 100), vig("2026-06", None, 250)]);
    assert_sem_sobreposicao(&r.vigencias);

    // Para trás, no meio da primeira: a de junho some, a primeira fecha em fevereiro.
    let r = financas.mudar_valor_a_partir_de(id, 300, "2026-03").await.unwrap();
    assert_eq!(intervalos(&r.vigencias), vec![vig("2026-01", Some("2026-02"), 100), vig("2026-03", None, 300)]);
    assert_sem_sobreposicao(&r.vigencias);

    // No início da primeira vigência de todas: sobra uma só, aberta.
    let r = financas.mudar_valor_a_partir_de(id, 50, "2026-01").await.unwrap();
    assert_eq!(intervalos(&r.vigencias), vec![vig("2026-01", None, 50)]);

    assert!(matches!(financas.mudar_valor_a_partir_de(id, -1, "2026-02").await, Err(Error::Invalid(_))));
    assert!(matches!(financas.mudar_valor_a_partir_de(Uuid::now_v7(), 1, "2026-02").await, Err(Error::NotFound(_))));

    db.teardown().await;
}

#[tokio::test]
async fn encerrar_recorrente_tem_fim_inclusivo() {
    let db = IsolatedDatabase::setup("financas-encerrar").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let criado = financas.criar_recorrente("Academia", "saida", None, 9_900, "2026-01").await.unwrap();
    let id = criado.recorrente.id;
    // Um aumento futuro já agendado precisa sumir ao encerrar antes dele.
    financas.mudar_valor_a_partir_de(id, 12_000, "2027-01").await.unwrap();

    let r = financas.encerrar_recorrente(id, "2026-09").await.unwrap();
    assert_eq!(intervalos(&r.vigencias), vec![vig("2026-01", Some("2026-09"), 9_900)]);

    let setembro = financas.resumo_do_mes("2026-09").await.unwrap();
    assert_eq!(setembro.saidas_previstas, 9_900, "o mês encerrado ainda prevê");
    assert_eq!(setembro.fixos.len(), 1);

    let outubro = financas.resumo_do_mes("2026-10").await.unwrap();
    assert_eq!(outubro.saidas_previstas, 0, "o mês seguinte já não prevê");
    assert!(outubro.fixos.is_empty());

    assert!(matches!(financas.encerrar_recorrente(id, "2026-11").await, Err(Error::Invalid(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Confirmação
// ---------------------------------------------------------------------------

#[tokio::test]
async fn confirmar_o_mesmo_recorrente_duas_vezes_no_mes_e_recusado() {
    let db = IsolatedDatabase::setup("financas-confirmar").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let telefone = financas.criar_recorrente("Telefone", "saida", None, 5_990, "2026-01").await.unwrap();
    let id = telefone.recorrente.id;

    let setembro = financas.confirmar_recorrente(id, "2026-09", None, None).await.unwrap();
    assert_eq!(setembro.valor_centavos, 5_990, "valor padrão = vigente");
    assert_eq!(setembro.data_local, "2026-09-01", "data padrão = dia 1");
    assert_eq!(setembro.descricao, "Telefone");
    assert_eq!(setembro.recorrente_id, Some(id));
    assert_eq!(setembro.mes_referencia.as_deref(), Some("2026-09"));

    let repetido = financas.confirmar_recorrente(id, "2026-09", Some(1), Some("2026-09-10")).await;
    assert!(matches!(repetido, Err(Error::Invalid(_))), "obtido: {repetido:?}");

    let outubro = financas.confirmar_recorrente(id, "2026-10", Some(6_100), Some("2026-10-05")).await.unwrap();
    assert_eq!(outubro.valor_centavos, 6_100);
    assert_eq!(outubro.data_local, "2026-10-05");

    let antes_de_existir = financas.confirmar_recorrente(id, "2025-12", None, None).await;
    assert!(matches!(antes_de_existir, Err(Error::Invalid(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Resumo do mês
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lancamento_pertence_ao_mes_pela_data_local() {
    let db = IsolatedDatabase::setup("financas-limite-mes").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let fim_setembro = financas.criar_lancamento("2026-09-30", "Mercado", "saida", None, 1_000).await.unwrap();
    let inicio_outubro = financas.criar_lancamento("2026-10-01", "Padaria", "saida", None, 300).await.unwrap();

    let setembro = financas.resumo_do_mes("2026-09").await.unwrap();
    assert_eq!(setembro.saidas_realizadas, 1_000);
    let outubro = financas.resumo_do_mes("2026-10").await.unwrap();
    assert_eq!(outubro.saidas_realizadas, 300);

    let ids_setembro: Vec<Uuid> =
        financas.listar_lancamentos_do_mes("2026-09").await.unwrap().iter().map(|l| l.id).collect();
    assert_eq!(ids_setembro, vec![fim_setembro.id]);
    let ids_outubro: Vec<Uuid> =
        financas.listar_lancamentos_do_mes("2026-10").await.unwrap().iter().map(|l| l.id).collect();
    assert_eq!(ids_outubro, vec![inicio_outubro.id]);

    db.teardown().await;
}

#[tokio::test]
async fn previsto_vs_realizado_com_fixo_pendente_e_depois_confirmado() {
    let db = IsolatedDatabase::setup("financas-previsto-realizado").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let categorias = financas.listar_categorias().await.unwrap();
    let alimentacao = categorias.iter().find(|c| c.nome == "Alimentação").unwrap().id;

    let aluguel = financas.criar_recorrente("Aluguel", "saida", None, 100_000, "2026-09").await.unwrap();
    financas.criar_recorrente("Salário", "entrada", None, 500_000, "2026-01").await.unwrap();
    financas.criar_lancamento("2026-09-15", "Mercado", "saida", Some(alimentacao), 3_000).await.unwrap();

    let pendente = financas.resumo_do_mes("2026-09").await.unwrap();
    assert_eq!(pendente.entradas_previstas, 500_000);
    assert_eq!(pendente.saidas_previstas, 103_000);
    assert_eq!(pendente.entradas_realizadas, 0);
    assert_eq!(pendente.saidas_realizadas, 3_000);
    assert_eq!(pendente.sobra_prevista, 397_000);
    assert_eq!(pendente.sobra_realizada, -3_000);
    assert_eq!(pendente.fixos.len(), 2);
    assert!(pendente.fixos.iter().all(|f| f.lancamento_id.is_none()));

    let confirmado =
        financas.confirmar_recorrente(aluguel.recorrente.id, "2026-09", Some(98_000), Some("2026-09-05")).await.unwrap();

    let depois = financas.resumo_do_mes("2026-09").await.unwrap();
    assert_eq!(depois.saidas_previstas, 103_000, "o confirmado não soma de novo no previsto");
    assert_eq!(depois.saidas_realizadas, 101_000);
    assert_eq!(depois.sobra_realizada, -101_000);
    let fixo = depois.fixos.iter().find(|f| f.recorrente_id == aluguel.recorrente.id).unwrap();
    assert_eq!(fixo.valor_previsto_centavos, 100_000);
    assert_eq!(fixo.lancamento_id, Some(confirmado.id));
    assert_eq!(fixo.valor_confirmado_centavos, Some(98_000));

    // Saídas realizadas por categoria: a maior primeira, sem categoria = nulo.
    assert_eq!(depois.por_categoria.len(), 2);
    assert_eq!(depois.por_categoria[0].categoria_id, None);
    assert_eq!(depois.por_categoria[0].saidas_centavos, 98_000);
    assert_eq!(depois.por_categoria[1].categoria_id, Some(alimentacao));
    assert_eq!(depois.por_categoria[1].nome.as_deref(), Some("Alimentação"));
    assert_eq!(depois.por_categoria[1].saidas_centavos, 3_000);

    db.teardown().await;
}

#[tokio::test]
async fn remover_recorrente_mantem_o_lancamento_confirmado_no_realizado() {
    let db = IsolatedDatabase::setup("financas-remover-recorrente").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let luz = financas.criar_recorrente("Luz", "saida", None, 20_000, "2026-01").await.unwrap();
    let confirmado = financas.confirmar_recorrente(luz.recorrente.id, "2026-09", None, None).await.unwrap();

    financas.remover_recorrente(luz.recorrente.id).await.unwrap();
    assert!(matches!(financas.remover_recorrente(luz.recorrente.id).await, Err(Error::NotFound(_))));
    assert!(financas.listar_recorrentes().await.unwrap().is_empty());

    let lancamentos = financas.listar_lancamentos_do_mes("2026-09").await.unwrap();
    assert_eq!(lancamentos.len(), 1);
    assert_eq!(lancamentos[0].id, confirmado.id);
    assert_eq!(lancamentos[0].recorrente_id, None, "SET NULL, não CASCADE");

    let resumo = financas.resumo_do_mes("2026-09").await.unwrap();
    assert_eq!(resumo.saidas_realizadas, 20_000);
    assert!(resumo.fixos.is_empty());

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Lançamentos: atualizar/remover
// ---------------------------------------------------------------------------

#[tokio::test]
async fn atualizar_e_remover_lancamento() {
    let db = IsolatedDatabase::setup("financas-lancamento-crud").await;
    let financas = FinancasRepository::new(db.pool.clone());

    let criado = financas.criar_lancamento("2026-09-10", "Cinema", "saida", None, 4_000).await.unwrap();
    let patch = learno_lib::db::LancamentoPatchInput { valor_centavos: Some(4_500), ..Default::default() };
    let atualizado = financas.atualizar_lancamento(criado.id, patch).await.unwrap();
    assert_eq!(atualizado.valor_centavos, 4_500);
    assert_eq!(atualizado.descricao, "Cinema", "não pedido no patch, continua igual");

    financas.remover_lancamento(criado.id).await.unwrap();
    assert!(matches!(financas.remover_lancamento(criado.id).await, Err(Error::NotFound(_))));

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// Entrada inválida
// ---------------------------------------------------------------------------

#[tokio::test]
async fn valor_negativo_e_mes_13_sao_recusados() {
    let db = IsolatedDatabase::setup("financas-invalidos").await;
    let financas = FinancasRepository::new(db.pool.clone());

    assert!(matches!(financas.criar_recorrente("Aluguel", "saida", None, -1, "2026-09").await, Err(Error::Invalid(_))));
    assert!(matches!(financas.criar_recorrente("Aluguel", "saida", None, 100, "2026-13").await, Err(Error::Invalid(_))));
    assert!(matches!(financas.criar_lancamento("2026-09-01", "X", "saida", None, -5).await, Err(Error::Invalid(_))));
    assert!(matches!(financas.criar_lancamento("2026-13-01", "X", "saida", None, 5).await, Err(Error::Invalid(_))));
    assert!(matches!(financas.resumo_do_mes("2026-13").await, Err(Error::Invalid(_))));
    assert!(matches!(financas.listar_lancamentos_do_mes("2026-13").await, Err(Error::Invalid(_))));
    assert!(financas.listar_recorrentes().await.unwrap().is_empty(), "nada foi gravado pelas recusas");

    db.teardown().await;
}

#[tokio::test]
async fn visao_por_meses_recusa_0_e_37_e_atravessa_o_ano() {
    let db = IsolatedDatabase::setup("financas-visao").await;
    let financas = FinancasRepository::new(db.pool.clone());

    assert!(matches!(financas.visao_por_meses("2026-09", 0).await, Err(Error::Invalid(_))));
    assert!(matches!(financas.visao_por_meses("2026-09", 37).await, Err(Error::Invalid(_))));

    financas.criar_recorrente("Salário", "entrada", None, 500_000, "2026-12").await.unwrap();
    let linhas = financas.visao_por_meses("2026-11", 3).await.unwrap();
    let meses: Vec<&str> = linhas.iter().map(|l| l.mes.as_str()).collect();
    assert_eq!(meses, vec!["2026-11", "2026-12", "2027-01"]);
    assert_eq!(linhas[0].entradas_previstas, 0);
    assert_eq!(linhas[1].entradas_previstas, 500_000);
    assert_eq!(linhas[2].sobra_prevista, 500_000);

    assert_eq!(financas.visao_por_meses("2026-01", 36).await.unwrap().len(), 36);

    db.teardown().await;
}
