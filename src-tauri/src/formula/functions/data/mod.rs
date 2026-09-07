//! Categoria "data" (DBS-070/071/073/074): `now`/`today`, aritmética
//! (`dateAdd`/`dateSubtract`/`dateBetween`) e formatação
//! (`formatDate`/`parseDate`), mais a extração de componente
//! (`minute`/`hour`/`day`/`date`/`week`/`month`/`year`).
//!
//! ## `now()`/`today()` e o fuso do usuário
//!
//! O usuário é brasileiro, sem servidor, sem sync (arquitetura §2) — a
//! MESMA decisão que `db::cards::inicio_do_dia_local_em_utc` já tomou para
//! "que fuso é 'hoje'": o fuso do SISTEMA (`chrono::Local`), não UTC fixo.
//! A direção aqui é a OPOSTA da função de `db::cards`: aquela vai de um DIA
//! LOCAL para um instante UTC (por isso precisa tratar horário ambíguo/
//! inexistente na virada do horário de verão); `today()`/`now()` vão de um
//! instante UTC já conhecido (`EvalCtx::now()`, fixado no início da
//! avaliação — arquitetura §4, "duas chamadas de `now()` na mesma fórmula
//! vêm com o MESMO instante") para a leitura de parede no fuso Local, o que
//! NUNCA é ambíguo nem inexistente (todo instante UTC mapeia para
//! exatamente uma leitura local) — por isso nenhuma das duas precisa da
//! lógica de `chrono::LocalResult` que `inicio_do_dia_local_em_utc` tem.
//!
//! ## `dateBetween`: a ordem escolhida
//!
//! `dateBetween(a, b, unidade)` = `a - b`, na unidade pedida — "quantas
//! unidades `a` está à FRENTE de `b`". Com `Entrega` cinco dias no futuro,
//! `dateBetween(prop("Entrega"), now(), "days")` devolve `+5` (DBS-071
//! aceita `5` OU `-5`, desde que documentado e testado — esta é a decisão
//! tomada). Só `weeks`/`days`/`hours`/`minutes`: uma diferença em
//! `months`/`years` exigiria uma convenção de arredondamento de calendário
//! que nenhum exemplo do checklist pede — unidade desconhecida (inclusive
//! essas duas) devolve vazio, nunca pânico.
//!
//! ## `dateAdd`/`dateSubtract`: unidades e a forma da saída
//!
//! Seis unidades: `years`/`months`/`weeks`/`days`/`hours`/`minutes`.
//! `amount` é arredondado para o inteiro mais próximo antes de aplicar —
//! uma fração de mês ou semana não tem um único significado de calendário.
//! `years`/`months`/`weeks`/`days` preservam a FORMA da entrada (uma data
//! só-dia continua só-dia); `hours`/`minutes` sempre produzem uma saída COM
//! hora, mesmo que a entrada não tivesse — um deslocamento sub-dia perderia
//! sentido se fosse arredondado de volta para "só data". Unidade
//! desconhecida ou resultado que estoura o range do `chrono` (ano grande
//! demais) devolvem vazio, nunca pânico.
//!
//! ## `formatDate`: tokens suportados
//!
//! `YYYY` (ano, 4 dígitos) · `MM` (mês, 2 dígitos) · `DD` (dia do mês, 2
//! dígitos) · `HH` (hora 24h, 2 dígitos) · `mm` (minuto, 2 dígitos).
//! Qualquer outro trecho do padrão — separador (`/`, `-`, espaço) ou uma
//! sequência de letras que não é nenhum destes cinco — atravessa para a
//! saída sem alteração: nunca pânico, nunca lixo, sempre o mesmo texto de
//! volta (testado em `format_date_with_an_unknown_token_passes_it_through`).
//!
//! ## `day()` vs `date()`
//!
//! `day()` é o dia da SEMANA (0=domingo .. 6=sábado, convenção do Notion);
//! `date()` é o dia do MÊS (1-31). Os dois nomes colidem de propósito com o
//! vocabulário do Notion, não com `chrono::Datelike::day()` (que É o dia do
//! mês) — ver o comentário de [`eval_day`]/[`eval_date`] para o porquê da
//! troca de nome não ser um erro de digitação.
//!
//! ## Vazio
//!
//! Todas as funções desta categoria têm `accepts_empty(_) = false` (vazio
//! propaga de graça, arquitetura §4) — nenhuma delas é `empty()`/`if`, que
//! moram em `functions::logica`.
mod checks;

