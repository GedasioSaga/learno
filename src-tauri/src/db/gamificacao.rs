//! Gamificação (Fase 1 de 2 — só banco e Rust; a Fase 2 liga isto à UI e ao
//! contrato de IPC em `src/lib/ipc.ts`): XP, nível, desafios diários,
//! recordes pessoais e resumo de sessão.
//!
//! ## A regra mais forte deste projeto decide o desenho inteiro deste módulo
//!
//! "Nada na tela pode afirmar mais do que o dado sustenta" — ver o comentário
//! de módulo de `0026_gamificacao.sql` para as duas consequências diretas
//! (sem ranking contra ninguém, XP sempre rastreável numa linha). Este
//! arquivo é a metade Rust dessa promessa:
//!
//! - [`GamificacaoRepository::xp_total`]/[`GamificacaoRepository::nivel_atual`]
//!   são sempre `SUM(amount) FROM xp_events` (ou uma função pura desse
//!   total) — nunca um contador incrementado à parte.
//! - [`GamificacaoRepository::recordes_pessoais`] não lê tabela nenhuma de
//!   "recorde": é uma leitura derivada de `review_log`, reusando
//!   [`ReviewLogRepository::stats`] em vez de recalcular sequência/dias
//!   estudados uma segunda vez com uma lógica que poderia divergir.
//! - [`GamificacaoRepository::desafios_hoje`] calcula progresso a partir do
//!   histórico real (`review_log`, `pomodoro_sessions`, `study_plan_blocks`)
//!   — nunca de um contador paralelo.
//!
//! ## Reuso deliberado (e cópia deliberada) de outros módulos
//!
//! Este módulo NÃO é dono de `review_log`/`pomodoro_sessions`/
//! `study_plan_blocks` (outras peças, algumas em paralelo) — só lê o
//! suficiente delas para gamificação, do mesmo jeito que `db::review_log` já
//! só lê `cards`/`decks` sem ser dono deles.
//!
//! ## XP é CONSEQUÊNCIA do evento de domínio, não uma chamada separada
//!
//! Até esta peça, `registrar_xp_revisao_cartao`/`registrar_xp_pomodoro_concluido`
//! eram comandos IPC prontos que NENHUMA tela chamava — impossível de chamar,
//! no caso da revisão de cartão, porque `AnswerOutcome` nunca carregava o
//! `review_log_id` que o comando exige. XP virar uma ação separada que
//! depende de alguma tela lembrar de disparar é exatamente o padrão que este
//! projeto já reprovou repetidas vezes.
//!
//! A correção inverte a dependência: [`GamificacaoRepository::creditar_xp_na_transacao`]
//! é uma função `pub` que recebe a `Transaction` de OUTRO módulo já aberta, e
//! `db::cards::CardRepository::answer_card`/`db::pomodoro::PomodoroRepository::finish`
//! chamam-na dentro da MESMA transação que grava `review_log`/fecha a sessão
//! de pomodoro — então `db::cards` e `db::pomodoro` passam a depender de
//! `db::gamificacao` (o único sentido em que este módulo deixa de ser só
//! leitura-e-cálculo). Os três comandos `registrar_xp_*` continuam existindo
//! como caminho de REPROCESSAMENTO (ver o comentário de
//! `ipc::gamificacao_commands` para o porquê de mantê-los) — não como o
//! caminho principal, que agora é automático.
//!
//! [`local_date_for`]/[`now_local_date_and_offset`] abaixo são CÓPIAS
//! literais dos homônimos privados em `db::pomodoro` — o pedido desta peça
//! aponta explicitamente para eles ("já existe conversão pronta... reuse").
//! Como são privados naquele módulo e `pomodoro.rs` está fora da lista de
//! arquivos desta peça, copiar é o padrão que este projeto já usa nesta
//! situação exata: `db::review_log` copia `ESCOPO_BARALHOS_CTE`/
//! `inicio_do_dia_local_em_utc` de `db::cards` pelo mesmo motivo (ver o
//! comentário de módulo de `db::review_log`). Mudar o comportamento de um
//! lado precisa ser replicado manualmente no outro até existir um módulo
//! `db::tempo_local` compartilhado.
//!
//! ## Desafio diário: determinístico, não sorteado
//!
//! Três categorias fixas (revisar cartões, focar minutos, concluir blocos do
//! cronograma), cada uma com uma pequena lista de metas candidatas. A meta do
//! dia é escolhida por um hash SHA-256 de `(dia_local, categoria)` — MESMA
//! entrada, MESMA saída, sempre. Abrir o app duas vezes no mesmo dia local
//! mostra os mesmos três desafios com a mesma meta; não há `rand` nem
//! relógio de novo consultado depois da primeira leitura do dia. Não existe
//! tabela de "desafio do dia": a chave `"<dia_local>:<tipo>"` em
//! `xp_events.reference_id` já é suficiente para saber se aquele desafio,
//! naquele dia, já foi creditado — reaproveitar a mesma tabela de evento em
//! vez de inventar uma segunda é a mesma disciplina de "todo número tem uma
//! origem" aplicada ao desafio.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Days, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::cards::CardRepository;
use crate::db::ids::{DbId, IdBind};
use crate::db::review_log::ReviewLogRepository;
use crate::error::{Error, Result};

// ---------------------------------------------------------------------
// Quanto vale cada origem de XP — um lugar só, com o porquê ao lado.
// ---------------------------------------------------------------------

/// Uma resposta de cartão (`review_log`), qualquer nota (`again`..`easy`).
/// Mesmo valor para toda nota: mesmo errar ("again") é engajamento real —
/// revisar é o hábito central deste app, e o valor fica baixo de propósito
/// porque uma sessão de estudo gera DEZENAS de revisões, então o total do
/// dia vem da repetição, não de um valor unitário alto.
pub const XP_POR_REVISAO_CARTAO: i64 = 10;

/// Um pomodoro de FOCO concluído até o fim (nunca um cancelado — ver
/// [`GamificacaoRepository::registrar_xp_pomodoro_concluido`]). Maior que uma
/// revisão isolada porque exige uma janela de tempo contínua sem largar o
/// timer, e um ciclo típico (25 min) vale mais que revisar um punhado de
/// cartões nesse mesmo tempo.
pub const XP_POR_POMODORO_CONCLUIDO: i64 = 30;

/// Um bloco do cronograma (`study_plan_blocks`) cujo tempo realizado já
/// alcançou `planned_minutes`. Entre revisão e pomodoro: um bloco pode ser
/// leitura ou mapa mental (atividades sem execução própria), então o valor
/// não pode depender de qual atividade era — só de ter sido cumprido.
pub const XP_POR_BLOCO_CRONOGRAMA: i64 = 20;

