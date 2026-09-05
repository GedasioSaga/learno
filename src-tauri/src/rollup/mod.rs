//! R1 — kernel de agregação de rollup e rodapé (`docs/FASE-3-ARQUITETURA.md` §9).
//!
//! As duas funções publicadas aqui são um **fold puro**: zero I/O, zero
//! `sqlx`, zero conhecimento de banco. `aggregate` entra com uma lista de
//! valores por página relacionada (porque uma página pode ter múltiplos
//! valores num multi-select) e sai um único `serde_json::Value`.
//! `explode_cell` é o passo anterior — transforma o jsonb bruto de UMA
//! célula na lista de valores atômicos que `aggregate` espera.
//!
//! Este kernel é **reusado verbatim** pelo rodapé de agregação por coluna
//! (DBS-058/130): a única diferença é de onde vem a lista — para rollup,
//! cada `Vec` interno é os valores da propriedade-alvo em UMA página
//! relacionada; para o rodapé, cada `Vec` interno é o valor de UMA linha
//! visível na coluna. Ver `dbs_130_footer_aggregations_reuse_the_same_kernel`
//! nos testes abaixo.
//!
//! ## I1 — como a ausência chega até aqui
//!
//! **Decisão, e é preciso ser consistente com ela para `Count empty`
//! funcionar:** ausência é o `Vec` interno **vazio** — zero elementos —
//! nunca um elemento `Value::Null` nem um `Value::Array` vazio dentro do
//! `Vec`. Isso é literal na arquitetura (§9): "o Vec interno vazio significa
//! 'esta página tem o alvo vazio'". Concretamente:
//!
//! - Se a página relacionada não tem linha em `database_record_values` para
//!   a propriedade-alvo (I1: vazio é a AUSÊNCIA da linha), quem monta
//!   `per_page` (fora deste módulo — provavelmente D1) não chama
//!   `explode_cell` para essa página: simplesmente empurra `Vec::new()`.
//! - Se a página TEM linha, `explode_cell(property_type, &value)` devolve a
//!   lista de valores atômicos daquela célula — um elemento para a maioria
//!   dos tipos, N elementos para `multi_select`/lista de arquivos.
//! - Defensivamente (nunca deveria acontecer, porque I4 nunca grava vazio),
//!   `explode_cell` trata `Value::Null` e `[]` como **zero** elementos, nunca
//!   como um elemento vazio — se algum chamador passar `Null` em vez de
//!   simplesmente omitir a chamada, `count_empty` continua correto.
//!
//! ## Decisões que não estavam fechadas no contrato
//!
//! - **`AggregationKind` acrescenta `ShowOriginal`**, que não existe no
//!   union TypeScript de `AggregationKind` (arquitetura §6) — aquele union é
//!   só o vocabulário do rodapé de coluna (DBS-058/130), que nunca usa
//!   "original". "Show original" é DBS-091, exclusivo de rollup. Registrado
//!   em `divergencias_da_arquitetura` do relatório desta peça.
//! - **Percentuais (`PercentEmpty`/`PercentNotEmpty`) devolvem uma fração
//!   `0.0..=1.0`**, não `0..=100`. Formatar como "30%" é decisão de
//!   renderização (multiplicar por 100 e anexar o símbolo), fora do escopo
//!   de um fold puro.
//! - **Agregação numérica/de data sem nenhum valor aplicável devolve
//!   `Value::Null`** — "nenhum valor computado", nunca `0` (que seria uma
//!   resposta errada e silenciosa: zero páginas preenchidas não é o mesmo
//!   que soma zero).
//! - **`Earliest date`/`Latest date` devolvem o valor de data ORIGINAL**
//!   (o objeto inteiro, com `end` se ele tinha) da página vencedora — não
//!   só a string `start` — para que o resultado já sirva de valor de uma
//!   célula de Data (I5) sem conversão adicional. **`Date range`** monta um
//!   novo objeto `{"start": <menor>, "end": <maior>}` a partir dos `start`
//!   das duas pontas.
//! - **`property_type` multi-valorado é uma lista explícita, não inferida
//!   pela forma do JSON** (`multi_select`, confirmado na arquitetura §6;
//!   `files`/`file_list` são meu palpite para o tipo de anexos — a
//!   arquitetura só nomeia o `ValueShape` `"file_list"`, nunca o
//!   `property_type` de fato. Se a peça que registra esse tipo usar outro
//!   nome, `MULTI_VALUED_PROPERTY_TYPES` é o único lugar a atualizar).
//!   Design DECLARADO, não adivinhado pela forma do valor, no mesmo
//!   espírito do restante do registro de tipos (§6: "filtro, ordenação e
//!   agregação são DECLARADOS, nunca funções").

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Tipos de propriedade cujo jsonb já É um `Value::Array` de entradas
/// atômicas independentes. Ver nota de divergência no cabeçalho do módulo.
const MULTI_VALUED_PROPERTY_TYPES: &[&str] = &["multi_select", "files", "file_list"];