use chrono::{Datelike, Days, Local, Months, NaiveDate, NaiveDateTime, NaiveTime, TimeDelta, Timelike};

use crate::formula::core::{register, Arg, Arity, DateValue, EvalCtx, FunctionDef, ParamKind, Value};

use checks::{
    check_date, check_date_add, check_date_between, check_date_subtract, check_day, check_format_date, check_hour,
    check_minute, check_month, check_now, check_parse_date, check_today, check_week, check_year,
};

fn date_arg(args: &[Arg], index: usize) -> Option<DateValue> {
    match args.get(index) {
        Some(Arg::Value(Value::Date(d))) => Some(d.clone()),
        _ => None,
    }
}

fn string_arg(args: &[Arg], index: usize) -> Option<&str> {
    match args.get(index) {
        Some(Arg::Value(Value::String(s))) => Some(s.as_str()),
        _ => None,
    }
}

fn number_arg(args: &[Arg], index: usize) -> Option<f64> {
    match args.get(index) {
        Some(Arg::Value(Value::Number(n))) => Some(*n),
        _ => None,
    }
}

/// `DateValue::parse` (`core/types.rs`) só confere a FORMA (dígitos em
/// posição fixa); aqui também confirmamos que os componentes formam uma
/// data de CALENDÁRIO real (`chrono` recusa "2026-02-30") antes de aceitar —
/// as duas checagens juntas garantem que todo `NaiveDateTime` que sai desta
/// função é utilizável em aritmética sem risco de pânico.
fn parse_naive(component: &str) -> Option<NaiveDateTime> {
    match component.len() {
        10 => NaiveDate::parse_from_str(component, "%Y-%m-%d").ok().map(|d| d.and_time(NaiveTime::MIN)),
        16 => NaiveDateTime::parse_from_str(component, "%Y-%m-%dT%H:%M").ok(),
        _ => None,
    }
}

fn format_naive(ndt: NaiveDateTime, with_time: bool) -> String {
    if with_time {
        ndt.format("%Y-%m-%dT%H:%M").to_string()
    } else {
        ndt.date().format("%Y-%m-%d").to_string()
    }
}

/// `value` já é um inteiro (arredondado por quem chama) — só falta
/// confirmar que cabe em `u32` antes do `as` (regra 3): fora da faixa
/// `[0, u32::MAX]`, `None`, nunca um `as u32` que trunca em silêncio.
fn magnitude_as_u32(value: f64) -> Option<u32> {
    (value.is_finite() && (0.0..=(u32::MAX as f64)).contains(&value)).then_some(value as u32)
}

/// Mesma prova que [`magnitude_as_u32`], para `Days` (que usa `u64`).
fn magnitude_as_u64(value: f64) -> Option<u64> {
    (value.is_finite() && (0.0..=(u64::MAX as f64)).contains(&value)).then_some(value as u64)
}

/// Para horas/minutos: `TimeDelta::try_hours`/`try_minutes` já recebem o
/// sinal, então não precisamos separar magnitude e direção como nas duas
/// funções acima — só confirmar que o valor cabe num `i64` antes do `as`.
fn as_i64_checked(value: f64) -> Option<i64> {
    (value.is_finite() && ((i64::MIN as f64)..=(i64::MAX as f64)).contains(&value)).then_some(value as i64)
}