/// Um desafio diário vencido. O maior valor dos quatro de propósito: é o
/// "prêmio do dia" que a tela de gamificação destaca, e precisa valer
/// nitidamente mais que qualquer ação isolada para funcionar como o alvo que
/// puxa o usuário a fechar as três categorias.
pub const XP_POR_DESAFIO_DIARIO: i64 = 50;

/// `planned_minutes` do bloco, ou `None` se ele não existe.
async fn minutos_planejados_do_bloco<'e, E>(executor: E, block_id: Uuid) -> Result<Option<i64>>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query_scalar("SELECT planned_minutes FROM study_plan_blocks WHERE id = $1")
        .bind(block_id.db())
        .fetch_optional(executor)
        .await?)
}

/// Minutos de fato realizados para o bloco `block_id`, somando as duas fontes
/// que `study_day_totals` (`0024_cronograma.sql`) já reconhece como tempo
/// realizado — sessão de pomodoro de foco concluída ligada a ele, e lançamento
/// manual ligado a ele — restrito a um bloco só em vez do dia inteiro.
async fn minutos_realizados_do_bloco<'e, E>(executor: E, block_id: Uuid) -> Result<i64>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    let (segundos_pomodoro, minutos_manuais): (i64, i64) = sqlx::query_as(
        "SELECT \
             COALESCE((SELECT SUM(duration_seconds) FROM pomodoro_sessions \
                        WHERE plan_block_id = $1 AND kind = 'focus' AND completed = 1), 0), \
             COALESCE((SELECT SUM(minutes) FROM study_time_entries WHERE plan_block_id = $1), 0)",
    )
    .bind(block_id.db())
    .fetch_one(executor)
    .await?;

    // Segundos -> minuto inteiro arredondado ao mais próximo — mesma regra de
    // conversão que `study_day_totals` usa ("+30 s, divide por 60"), para
    // "bloco cumprido" bater com o tempo que a tela do cronograma mostra.
    let minutos_pomodoro = segundos_pomodoro.saturating_add(30) / 60;
    Ok(minutos_pomodoro.saturating_add(minutos_manuais))
}

// ---------------------------------------------------------------------
// Curva de nível — pura, sem tocar o banco.
// ---------------------------------------------------------------------

/// Quanto XP a MAIS cada nível custa, multiplicado pelo nível anterior:
/// 1→2 custa `XP_INCREMENTO_BASE`, 2→3 o dobro, 3→4 o triplo. Curva comum de
/// jogo de progressão (Duolingo, curva de nível de RPG): sobe rápido no
/// início — motivação para quem acabou de começar — e cada vez mais devagar
/// depois, para "nível 500" não acontecer numa tarde de estudo.
const XP_INCREMENTO_BASE: u128 = 100;

/// XP TOTAL cumulativo (desde o nível 1, que começa em zero XP) necessário
/// para ALCANÇAR `nivel`:
///
/// ```text
/// cumulativo(nivel) = Σ_{i=1}^{nivel-1} XP_INCREMENTO_BASE * i
///                    = XP_INCREMENTO_BASE * (nivel - 1) * nivel / 2
/// ```
///
/// `saturating_sub`/`saturating_mul` (não aritmética crua) são a resposta
/// certa aqui — não porque um valor saturado vá para a tela: esta função só
/// alimenta COMPARAÇÕES (`<=`) dentro de [`maior_nivel_dentro_do_xp`], nunca
/// um XP final mostrado ao usuário. Saturar em `u128::MAX` só faz a
/// comparação responder "isso é maior que qualquer XP real", que é
/// exatamente verdade quando o produto de verdade estouraria.
fn xp_cumulativo_para_nivel(nivel: u128) -> u128 {
    let anteriores = nivel.saturating_sub(1);
    XP_INCREMENTO_BASE.saturating_mul(anteriores).saturating_mul(nivel) / 2
}

/// Maior `nivel` (sempre >= 1) cujo XP cumulativo cabe dentro de `xp_total`.
///
/// Busca binária sobre uma função estritamente crescente — não um laço que
/// soma incremento até estourar `xp_total`. O laço ingênuo precisaria de
/// milhões de iterações para um XP absurdamente alto (o próprio caso que o
/// pedido desta peça manda testar: "não pode estourar nem entrar em laço");
/// a busca binária resolve o mesmo em poucas dezenas de passos não importa
/// quão grande `xp_total` seja.
fn maior_nivel_dentro_do_xp(xp_total: u128) -> u128 {
    // Teto de segurança para o laço de duplicação abaixo: mesmo um `xp_total`
    // astronomicamente maior que qualquer XP real (a API pública só aceita
    // `i64`, então o nível correspondente de verdade fica bem abaixo disto)
    // faz `hi` ultrapassar `xp_total` muito antes deste teto — ele só existe
    // para o laço ter uma prova de término que não dependa da curva
    // continuar crescendo do jeito esperado.
    const TETO_BUSCA: u128 = 1 << 100;

    let mut hi: u128 = 2;
    while hi < TETO_BUSCA && xp_cumulativo_para_nivel(hi) <= xp_total {
        // `hi < TETO_BUSCA` (bem abaixo de `u128::MAX / 2`) garante que esta
        // multiplicação nunca estoura.
        hi *= 2;
    }

    let mut lo: u128 = 1;
    // Invariante mantido do início ao fim deste laço:
    // `cumulativo(lo) <= xp_total < cumulativo(hi)`.
    while hi - lo > 1 {
        let meio = lo + (hi - lo) / 2;
        if xp_cumulativo_para_nivel(meio) <= xp_total {
            lo = meio;
        } else {
            hi = meio;
        }
    }
    lo
}

/// O que a tela de progressão desenha: nível atual, XP já acumulado dentro
/// dele, quanto falta para o próximo, e a fração pronta para a barra de
/// progresso. Espelha `EstadoDeNivel` em `src/lib/ipc.ts` (a Fase 2 escreve o
/// contrato TypeScript).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoDeNivel {
    pub nivel: i64,
    pub xp_total: i64,
    pub xp_no_nivel_atual: i64,
    pub xp_para_proximo_nivel: i64,
    /// 0.0..=1.0 — exatamente o que a barra de progresso desenha. Nunca
    /// `NaN`: o incremento de um nível é sempre
    /// `XP_INCREMENTO_BASE * nivel` com `nivel >= 1`, então o denominador
    /// da divisão abaixo nunca é zero.
    pub progresso: f64,
}