/// As 17 funções de agregação — 15 nomeadas na tarefa mais `ShowOriginal`
/// (rollup-only, ver cabeçalho) e o par `Count`/`Percent` (not) empty, que a
/// tarefa lista como itens distintos. Espelha os nomes de string do union
/// TypeScript `AggregationKind` (arquitetura §6) via `snake_case` — mesma
/// grafia, sem `camelCase`, porque o contrato TS já usa `snake_case` nos
/// literais ("count_all", não "countAll").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggregationKind {
    /// DBS-091 — só rollup; não existe no union TS do rodapé (ver
    /// divergência no cabeçalho do módulo).
    ShowOriginal,
    /// DBS-093.
    CountAll,
    /// DBS-094.
    CountValues,
    /// DBS-095.
    CountUnique,
    /// DBS-096.
    CountEmpty,
    /// DBS-097.
    CountNotEmpty,
    PercentEmpty,
    PercentNotEmpty,
    /// DBS-100.
    Sum,
    Average,
    Median,
    Min,
    Max,
    Range,
    /// DBS-101.
    EarliestDate,
    LatestDate,
    DateRange,
}

/// Explode o jsonb bruto de UMA célula na lista de valores atômicos que
/// [`aggregate`] espera para aquela página/linha. Ver a seção I1 no
/// cabeçalho do módulo para a convenção de ausência.
pub fn explode_cell(property_type: &str, value: &JsonValue) -> Vec<JsonValue> {
    if value.is_null() {
        return Vec::new();
    }
    if is_multi_valued_property(property_type) {
        if let JsonValue::Array(items) = value {
            return items.clone();
        }
    }
    vec![value.clone()]
}

fn is_multi_valued_property(property_type: &str) -> bool {
    MULTI_VALUED_PROPERTY_TYPES.contains(&property_type)
}

/// O fold. `per_page` tem um `Vec` por página relacionada viva (ou por linha
/// visível, no caso do rodapé) — ver a nota de reuso no cabeçalho do módulo.
pub fn aggregate(function: AggregationKind, per_page: &[Vec<JsonValue>]) -> JsonValue {
    match function {
        AggregationKind::ShowOriginal => {
            JsonValue::Array(per_page.iter().flatten().cloned().collect())
        }
        AggregationKind::CountAll => JsonValue::from(per_page.len()),
        AggregationKind::CountValues => {
            JsonValue::from(per_page.iter().map(Vec::len).sum::<usize>())
        }
        AggregationKind::CountUnique => JsonValue::from(count_unique(per_page)),
        AggregationKind::CountEmpty => JsonValue::from(count_empty_pages(per_page)),
        AggregationKind::CountNotEmpty => JsonValue::from(count_not_empty_pages(per_page)),
        AggregationKind::PercentEmpty => percent(count_empty_pages(per_page), per_page.len()),
        AggregationKind::PercentNotEmpty => {
            percent(count_not_empty_pages(per_page), per_page.len())
        }
        AggregationKind::Sum => numeric_values(per_page)
            .map_or(JsonValue::Null, |values| JsonValue::from(values.iter().sum::<f64>())),
        AggregationKind::Average => numeric_values(per_page).map_or(JsonValue::Null, |values| {
            JsonValue::from(values.iter().sum::<f64>() / values_len_as_f64(&values))
        }),
        AggregationKind::Median => numeric_values(per_page).map_or(JsonValue::Null, |mut values| {
            values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            JsonValue::from(median_of_sorted(&values))
        }),
        AggregationKind::Min => numeric_values(per_page).map_or(JsonValue::Null, |values| {
            JsonValue::from(values.into_iter().fold(f64::INFINITY, f64::min))
        }),
        AggregationKind::Max => numeric_values(per_page).map_or(JsonValue::Null, |values| {
            JsonValue::from(values.into_iter().fold(f64::NEG_INFINITY, f64::max))
        }),
        AggregationKind::Range => numeric_values(per_page).map_or(JsonValue::Null, |values| {
            let min = values.iter().copied().fold(f64::INFINITY, f64::min);
            let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            JsonValue::from(max - min)
        }),
        AggregationKind::EarliestDate => {
            earliest(per_page).map_or(JsonValue::Null, |(_, value)| value.clone())
        }
        AggregationKind::LatestDate => {
            latest(per_page).map_or(JsonValue::Null, |(_, value)| value.clone())
        }
        AggregationKind::DateRange => date_range(per_page),
    }
}

