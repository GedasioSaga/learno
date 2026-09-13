//! Leitura de `review_log` (migração `0012_review_log.sql`) para a tela de
//! Estatísticas de cartões — mapa de calor, dias estudados, sequências e
//! True Retention. `review_log` já é GRAVADA por `db::cards::CardRepository`
//! (`answer_card`, na mesma transação que reagenda o cartão); este módulo só
//! LÊ — nenhum método aqui grava uma linha.
//!
//! ## Escopo de baralho: o mesmo critério de `db::cards`, byte a byte
//!
//! "Com `deck_id`, soma aquele baralho e os descendentes ativos dele; sem
//! `deck_id`, soma toda árvore ativa" é a mesma CTE recursiva que
//! `CardRepository::deck_counts`/`deck_forecast` já usam
//! (`ESCOPO_BARALHOS_CTE` em `db::cards`) — reusar o critério, não inventar
//! um segundo, é o pedido explícito desta peça. Essa constante é privada ao
//! módulo `cards` (sem `pub(crate)`) e `cards.rs` está fora do escopo de
//! edição desta peça (outro agente trabalha nele em paralelo), então
//! [`ESCOPO_BARALHOS_CTE`] abaixo é uma cópia literal, não uma reimplementação
//! — qualquer mudança de critério em `db::cards` precisa ser replicada aqui
//! manualmente até o dia em que a constante puder virar `pub(crate)` e um
//! módulo `db::deck_scope` compartilhado a hospedar.
//!
//! ## Semântica que este módulo decide (e por quê)
//!
//! - **Dia é o calendário LOCAL, `reviewed_at` é TEXT em UTC.** Uma revisão
//!   às 22h de terça em São Paulo é quarta em UTC; agrupar pelo texto UTC
//!   tornaria o mapa de calor mentiroso. A conversão acontece em Rust
//!   (`DateTime<Utc>::with_timezone(&Local)`), o mesmo padrão que
//!   `CardRepository::deck_forecast` já usa para os mesmos motivos — não em
//!   SQL (`date(x, 'localtime')` depende do SQLite enxergar o fuso do
//!   sistema do jeito certo; a conversão do lado Rust é a que o resto do
//!   projeto já confia).
//! - **Dias sem revisão não entram em `por_dia`.** Quem desenha o calendário
//!   preenche o buraco — a mesma decisão que o comentário de `RevisaoDoDia`
//!   em `src/lib/ipc.ts` já documenta.
//! - **`media_diaria` é por dia ESTUDADO**, não por dia da janela, e é `0.0`
//!   (nunca `NaN`) quando `dias_estudados == 0` — dividir por zero em `f64`
//!   não estoura, produz `NaN`, e `NaN` serializa como `null` no JSON, o que
//!   quebraria a tela em silêncio.
//! - **`maior_sequencia`/`sequencia_atual` são corridas de dias
//!   CONSECUTIVOS** com pelo menos uma revisão, calculadas em Rust a partir
//!   da lista ordenada de dias com revisão — nunca em SQL. `sequencia_atual`
//!   só é maior que zero quando o ÚLTIMO dia estudado é hoje ou ontem (fuso
//!   local); se a pessoa parou há três dias, a sequência atual é zero mesmo
//!   que a corrida antiga tenha sido longa.
//! - **`retencao` é a True Retention do Anki**: entre revisões cujo
//!   `state_before = 'review'` (cartão já maduro — novo e aprendizado NÃO
//!   entram, porque errar um cartão novo é esperado e diluiria a medida), a
//!   fração com `rating >= 3`. Sem nenhuma revisão madura na janela, o valor
//!   é `None` — nunca `0.0`, que significaria "errei tudo".

use std::collections::BTreeMap;