/// Pura: XP total -> nível + progresso. Testada sozinha (sem banco) nos
/// testes deste módulo, nos extremos que o pedido desta peça exige: zero XP,
/// exatamente a fronteira de um nível, e um XP absurdamente alto.
pub fn calcular_nivel(xp_total: i64) -> Result<EstadoDeNivel> {
    if xp_total < 0 {
        return Err(Error::Invalid(format!("XP total não pode ser negativo: {xp_total}")));
    }
    // `xp_total >= 0` acabou de ser checado — esta conversão nunca falha na
    // prática, mas o erro é propagado em vez de `unwrap`/`expect` mesmo
    // assim (regra do projeto: nenhum atalho por "eu sei que não falha").
    let xp_total_u64 = u64::try_from(xp_total).map_err(|_| Error::Invalid("XP total inválido".into()))?;
    let xp_total_u128 = u128::from(xp_total_u64); // Alargar é sempre seguro.

    let nivel_u128 = maior_nivel_dentro_do_xp(xp_total_u128);
    let cumulativo_atual = xp_cumulativo_para_nivel(nivel_u128);
    let cumulativo_proximo = xp_cumulativo_para_nivel(nivel_u128 + 1);

    // `maior_nivel_dentro_do_xp` devolve, por definição, o maior nível cujo
    // cumulativo cabe em `xp_total_u128` — esta subtração nunca estoura por
    // baixo.
    let xp_no_nivel_atual_u128 = xp_total_u128 - cumulativo_atual;
    // A curva é estritamente crescente, então `cumulativo_proximo` é sempre
    // maior que `cumulativo_atual` — este incremento nunca é zero.
    let incremento_do_nivel_u128 = cumulativo_proximo - cumulativo_atual;
    let xp_para_proximo_u128 = incremento_do_nivel_u128 - xp_no_nivel_atual_u128;

    let converter = |valor: u128, rotulo: &str| -> Result<i64> {
        i64::try_from(valor).map_err(|_| Error::Invalid(format!("{rotulo} grande demais para representar: {valor}")))
    };

    let nivel = converter(nivel_u128, "nível")?;
    let xp_no_nivel_atual = converter(xp_no_nivel_atual_u128, "XP no nível atual")?;
    let xp_para_proximo_nivel = converter(xp_para_proximo_u128, "XP para o próximo nível")?;
    let incremento_do_nivel = converter(incremento_do_nivel_u128, "incremento do nível")?;

    // Os quatro valores acima já couberam em `i64` (senão `converter` teria
    // retornado erro) e são contagens de XP de um usuário só, muito abaixo
    // de 2^53 (onde `f64` deixaria de representar inteiro com exatidão) —
    // mesmo raciocínio que `db::review_log::stats` já usa para
    // `media_diaria`/`retencao`.
    let progresso = xp_no_nivel_atual as f64 / incremento_do_nivel as f64;

    Ok(EstadoDeNivel { nivel, xp_total, xp_no_nivel_atual, xp_para_proximo_nivel, progresso })
}

// ---------------------------------------------------------------------
// Dia local — copiado de `db::pomodoro` (ver o comentário de módulo).
// ---------------------------------------------------------------------

/// Copiado de `db::pomodoro::local_date_for` (privado naquele módulo, fora
/// do escopo de edição desta peça).
fn local_date_for(instant_utc: DateTime<Utc>, offset_minutes: i64) -> String {
    let shifted = instant_utc + Duration::minutes(offset_minutes);
    shifted.format("%Y-%m-%d").to_string()
}

/// Copiado de `db::pomodoro::now_local_date_and_offset` — ver o comentário de
/// [`local_date_for`] acima.
fn now_local_date_and_offset() -> (String, i64) {
    let offset_seconds = i64::from(Local::now().offset().local_minus_utc());
    let offset_minutes = offset_seconds / 60;
    (local_date_for(Utc::now(), offset_minutes), offset_minutes)
}

/// Início (inclusive) e fim (exclusivo), em UTC, do dia local `local_date`
/// (`YYYY-MM-DD`) sob o deslocamento `offset_minutes` — o par que
/// [`now_local_date_and_offset`] produz.
///
/// Existe porque `review_log` (diferente de `pomodoro_sessions`, que ganhou
/// uma coluna `local_date` em `0024_cronograma.sql`) não guarda o dia local:
/// para contar "quantas revisões aconteceram no dia local X" é preciso
/// converter o dia alvo numa janela UTC e filtrar `reviewed_at` por ela —
/// mesma ideia de `db::review_log::inicio_do_dia_local_em_utc`, mas para um
/// dia específico em vez de "hoje + deslocamento".
fn limites_utc_do_dia_local(local_date: &str, offset_minutes: i64) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let dia = NaiveDate::parse_from_str(local_date, "%Y-%m-%d")
        .map_err(|err| Error::Invalid(format!("data local inválida {local_date:?}: {err}")))?;
    let meia_noite_local = NaiveDateTime::new(dia, NaiveTime::MIN);
    // `local = utc + offset` (mesma convenção de `local_date_for` acima) ->
    // `utc = local - offset`.
    let inicio_utc_ingenuo = meia_noite_local - Duration::minutes(offset_minutes);
    let inicio_utc = Utc.from_utc_datetime(&inicio_utc_ingenuo);
    let fim_utc = inicio_utc + Duration::days(1);
    Ok((inicio_utc, fim_utc))
}

