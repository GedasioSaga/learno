//! Repository for the Pomodoro timer — Fase 5's `pomodoro_sessions` table
//! (`0014_pomodoro.sql`): one row per timer cycle actually run.

use std::collections::HashSet;

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::gamificacao::{GamificacaoRepository, XP_POR_POMODORO_CONCLUIDO};
use crate::db::ids::{DbId, IdBind};
use crate::error::{Error, Result};

/// Os três valores que `kind` aceita — espelha o `CHECK (kind IN (...))` da
/// migração. Validado aqui também (não só no banco) para que uma entrada
/// ruim vinda do IPC vire `Error::Invalid` com mensagem legível em vez de
/// `Error::Database` opaco por violação de `CHECK`.
const VALID_KINDS: [&str; 3] = ["focus", "short_break", "long_break"];

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub kind: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_seconds: i64,
    pub completed: bool,
    pub created_at: DateTime<Utc>,
}

/// `pomodoro_today`'s return shape — POM-010 na tela: quantos focos
/// completos hoje, quanto tempo focado hoje, e a sequência de dias seguidos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroResumo {
    pub focos_completos: i64,
    pub segundos_focados: i64,
    pub sequencia_dias: i64,
}

const SESSION_COLUMNS: &str = "id, kind, started_at, ended_at, duration_seconds, completed, created_at";

pub struct PomodoroRepository {
    pool: SqlitePool,
}