use chrono::{DateTime, Days, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::IdBind;
use crate::error::{Error, Result};

/// Teto de `dias` que `stats` aceita. Entrada de comando IPC é hostil
/// (alcançável por script na WebView) e `dias` dimensiona diretamente a
/// largura da janela consultada — mesmo raciocínio e mesmo valor de
/// `CardRepository::deck_forecast` (`DECK_FORECAST_DIAS_MAXIMO`, em
/// `db::cards`): dez anos é generoso para qualquer gráfico real de
/// estatísticas de estudo.
const STUDY_STATS_DIAS_MAXIMO: i64 = 3650;

/// Cópia literal de `ESCOPO_BARALHOS_CTE` (`db::cards`) — ver o comentário de
/// módulo acima sobre por que é uma cópia e não uma importação.
const ESCOPO_BARALHOS_CTE: &str = "WITH RECURSIVE escopo AS ( \
     SELECT id FROM decks WHERE deleted_at IS NULL AND parent_id IS NULL AND $1 IS NULL \
     UNION ALL \
     SELECT id FROM decks WHERE deleted_at IS NULL AND id = $1 AND $1 IS NOT NULL \
     UNION ALL \
     SELECT d.id FROM decks d JOIN escopo e ON d.parent_id = e.id WHERE d.deleted_at IS NULL \
 )";

/// Um dia do histórico de revisões — espelha `RevisaoDoDia` em `src/lib/ipc.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisaoDoDia {
    pub dia: String,
    pub revisoes: i64,
    pub segundos: i64,
}

/// O que a tela de Estatísticas de cartões desenha — espelha
/// `EstatisticasDeEstudo` em `src/lib/ipc.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyStats {
    pub por_dia: Vec<RevisaoDoDia>,
    pub total_revisoes: i64,
    pub media_diaria: f64,
    pub dias_estudados: i64,
    pub maior_sequencia: i64,
    pub sequencia_atual: i64,
    pub retencao: Option<f64>,
}

pub struct ReviewLogRepository {
    pool: SqlitePool,
}

