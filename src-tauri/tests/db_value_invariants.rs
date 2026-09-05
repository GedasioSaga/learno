#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for I1..I4 (arquitetura §2) against a real Postgres
//! instance, exercised through `db::record_values::RecordValueRepository`.
//!
//! `#[ignore]`d like every other `db_*.rs` file here for the tests that need
//! `LEARNO_TEST_DATABASE_URL` (`scripts/dev-db.ps1 start`, then
//! `cargo test -- --ignored`) — see `db_blocks.rs`'s header. The I4 grep
//! test at the bottom needs no database and runs under a plain `cargo test`.
//!
//! No `database`/`database_properties` repository exists yet in this
//! repository (a different Fase 3 piece owns it), so this file inserts
//! those rows with plain SQL — exactly as much setup as I1..I4 need, no
//! more.

mod support;

use std::collections::HashSet;

use learno_lib::db::{PageRepository, RecordValueChangeInput, RecordValueRepository};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

async fn create_database(pool: &SqlitePool, container_page_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO databases (container_page_id, name) VALUES ($1, $2) RETURNING id")
        .bind(container_page_id)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn create_property(pool: &SqlitePool, database_id: Uuid, name: &str, property_type: &str, config: &JsonValue) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO database_properties (database_id, name, property_type, config, position) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(database_id)
    .bind(name)
    .bind(property_type)
    .bind(config)
    .bind("a0")
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn create_record(pool: &SqlitePool, database_id: Uuid, title: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO pages (database_id, title, position) VALUES ($1, $2, $3) RETURNING id")
        .bind(database_id)
        .bind(title)
        .bind("a0")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn row_count(pool: &SqlitePool, record_id: Uuid, property_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM database_record_values WHERE record_id = $1 AND property_id = $2",
    )
    .bind(record_id)
    .bind(property_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// A ready-to-use `(database, record)` pair, sharing one container page —
/// what almost every test below needs before it can touch a property.
struct Fixture {
    pool: SqlitePool,
    database_id: Uuid,
    record_id: Uuid,
}

async fn setup_database_and_record(db: &IsolatedDatabase, label: &str) -> Fixture {
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, &format!("Database de teste — {label}")).await.unwrap();
    let database_id = create_database(&db.pool, container.id, label).await;
    let record_id = create_record(&db.pool, database_id, "Registro de teste").await;
    Fixture { pool: db.pool.clone(), database_id, record_id }
}

#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn i1_writing_empty_deletes_an_existing_row() {
    let db = IsolatedDatabase::setup("value_inv").await;
    let fixture = setup_database_and_record(&db, "I1 vazio apaga").await;
    let repo = RecordValueRepository::new(fixture.pool.clone());
    let property_id = create_property(&fixture.pool, fixture.database_id, "Nota", "text", &serde_json::json!({})).await;

    repo.apply_record_value_changes(vec![RecordValueChangeInput {
        record_id: fixture.record_id,
        property_id,
        value: serde_json::json!("Anotação da Fase 3"),
    }])
    .await
    .unwrap();
    assert_eq!(row_count(&fixture.pool, fixture.record_id, property_id).await, 1);

    let applied = repo
        .apply_record_value_changes(vec![RecordValueChangeInput {
            record_id: fixture.record_id,
            property_id,
            value: serde_json::json!(""),
        }])
        .await
        .unwrap();

    assert!(applied.results[0].value.is_none(), "escrever vazio deve reportar a linha como ausente");
    assert_eq!(
        row_count(&fixture.pool, fixture.record_id, property_id).await,
        0,
        "I1: vazio é a AUSÊNCIA da linha, não uma linha com valor vazio"
    );

    db.teardown().await;
}

/// A literal do achado: "50.000 cards desmarcados são 0 linhas, não 50.000".
/// Testado aqui com um card só, mas a asserção que importa é a mesma:
/// `false` de checkbox nunca deveria sequer ter criado a linha.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn i1_checkbox_false_never_creates_a_row() {
    let db = IsolatedDatabase::setup("value_inv").await;
    let fixture = setup_database_and_record(&db, "I1 checkbox").await;
    let repo = RecordValueRepository::new(fixture.pool.clone());
    let property_id =
        create_property(&fixture.pool, fixture.database_id, "Concluído", "checkbox", &serde_json::json!({})).await;

    let applied = repo
        .apply_record_value_changes(vec![RecordValueChangeInput {
            record_id: fixture.record_id,
            property_id,
            value: serde_json::json!(false),
        }])
        .await
        .unwrap();

    assert!(applied.results[0].value.is_none());
    assert_eq!(
        row_count(&fixture.pool, fixture.record_id, property_id).await,
        0,
        "checkbox desmarcado (false) tem que resultar em ZERO linhas, nunca uma linha com value=false"
    );

    db.teardown().await;
}