/// O núcleo de `dateAdd`/`dateSubtract`: desloca `ndt` por `amount` unidades
/// de `unit`. `amount` é arredondado para o inteiro mais próximo antes de
/// aplicar — ver a doc do módulo. `years`/`months`/`weeks`/`days` deslocam
/// só a DATA (a hora do dia não muda); `hours`/`minutes` deslocam o
/// instante inteiro. `None` — nunca pânico — quando o resultado estouraria
/// o range que `chrono` representa ou quando `unit` não é nenhuma das seis
/// reconhecidas.
fn shift_naive_datetime(ndt: NaiveDateTime, amount: f64, unit: &str) -> Option<NaiveDateTime> {
    let rounded = amount.round();
    if !rounded.is_finite() {
        return None;
    }
    let negative = rounded < 0.0;
    match unit {
        "years" => {
            let months = Months::new(magnitude_as_u32(rounded.abs() * 12.0)?);
            if negative {
                ndt.checked_sub_months(months)
            } else {
                ndt.checked_add_months(months)
            }
        }
        "months" => {
            let months = Months::new(magnitude_as_u32(rounded.abs())?);
            if negative {
                ndt.checked_sub_months(months)
            } else {
                ndt.checked_add_months(months)
            }
        }
        "weeks" => {
            let days = Days::new(magnitude_as_u64(rounded.abs() * 7.0)?);
            if negative {
                ndt.checked_sub_days(days)
            } else {
                ndt.checked_add_days(days)
            }
        }
        "days" => {
            let days = Days::new(magnitude_as_u64(rounded.abs())?);
            if negative {
                ndt.checked_sub_days(days)
            } else {
                ndt.checked_add_days(days)
            }
        }
        "hours" => ndt.checked_add_signed(TimeDelta::try_hours(as_i64_checked(rounded)?)?),
        "minutes" => ndt.checked_add_signed(TimeDelta::try_minutes(as_i64_checked(rounded)?)?),
        _ => None,
    }
}

/// `unit` em `hours`/`minutes` força a saída a CARREGAR hora, mesmo que a
/// entrada fosse só data — ver a doc do módulo.
fn shift_date_value(date: &DateValue, amount: f64, unit: &str) -> Option<DateValue> {
    let had_time = date.start.len() == 16;
    let force_time = matches!(unit, "hours" | "minutes");
    let shifted = shift_naive_datetime(parse_naive(&date.start)?, amount, unit)?;
    let start = format_naive(shifted, had_time || force_time);
    DateValue::parse(&start, None)
}

fn eval_now(_args: &[Arg], ctx: &mut EvalCtx) -> Value {
    let start = ctx.now().with_timezone(&Local).format("%Y-%m-%dT%H:%M").to_string();
    DateValue::parse(&start, None).map(Value::Date).unwrap_or(Value::Empty)
}

fn eval_today(_args: &[Arg], ctx: &mut EvalCtx) -> Value {
    let start = ctx.now().with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string();
    DateValue::parse(&start, None).map(Value::Date).unwrap_or(Value::Empty)
}

fn eval_date_shift(args: &[Arg], sign: f64) -> Value {
    let (Some(date), Some(amount), Some(unit)) = (date_arg(args, 0), number_arg(args, 1), string_arg(args, 2)) else {
        return Value::Empty;
    };
    shift_date_value(&date, amount * sign, unit).map(Value::Date).unwrap_or(Value::Empty)
}

fn eval_date_add(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    eval_date_shift(args, 1.0)
}

/// `dateSubtract(d, n, u)` é `dateAdd(d, -n, u)` — reaproveita o mesmo
/// núcleo em vez de duplicar a lógica de deslocamento.
fn eval_date_subtract(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    eval_date_shift(args, -1.0)
}

/// `dateBetween(a, b, unidade)` = `a - b` — ver a doc do módulo para o
/// porquê desta ordem e para as unidades suportadas.
fn eval_date_between(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let (Some(a), Some(b), Some(unit)) = (date_arg(args, 0), date_arg(args, 1), string_arg(args, 2)) else {
        return Value::Empty;
    };
    let (Some(na), Some(nb)) = (parse_naive(&a.start), parse_naive(&b.start)) else {
        return Value::Empty;
    };
    let delta = na.signed_duration_since(nb);
    let count = match unit {
        "weeks" => delta.num_weeks(),
        "days" => delta.num_days(),
        "hours" => delta.num_hours(),
        "minutes" => delta.num_minutes(),
        _ => return Value::Empty,
    };
    // A diferença entre duas datas de fórmula nunca chega perto de 2^53 (o
    // maior inteiro que um f64 representa sem perda) — sem erro de precisão
    // nesta conversão.
    Value::Number(count as f64)
}

/// Tokens suportados, cada um documentado na doc do módulo. Como todo valor
/// de substituição é só dígito, encadear `replace` não corre o risco de uma
/// substituição anterior "criar" acidentalmente o próximo token na saída.
fn apply_format_tokens(ndt: NaiveDateTime, pattern: &str) -> String {
    pattern
        .replace("YYYY", &format!("{:04}", ndt.year()))
        .replace("MM", &format!("{:02}", ndt.month()))
        .replace("DD", &format!("{:02}", ndt.day()))
        .replace("HH", &format!("{:02}", ndt.hour()))
        .replace("mm", &format!("{:02}", ndt.minute()))
}