impl ReviewLogRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `study_stats` do contrato de IPC: histórico dos últimos `dias` dias
    /// (contando hoje), agregado por dia local. Sem `deck_id`, soma toda
    /// árvore ativa de baralhos; com `deck_id`, soma aquele baralho e seus
    /// descendentes ativos — ver o comentário de módulo sobre
    /// `ESCOPO_BARALHOS_CTE`.
    pub async fn stats(&self, deck_id: Option<Uuid>, dias: i64) -> Result<StudyStats> {
        if !(1..=STUDY_STATS_DIAS_MAXIMO).contains(&dias) {
            return Err(Error::Invalid(format!(
                "dias precisa estar entre 1 e {STUDY_STATS_DIAS_MAXIMO}, recebido {dias}"
            )));
        }

        let agora = Utc::now();
        let hoje_local = agora.with_timezone(&Local).date_naive();
        // Janela de `dias` dias terminando em hoje (inclusive): começa
        // `dias - 1` dias atrás. `dias >= 1` já foi validado acima, então
        // `dias - 1 >= 0` e o deslocamento nunca aponta para o futuro.
        let inicio_da_janela = inicio_do_dia_local_em_utc(agora, -(dias - 1));
        let inicio_de_amanha = inicio_do_dia_local_em_utc(agora, 1);

        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT r.reviewed_at, r.duration_ms, r.state_before, r.rating \
             FROM review_log r \
             JOIN cards c ON c.id = r.card_id \
             WHERE c.deck_id IN (SELECT id FROM escopo) \
               AND r.reviewed_at >= $2 AND r.reviewed_at < $3"
        );

        let linhas: Vec<(DateTime<Utc>, Option<i64>, String, i64)> = sqlx::query_as(&sql)
            .bind(deck_id.db())
            .bind(formatar_timestamp(inicio_da_janela))
            .bind(formatar_timestamp(inicio_de_amanha))
            .fetch_all(&self.pool)
            .await?;

        // `BTreeMap<NaiveDate, _>` dá agregação por dia local E ordem
        // crescente de uma vez só — o contrato exige `por_dia` ordenado por
        // dia crescente, e um `BTreeMap` iterado por chave já entrega isso
        // sem `sort` adicional.
        let mut por_dia_mapa: BTreeMap<NaiveDate, (i64, i64)> = BTreeMap::new();
        let mut revisoes_maduras: i64 = 0;
        let mut revisoes_maduras_boas: i64 = 0;

        for (reviewed_at, duration_ms, state_before, rating) in &linhas {
            let dia_local = reviewed_at.with_timezone(&Local).date_naive();
            let entrada = por_dia_mapa.entry(dia_local).or_insert((0, 0));
            entrada.0 += 1;
            // Soma final mostrada no mapa de calor, não um intermediário que
            // alimenta outra conta (a distinção que justifica `saturating_*`
            // em vez de alargar o tipo) — `duration_ms` nulo vira zero, nunca
            // erro.
            entrada.1 = entrada.1.saturating_add(duration_ms.unwrap_or(0));

            // True Retention: só revisões de cartão que já estava em
            // `review` entram — novo e aprendizado ficam de fora de
            // propósito (ver comentário de módulo).
            if state_before == "review" {
                revisoes_maduras = revisoes_maduras.saturating_add(1);
                if *rating >= 3 {
                    revisoes_maduras_boas = revisoes_maduras_boas.saturating_add(1);
                }
            }
        }

        let por_dia: Vec<RevisaoDoDia> = por_dia_mapa
            .iter()
            .map(|(dia, (revisoes, duration_ms_soma))| RevisaoDoDia {
                dia: dia.format("%Y-%m-%d").to_string(),
                revisoes: *revisoes,
                segundos: segundos_arredondados(*duration_ms_soma),
            })
            .collect();

        // `linhas.len()`/`por_dia.len()` são `usize`; convertê-los para `i64`
        // (o tipo do contrato JSON) só poderia estourar se o banco tivesse
        // mais de `i64::MAX` linhas de `review_log` ou dias na janela —
        // fisicamente impossível para o armazenamento deste app — mas
        // propagamos como erro em vez de `as` mesmo assim (regra 3 do
        // projeto: nenhum `as` estreitando sem prova ou `try_from`).
        let total_revisoes = i64::try_from(linhas.len())
            .map_err(|_| Error::Invalid("janela de estatísticas grande demais para representar".into()))?;
        let dias_estudados = i64::try_from(por_dia.len())
            .map_err(|_| Error::Invalid("janela de estatísticas grande demais para representar".into()))?;

        // Divisão por dia ESTUDADO, não por dia da janela — dia zerado não
        // puxa a média para baixo. `0.0`, nunca `NaN`: `NaN` serializa como
        // `null` e quebraria a tela em silêncio.
        let media_diaria = if dias_estudados == 0 {
            0.0
        } else {
            // `total_revisoes`/`dias_estudados` são contagens de revisões
            // reais de um usuário só, muito abaixo de 2^53 (onde `f64`
            // deixaria de representar inteiro com exatidão) — a conversão é
            // segura na prática, mesmo sem equivalente `try_from` para f64.
            total_revisoes as f64 / dias_estudados as f64
        };

        let dias_com_revisao: Vec<NaiveDate> = por_dia_mapa.keys().copied().collect();
        let (maior_sequencia, sequencia_atual) = calcular_sequencias(&dias_com_revisao, hoje_local);

        let retencao = if revisoes_maduras == 0 {
            None
        } else {
            // Mesmo raciocínio de `media_diaria` sobre a conversão para
            // `f64`: contagens de revisão de um usuário só, longe de 2^53.
            Some(revisoes_maduras_boas as f64 / revisoes_maduras as f64)
        };

        Ok(StudyStats { por_dia, total_revisoes, media_diaria, dias_estudados, maior_sequencia, sequencia_atual, retencao })
    }
}