/// Mesmo formato que os defaults de coluna deste projeto usam
/// (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`) — ISO 8601 UTC de largura fixa,
/// para comparar contra `reviewed_at`/`created_at` (TEXT) com `>=`/`<`
/// concordar com a ordem cronológica real. Mesma função, byte a byte, que
/// `db::review_log::formatar_timestamp` (privada naquele módulo).
fn formatar_timestamp(instante: DateTime<Utc>) -> String {
    instante.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------
// Desafio diário.
// ---------------------------------------------------------------------

/// Uma categoria fixa de desafio, com uma pequena lista de metas candidatas
/// — a meta do dia é escolhida entre elas por [`indice_deterministico`].
struct CategoriaDesafio {
    /// Chave estável: metade de `xp_events.reference_id`
    /// (`"<dia_local>:<tipo>"`) e o que o frontend manda de volta em
    /// `registrar_xp_desafio_diario`.
    tipo: &'static str,
    titulo: &'static str,
    unidade: &'static str,
    metas: &'static [i64],
}

const CATEGORIAS_DESAFIO: [CategoriaDesafio; 3] = [
    CategoriaDesafio {
        tipo: "revisar_cartoes",
        titulo: "Revisar cartões",
        unidade: "cartões",
        metas: &[15, 20, 30],
    },
    CategoriaDesafio {
        tipo: "focar_minutos",
        titulo: "Focar em uma sessão de pomodoro",
        unidade: "minutos",
        metas: &[25, 50, 75],
    },
    CategoriaDesafio {
        tipo: "concluir_blocos",
        titulo: "Concluir um bloco do cronograma",
        unidade: "blocos",
        metas: &[1, 2],
    },
];

/// Índice determinístico dentro de `0..metas.len()`, derivado de
/// `(local_date, tipo)` por SHA-256 — mesma entrada, mesma saída, sempre
/// (ver o comentário de módulo sobre "determinístico, não sorteado"). Não é
/// uso criptográfico: só precisa parecer embaralhado entre poucos
/// candidatos (no máximo dezenas) e nunca mudar para a mesma entrada.
fn indice_deterministico(local_date: &str, tipo: &str, quantidade_metas: usize) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(local_date.as_bytes());
    hasher.update(b":");
    hasher.update(tipo.as_bytes());
    let digest = hasher.finalize();
    // `digest[0]` é `u8` (0..=255); alargar para `usize` é sempre seguro —
    // nenhuma plataforma suportada por este app tem `usize` menor que 8
    // bits. `.max(1)` no divisor é só para o `%` nunca ver um módulo zero,
    // ainda que nenhuma entrada de [`CATEGORIAS_DESAFIO`] hoje tenha lista de
    // metas vazia.
    (digest[0] as usize) % quantidade_metas.max(1)
}

/// Um desafio do dia — espelha `Desafio` em `src/lib/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Desafio {
    pub tipo: String,
    pub titulo: String,
    pub unidade: String,
    pub meta: i64,
    /// Calculado a partir do histórico real — nunca de um contador à parte
    /// (ver o comentário de módulo).
    pub progresso: i64,
    pub concluido: bool,
    pub xp_recompensa: i64,
    /// `true` quando a XP deste desafio, neste dia, JÁ foi creditada (existe
    /// uma linha em `xp_events`). Distinto de `concluido`: dá para estar
    /// concluído (progresso >= meta) e ainda não creditado, se ninguém
    /// chamou [`GamificacaoRepository::registrar_xp_desafio_diario`] ainda.
    pub xp_creditado: bool,
}

// ---------------------------------------------------------------------
// Registros derivados do histórico — sem tabela própria de "recorde".
// ---------------------------------------------------------------------

/// Mesmo teto de `ReviewLogRepository::stats` (`STUDY_STATS_DIAS_MAXIMO`,
/// privado naquele módulo) — dez anos de histórico é generoso para qualquer
/// recorde pessoal real.
const JANELA_RECORDES_DIAS: i64 = 3650;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelhorDia {
    pub dia: String,
    pub revisoes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelhorSemana {
    /// Domingo (calendário brasileiro — mesma convenção de
    /// `weekly_study_goals.week_start_date`, `0024_cronograma.sql`) que abre
    /// a semana recordista.
    pub semana_inicio: String,
    pub revisoes: i64,
}

/// `recordes_pessoais()` do contrato de IPC — o que substitui "ranking"
/// nesta tela (ver o comentário de módulo de `0026_gamificacao.sql`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordesPessoais {
    /// `None` só quando não há nenhuma revisão no histórico.
    pub melhor_dia: Option<MelhorDia>,
    /// Reusa `ReviewLogRepository::stats` — ver o comentário de módulo.
    pub maior_sequencia: i64,
    pub melhor_semana: Option<MelhorSemana>,
}

/// `resumo_de_sessao()` do contrato de IPC: o que aconteceu num intervalo —
/// tipicamente do início ao fim de uma sessão de estudo.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumoDeSessao {
    pub cartoes_revisados: i64,
    pub segundos_estudados: i64,
    pub xp_ganho: i64,
    /// Reusa `CardRepository::deck_forecast` (dia 1 = amanhã) em vez de
    /// reimplementar a previsão de vencimento — ver o comentário de módulo.
    pub cartoes_vencendo_amanha: i64,
}

/// Uma linha de `xp_events`, do jeito que qualquer comando de
/// `registrar_xp_*` a devolve.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XpEventRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub amount: i64,
    pub origin: String,
    pub reference_id: String,
    pub created_at: DateTime<Utc>,
    /// `false` quando esta chamada de fato criou a linha; `true` quando a
    /// origem já tinha sido creditada antes e a linha devolvida é a que já
    /// existia (idempotência garantida pela `UNIQUE` do schema — ver
    /// `0026_gamificacao.sql`).
    pub ja_creditado: bool,
}

pub struct GamificacaoRepository {
    pool: SqlitePool,
}