fn eval_format_date(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let (Some(date), Some(pattern)) = (date_arg(args, 0), string_arg(args, 1)) else {
        return Value::Empty;
    };
    match parse_naive(&date.start) {
        Some(ndt) => Value::String(apply_format_tokens(ndt, pattern)),
        None => Value::Empty,
    }
}

/// Aceita as MESMAS duas formas que `DateValue`/`prop()` já aceitam
/// (`YYYY-MM-DD` ou `YYYY-MM-DDTHH:MM`) — texto lixo (formato errado, ou
/// forma certa mas calendário inválido tipo "2026-13-40") vira vazio, nunca
/// erro nem pânico.
fn eval_parse_date(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    let Some(text) = string_arg(args, 0) else {
        return Value::Empty;
    };
    match DateValue::parse(text, None) {
        Some(date) if parse_naive(&date.start).is_some() => Value::Date(date),
        _ => Value::Empty,
    }
}

fn eval_minute(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0).and_then(|d| parse_naive(&d.start)).map(|ndt| Value::Number(f64::from(ndt.minute()))).unwrap_or(Value::Empty)
}

fn eval_hour(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0).and_then(|d| parse_naive(&d.start)).map(|ndt| Value::Number(f64::from(ndt.hour()))).unwrap_or(Value::Empty)
}

/// `day()`: dia da SEMANA, 0 (domingo) a 6 (sábado) — a convenção do
/// Notion, diferente de `date()` (dia do MÊS, abaixo). `Weekday::
/// num_days_from_sunday` é exatamente essa contagem.
fn eval_day(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0)
        .and_then(|d| parse_naive(&d.start))
        .map(|ndt| Value::Number(f64::from(ndt.weekday().num_days_from_sunday())))
        .unwrap_or(Value::Empty)
}

/// `date()`: dia do MÊS, 1-31 — `chrono::Datelike::day()` já é exatamente
/// isso (o nome `day` do `chrono` colide com a função `day()` DESTA
/// linguagem, que é dia da SEMANA — os dois não são a mesma coisa, daí a
/// troca de nome entre a função chrono e a função da fórmula).
fn eval_date(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0).and_then(|d| parse_naive(&d.start)).map(|ndt| Value::Number(f64::from(ndt.day()))).unwrap_or(Value::Empty)
}

fn eval_week(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0)
        .and_then(|d| parse_naive(&d.start))
        .map(|ndt| Value::Number(f64::from(ndt.iso_week().week())))
        .unwrap_or(Value::Empty)
}

fn eval_month(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0).and_then(|d| parse_naive(&d.start)).map(|ndt| Value::Number(f64::from(ndt.month()))).unwrap_or(Value::Empty)
}

fn eval_year(args: &[Arg], _ctx: &mut EvalCtx) -> Value {
    date_arg(args, 0).and_then(|d| parse_naive(&d.start)).map(|ndt| Value::Number(f64::from(ndt.year()))).unwrap_or(Value::Empty)
}