/// Maior corrida de dias consecutivos em `dias_com_revisao` (ordenada
/// crescente, sem repetição — é exatamente o que iterar as chaves de um
/// `BTreeMap<NaiveDate, _>` entrega) e o comprimento da corrida que termina
/// no ÚLTIMO dia da lista, mas só contado como `sequencia_atual` quando esse
/// último dia é hoje ou ontem (fuso local) — parar há três dias zera a
/// sequência atual mesmo que a corrida em si tivesse sido longa.
fn calcular_sequencias(dias_com_revisao: &[NaiveDate], hoje_local: NaiveDate) -> (i64, i64) {
    let Some(&primeiro) = dias_com_revisao.first() else {
        return (0, 0);
    };

    let mut maior_sequencia: i64 = 1;
    let mut corrida_atual: i64 = 1;
    let mut ultimo_dia = primeiro;

    for &dia in &dias_com_revisao[1..] {
        if dia == ultimo_dia + Days::new(1) {
            corrida_atual += 1;
        } else {
            corrida_atual = 1;
        }
        maior_sequencia = maior_sequencia.max(corrida_atual);
        ultimo_dia = dia;
    }

    let ontem_local = hoje_local - Days::new(1);
    let sequencia_atual = if ultimo_dia == hoje_local || ultimo_dia == ontem_local { corrida_atual } else { 0 };

    (maior_sequencia, sequencia_atual)
}

/// `duration_ms` somado de um dia, dividido por 1000 e arredondado ao
/// inteiro mais próximo (arredondamento "meio para cima", suficiente porque
/// `duration_ms` nunca é negativo — tempo de resposta de um cartão).
/// Aritmética inteira em vez de `f64` + `.round()`: nenhuma perda de
/// precisão possível a evitar.
fn segundos_arredondados(duration_ms_soma: i64) -> i64 {
    // Soma final mostrada no mapa de calor (não um intermediário que
    // alimenta outra divisão) — saturar no teto é o caso correto de
    // `saturating_*` aqui, não um valor errado e silencioso.
    duration_ms_soma.saturating_add(500) / 1000
}

/// Meia-noite LOCAL (fuso do sistema) do dia `agora + deslocamento_dias`,
/// convertida de volta para UTC — mesma função e mesmo raciocínio do
/// homônimo privado em `db::cards` (comentário `I5`), generalizada para
/// `deslocamento_dias: i64` porque a janela de `stats` precisa de um limite
/// inferior no PASSADO (`db::cards` só olha para frente, então o original
/// aceita só `u64`). Cópia deliberada pelo mesmo motivo de
/// `ESCOPO_BARALHOS_CTE`: a função de origem é privada e `cards.rs` está
/// fora do escopo de edição desta peça.
fn inicio_do_dia_local_em_utc(agora_utc: DateTime<Utc>, deslocamento_dias: i64) -> DateTime<Utc> {
    let hoje_local = agora_utc.with_timezone(&Local).date_naive();
    let dia_alvo = if deslocamento_dias >= 0 {
        hoje_local + Days::new(deslocamento_dias.unsigned_abs())
    } else {
        hoje_local - Days::new(deslocamento_dias.unsigned_abs())
    };
    let meia_noite_ingenua = NaiveDateTime::new(dia_alvo, NaiveTime::MIN);

    match Local.from_local_datetime(&meia_noite_ingenua) {
        chrono::LocalResult::Single(instante) => instante.with_timezone(&Utc),
        // Horário duplicado (fim do horário de verão): a ocorrência mais
        // cedo é a leitura conservadora.
        chrono::LocalResult::Ambiguous(mais_cedo, _mais_tarde) => mais_cedo.with_timezone(&Utc),
        // Horário inexistente (início do horário de verão pulando a meia-
        // noite): o Brasil não usa horário de verão desde 2019 — este ramo
        // só protege contra um usuário rodando com outro fuso do sistema.
        chrono::LocalResult::None => Utc.from_utc_datetime(&meia_noite_ingenua),
    }
}