impl PomodoroRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `start_pomodoro`. Não olha para nenhuma sessão anterior — se uma
    /// sessão ficou aberta (`ended_at IS NULL`) porque o app fechou no meio,
    /// ela simplesmente fica lá, órfã e nunca contada (`completed` nasce
    /// `0`); começar uma sessão nova nunca espera nem depende dela. É a
    /// solução para "sessão nunca finalizada não pode travar a próxima": não
    /// existe nenhum estado global de "sessão em andamento" para travar
    /// contra — cada linha é independente, e só `finish` decide se ela conta.
    pub async fn start(&self, kind: &str, duration_seconds: i64) -> Result<PomodoroRow> {
        if !VALID_KINDS.contains(&kind) {
            return Err(Error::Invalid(format!(
                "tipo de sessão inválido: {kind:?} (esperado um de {VALID_KINDS:?})"
            )));
        }
        if duration_seconds <= 0 {
            return Err(Error::Invalid("duração do pomodoro precisa ser maior que zero segundos".into()));
        }

        let id = Uuid::now_v7();
        // `local_date`/`utc_offset_minutes` (0024_cronograma.sql) são as
        // colunas que fazem a faixa semanal creditar esta sessão ao dia
        // CERTO — ver o cabeçalho de `db::cronograma` para a decisão de não
        // duplicar isto numa linha de `study_time_entries`. A migração exige
        // que seja o Rust a gravá-las (o `ALTER TABLE` não aceita default não
        // constante), e só faz sentido gravá-las aqui: são o dia e o fuso do
        // instante em que a sessão COMEÇA, e `finish` nunca os toca depois.
        let (local_date, utc_offset_minutes) = now_local_date_and_offset();
        let sql = format!(
            "INSERT INTO pomodoro_sessions (id, kind, duration_seconds, local_date, utc_offset_minutes) \
             VALUES ($1, $2, $3, $4, $5) RETURNING {SESSION_COLUMNS}"
        );
        let row = sqlx::query_as::<_, PomodoroRow>(&sql)
            .bind(id.db())
            .bind(kind)
            .bind(duration_seconds)
            .bind(&local_date)
            .bind(utc_offset_minutes)
            .fetch_one(&self.pool)
            .await?;

        Ok(row)
    }

    pub async fn get(&self, id: Uuid) -> Result<PomodoroRow> {
        let sql = format!("SELECT {SESSION_COLUMNS} FROM pomodoro_sessions WHERE id = $1");
        sqlx::query_as::<_, PomodoroRow>(&sql)
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("sessão de pomodoro {id}")))
    }

    /// `finish_pomodoro`: fecha a sessão com o resultado que o cronômetro do
    /// frontend observou (`completed = true` quando o tempo correu até o
    /// fim, `false` quando o usuário cancelou antes). Só fecha uma sessão que
    /// ainda está aberta (`ended_at IS NULL`) — chamar de novo sobre a mesma
    /// sessão não pode reescrever um resultado já gravado.
    ///
    /// **XP é CONSEQUÊNCIA, não uma chamada separada**: um foco (`kind =
    /// 'focus'`) que termina `completed = true` credita
    /// [`crate::db::gamificacao::XP_POR_POMODORO_CONCLUIDO`] na MESMA
    /// transação que fecha a sessão — nunca uma pausa, nunca uma sessão
    /// cancelada. `db::pomodoro` passa a depender de `db::gamificacao` pelo
    /// mesmo motivo, e com a mesma decisão sobre falha, que
    /// `db::cards::CardRepository::answer_card` (ver o comentário de
    /// `GamificacaoRepository::creditar_xp_na_transacao`): se o crédito de XP
    /// falhar de verdade, a transação inteira reverte e a sessão CONTINUA
    /// aberta (`ended_at` continua `NULL`) para o chamador tentar `finish`
    /// de novo, em vez de ficar "concluída" sem o XP correspondente.
    pub async fn finish(&self, session_id: Uuid, completed: bool) -> Result<PomodoroRow> {
        let sql = format!(
            "UPDATE pomodoro_sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), completed = $2 \
             WHERE id = $1 AND ended_at IS NULL RETURNING {SESSION_COLUMNS}"
        );

        let mut tx = self.pool.begin().await?;

        let row = sqlx::query_as::<_, PomodoroRow>(&sql)
            .bind(session_id.db())
            .bind(completed)
            .fetch_optional(&mut *tx)
            .await?;

        let row = match row {
            Some(row) => row,
            None => {
                // Nenhuma linha atualizada: não há nada para reverter (só uma
                // tentativa de UPDATE que não bateu no `WHERE`), então a
                // transação é fechada explicitamente ANTES de reusar
                // `self.get` sobre o pool comum — mesma distinção de antes
                // entre "nunca existiu" (`NotFound`, propagado por `get`) e
                // "existe, mas já foi finalizada" (`Invalid` abaixo). Mesmo
                // padrão de `PageRepository::trash` para uma página já
                // trashed.
                tx.rollback().await?;
                self.get(session_id).await?;
                return Err(Error::Invalid("sessão de pomodoro já foi finalizada".into()));
            }
        };

        if completed && row.kind == "focus" {
            GamificacaoRepository::creditar_xp_na_transacao(
                &mut tx,
                XP_POR_POMODORO_CONCLUIDO,
                "pomodoro_focus",
                &session_id.hyphenated().to_string(),
            )
            .await?;
        }

        tx.commit().await?;
        Ok(row)
    }

    /// `pomodoro_today`. "Hoje" e "dias seguidos" são sobre o dia LOCAL do
    /// usuário, não o dia UTC em que `started_at` é gravado — mesmo cuidado
    /// de fuso que o resto do app já tem. A diferença aqui é que ISTO É UM
    /// APP DESKTOP: o SQLite embutido roda no MESMO processo, na MESMA
    /// máquina do usuário, então o modificador `'localtime'` do próprio
    /// SQLite já resolve a conversão certa usando o fuso horário real do
    /// sistema operacional — sem este código precisar redescobrir o fuso em
    /// Rust (o que seria necessário, e mais arriscado, se isto fosse um
    /// servidor atendendo usuários em fusos diferentes).
    pub async fn today_summary(&self) -> Result<PomodoroResumo> {
        let today_local: String =
            sqlx::query_scalar("SELECT strftime('%Y-%m-%d', 'now', 'localtime')").fetch_one(&self.pool).await?;

        let (focos_completos, segundos_focados): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(duration_seconds), 0) FROM pomodoro_sessions \
             WHERE kind = 'focus' AND completed = 1 AND strftime('%Y-%m-%d', started_at, 'localtime') = $1",
        )
        .bind(&today_local)
        .fetch_one(&self.pool)
        .await?;

        let completed_days_desc: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT strftime('%Y-%m-%d', started_at, 'localtime') AS dia FROM pomodoro_sessions \
             WHERE kind = 'focus' AND completed = 1 ORDER BY dia DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        let sequencia_dias = compute_streak(&today_local, &completed_days_desc)?;

        Ok(PomodoroResumo { focos_completos, segundos_focados, sequencia_dias })
    }
}