/// A exceção nomeada de I1: `false` vindo de uma fórmula booleana É um
/// valor legítimo e tem que sobreviver como uma linha de verdade — só o
/// CHECKBOX apaga `false`.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn i1_formula_boolean_false_is_accepted_and_kept() {
    let db = IsolatedDatabase::setup("value_inv").await;
    let fixture = setup_database_and_record(&db, "I1 formula false").await;
    let repo = RecordValueRepository::new(fixture.pool.clone());
    let property_id = create_property(
        &fixture.pool,
        fixture.database_id,
        "Aprovado?",
        "formula",
        &serde_json::json!({ "expression": "prop(\"Nota\") >= 7" }),
    )
    .await;

    let applied = repo
        .apply_record_value_changes(vec![RecordValueChangeInput {
            record_id: fixture.record_id,
            property_id,
            value: serde_json::json!(false),
        }])
        .await
        .unwrap();

    let row = applied.results[0].value.as_ref().expect("false de fórmula tem que ser gravado, não apagado");
    assert_eq!(row.value, serde_json::json!(false));
    assert_eq!(row.sort_num, Some(0.0), "sort_num gerado trata boolean false como 0");
    assert_eq!(
        row_count(&fixture.pool, fixture.record_id, property_id).await,
        1,
        "o CHECK aceita false explicitamente — só checkbox o apaga, não o Postgres"
    );

    db.teardown().await;
}

/// I2: a mesma propriedade com duas formas de data — uma só-início (menos
/// chaves), outra com início+fim (mais chaves) — provando que `sort_text`,
/// não `value`, é quem ordena corretamente. Sem as duas formas JUNTAS numa
/// mesma propriedade, um teste passa verde sobre `ORDER BY value`, que é
/// exatamente o bug que I2 existe para prevenir.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn i2_two_date_shapes_on_the_same_property_order_by_sort_text_not_value() {
    let db = IsolatedDatabase::setup("value_inv").await;
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, "Database de teste — I2").await.unwrap();
    let database_id = create_database(&db.pool, container.id, "I2").await;
    let property_id =
        create_property(&db.pool, database_id, "Período", "date", &serde_json::json!({ "hasEnd": true })).await;
    let repo = RecordValueRepository::new(db.pool.clone());

    // Cronologicamente PRIMEIRO (01/01 a 02/01) mas com DUAS chaves.
    let earlier_two_keys = create_record(&db.pool, database_id, "Cedo, com fim").await;
    // Cronologicamente DEPOIS (01/02) mas com UMA chave só.
    let later_one_key = create_record(&db.pool, database_id, "Tarde, só início").await;

    repo.apply_record_value_changes(vec![
        RecordValueChangeInput {
            record_id: earlier_two_keys,
            property_id,
            value: serde_json::json!({ "start": "2026-01-01", "end": "2026-01-02" }),
        },
        RecordValueChangeInput {
            record_id: later_one_key,
            property_id,
            value: serde_json::json!({ "start": "2026-02-01" }),
        },
    ])
    .await
    .unwrap();

    // A prova negativa primeiro: `ORDER BY value` (o que I2 proíbe) inverte
    // a ordem cronológica, porque jsonb compara objeto por QUANTIDADE de
    // chaves antes do conteúdo — exatamente o achado da arquitetura §2.
    let by_value: Vec<Uuid> =
        sqlx::query_scalar("SELECT record_id FROM database_record_values WHERE property_id = $1 ORDER BY value")
            .bind(property_id)
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        by_value,
        vec![later_one_key, earlier_two_keys],
        "ORDER BY value deveria mesmo estar cronologicamente ERRADO — se isto falhar, a premissa do teste mudou"
    );

    // A prova positiva: `ORDER BY sort_text` é a ordem cronológica correta.
    let by_sort_text: Vec<Uuid> = sqlx::query_scalar(
        "SELECT record_id FROM database_record_values WHERE property_id = $1 ORDER BY sort_text",
    )
    .bind(property_id)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        by_sort_text,
        vec![earlier_two_keys, later_one_key],
        "I2: sort_text tem que ordenar cronologicamente mesmo quando value não ordenaria"
    );

    db.teardown().await;
}