/// Mesmo formato que os defaults de coluna de `review_log` usam
/// (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` na migração) e que
/// `db::cards::formatar_timestamp` já grava — ISO 8601 UTC de largura fixa
/// com 3 casas de milissegundo, formatado à mão em vez de confiar no
/// `Encode<Sqlite>` derivado do sqlx para `DateTime<Utc>` (a armadilha que
/// `db::ids` documenta: tipo do sqlx e formato do schema podem divergir em
/// silêncio). Aqui o texto ligado é sempre este, byte a byte, então comparar
/// contra `reviewed_at` (TEXT) com `>=`/`<` concorda com a ordem cronológica
/// real.
fn formatar_timestamp(instante: DateTime<Utc>) -> String {
    instante.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui — mesmo
    // padrão de `db::cards`/`db::decks`.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn data(texto: &str) -> NaiveDate {
        NaiveDate::parse_from_str(texto, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn sequencia_vazia_devolve_zero_para_as_duas() {
        assert_eq!(calcular_sequencias(&[], data("2026-09-05")), (0, 0));
    }

    #[test]
    fn corrida_com_buraco_no_meio_a_maior_vem_da_corrida_mais_longa_nao_da_ultima() {
        // 01,02,03 (corrida de 3) — buraco — 08,09 (corrida de 2, é a última).
        let dias = vec![data("2026-09-01"), data("2026-09-02"), data("2026-09-03"), data("2026-09-08"), data("2026-09-09")];
        let (maior, _atual) = calcular_sequencias(&dias, data("2026-09-09"));
        assert_eq!(maior, 3, "a corrida de 3 dias precisa vencer mesmo não sendo a última");
    }

    #[test]
    fn sequencia_atual_conta_quando_o_ultimo_dia_estudado_foi_ontem() {
        let dias = vec![data("2026-09-03"), data("2026-09-04")];
        let (_maior, atual) = calcular_sequencias(&dias, data("2026-09-05"));
        assert_eq!(atual, 2);
    }

    #[test]
    fn sequencia_atual_conta_quando_o_ultimo_dia_estudado_foi_hoje() {
        let dias = vec![data("2026-09-04"), data("2026-09-05")];
        let (_maior, atual) = calcular_sequencias(&dias, data("2026-09-05"));
        assert_eq!(atual, 2);
    }

    #[test]
    fn sequencia_atual_zera_quando_o_ultimo_estudo_foi_ha_tres_dias() {
        let dias = vec![data("2026-08-30"), data("2026-08-31"), data("2026-09-02")];
        let (maior, atual) = calcular_sequencias(&dias, data("2026-09-05"));
        assert_eq!(maior, 2, "a maior corrida (30,31) continua valendo 2");
        assert_eq!(atual, 0, "último estudo há três dias precisa zerar a sequência atual");
    }

    #[test]
    fn segundos_arredondados_arredonda_meio_para_cima() {
        assert_eq!(segundos_arredondados(0), 0);
        assert_eq!(segundos_arredondados(999), 1);
        assert_eq!(segundos_arredondados(1499), 1);
        assert_eq!(segundos_arredondados(1500), 2);
    }

    #[test]
    fn formatar_timestamp_bate_byte_a_byte_com_o_default_das_migracoes() {
        let instante = DateTime::parse_from_rfc3339("2026-09-05T10:00:05.123Z").unwrap().with_timezone(&Utc);
        assert_eq!(formatar_timestamp(instante), "2026-09-05T10:00:05.123Z");
    }

    #[test]
    fn inicio_do_dia_local_aceita_deslocamento_negativo_e_olha_para_o_passado() {
        let agora = DateTime::parse_from_rfc3339("2026-09-05T15:30:00Z").unwrap().with_timezone(&Utc);
        let hoje = inicio_do_dia_local_em_utc(agora, 0);
        let seis_dias_atras = inicio_do_dia_local_em_utc(agora, -6);

        assert_eq!(hoje - seis_dias_atras, chrono::Duration::days(6));
        assert!(seis_dias_atras < hoje);
    }
}