/// Pure: quantos dias consecutivos, terminando hoje OU ontem, têm pelo menos
/// uma sessão de foco completa em `completed_days_desc` (datas `YYYY-MM-DD`,
/// já em ordem decrescente — a ordem não importa para esta função, que só
/// precisa do conjunto, mas o formato bate com o que a consulta devolve).
///
/// Decisão de produto embutida aqui: a sequência não zera no instante em que
/// a virada do dia acontece e o usuário ainda não abriu o app hoje — ela só
/// zera quando um dia INTEIRO passa em branco (nem hoje, nem ontem, têm
/// sessão completa). Sem essa folga, o contador mostraria "0 dias" toda
/// manhã até a primeira sessão do dia, o que é pior experiência do que os
/// apps de hábito (Duolingo e afins) resolvem do mesmo jeito.
fn compute_streak(today: &str, completed_days_desc: &[String]) -> Result<i64> {
    let today_date = parse_local_date(today)?;

    let days: HashSet<NaiveDate> =
        completed_days_desc.iter().map(|raw| parse_local_date(raw)).collect::<Result<_>>()?;

    let mut cursor = if days.contains(&today_date) {
        today_date
    } else {
        match today_date.pred_opt().filter(|yesterday| days.contains(yesterday)) {
            Some(yesterday) => yesterday,
            None => return Ok(0),
        }
    };

    let mut streak: i64 = 0;
    while days.contains(&cursor) {
        streak += 1;
        match cursor.pred_opt() {
            Some(previous) => cursor = previous,
            // `NaiveDate` mínimo alcançado: nunca acontece com dado real (o
            // app não existia há proleps milênios), mas termina o laço em vez
            // de um `unwrap` sem rede.
            None => break,
        }
    }
    Ok(streak)
}

fn parse_local_date(raw: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|err| Error::Invalid(format!("data local corrompida vinda do banco: {raw:?} ({err})")))
}

/// Pura: a data de calendário LOCAL de um instante UTC deslocado por
/// `offset_minutes`. Separada de [`now_local_date_and_offset`] justamente
/// para o caso da virada — uma sessão às 23h em São Paulo (UTC-3) tem
/// `instant_utc` já no dia seguinte — poder ser provado com um instante e um
/// offset fixos, sem depender do fuso horário real da máquina que roda o
/// teste.
fn local_date_for(instant_utc: DateTime<Utc>, offset_minutes: i64) -> String {
    let shifted = instant_utc + Duration::minutes(offset_minutes);
    shifted.format("%Y-%m-%d").to_string()
}