/// O texto de 6 KB de ALTA ENTROPIA do fixture compartilhado (md5
/// concatenado — `repeat('x', N)` comprime no btree e passaria mesmo com o
/// índice quebrado). Prova duas coisas ao mesmo tempo: a gravação não
/// estoura o índice (a versão sem `left(...,256)` falha com
/// "index row size ... exceeds btree version 4 maximum"), e `sort_text`
/// trunca exatamente nos primeiros 256 caracteres.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn high_entropy_6kb_text_survives_and_sort_text_truncates_at_256() {
    let fixture = load_fixture();
    let case = find_case(&fixture, "text_high_entropy_6400_chars_truncates_sort_text_at_256");
    let raw_text = case.value.as_str().expect("caso deveria ter um valor string");
    assert_eq!(raw_text.chars().count(), 6400, "o fixture deveria mesmo ter 6.400 caracteres");

    let db = IsolatedDatabase::setup("value_inv").await;
    let fixture_db = setup_database_and_record(&db, "entropia").await;
    let repo = RecordValueRepository::new(fixture_db.pool.clone());
    let property_id =
        create_property(&fixture_db.pool, fixture_db.database_id, "Texto grande", "text", &serde_json::json!({})).await;

    let applied = repo
        .apply_record_value_changes(vec![RecordValueChangeInput {
            record_id: fixture_db.record_id,
            property_id,
            value: case.value.clone(),
        }])
        .await
        .unwrap();

    let row = applied.results[0].value.as_ref().expect("texto não vazio tem que gerar uma linha");
    assert_eq!(row.value.as_str(), Some(raw_text), "o texto de 6.400 caracteres tem que sobreviver íntegro em `value`");
    assert_eq!(
        row.sort_text.as_deref(),
        case.expected_sort_text.as_deref(),
        "sort_text tem que ser exatamente os primeiros 256 caracteres"
    );
    assert_eq!(row.sort_text.as_ref().map(|s| s.chars().count()), Some(256));

    db.teardown().await;
}

