#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for I1..I4 (arquitetura §2) against um SQLite de
//! verdade, exercised through `db::record_values::RecordValueRepository`.
//!
//! Cada teste cria seu próprio arquivo de banco descartável em pasta
//! temporária (`support::IsolatedDatabase::setup`) e roda num `cargo test`
//! limpo, em qualquer máquina, sem preparação nenhuma. Não existe mais
//! cluster Postgres, nem `LEARNO_TEST_DATABASE_URL`, nem `#[ignore]` neste
//! arquivo — mudança que veio da migração para SQLite
//! (`docs/MIGRACAO-SQLITE.md`). O teste I4 no fim continua sem precisar de
//! banco nenhum — é análise estática do próprio código-fonte via `rg` — e
//! por isso nunca teve `#[ignore]`.
//!
//! No `database`/`database_properties` repository exists yet in this
//! repository (a different Fase 3 piece owns it), so this file inserts
//! those rows with plain SQL — exactly as much setup as I1..I4 need, no
//! more.

mod support;

use std::collections::HashSet;

use learno_lib::db::{DbId, IdBind, PageRepository, RecordValueChangeInput, RecordValueRepository};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

// `databases.id` / `database_properties.id` / `pages.id` são TEXT PRIMARY
// KEY sem DEFAULT (ver as migrações 0003/0007/0008) — este crate gera o id
// em Rust com `Uuid::now_v7()` antes de todo INSERT, exatamente como
// `PageRepository::create` (`src/db/pages.rs`) já faz; não há `RETURNING`
// para buscar de volta porque o id já é conhecido antes da escrita.

async fn create_database(pool: &SqlitePool, container_page_id: Uuid, name: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, $3)")
        .bind(id.db())
        .bind(container_page_id.db())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_property(pool: &SqlitePool, database_id: Uuid, name: &str, property_type: &str, config: &JsonValue) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO database_properties (id, database_id, name, property_type, config, position) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id.db())
    .bind(database_id.db())
    .bind(name)
    .bind(property_type)
    .bind(config)
    .bind("a0")
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn create_record(pool: &SqlitePool, database_id: Uuid, title: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, $3, $4)")
        .bind(id.db())
        .bind(database_id.db())
        .bind(title)
        .bind("a0")
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn row_count(pool: &SqlitePool, record_id: Uuid, property_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM database_record_values WHERE record_id = $1 AND property_id = $2",
    )
    .bind(record_id.db())
    .bind(property_id.db())
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
        "o CHECK aceita false explicitamente — só checkbox o apaga, não o banco"
    );

    db.teardown().await;
}

/// I2: a mesma propriedade com duas formas de data — uma só-início (uma
/// chave), outra com início+fim (duas chaves) — provando que `sort_text`,
/// não `value`, é quem ordena corretamente. Sem as duas formas JUNTAS numa
/// mesma propriedade, um teste passa verde sobre `ORDER BY value`, que é
/// exatamente o bug que I2 existe para prevenir.
///
/// O mecanismo da armadilha mudou com a migração para SQLite — descrito em
/// `docs/MIGRACAO-SQLITE.md` — e por isso os papéis "cedo"/"tarde" abaixo
/// estão invertidos em relação à versão Postgres deste teste: `value` aqui
/// é TEXT puro (não jsonb), e o `serde_json::Value` deste crate serializa
/// objeto sem a feature `preserve_order` (confirmado no `Cargo.lock`: a
/// entrada de `serde_json` não depende de `indexmap`), então as chaves saem
/// sempre em ordem ALFABÉTICA — um objeto com `end` sempre serializa como
/// `{"end":...` antes de `{"start":...`, e "e" byte a byte é menor que "s".
/// Resultado: QUALQUER linha cujo valor tenha a chave `end` ordena antes de
/// qualquer linha só-`start` em `ORDER BY value`, não importa a data — o
/// mesmo tipo de bug que a versão Postgres tinha por jsonb comparar
/// QUANTIDADE de chaves antes do conteúdo, só que aqui é o NOME da chave
/// quem decide. Por isso a linha de duas chaves abaixo é a
/// cronologicamente DEPOIS e a linha de uma chave é a cronologicamente
/// ANTES — inversão deliberada para reproduzir a armadilha sob a semântica
/// real do SQLite.
#[tokio::test]
async fn i2_two_date_shapes_on_the_same_property_order_by_sort_text_not_value() {
    let db = IsolatedDatabase::setup("value_inv").await;
    let pages = PageRepository::new(db.pool.clone());
    let container = pages.create(None, "Database de teste — I2").await.unwrap();
    let database_id = create_database(&db.pool, container.id, "I2").await;
    let property_id =
        create_property(&db.pool, database_id, "Período", "date", &serde_json::json!({ "hasEnd": true })).await;
    let repo = RecordValueRepository::new(db.pool.clone());

    // Cronologicamente PRIMEIRO (01/01) mas com UMA chave só — o valor
    // serializa como `{"start":...}`.
    let earlier_one_key = create_record(&db.pool, database_id, "Cedo, só início").await;
    // Cronologicamente DEPOIS (01/02 a 02/02) mas com DUAS chaves — o valor
    // serializa como `{"end":...,"start":...}` (chaves em ordem alfabética),
    // então começa com "e", que sempre vence "s" em ORDER BY value.
    let later_two_keys = create_record(&db.pool, database_id, "Tarde, com fim").await;

    repo.apply_record_value_changes(vec![
        RecordValueChangeInput {
            record_id: earlier_one_key,
            property_id,
            value: serde_json::json!({ "start": "2026-01-01" }),
        },
        RecordValueChangeInput {
            record_id: later_two_keys,
            property_id,
            value: serde_json::json!({ "start": "2026-02-01", "end": "2026-02-02" }),
        },
    ])
    .await
    .unwrap();

    // A prova negativa primeiro: `ORDER BY value` (o que I2 proíbe) inverte
    // a ordem cronológica, porque a chave "end" vence "start" em ordem
    // alfabética — se isto falhar, a premissa do teste mudou.
    let by_value_ids: Vec<DbId> = sqlx::query_scalar(
        "SELECT record_id FROM database_record_values WHERE property_id = $1 ORDER BY value",
    )
    .bind(property_id.db())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    let by_value: Vec<Uuid> = by_value_ids.into_iter().map(Uuid::from).collect();
    assert_eq!(
        by_value,
        vec![later_two_keys, earlier_one_key],
        "ORDER BY value deveria mesmo estar cronologicamente ERRADO — se isto falhar, a premissa do teste mudou"
    );

    // A prova positiva: `ORDER BY sort_text` é a ordem cronológica correta.
    let by_sort_text_ids: Vec<DbId> = sqlx::query_scalar(
        "SELECT record_id FROM database_record_values WHERE property_id = $1 ORDER BY sort_text",
    )
    .bind(property_id.db())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    let by_sort_text: Vec<Uuid> = by_sort_text_ids.into_iter().map(Uuid::from).collect();
    assert_eq!(
        by_sort_text,
        vec![earlier_one_key, later_two_keys],
        "I2: sort_text tem que ordenar cronologicamente mesmo quando value não ordenaria"
    );

    db.teardown().await;
}