/// O par que `start` grava: o dia local de agora, e o deslocamento (em
/// minutos) em vigor neste instante. `Utc::now()` e `Local::now()` são duas
/// chamadas de relógio separadas (no máximo alguns milissegundos de
/// diferença — irrelevante para uma data de calendário), em vez de derivar
/// uma da outra, porque `chrono::Local` já resolve o fuso do sistema
/// operacional sozinho (app desktop, mesmo raciocínio de
/// `PomodoroRepository::today_summary`) e não há necessidade de reimplementar
/// essa parte.
fn now_local_date_and_offset() -> (String, i64) {
    let offset_seconds = i64::from(Local::now().offset().local_minus_utc());
    let offset_minutes = offset_seconds / 60;
    (local_date_for(Utc::now(), offset_minutes), offset_minutes)
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn days(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn streak_counts_consecutive_days_ending_today() {
        let completed = days(&["2026-09-05", "2026-09-04", "2026-09-03", "2026-08-30"]);
        assert_eq!(compute_streak("2026-09-05", &completed).unwrap(), 3);
    }

    #[test]
    fn streak_still_counts_yesterday_when_today_has_no_session_yet() {
        // O usuário ainda não abriu o app hoje — a sequência de ontem não
        // pode zerar só por causa disso.
        let completed = days(&["2026-09-04", "2026-09-03"]);
        assert_eq!(compute_streak("2026-09-05", &completed).unwrap(), 2);
    }

    #[test]
    fn streak_is_zero_when_neither_today_nor_yesterday_has_a_session() {
        let completed = days(&["2026-09-01"]);
        assert_eq!(compute_streak("2026-09-05", &completed).unwrap(), 0);
    }

    #[test]
    fn streak_is_zero_with_no_completed_days_at_all() {
        assert_eq!(compute_streak("2026-09-05", &[]).unwrap(), 0);
    }

    #[test]
    fn streak_stops_at_the_first_gap() {
        let completed = days(&["2026-09-05", "2026-09-04", "2026-09-01"]);
        assert_eq!(compute_streak("2026-09-05", &completed).unwrap(), 2);
    }

    #[test]
    fn streak_survives_a_month_boundary() {
        let completed = days(&["2026-09-01", "2026-08-31", "2026-08-30"]);
        assert_eq!(compute_streak("2026-09-01", &completed).unwrap(), 3);
    }

    #[test]
    fn corrupt_date_from_the_database_is_reported_not_panicked() {
        let completed = days(&["not-a-date"]);
        assert!(compute_streak("2026-09-05", &completed).is_err());
    }

    /// O caso da virada: 23h de terça em São Paulo (UTC-3) é `started_at` =
    /// 02h00 de QUARTA em UTC. `local_date_for` tem que devolver terça, não
    /// quarta — senão a faixa semanal do cronograma credita a sessão ao dia
    /// errado (ver `db::cronograma::semana`, que lê `local_date` direto).
    #[test]
    fn local_date_for_a_late_night_sao_paulo_session_is_the_previous_utc_day() {
        // 2026-09-01 é terça; 2026-09-02T02:00:00Z é terça 23h em UTC-3.
        let instant_utc = "2026-09-02T02:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let offset_minutes = -180; // UTC-3.

        assert_eq!(local_date_for(instant_utc, offset_minutes), "2026-09-01");
    }

    /// O mesmo instante, sem deslocamento (UTC puro), tem que ficar no dia
    /// UTC — prova que `local_date_for` não está sempre "voltando um dia": o
    /// deslocamento é o que decide, não um vício da função.
    #[test]
    fn local_date_for_with_zero_offset_matches_the_utc_calendar_day() {
        let instant_utc = "2026-09-02T02:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(local_date_for(instant_utc, 0), "2026-09-02");
    }

    /// A borda simétrica: um offset POSITIVO (fuso a leste de UTC) pode
    /// empurrar o dia local para a FRENTE do dia UTC — ex.: 23h UTC em
    /// UTC+3 já é o dia seguinte.
    #[test]
    fn local_date_for_a_positive_offset_can_land_on_the_next_utc_day() {
        let instant_utc = "2026-09-01T23:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(local_date_for(instant_utc, 180), "2026-09-02");
    }
}

#[cfg(test)]
mod start_writes_local_date {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;
    use crate::db::pool::connect_and_migrate;

    fn pasta_temporaria(rotulo: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-pomodoro-local-date-test-{rotulo}-{}", Uuid::new_v4()))
    }

    /// Prova a fiação de ponta a ponta (não só a função pura acima): uma
    /// sessão de verdade, gravada por `start`, sai do banco com
    /// `local_date`/`utc_offset_minutes` preenchidos — nenhum dos dois fica
    /// `NULL` (o caso reservado para linha gravada ANTES desta migração).
    #[tokio::test]
    async fn start_populates_local_date_and_utc_offset_on_a_real_row() {
        let data_dir = pasta_temporaria("wiring");
        let db_path = data_dir.join("learno.sqlite");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = PomodoroRepository::new(pool.clone());

        let session = repo.start("focus", 1500).await.unwrap();

        let (local_date, utc_offset_minutes): (Option<String>, Option<i64>) =
            sqlx::query_as("SELECT local_date, utc_offset_minutes FROM pomodoro_sessions WHERE id = $1")
                .bind(session.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();

        assert!(local_date.is_some_and(|d| d.len() == 10));
        assert!(utc_offset_minutes.is_some());

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}

/// `finish` credita XP sozinho, na mesma transação — a peça que corrige o
/// achado "concluir um Pomodoro nunca deu XP nenhum" (o comando
/// `registrar_xp_pomodoro_concluido` existia, mas nenhuma tela o chamava).
#[cfg(test)]
mod finish_credits_xp {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;
    use crate::db::pool::connect_and_migrate;

    fn pasta_temporaria(rotulo: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-pomodoro-xp-test-{rotulo}-{}", Uuid::new_v4()))
    }

    async fn banco_migrado(rotulo: &str) -> (SqlitePool, PathBuf) {
        let data_dir = pasta_temporaria(rotulo);
        let pool = connect_and_migrate(&data_dir.join("learno.sqlite")).await.unwrap();
        (pool, data_dir)
    }

    async fn contar_xp_de_pomodoro(pool: &SqlitePool, session_id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM xp_events WHERE origin = 'pomodoro_focus' AND reference_id = $1")
            .bind(session_id.hyphenated().to_string())
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn foco_concluido_credita_xp_exatamente_uma_vez() {
        let (pool, data_dir) = banco_migrado("foco-concluido").await;
        let repo = PomodoroRepository::new(pool.clone());

        let sessao = repo.start("focus", 1500).await.unwrap();
        repo.finish(sessao.id, true).await.unwrap();

        assert_eq!(contar_xp_de_pomodoro(&pool, sessao.id).await, 1);
        let amount: i64 = sqlx::query_scalar("SELECT amount FROM xp_events WHERE origin = 'pomodoro_focus' AND reference_id = $1")
            .bind(sessao.id.hyphenated().to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(amount, XP_POR_POMODORO_CONCLUIDO);

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// O caso que a tela de gamificação já prometia e o desenho antigo não
    /// entregava: uma sessão CANCELADA nunca credita XP.
    #[tokio::test]
    async fn foco_cancelado_nao_credita_xp() {
        let (pool, data_dir) = banco_migrado("foco-cancelado").await;
        let repo = PomodoroRepository::new(pool.clone());

        let sessao = repo.start("focus", 1500).await.unwrap();
        repo.finish(sessao.id, false).await.unwrap();

        assert_eq!(contar_xp_de_pomodoro(&pool, sessao.id).await, 0, "sessão cancelada não pode pagar XP");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// Uma pausa (curta ou longa) "concluída" também não é foco — não pode
    /// pagar XP de pomodoro mesmo com `completed = true`.
    #[tokio::test]
    async fn pausa_concluida_nao_credita_xp_de_foco() {
        let (pool, data_dir) = banco_migrado("pausa-concluida").await;
        let repo = PomodoroRepository::new(pool.clone());

        let sessao = repo.start("short_break", 300).await.unwrap();
        repo.finish(sessao.id, true).await.unwrap();

        assert_eq!(contar_xp_de_pomodoro(&pool, sessao.id).await, 0, "pausa não é foco — não pode pagar XP de pomodoro");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    /// A ARMADILHA CENTRAL, do lado do pomodoro: se a escrita de XP falhar de
    /// verdade, a transação inteira reverte — a sessão NÃO fica finalizada
    /// sem a contrapartida de XP. Simulado derrubando `xp_events` antes de
    /// chamar `finish`: o `INSERT` de XP esbarra em "no such table" (erro
    /// real de banco), e a prova é que a sessão continua exatamente como
    /// `start` a deixou — aberta, não concluída.
    #[tokio::test]
    async fn falha_ao_creditar_xp_reverte_finish_e_a_sessao_continua_aberta() {
        let (pool, data_dir) = banco_migrado("falha-xp").await;
        let repo = PomodoroRepository::new(pool.clone());

        let sessao = repo.start("focus", 1500).await.unwrap();
        sqlx::query("DROP TABLE xp_events").execute(&pool).await.unwrap();

        let resultado = repo.finish(sessao.id, true).await;
        assert!(resultado.is_err(), "sem a tabela de XP o crédito tem que falhar, e o erro tem que subir");

        let (ended_at, completed): (Option<String>, bool) =
            sqlx::query_as("SELECT ended_at, completed FROM pomodoro_sessions WHERE id = $1")
                .bind(sessao.id.db())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ended_at, None, "a transação revertida não pode deixar a sessão fechada");
        assert!(!completed, "completed não pode ter avançado se a transação reverteu");

        pool.close().await;
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