fn count_empty_pages(per_page: &[Vec<JsonValue>]) -> usize {
    per_page.iter().filter(|values| values.is_empty()).count()
}

/// Invariante: sempre `<= per_page.len()`, porque conta um subconjunto do
/// mesmo slice — a subtração abaixo nunca estoura.
fn count_not_empty_pages(per_page: &[Vec<JsonValue>]) -> usize {
    per_page.len() - count_empty_pages(per_page)
}

/// Contagem de distintos por serialização canônica (`Display` de
/// `serde_json::Value`, confirmado em docs.rs 1.0.151: formato compacto
/// determinístico). `serde_json` roda aqui SEM a feature `preserve_order`
/// (confere `Cargo.lock`: nenhuma dependência em `indexmap`), então o `Map`
/// por trás de um valor-objeto (uma data com `start`/`end`) é um
/// `BTreeMap` — a mesma chave sempre serializa na mesma ordem alfabética,
/// não na ordem de inserção, então dois valores estruturalmente iguais
/// sempre produzem o mesmo texto.
fn count_unique(per_page: &[Vec<JsonValue>]) -> usize {
    per_page
        .iter()
        .flatten()
        .map(ToString::to_string)
        .collect::<HashSet<_>>()
        .len()
}

/// `None` quando não há nenhum valor numérico para agregar — o chamador
/// devolve `Value::Null` ("nenhum valor computado"), nunca `0`.
fn numeric_values(per_page: &[Vec<JsonValue>]) -> Option<Vec<f64>> {
    let values: Vec<f64> = per_page.iter().flatten().filter_map(JsonValue::as_f64).collect();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

/// `values` vem de [`numeric_values`], que nunca devolve `Some(vec![])` —
/// então esta conversão nunca representa uma contagem maior que a precisão
/// exata do `f64` (2^53) na escala real do produto (§13 da arquitetura: a
/// escala-alvo é 50.000 registros, catorze ordens de grandeza abaixo).
fn values_len_as_f64(values: &[f64]) -> f64 {
    values.len() as f64
}

/// `sorted` não-vazio é responsabilidade do chamador ([`numeric_values`] só
/// devolve `Some` quando há ao menos um elemento) — sem isso o índice
/// `mid - 1` do ramo par estouraria.
fn median_of_sorted(sorted: &[f64]) -> f64 {
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

/// I5: `{"start": "YYYY-MM-DD"}` ou com hora. `None` quando o valor não tem
/// `"start"` string — não é uma data válida, ignorado silenciosamente pelo
/// fold em vez de panicar.
fn date_start(value: &JsonValue) -> Option<&str> {
    value.get("start").and_then(JsonValue::as_str)
}

/// I2: nunca compara o objeto inteiro (jsonb ordena por quantidade de
/// chaves antes do conteúdo — uma data com `end` teria mais chaves que uma
/// só-início e "venceria" uma comparação ingênua mesmo sendo cronologicamente
/// anterior). Compara sempre pela string `start`, que I5 garante ser ISO de
/// largura fixa — lexicográfico == cronológico.
fn select_date_edge(
    per_page: &[Vec<JsonValue>],
    keep_current: fn(&str, &str) -> bool,
) -> Option<(&str, &JsonValue)> {
    let mut best: Option<(&str, &JsonValue)> = None;
    for value in per_page.iter().flatten() {
        let Some(start) = date_start(value) else {
            continue;
        };
        best = match best {
            Some((current_start, _)) if keep_current(current_start, start) => best,
            _ => Some((start, value)),
        };
    }
    best
}

fn earliest(per_page: &[Vec<JsonValue>]) -> Option<(&str, &JsonValue)> {
    select_date_edge(per_page, |current, candidate| current <= candidate)
}

fn latest(per_page: &[Vec<JsonValue>]) -> Option<(&str, &JsonValue)> {
    select_date_edge(per_page, |current, candidate| current >= candidate)
}

fn date_range(per_page: &[Vec<JsonValue>]) -> JsonValue {
    match (earliest(per_page), latest(per_page)) {
        (Some((start, _)), Some((end, _))) => serde_json::json!({ "start": start, "end": end }),
        _ => JsonValue::Null,
    }
}

fn percent(count: usize, total: usize) -> JsonValue {
    if total == 0 {
        return JsonValue::Null;
    }
    // usize -> f64: o total é uma contagem de páginas/linhas, na escala-alvo
    // do produto (50.000, §13 da arquitetura) muito abaixo dos 2^53 que o
    // f64 representa com exatidão — a conversão não perde precisão aqui.
    JsonValue::from(count as f64 / total as f64)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // ---- DBS-091..101: texto literal do checklist, um teste por critério ----

    #[test]
    fn dbs_091_show_original_lists_values_side_by_side() {
        // "Dado 3 páginas relacionadas com Status distintos, quando 'Show
        // original' é usado, então os 3 valores aparecem lado a lado."
        let per_page = vec![vec![json!("todo")], vec![json!("doing")], vec![json!("done")]];
        assert_eq!(
            aggregate(AggregationKind::ShowOriginal, &per_page),
            json!(["todo", "doing", "done"])
        );
    }

    #[test]
    fn dbs_093_count_all_counts_pages_even_when_target_is_empty() {
        // "Dado 5 páginas vinculadas com 2 vazias no alvo, quando 'Count
        // all' é usado, então o valor é 5."
        let per_page = vec![vec![json!("a")], vec![], vec![json!("b")], vec![], vec![json!("c")]];
        assert_eq!(aggregate(AggregationKind::CountAll, &per_page), json!(5));
    }

    #[test]
    fn dbs_094_count_values_counts_a_multi_select_page_as_two() {
        // "Dado 5 páginas e uma com 2 tags multi-select, quando 'Count
        // values' é usado, então essa página conta como 2."
        let per_page = vec![
            vec![json!("x")],
            vec![json!("tag1"), json!("tag2")],
            vec![json!("y")],
            vec![json!("z")],
            vec![json!("w")],
        ];
        assert_eq!(aggregate(AggregationKind::CountValues, &per_page), json!(6));
    }

    #[test]
    fn dbs_095_count_unique_counts_distinct_values() {
        // "Dado valores 'A,A,B,C', quando 'Count unique values' é usado,
        // então o resultado é 3."
        let per_page = vec![vec![json!("A")], vec![json!("A")], vec![json!("B")], vec![json!("C")]];
        assert_eq!(aggregate(AggregationKind::CountUnique, &per_page), json!(3));
    }

    #[test]
    fn dbs_096_count_empty_counts_pages_with_empty_target() {
        // "Dado 5 páginas com 2 vazias, quando 'Count empty' é usado, então
        // o resultado é 2."
        let per_page =
            vec![vec![json!(1.0)], vec![], vec![json!(2.0)], vec![], vec![json!(3.0)]];
        assert_eq!(aggregate(AggregationKind::CountEmpty, &per_page), json!(2));
    }

    #[test]
    fn dbs_097_count_not_empty_counts_pages_with_filled_target() {
        // "Dado 5 páginas com 3 preenchidas, quando 'Count not empty' é
        // usado, então o resultado é 3."
        let per_page =
            vec![vec![json!(1.0)], vec![json!(2.0)], vec![json!(3.0)], vec![], vec![]];
        assert_eq!(aggregate(AggregationKind::CountNotEmpty, &per_page), json!(3));
    }

    #[test]
    fn dbs_100_numeric_rollups_over_related_pages() {
        // "Dado valores 10,20,30, quando 'Range' é usado, então o resultado
        // é 20 (30-10); 'Average' dá 20."
        let per_page = vec![vec![json!(10.0)], vec![json!(20.0)], vec![json!(30.0)]];
        assert_eq!(aggregate(AggregationKind::Range, &per_page), json!(20.0));
        assert_eq!(aggregate(AggregationKind::Average, &per_page), json!(20.0));
        assert_eq!(aggregate(AggregationKind::Sum, &per_page), json!(60.0));
        assert_eq!(aggregate(AggregationKind::Min, &per_page), json!(10.0));
        assert_eq!(aggregate(AggregationKind::Max, &per_page), json!(30.0));
        assert_eq!(aggregate(AggregationKind::Median, &per_page), json!(20.0));
    }

    #[test]
    fn dbs_101_date_rollups_find_earliest_and_latest() {
        // "Dado datas 01/01,15/01,10/02, quando 'Earliest date' é usado,
        // então o valor é 01/01; 'Latest date' dá 10/02."
        let per_page = vec![
            vec![json!({"start": "2026-01-01"})],
            vec![json!({"start": "2026-01-15"})],
            vec![json!({"start": "2026-02-10"})],
        ];
        assert_eq!(
            aggregate(AggregationKind::EarliestDate, &per_page),
            json!({"start": "2026-01-01"})
        );
        assert_eq!(
            aggregate(AggregationKind::LatestDate, &per_page),
            json!({"start": "2026-02-10"})
        );
        assert_eq!(
            aggregate(AggregationKind::DateRange, &per_page),
            json!({"start": "2026-01-01", "end": "2026-02-10"})
        );
    }

    #[test]
    fn dbs_130_footer_aggregations_reuse_the_same_kernel() {
        // Rodapé: a lista vem de LINHAS VISÍVEIS, não de páginas
        // relacionadas — mesma forma, dono diferente da lista (nota do
        // cabeçalho do módulo). 10 linhas, 3 com a coluna numérica vazia.
        let per_page = vec![
            vec![json!(2.0)],
            vec![json!(4.0)],
            vec![],
            vec![json!(6.0)],
            vec![],
            vec![json!(8.0)],
            vec![json!(8.0)],
            vec![],
            vec![json!(10.0)],
            vec![json!(12.0)],
        ];
        assert_eq!(aggregate(AggregationKind::CountAll, &per_page), json!(10));
        assert_eq!(aggregate(AggregationKind::CountValues, &per_page), json!(7));
        assert_eq!(aggregate(AggregationKind::CountUnique, &per_page), json!(6)); // 8.0 repete
        assert_eq!(aggregate(AggregationKind::CountEmpty, &per_page), json!(3));
        assert_eq!(aggregate(AggregationKind::PercentEmpty, &per_page), json!(0.3));
        assert_eq!(aggregate(AggregationKind::CountNotEmpty, &per_page), json!(7));
        assert_eq!(aggregate(AggregationKind::PercentNotEmpty, &per_page), json!(0.7));

        let dates = vec![
            vec![json!({"start": "2026-03-01"})],
            vec![],
            vec![json!({"start": "2026-01-20"})],
            vec![json!({"start": "2026-05-05"})],
        ];
        assert_eq!(
            aggregate(AggregationKind::EarliestDate, &dates),
            json!({"start": "2026-01-20"})
        );
        assert_eq!(
            aggregate(AggregationKind::LatestDate, &dates),
            json!({"start": "2026-05-05"})
        );
        assert_eq!(
            aggregate(AggregationKind::DateRange, &dates),
            json!({"start": "2026-01-20", "end": "2026-05-05"})
        );
    }

    // ---- explode_cell: I1 e multi-valor ----

    #[test]
    fn explode_cell_splits_multi_select_arrays_into_atomic_entries() {
        assert_eq!(
            explode_cell("multi_select", &json!(["tag1", "tag2"])),
            vec![json!("tag1"), json!("tag2")]
        );
    }

    #[test]
    fn explode_cell_keeps_scalar_and_date_values_as_a_single_entry() {
        assert_eq!(explode_cell("number", &json!(10.0)), vec![json!(10.0)]);
        let date = json!({"start": "2026-01-01", "end": "2026-01-05"});
        assert_eq!(explode_cell("date", &date), vec![date]);
    }

    #[test]
    fn explode_cell_treats_null_and_empty_array_as_zero_elements_i1() {
        // Borda: I1 diz que isso nunca deveria chegar aqui (a linha nem
        // existiria), mas um chamador defensivo pode passar Null em vez de
        // omitir a chamada — nunca vira `vec![Value::Null]`.
        assert_eq!(explode_cell("text", &JsonValue::Null), Vec::<JsonValue>::new());
        assert_eq!(explode_cell("multi_select", &json!([])), Vec::<JsonValue>::new());
    }

    // ---- bordas exigidas pela regra 6: o tipo permite, o caminho feliz não vê ----

    #[test]
    fn aggregate_returns_null_for_numeric_and_date_kinds_with_nothing_to_aggregate() {
        let per_page: Vec<Vec<JsonValue>> = vec![vec![], vec![]]; // toda página com alvo vazio
        for kind in [
            AggregationKind::Sum,
            AggregationKind::Average,
            AggregationKind::Median,
            AggregationKind::Min,
            AggregationKind::Max,
            AggregationKind::Range,
            AggregationKind::EarliestDate,
            AggregationKind::LatestDate,
            AggregationKind::DateRange,
        ] {
            assert_eq!(aggregate(kind, &per_page), JsonValue::Null);
        }
    }

    #[test]
    fn aggregate_ignores_non_numeric_entries_instead_of_panicking() {
        // Nunca deveria acontecer (I1/I4 normalizam por tipo antes de
        // gravar), mas o fold é puro e não pode confiar nisso.
        let per_page = vec![vec![json!(10.0)], vec![json!("not a number")], vec![json!(20.0)]];
        assert_eq!(aggregate(AggregationKind::Sum, &per_page), json!(30.0));
    }

    #[test]
    fn aggregate_handles_the_empty_slice_without_dividing_by_zero() {
        let per_page: Vec<Vec<JsonValue>> = vec![];
        assert_eq!(aggregate(AggregationKind::CountAll, &per_page), json!(0));
        assert_eq!(aggregate(AggregationKind::PercentEmpty, &per_page), JsonValue::Null);
        assert_eq!(aggregate(AggregationKind::PercentNotEmpty, &per_page), JsonValue::Null);
        assert_eq!(aggregate(AggregationKind::ShowOriginal, &per_page), json!([]));
    }

    #[test]
    fn date_range_is_degenerate_but_valid_with_a_single_date() {
        let per_page = vec![vec![json!({"start": "2026-06-01"})]];
        assert_eq!(
            aggregate(AggregationKind::DateRange, &per_page),
            json!({"start": "2026-06-01", "end": "2026-06-01"})
        );
    }

    #[test]
    fn earliest_date_orders_by_start_never_by_the_whole_object_i2() {
        // Regressão direta do exemplo de I2 na arquitetura: um valor com
        // `end` tem mais chaves e "venceria" uma comparação ingênua de
        // objeto inteiro mesmo sendo cronologicamente o primeiro.
        let per_page = vec![
            vec![json!({"start": "2026-01-01", "end": "2026-01-02"})],
            vec![json!({"start": "2026-10-01"})],
        ];
        assert_eq!(
            aggregate(AggregationKind::EarliestDate, &per_page),
            json!({"start": "2026-01-01", "end": "2026-01-02"})
        );
    }
}