/// Roda TODOS os 18 casos do fixture compartilhado contra Postgres de
/// verdade — a peça central da resposta ao achado da Fase 2 (arquitetura
/// §10): `sort_text`/`sort_num` aqui vêm da COLUNA GERADA, não de um cálculo
/// em Rust que poderia divergir do banco em silêncio.
#[tokio::test]
#[ignore = "requires a running Postgres cluster (scripts/dev-db.ps1)"]
async fn every_fixture_case_matches_postgres_generated_sort_columns() {
    let fixture = load_fixture();
    assert!(fixture.cases.len() >= 18, "fixture perdeu casos — esperava pelo menos 18, achou {}", fixture.cases.len());

    let db = IsolatedDatabase::setup("value_inv").await;
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, "Database de teste — fixture").await.unwrap();
    let database_id = create_database(&db.pool, container.id, "fixture").await;
    let repo = RecordValueRepository::new(db.pool.clone());

    for case in &fixture.cases {
        let property_id =
            create_property(&db.pool, database_id, &format!("Prop {}", case.id), &case.property_type, &case.config).await;
        let record_id = create_record(&db.pool, database_id, &case.id).await;

        let applied = repo
            .apply_record_value_changes(vec![RecordValueChangeInput { record_id, property_id, value: case.value.clone() }])
            .await
            .unwrap();

        if case.expected_is_empty {
            assert!(applied.results[0].value.is_none(), "caso \"{}\": esperava linha ausente (vazio)", case.id);
            assert_eq!(
                row_count(&db.pool, record_id, property_id).await,
                0,
                "caso \"{}\": nenhuma linha deveria existir",
                case.id
            );
        } else {
            let row = applied.results[0].value.as_ref().unwrap_or_else(|| {
                panic!("caso \"{}\": esperava uma linha, a normalização a apagou", case.id)
            });
            assert_eq!(row.sort_text, case.expected_sort_text, "caso \"{}\": sort_text divergiu do fixture", case.id);
            assert_eq!(row.sort_num, case.expected_sort_num, "caso \"{}\": sort_num divergiu do fixture", case.id);
        }
    }

    db.teardown().await;
}

/// I4: `apply_record_value_changes` (`db/record_values.rs`) é o ÚNICO lugar
/// no crate autorizado a escrever em `database_record_values`. Não precisa
/// de banco — é análise estática do próprio código-fonte — e por isso não é
/// `#[ignore]`d.
#[test]
fn i4_only_record_values_rs_writes_to_database_record_values() {
    let output = std::process::Command::new("rg")
        .args([
            "--line-number",
            "--with-filename",
            "INSERT INTO database_record_values|UPDATE database_record_values|DELETE FROM database_record_values",
            "src",
        ])
        .output()
        .expect("ripgrep (rg) precisa estar disponível no PATH para este teste");

    // rg devolve 1 quando NENHUMA linha casa — o que aqui seria, ele
    // próprio, uma falha (o caminho de escrita tem que existir em algum
    // lugar). Só um código >= 2 é "rg falhou de verdade" (comando não
    // encontrado, argumento inválido).
    let exit_code = output.status.code().unwrap_or(2);
    assert!(
        exit_code <= 1,
        "rg falhou ao rodar: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let matching_files: HashSet<String> =
        stdout.lines().filter_map(|line| line.split(':').next()).map(|path| path.replace('\\', "/")).collect();

    assert!(
        !matching_files.is_empty(),
        "esperava encontrar o caminho único de escrita de I4 em algum arquivo; não achou nenhum"
    );
    for file in &matching_files {
        assert!(
            file.ends_with("db/record_values.rs"),
            "I4 violado: \"{file}\" também emite INSERT/UPDATE/DELETE em database_record_values; \
             só db/record_values.rs pode (apply_record_value_changes)"
        );
    }
}

#[derive(Debug, Deserialize)]
struct FixtureCase {
    id: String,
    #[serde(rename = "propertyType")]
    property_type: String,
    #[serde(default)]
    config: JsonValue,
    value: JsonValue,
    #[serde(rename = "expectedSortText")]
    expected_sort_text: Option<String>,
    #[serde(rename = "expectedSortNum")]
    expected_sort_num: Option<f64>,
    #[serde(rename = "expectedIsEmpty")]
    expected_is_empty: bool,
}

#[derive(Debug, Deserialize)]
struct FixtureFile {
    cases: Vec<FixtureCase>,
}

fn load_fixture() -> FixtureFile {
    serde_json::from_str(include_str!("fixtures/property_values.json")).unwrap()
}

fn find_case<'a>(fixture: &'a FixtureFile, id: &str) -> &'a FixtureCase {
    fixture.cases.iter().find(|case| case.id == id).unwrap_or_else(|| panic!("caso \"{id}\" não existe no fixture"))
}