pub fn register_all() {
    register(FunctionDef {
        name: "now",
        category: "data",
        doc: "Data e hora atuais (hora local).",
        arity: Arity::Exact(0),
        params: |_| ParamKind::Value,
        check: check_now,
        accepts_empty: |_| false,
        eval: eval_now,
    });
    register(FunctionDef {
        name: "today",
        category: "data",
        doc: "Data de hoje (hora local), sem componente de hora.",
        arity: Arity::Exact(0),
        params: |_| ParamKind::Value,
        check: check_today,
        accepts_empty: |_| false,
        eval: eval_today,
    });
    register(FunctionDef {
        name: "dateAdd",
        category: "data",
        doc: "Soma um número de unidades (years/months/weeks/days/hours/minutes) a uma data.",
        arity: Arity::Exact(3),
        params: |_| ParamKind::Value,
        check: check_date_add,
        accepts_empty: |_| false,
        eval: eval_date_add,
    });
    register(FunctionDef {
        name: "dateSubtract",
        category: "data",
        doc: "Subtrai um número de unidades (years/months/weeks/days/hours/minutes) de uma data.",
        arity: Arity::Exact(3),
        params: |_| ParamKind::Value,
        check: check_date_subtract,
        accepts_empty: |_| false,
        eval: eval_date_subtract,
    });
    register(FunctionDef {
        name: "dateBetween",
        category: "data",
        doc: "Diferença (primeira data menos a segunda) na unidade pedida (weeks/days/hours/minutes).",
        arity: Arity::Exact(3),
        params: |_| ParamKind::Value,
        check: check_date_between,
        accepts_empty: |_| false,
        eval: eval_date_between,
    });
    register(FunctionDef {
        name: "formatDate",
        category: "data",
        doc: "Formata uma data segundo um padrão (YYYY, MM, DD, HH, mm).",
        arity: Arity::Exact(2),
        params: |_| ParamKind::Value,
        check: check_format_date,
        accepts_empty: |_| false,
        eval: eval_format_date,
    });
    register(FunctionDef {
        name: "parseDate",
        category: "data",
        doc: "Interpreta um texto ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:MM) como data.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_parse_date,
        accepts_empty: |_| false,
        eval: eval_parse_date,
    });
    register(FunctionDef {
        name: "minute",
        category: "data",
        doc: "Minuto de uma data (0-59).",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_minute,
        accepts_empty: |_| false,
        eval: eval_minute,
    });
    register(FunctionDef {
        name: "hour",
        category: "data",
        doc: "Hora de uma data (0-23).",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_hour,
        accepts_empty: |_| false,
        eval: eval_hour,
    });
    register(FunctionDef {
        name: "day",
        category: "data",
        doc: "Dia da semana de uma data (0=domingo .. 6=sábado).",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_day,
        accepts_empty: |_| false,
        eval: eval_day,
    });
    register(FunctionDef {
        name: "date",
        category: "data",
        doc: "Dia do mês de uma data (1-31).",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_date,
        accepts_empty: |_| false,
        eval: eval_date,
    });
    register(FunctionDef {
        name: "week",
        category: "data",
        doc: "Número da semana ISO do ano de uma data.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_week,
        accepts_empty: |_| false,
        eval: eval_week,
    });
    register(FunctionDef {
        name: "month",
        category: "data",
        doc: "Mês de uma data (1-12).",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_month,
        accepts_empty: |_| false,
        eval: eval_month,
    });
    register(FunctionDef {
        name: "year",
        category: "data",
        doc: "Ano de uma data.",
        arity: Arity::Exact(1),
        params: |_| ParamKind::Value,
        check: check_year,
        accepts_empty: |_| false,
        eval: eval_year,
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::formula::core::{compile, eval, PageMeta, PropertyId, Type, ValueSource};
    use uuid::Uuid;

    /// Schema falso com "Data"/"Entrega" configuráveis como `Value::Date` —
    /// o par que os exemplos literais do checklist (DBS-070/071/074)
    /// precisam.
    struct FakeSchema {
        data: Option<Value>,
        entrega: Option<Value>,
    }

    impl ValueSource for FakeSchema {
        fn value(&self, _record: Uuid, property: PropertyId) -> Value {
            if property == Uuid::from_u128(1) {
                self.data.clone().unwrap_or(Value::Empty)
            } else if property == Uuid::from_u128(2) {
                self.entrega.clone().unwrap_or(Value::Empty)
            } else {
                Value::Empty
            }
        }
        fn related(&self, _record: Uuid, _property: PropertyId) -> Vec<Uuid> {
            Vec::new()
        }
        fn page_meta(&self, record: Uuid) -> PageMeta {
            PageMeta { id: record, title: String::new(), created_at: String::new(), updated_at: String::new() }
        }
        fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)> {
            match name {
                "Data" => Some((Uuid::from_u128(1), Type::Date)),
                "Entrega" => Some((Uuid::from_u128(2), Type::Date)),
                _ => None,
            }
        }
    }

    fn schema_with_data(data: &str) -> FakeSchema {
        FakeSchema {
            data: DateValue::parse(data, None).map(Value::Date),
            entrega: None,
        }
    }

    fn run_with(schema: &FakeSchema, src: &str) -> Value {
        crate::formula::functions::register_all();
        let compiled = compile(src, schema).unwrap_or_else(|errors| panic!("esperava compilar \"{src}\", veio {errors:?}"));
        let mut ctx = EvalCtx::new(schema, Uuid::new_v4(), chrono::Utc::now());
        eval(&compiled.expr, &mut ctx)
    }

    fn run(src: &str) -> Value {
        run_with(&schema_with_data("2026-03-15"), src)
    }

    /// O exemplo LITERAL de DBS-070: `month(prop("Data"))` com
    /// Data=2026-03-15 retorna 3.
    #[test]
    fn dbs_070_month_of_a_date() {
        assert_eq!(run("month(prop(\"Data\"))"), Value::Number(3.0));
    }

    #[test]
    fn date_component_extraction_happy_path() {
        let schema = schema_with_data("2026-03-15T14:07");
        assert_eq!(run_with(&schema, "year(prop(\"Data\"))"), Value::Number(2026.0));
        assert_eq!(run_with(&schema, "month(prop(\"Data\"))"), Value::Number(3.0));
        assert_eq!(run_with(&schema, "date(prop(\"Data\"))"), Value::Number(15.0));
        assert_eq!(run_with(&schema, "hour(prop(\"Data\"))"), Value::Number(14.0));
        assert_eq!(run_with(&schema, "minute(prop(\"Data\"))"), Value::Number(7.0));
        // 2026-03-15 é um domingo.
        assert_eq!(run_with(&schema, "day(prop(\"Data\"))"), Value::Number(0.0));
    }

    /// Data-só (sem hora) tem hora/minuto 0 — a meia-noite implícita que
    /// `parse_naive` usa para o componente de 10 caracteres.
    #[test]
    fn date_only_value_has_zero_hour_and_minute() {
        assert_eq!(run("hour(prop(\"Data\"))"), Value::Number(0.0));
        assert_eq!(run("minute(prop(\"Data\"))"), Value::Number(0.0));
    }

    #[test]
    fn week_returns_the_iso_week_number() {
        // 2026-03-15 é uma domingo da semana ISO 11 de 2026.
        assert_eq!(run("week(prop(\"Data\"))"), Value::Number(11.0));
    }

    /// O exemplo LITERAL de DBS-074: `formatDate(prop("Data"), "DD/MM/YYYY")`
    /// com Data=2026-09-02 retorna "02/09/2026".
    #[test]
    fn dbs_074_format_date_literal_example() {
        let schema = schema_with_data("2026-09-02");
        assert_eq!(
            run_with(&schema, "formatDate(prop(\"Data\"), \"DD/MM/YYYY\")"),
            Value::String("02/09/2026".to_string())
        );
    }

    /// Borda pedida pela regra 6: um token que não é nenhum dos cinco
    /// suportados atravessa para a saída sem alteração — nunca pânico,
    /// nunca lixo.
    #[test]
    fn format_date_with_an_unknown_token_passes_it_through() {
        let schema = schema_with_data("2026-09-02");
        assert_eq!(
            run_with(&schema, "formatDate(prop(\"Data\"), \"ZZZZ-MM\")"),
            Value::String("ZZZZ-09".to_string())
        );
    }

    #[test]
    fn format_date_with_time_tokens() {
        let schema = schema_with_data("2026-09-02T08:05");
        assert_eq!(
            run_with(&schema, "formatDate(prop(\"Data\"), \"HH:mm\")"),
            Value::String("08:05".to_string())
        );
    }

    #[test]
    fn parse_date_accepts_date_only_and_date_time() {
        assert_eq!(
            run("parseDate(\"2026-03-15\")"),
            Value::Date(DateValue { start: "2026-03-15".to_string(), end: None })
        );
        assert_eq!(
            run("parseDate(\"2026-03-15T08:30\")"),
            Value::Date(DateValue { start: "2026-03-15T08:30".to_string(), end: None })
        );
    }

    /// Borda pedida pela regra 6: string lixo (formato errado ou calendário
    /// inválido) vira vazio, nunca erro nem pânico.
    #[test]
    fn parse_date_of_garbage_text_is_empty() {
        assert_eq!(run("parseDate(\"não é uma data\")"), Value::Empty);
        assert_eq!(run("parseDate(\"2026-13-40\")"), Value::Empty); // mês/dia inválidos
        assert_eq!(run("parseDate(\"\")"), Value::Empty);
    }

    #[test]
    fn date_add_and_subtract_happy_path_each_unit() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(
            run_with(&schema, "dateAdd(prop(\"Data\"), 1, \"years\")"),
            Value::Date(DateValue { start: "2027-01-15".to_string(), end: None })
        );
        assert_eq!(
            run_with(&schema, "dateAdd(prop(\"Data\"), 2, \"months\")"),
            Value::Date(DateValue { start: "2026-03-15".to_string(), end: None })
        );
        assert_eq!(
            run_with(&schema, "dateAdd(prop(\"Data\"), 1, \"weeks\")"),
            Value::Date(DateValue { start: "2026-01-22".to_string(), end: None })
        );
        assert_eq!(
            run_with(&schema, "dateAdd(prop(\"Data\"), 10, \"days\")"),
            Value::Date(DateValue { start: "2026-01-25".to_string(), end: None })
        );
        assert_eq!(
            run_with(&schema, "dateSubtract(prop(\"Data\"), 5, \"days\")"),
            Value::Date(DateValue { start: "2026-01-10".to_string(), end: None })
        );
    }

    /// `hours`/`minutes` sempre produzem uma saída COM hora, mesmo partindo
    /// de uma data-só.
    #[test]
    fn date_add_with_hours_forces_a_time_component_even_from_a_date_only_input() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(
            run_with(&schema, "dateAdd(prop(\"Data\"), 25, \"hours\")"),
            Value::Date(DateValue { start: "2026-01-16T01:00".to_string(), end: None })
        );
    }

    /// Borda pedida pela regra 6: `dateAdd` estourando o range do `chrono`
    /// devolve vazio, nunca pânico.
    #[test]
    fn date_add_overflowing_the_chrono_range_is_empty_not_a_panic() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(run_with(&schema, "dateAdd(prop(\"Data\"), 999999999, \"years\")"), Value::Empty);
    }

    /// Borda pedida pela regra 6: unidade desconhecida devolve vazio.
    #[test]
    fn date_add_with_an_unknown_unit_is_empty() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(run_with(&schema, "dateAdd(prop(\"Data\"), 1, \"lustros\")"), Value::Empty);
    }

    /// O exemplo LITERAL de DBS-071: `dateBetween(prop("Entrega"), now(),
    /// "days")` com Entrega em 5 dias no futuro retorna 5 (a ordem escolhida
    /// — ver a doc do módulo).
    ///
    /// `Entrega` é construída no MESMO grão (data + hora, não só a data) que
    /// `now()` vai produzir dentro da avaliação — comparar uma Entrega à
    /// meia-noite com um `now()` que tem hora real arredondaria `num_days()`
    /// para baixo sempre que o teste rodasse depois da meia-noite local.
    #[test]
    fn dbs_071_date_between_entrega_e_now_em_dias() {
        let agora_local_naive = chrono::Utc::now().with_timezone(&Local).naive_local();
        let entrega_em_cinco_dias = agora_local_naive.checked_add_days(chrono::Days::new(5)).expect("data de teste válida");
        let schema = FakeSchema {
            data: None,
            entrega: DateValue::parse(&entrega_em_cinco_dias.format("%Y-%m-%dT%H:%M").to_string(), None).map(Value::Date),
        };

        let compiled_src = "dateBetween(prop(\"Entrega\"), now(), \"days\")";
        let resultado = run_with(&schema, compiled_src);
        assert_eq!(resultado, Value::Number(5.0));
    }

    /// Borda pedida pela regra 6: unidade desconhecida em `dateBetween`
    /// devolve vazio.
    #[test]
    fn date_between_with_an_unknown_unit_is_empty() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(run_with(&schema, "dateBetween(prop(\"Data\"), prop(\"Data\"), \"anos-luz\")"), Value::Empty);
    }

    #[test]
    fn date_between_same_instant_is_zero() {
        let schema = schema_with_data("2026-01-15");
        assert_eq!(run_with(&schema, "dateBetween(prop(\"Data\"), prop(\"Data\"), \"days\")"), Value::Number(0.0));
    }

    #[test]
    fn now_and_today_produce_a_date_value() {
        assert!(matches!(run("now()"), Value::Date(_)));
        assert!(matches!(run("today()"), Value::Date(_)));
    }

    /// `today()` nunca carrega hora — só os dez caracteres `YYYY-MM-DD`.
    #[test]
    fn today_has_no_time_component() {
        match run("today()") {
            Value::Date(d) => assert_eq!(d.start.len(), 10, "today() não deveria carregar hora"),
            other => panic!("esperava Value::Date, veio {other:?}"),
        }
    }
}