impl GamificacaoRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Credita um evento de XP DENTRO de uma transação já aberta por OUTRO
    /// módulo — o mecanismo que faz XP ser CONSEQUÊNCIA do evento de
    /// domínio, gravada na MESMA transação que grava esse evento, em vez de
    /// uma ação separada que dependeria de alguma tela lembrar de chamar
    /// (ver o comentário de módulo, seção "XP é CONSEQUÊNCIA..."). Hoje só
    /// dois chamadores: `db::cards::CardRepository::answer_card` (referência
    /// = `review_log.id`, origem `'card_review'`) e
    /// `db::pomodoro::PomodoroRepository::finish` (referência = `session_id`,
    /// origem `'pomodoro_focus'`, só quando `kind = 'focus'` e
    /// `completed = true`).
    ///
    /// Idempotência: a mesma da `UNIQUE (origin, reference_id)` do schema —
    /// chamar duas vezes com a mesma `(origin, reference_id)` nunca produz
    /// dois eventos nem um erro; a segunda chamada só enxerga a linha da
    /// primeira, com `ja_creditado = true`. Na prática isto não deveria
    /// disparar para `card_review`/`pomodoro_focus` (cada chamada usa um id
    /// de linha/sessão NOVO), mas a garantia fica de qualquer forma — o mesmo
    /// código que os comandos `registrar_xp_*` de reprocessamento usam.
    ///
    /// DECISÃO SOBRE FALHA (a armadilha central deste desenho): se este
    /// `INSERT` falhar de verdade — não o caminho normal de
    /// `ON CONFLICT DO NOTHING`, que nunca é erro, mas uma falha real de
    /// banco (disco cheio, arquivo corrompido, timeout de lock) — o erro
    /// sobe e é o CHAMADOR quem decide: nem `answer_card` nem `finish` fazem
    /// `commit` depois de receber um `Err` daqui, então a transação inteira
    /// reverte — o cartão NÃO fica reagendado, a sessão de pomodoro NÃO fica
    /// finalizada. A alternativa (capturar o erro aqui e seguir sem XP,
    /// "best-effort") foi descartada de propósito: deixaria o cartão
    /// reagendado sem a contrapartida de XP SILENCIOSAMENTE — exatamente a
    /// lacuna entre tela e dado que este módulo existe para impedir (ver o
    /// comentário de módulo). Reverter tudo é seguro para o usuário repetir a
    /// ação: tanto `review_log_id` quanto `session_id` são gerados de novo a
    /// cada tentativa real, então uma nova tentativa nunca colide com a
    /// `UNIQUE` de uma tentativa anterior que falhou.
    pub async fn creditar_xp_na_transacao(
        tx: &mut Transaction<'_, Sqlite>,
        amount: i64,
        origin: &str,
        reference_id: &str,
    ) -> Result<XpEventRow> {
        let id = Uuid::now_v7();
        let inserido: Option<XpEventRow> = sqlx::query_as(
            "INSERT INTO xp_events (id, amount, origin, reference_id) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (origin, reference_id) DO NOTHING \
             RETURNING id, amount, origin, reference_id, created_at, 0 AS ja_creditado",
        )
        .bind(id.db())
        .bind(amount)
        .bind(origin)
        .bind(reference_id)
        .fetch_optional(&mut **tx)
        .await?;

        match inserido {
            Some(evento) => Ok(evento),
            None => sqlx::query_as(
                "SELECT id, amount, origin, reference_id, created_at, 1 AS ja_creditado \
                 FROM xp_events WHERE origin = $1 AND reference_id = $2",
            )
            .bind(origin)
            .bind(reference_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(Error::from),
        }
    }

    /// Insere um evento de XP na SUA PRÓPRIA transação (`begin`+`commit` em
    /// volta de [`Self::creditar_xp_na_transacao`], que é a única lógica de
    /// fato — sem duplicar SQL). Usado pelos métodos `registrar_xp_*` abaixo:
    /// o caminho de reprocessamento/backfill, chamado FORA de qualquer
    /// transação de domínio já aberta (ao contrário de `answer_card`/
    /// `finish`, que já têm uma `tx` própria e chamam
    /// `creditar_xp_na_transacao` diretamente).
    async fn inserir_evento_xp(&self, amount: i64, origin: &str, reference_id: &str) -> Result<XpEventRow> {
        let mut tx = self.pool.begin().await?;
        let evento = Self::creditar_xp_na_transacao(&mut tx, amount, origin, reference_id).await?;
        tx.commit().await?;
        Ok(evento)
    }

    /// Credita [`XP_POR_REVISAO_CARTAO`] pela revisão `review_log_id`. A
    /// referência é o `id` da própria linha de `review_log` — cada resposta
    /// de cartão já é uma linha nova lá, então idempotência aqui é "a mesma
    /// resposta não paga duas vezes", não "o mesmo cartão só paga uma vez
    /// para sempre" (responder de novo é uma revisão NOVA, com XP novo).
    pub async fn registrar_xp_revisao_cartao(&self, review_log_id: Uuid) -> Result<XpEventRow> {
        let existe: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM review_log WHERE id = $1)").bind(review_log_id.db()).fetch_one(&self.pool).await?;
        if !existe {
            return Err(Error::NotFound(format!("revisão {review_log_id}")));
        }

        let reference_id = review_log_id.hyphenated().to_string();
        self.inserir_evento_xp(XP_POR_REVISAO_CARTAO, "card_review", &reference_id).await
    }

    /// Credita [`XP_POR_POMODORO_CONCLUIDO`] pela sessão `session_id` — só
    /// quando ela é um foco (`kind = 'focus'`) de fato CONCLUÍDO
    /// (`completed = 1`). Uma sessão cancelada, ou uma pausa curta/longa,
    /// nunca paga XP: entrada de IPC é hostil, então a condição é conferida
    /// no banco, não confiada ao chamador.
    pub async fn registrar_xp_pomodoro_concluido(&self, session_id: Uuid) -> Result<XpEventRow> {
        let sessao: Option<(String, bool)> =
            sqlx::query_as("SELECT kind, completed FROM pomodoro_sessions WHERE id = $1").bind(session_id.db()).fetch_optional(&self.pool).await?;
        let (kind, completed) = sessao.ok_or_else(|| Error::NotFound(format!("sessão de pomodoro {session_id}")))?;

        if kind != "focus" || !completed {
            return Err(Error::Invalid(format!(
                "sessão {session_id} não é um foco concluído — XP de pomodoro só é concedido a foco terminado"
            )));
        }

        let reference_id = session_id.hyphenated().to_string();
        self.inserir_evento_xp(XP_POR_POMODORO_CONCLUIDO, "pomodoro_focus", &reference_id).await
    }

    /// Credita [`XP_POR_BLOCO_CRONOGRAMA`] dentro de uma transação de domínio
    /// já aberta: `PomodoroRepository::finish`, quando o foco que acabou de
    /// fechar estava ligado a um bloco. O próprio foco já conta, porque o
    /// `UPDATE` de `finish` veio antes, na mesma `tx`.
    ///
    /// `None` quando o tempo realizado ainda não alcançou o planejado, ou
    /// quando o bloco não existe mais (apagado durante o foco). Passar do
    /// planejado não paga de novo: a referência é o bloco, e `xp_events` tem
    /// `UNIQUE (origin, reference_id)`.
    pub async fn creditar_xp_de_bloco_se_cumprido(
        tx: &mut Transaction<'_, Sqlite>,
        block_id: Uuid,
    ) -> Result<Option<XpEventRow>> {
        let Some(planejados) = minutos_planejados_do_bloco(&mut **tx, block_id).await? else {
            return Ok(None);
        };
        if minutos_realizados_do_bloco(&mut **tx, block_id).await? < planejados {
            return Ok(None);
        }
        Self::creditar_xp_na_transacao(tx, XP_POR_BLOCO_CRONOGRAMA, "cronograma_bloco", &block_id.hyphenated().to_string())
            .await
            .map(Some)
    }

    /// Credita [`XP_POR_BLOCO_CRONOGRAMA`] pelo bloco `block_id`, só quando
    /// o tempo já realizado (ver [`minutos_realizados_do_bloco`]) alcançou
    /// `planned_minutes` — nunca confia numa alegação de "cumpri" vinda do IPC
    /// sem checar contra o histórico real. Caminho de reprocessamento: no uso
    /// normal o crédito sai sozinho em [`Self::creditar_xp_de_bloco_se_cumprido`].
    pub async fn registrar_xp_bloco_cronograma(&self, block_id: Uuid) -> Result<XpEventRow> {
        let planned_minutes = minutos_planejados_do_bloco(&self.pool, block_id)
            .await?
            .ok_or_else(|| Error::NotFound(format!("bloco do cronograma {block_id}")))?;

        let realizados = minutos_realizados_do_bloco(&self.pool, block_id).await?;
        if realizados < planned_minutes {
            return Err(Error::Invalid(format!(
                "bloco {block_id} ainda não foi cumprido: {realizados} de {planned_minutes} minutos realizados"
            )));
        }

        let reference_id = block_id.hyphenated().to_string();
        self.inserir_evento_xp(XP_POR_BLOCO_CRONOGRAMA, "cronograma_bloco", &reference_id).await
    }

    /// Progresso real (do histórico, nunca de um contador à parte) de uma
    /// categoria de desafio, no dia local `local_date` sob `offset_minutes`.
    async fn progresso_da_categoria(&self, tipo: &str, local_date: &str, offset_minutes: i64) -> Result<i64> {
        match tipo {
            "revisar_cartoes" => {
                let (inicio, fim) = limites_utc_do_dia_local(local_date, offset_minutes)?;
                let contagem: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM review_log WHERE reviewed_at >= $1 AND reviewed_at < $2")
                    .bind(formatar_timestamp(inicio))
                    .bind(formatar_timestamp(fim))
                    .fetch_one(&self.pool)
                    .await?;
                Ok(contagem)
            }
            "focar_minutos" => {
                // `local_date` já é a coluna que `pomodoro_sessions` guarda
                // (0024) — sem conversão UTC->local aqui, diferente de
                // `review_log` acima.
                let segundos: i64 = sqlx::query_scalar(
                    "SELECT COALESCE(SUM(duration_seconds), 0) FROM pomodoro_sessions \
                     WHERE local_date = $1 AND kind = 'focus' AND completed = 1",
                )
                .bind(local_date)
                .fetch_one(&self.pool)
                .await?;
                Ok(segundos.saturating_add(30) / 60)
            }
            "concluir_blocos" => {
                // Mesmo critério de `minutos_realizados_do_bloco`, aplicado a
                // cada bloco do dia numa consulta só (em vez de uma chamada
                // Rust por bloco) — a mesma regra "+30 s, divide por 60" para
                // bater com o critério de bloco cumprido usado ao creditar.
                let contagem: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM study_plan_blocks b WHERE b.local_date = $1 AND ( \
                         (COALESCE((SELECT SUM(duration_seconds) FROM pomodoro_sessions \
                                     WHERE plan_block_id = b.id AND kind = 'focus' AND completed = 1), 0) + 30) / 60 \
                         + COALESCE((SELECT SUM(minutes) FROM study_time_entries WHERE plan_block_id = b.id), 0) \
                     ) >= b.planned_minutes",
                )
                .bind(local_date)
                .fetch_one(&self.pool)
                .await?;
                Ok(contagem)
            }
            outro => Err(Error::Invalid(format!("tipo de desafio desconhecido: {outro:?}"))),
        }
    }

    /// Monta os desafios do dia local `local_date` (sob `offset_minutes`):
    /// meta determinística por categoria, progresso do histórico real, e se
    /// a XP daquele desafio, naquele dia, já foi creditada.
    async fn desafios_do_dia(&self, local_date: &str, offset_minutes: i64) -> Result<Vec<Desafio>> {
        let mut desafios = Vec::with_capacity(CATEGORIAS_DESAFIO.len());

        for categoria in &CATEGORIAS_DESAFIO {
            let indice = indice_deterministico(local_date, categoria.tipo, categoria.metas.len());
            let meta = categoria.metas[indice];
            let progresso = self.progresso_da_categoria(categoria.tipo, local_date, offset_minutes).await?;
            let reference_id = format!("{local_date}:{}", categoria.tipo);
            let xp_creditado: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM xp_events WHERE origin = 'desafio_diario' AND reference_id = $1)")
                    .bind(&reference_id)
                    .fetch_one(&self.pool)
                    .await?;

            desafios.push(Desafio {
                tipo: categoria.tipo.to_string(),
                titulo: categoria.titulo.to_string(),
                unidade: categoria.unidade.to_string(),
                meta,
                progresso,
                concluido: progresso >= meta,
                xp_recompensa: XP_POR_DESAFIO_DIARIO,
                xp_creditado,
            });
        }

        Ok(desafios)
    }

    /// `desafios_hoje()` do contrato de IPC: os três desafios do dia local de
    /// AGORA. Abrir o app duas vezes no mesmo dia devolve exatamente a mesma
    /// lista (mesma meta, progresso recalculado do histórico a cada
    /// chamada) — ver o comentário de módulo sobre determinismo.
    pub async fn desafios_hoje(&self) -> Result<Vec<Desafio>> {
        let (hoje_local, offset_minutes) = now_local_date_and_offset();
        self.desafios_do_dia(&hoje_local, offset_minutes).await
    }

    /// Credita [`XP_POR_DESAFIO_DIARIO`] para o desafio `tipo` de HOJE (dia
    /// local do relógio do sistema — nunca um `local_date` vindo do IPC, que
    /// deixaria o chamador reivindicar o desafio de qualquer dia passado).
    /// Recalcula o progresso do zero a partir do histórico antes de creditar
    /// — nunca confia numa alegação de "cumpri" vinda do frontend.
    pub async fn registrar_xp_desafio_diario(&self, tipo: &str) -> Result<XpEventRow> {
        let (hoje_local, offset_minutes) = now_local_date_and_offset();
        let desafios = self.desafios_do_dia(&hoje_local, offset_minutes).await?;
        let desafio =
            desafios.iter().find(|d| d.tipo == tipo).ok_or_else(|| Error::Invalid(format!("tipo de desafio desconhecido: {tipo:?}")))?;

        if !desafio.concluido {
            return Err(Error::Invalid(format!(
                "desafio {tipo:?} ainda não foi cumprido hoje: {} de {}",
                desafio.progresso, desafio.meta
            )));
        }

        let reference_id = format!("{hoje_local}:{tipo}");
        self.inserir_evento_xp(XP_POR_DESAFIO_DIARIO, "desafio_diario", &reference_id).await
    }

    /// `xp_total()` do contrato de IPC — SEMPRE a soma das linhas de
    /// `xp_events`, nunca um contador à parte. Apagar uma linha muda este
    /// número sozinho, sem nenhum outro lugar para corrigir.
    pub async fn xp_total(&self) -> Result<i64> {
        let total: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(amount), 0) FROM xp_events").fetch_one(&self.pool).await?;
        Ok(total)
    }

    /// `nivel_atual()` do contrato de IPC: [`calcular_nivel`] aplicado ao XP
    /// total de agora.
    pub async fn nivel_atual(&self) -> Result<EstadoDeNivel> {
        calcular_nivel(self.xp_total().await?)
    }

    /// Domingo (calendário brasileiro) que abre a semana de `dia` — mesma
    /// convenção que `weekly_study_goals.week_start_date`
    /// (`0024_cronograma.sql`) já usa para a meta semanal.
    fn inicio_da_semana_brasileira(dia: NaiveDate) -> NaiveDate {
        // Chamada pelo trait de propósito: o `chrono` também tem um
        // `weekday` inerente e privado em `NaiveDate`, e a resolução de
        // método prefere o inerente — `dia.weekday()` falha a compilar com
        // "method `weekday` is private" mesmo com `Datelike` importado.
        dia - Days::new(u64::from(Datelike::weekday(&dia).num_days_from_sunday()))
    }

    /// `recordes_pessoais()` do contrato de IPC — o substituto honesto de
    /// "ranking" nesta tela (ver o comentário de módulo). Reusa
    /// [`ReviewLogRepository::stats`] para `maior_sequencia` e para a lista
    /// por dia que `melhor_dia`/`melhor_semana` agregam — nunca recalcula
    /// sequência ou dias estudados com uma segunda lógica.
    pub async fn recordes_pessoais(&self) -> Result<RecordesPessoais> {
        let stats = ReviewLogRepository::new(self.pool.clone()).stats(None, JANELA_RECORDES_DIAS).await?;

        // Primeiro dia (o mais antigo) vence o empate: `por_dia` já vem
        // ordenado por data crescente (`BTreeMap` em `ReviewLogRepository::stats`),
        // e usar `>=` na comparação mantém o primeiro encontrado quando dois
        // dias empatam no recorde — resultado determinístico, sem depender
        // da ordem de iteração de `Iterator::max_by_key` (que devolve o
        // ÚLTIMO em empate, o oposto do que se quer aqui).
        let melhor_dia = stats.por_dia.iter().fold(None, |melhor: Option<&crate::db::review_log::RevisaoDoDia>, atual| match melhor {
            Some(m) if m.revisoes >= atual.revisoes => melhor,
            _ => Some(atual),
        });
        let melhor_dia = melhor_dia.map(|d| MelhorDia { dia: d.dia.clone(), revisoes: d.revisoes });

        let mut por_semana: BTreeMap<NaiveDate, i64> = BTreeMap::new();
        for dia in &stats.por_dia {
            let data = NaiveDate::parse_from_str(&dia.dia, "%Y-%m-%d")
                .map_err(|err| Error::Invalid(format!("data corrompida em recordes pessoais: {:?} ({err})", dia.dia)))?;
            let inicio_semana = Self::inicio_da_semana_brasileira(data);
            *por_semana.entry(inicio_semana).or_insert(0) += dia.revisoes;
        }
        let melhor_semana = por_semana.iter().fold(None, |melhor: Option<(&NaiveDate, &i64)>, atual| match melhor {
            Some((_, revisoes)) if *revisoes >= *atual.1 => melhor,
            _ => Some(atual),
        });
        let melhor_semana =
            melhor_semana.map(|(inicio, revisoes)| MelhorSemana { semana_inicio: inicio.format("%Y-%m-%d").to_string(), revisoes: *revisoes });

        Ok(RecordesPessoais { melhor_dia, maior_sequencia: stats.maior_sequencia, melhor_semana })
    }

    /// `resumo_de_sessao()` do contrato de IPC: quantos cartões, quanto
    /// tempo e quanto XP aconteceram entre `inicio` (inclusive) e `fim`
    /// (exclusivo), e quantos cartões vencem amanhã — reusando
    /// `CardRepository::deck_forecast` em vez de reimplementar a previsão.
    pub async fn resumo_de_sessao(&self, inicio: DateTime<Utc>, fim: DateTime<Utc>) -> Result<ResumoDeSessao> {
        if fim <= inicio {
            return Err(Error::Invalid("fim do intervalo precisa ser depois do início".into()));
        }

        let inicio_txt = formatar_timestamp(inicio);
        let fim_txt = formatar_timestamp(fim);

        let (cartoes_revisados, duracao_ms_soma): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(duration_ms), 0) FROM review_log WHERE reviewed_at >= $1 AND reviewed_at < $2")
                .bind(&inicio_txt)
                .bind(&fim_txt)
                .fetch_one(&self.pool)
                .await?;
        // Soma final mostrada no resumo (não um intermediário que alimenta
        // outra divisão) — `saturating_add` é a resposta certa, mesma regra
        // de `db::review_log::segundos_arredondados`.
        let segundos_estudados = duracao_ms_soma.saturating_add(500) / 1000;

        let xp_ganho: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(amount), 0) FROM xp_events WHERE created_at >= $1 AND created_at < $2")
            .bind(&inicio_txt)
            .bind(&fim_txt)
            .fetch_one(&self.pool)
            .await?;

        let previsao = CardRepository::new(self.pool.clone()).deck_forecast(None, 2).await?;
        // Índice 1 = amanhã (índice 0 é hoje) — `.get` em vez de indexação
        // direta, e `unwrap_or(0)` como resposta a "a previsão veio mais
        // curta do que o esperado" em vez de um `panic` de índice fora da
        // faixa.
        let cartoes_vencendo_amanha = previsao.get(1).map(|dia| dia.quantidade).unwrap_or(0);

        Ok(ResumoDeSessao { cartoes_revisados, segundos_estudados, xp_ganho, cartoes_vencendo_amanha })
    }
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui — mesmo
    // padrão do resto do projeto.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    // ---- xp_cumulativo_para_nivel / maior_nivel_dentro_do_xp -----------

    #[test]
    fn cumulativo_do_nivel_1_e_sempre_zero() {
        assert_eq!(xp_cumulativo_para_nivel(1), 0);
    }

    #[test]
    fn cumulativo_cresce_pelo_incremento_do_nivel_anterior() {
        assert_eq!(xp_cumulativo_para_nivel(2), 100); // 1 -> 2 custa 100
        assert_eq!(xp_cumulativo_para_nivel(3), 300); // + 200 (2 -> 3)
        assert_eq!(xp_cumulativo_para_nivel(4), 600); // + 300 (3 -> 4)
    }

    #[test]
    fn maior_nivel_na_fronteira_exata_ja_conta_o_nivel_novo() {
        assert_eq!(maior_nivel_dentro_do_xp(0), 1);
        assert_eq!(maior_nivel_dentro_do_xp(99), 1);
        assert_eq!(maior_nivel_dentro_do_xp(100), 2);
        assert_eq!(maior_nivel_dentro_do_xp(299), 2);
        assert_eq!(maior_nivel_dentro_do_xp(300), 3);
    }

    #[test]
    fn maior_nivel_termina_rapido_para_xp_absurdamente_alto() {
        // Prova de "não entra em laço": se isto rodar (o teste não trava),
        // já é a prova — a busca binária é O(log n) não importa o tamanho.
        let nivel = maior_nivel_dentro_do_xp(u128::from(u64::MAX));
        assert!(nivel > 0);
        // O nível encontrado tem que de fato caber no XP dado.
        assert!(xp_cumulativo_para_nivel(nivel) <= u128::from(u64::MAX));
        assert!(xp_cumulativo_para_nivel(nivel + 1) > u128::from(u64::MAX));
    }

    // ---- calcular_nivel --------------------------------------------------

    #[test]
    fn zero_xp_e_nivel_1_sem_progresso() {
        let estado = calcular_nivel(0).unwrap();
        assert_eq!(estado.nivel, 1);
        assert_eq!(estado.xp_no_nivel_atual, 0);
        assert_eq!(estado.xp_para_proximo_nivel, 100);
        assert_eq!(estado.progresso, 0.0);
    }

    #[test]
    fn xp_exatamente_na_fronteira_do_nivel_2_zera_o_progresso_do_nivel_novo() {
        let estado = calcular_nivel(100).unwrap();
        assert_eq!(estado.nivel, 2);
        assert_eq!(estado.xp_no_nivel_atual, 0);
        assert_eq!(estado.xp_para_proximo_nivel, 200); // 2 -> 3 custa 200
        assert_eq!(estado.progresso, 0.0);
    }

    #[test]
    fn xp_um_a_menos_da_fronteira_ainda_e_o_nivel_anterior_quase_completo() {
        let estado = calcular_nivel(99).unwrap();
        assert_eq!(estado.nivel, 1);
        assert_eq!(estado.xp_no_nivel_atual, 99);
        assert_eq!(estado.xp_para_proximo_nivel, 1);
        assert!((estado.progresso - 0.99).abs() < 1e-9);
    }

    #[test]
    fn xp_negativo_e_erro_de_entrada_invalida() {
        assert!(matches!(calcular_nivel(-1), Err(Error::Invalid(_))));
    }

    #[test]
    fn xp_absurdamente_alto_nao_estoura_e_devolve_um_estado_consistente() {
        let estado = calcular_nivel(i64::MAX).unwrap();
        assert!(estado.nivel > 0);
        assert_eq!(estado.xp_total, i64::MAX);
        assert!(estado.xp_no_nivel_atual >= 0);
        assert!(estado.xp_para_proximo_nivel > 0);
        assert!((0.0..=1.0).contains(&estado.progresso), "progresso fora de 0..=1: {}", estado.progresso);
    }

    // ---- indice_deterministico ------------------------------------------

    #[test]
    fn mesma_entrada_sempre_devolve_o_mesmo_indice() {
        let a = indice_deterministico("2026-09-05", "revisar_cartoes", 3);
        let b = indice_deterministico("2026-09-05", "revisar_cartoes", 3);
        assert_eq!(a, b);
    }

    #[test]
    fn indice_nunca_sai_do_intervalo_valido() {
        for dia in ["2026-01-01", "2026-06-15", "2030-12-31"] {
            for categoria in &CATEGORIAS_DESAFIO {
                let indice = indice_deterministico(dia, categoria.tipo, categoria.metas.len());
                assert!(indice < categoria.metas.len());
            }
        }
    }

    #[test]
    fn dias_diferentes_tendem_a_dar_indices_diferentes_em_algum_ponto() {
        // Não exige NENHUM par específico divergir (SHA-256 pode colidir por
        // sorte em pouquíssimos casos), só que nem todo dia caia no mesmo
        // índice — provando que a seleção de fato depende do dia, e não é
        // uma constante disfarçada.
        let indices: std::collections::HashSet<usize> =
            (1..=30).map(|dia| indice_deterministico(&format!("2026-09-{dia:02}"), "revisar_cartoes", 3)).collect();
        assert!(indices.len() > 1, "30 dias diferentes caíram todos no mesmo índice — seleção não depende do dia");
    }

    // ---- local_date_for / limites_utc_do_dia_local -----------------------

    /// A borda de fuso: 23h de terça em São Paulo (UTC-3) é `23:00`
    /// ainda de terça no calendário local, mesmo já sendo `02:00` de quarta
    /// em UTC.
    #[test]
    fn local_date_for_perto_da_meia_noite_cai_no_dia_local_certo() {
        let instante_utc = "2026-09-02T02:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(local_date_for(instante_utc, -180), "2026-09-01");
    }

    #[test]
    fn limites_utc_do_dia_local_cobre_exatamente_24h_comecando_na_meia_noite_local() {
        let (inicio, fim) = limites_utc_do_dia_local("2026-09-01", -180).unwrap();
        // Meia-noite local (UTC-3) é 03:00 UTC.
        assert_eq!(inicio.to_rfc3339(), "2026-09-01T03:00:00+00:00");
        assert_eq!(fim - inicio, Duration::days(1));
    }

    #[test]
    fn limites_utc_do_dia_local_rejeita_data_corrompida_em_vez_de_entrar_em_panico() {
        assert!(limites_utc_do_dia_local("não-é-uma-data", 0).is_err());
    }

    // ---- inicio_da_semana_brasileira -------------------------------------

    #[test]
    fn inicio_da_semana_brasileira_recua_ate_o_domingo() {
        // 2026-09-05 é um sábado; o domingo daquela semana é 2026-08-30.
        let sabado = NaiveDate::parse_from_str("2026-09-05", "%Y-%m-%d").unwrap();
        let domingo = GamificacaoRepository::inicio_da_semana_brasileira(sabado);
        assert_eq!(domingo.format("%Y-%m-%d").to_string(), "2026-08-30");
    }

    #[test]
    fn inicio_da_semana_brasileira_de_um_domingo_e_ele_mesmo() {
        let domingo = NaiveDate::parse_from_str("2026-08-30", "%Y-%m-%d").unwrap();
        assert_eq!(GamificacaoRepository::inicio_da_semana_brasileira(domingo), domingo);
    }
}