/// O texto de 6 KB de ALTA ENTROPIA do fixture compartilhado (md5
/// concatenado — `repeat('x', N)` comprime e passaria mesmo com um índice
/// de ordenação quebrado). Prova duas coisas ao mesmo tempo: a gravação
/// sobrevive sem erro (I3, `0017_database_value_invariants.sql`), e
/// `sort_text` trunca exatamente nos primeiros 256 caracteres mesmo que
/// `value` guarde o texto inteiro sem cortar nada.
#[tokio::test]
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

/// Roda TODOS os 18 casos do fixture compartilhado contra um SQLite de
/// verdade — a peça central da resposta ao achado da Fase 2 (arquitetura
/// §10): `sort_text`/`sort_num` aqui vêm da COLUNA GERADA, não de um cálculo
/// em Rust que poderia divergir do banco em silêncio.
#[tokio::test]
async fn every_fixture_case_matches_sqlite_generated_sort_columns() {
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
    // Só o código de produção conta. I4 é sobre o caminho pelo qual o app
    // escreve valor de propriedade; um `#[cfg(test)]` que insere uma linha
    // para provar outra coisa (a cascata de chave estrangeira, em
    // `db/pool.rs`) não é um segundo caminho de escrita — ele nem existe no
    // binário que o usuário roda. Sem este corte, a invariante passaria a
    // proibir que qualquer teste montasse um cenário com dado nessa tabela, o
    // que não é o que ela quer dizer.
    //
    // "Produção" aqui é tudo que vem ANTES do primeiro `#[cfg(test)]` do
    // arquivo — a convenção que todo módulo deste crate segue (o módulo de
    // teste é sempre o último item).
    let matching_files: HashSet<String> = escritas_em_record_values(std::path::Path::new("src"))
        .into_iter()
        .filter(|(caminho, numero)| !esta_em_modulo_de_teste(caminho, *numero))
        .map(|(caminho, _)| caminho)
        .collect();

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

/// Toda linha sob `raiz` que emite escrita em `database_record_values`, como
/// `(caminho com "/", número 1-based)`.
///
/// Varredura em Rust puro, e não `rg`: o runner do CI não tem ripgrep no PATH,
/// e uma invariante que só roda na máquina de quem tem a ferramenta instalada
/// não guarda nada. Arquivo que não é UTF-8 é pulado, como o `rg` pula binário.
fn escritas_em_record_values(raiz: &std::path::Path) -> Vec<(String, usize)> {
    const ESCRITAS: [&str; 3] = [
        "INSERT INTO database_record_values",
        "UPDATE database_record_values",
        "DELETE FROM database_record_values",
    ];

    let mut achados = Vec::new();
    let mut pastas = vec![raiz.to_path_buf()];
    while let Some(pasta) = pastas.pop() {
        for entrada in std::fs::read_dir(&pasta).unwrap() {
            let caminho = entrada.unwrap().path();
            if caminho.is_dir() {
                pastas.push(caminho);
                continue;
            }
            let Ok(conteudo) = std::fs::read_to_string(&caminho) else {
                continue;
            };
            let nome = caminho.to_string_lossy().replace('\\', "/");
            for (indice, linha) in conteudo.lines().enumerate() {
                if ESCRITAS.iter().any(|escrita| linha.contains(escrita)) {
                    achados.push((nome.clone(), indice + 1));
                }
            }
        }
    }
    achados
}

/// Verdadeiro quando a linha `numero` (1-based) de `caminho` está dentro do
/// módulo de teste do arquivo — isto é, depois do primeiro `#[cfg(test)]`.
///
/// Arquivo ilegível conta como produção, deliberadamente: uma invariante de
/// segurança que se desliga sozinha quando não consegue ler o código é pior
/// que uma que acusa demais.
fn esta_em_modulo_de_teste(caminho: &str, numero: usize) -> bool {
    let Ok(conteudo) = std::fs::read_to_string(caminho) else {
        return false;
    };

    conteudo
        .lines()
        .position(|linha| linha.trim_start().starts_with("#[cfg(test)]"))
        .is_some_and(|indice| numero > indice + 1)
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
