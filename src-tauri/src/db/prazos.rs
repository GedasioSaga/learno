//! Repository dos Prazos (contagem regressiva) — `0027_prazos.sql`.
//!
//! Duas peças distintas que este módulo mantém separadas de propósito:
//!
//! 1. **CRUD** sobre a linha (`criar`, `obter`, `atualizar`, `remover`) — nada
//!    de especial, mesmo desenho de `db::cronograma`.
//! 2. **A contagem regressiva** (`dias_ate_o_prazo`): uma função PURA sobre
//!    dois `NaiveDate`, sem acesso a banco nem a relógio, para poder ser
//!    testada isoladamente com datas fixas — mesmo raciocínio de
//!    `db::pomodoro::local_date_for`.
//!
//! `listar` é quem liga as duas: lê os prazos `ativo`s do banco, calcula a
//! contagem de cada um contra o dia de hoje, e separa vencidos de futuros. O
//! dia de hoje é lido do relógio do sistema (`chrono::Local`) porque este é
//! um app desktop de usuário único, no mesmo processo/máquina — a mesma
//! justificativa de `PomodoroRepository::today_summary` para não precisar
//! redescobrir fuso em lugar nenhum.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::error::{Error, Result};

/// Espelha o `CHECK (status IN (...))` da migração — validado aqui também
/// para que um status inválido vindo do IPC vire `Error::Invalid` legível,
/// não um `Error::Database` opaco (mesmo padrão de `VALID_KINDS` em
/// `db::pomodoro` e `VALID_ACTIVITIES` em `db::cronograma`).
const VALID_STATUSES: [&str; 3] = ["ativo", "concluido", "arquivado"];

/// Defesa contra entrada hostil de IPC, não regra de produto — mesmo teto
/// (e mesmo motivo) de `MAX_TITLE_CHARS` em `db::cronograma`.
const MAX_TITLE_CHARS: usize = 500;

const PRAZO_COLUMNS: &str = "id, title, due_local_date, deck_id, page_id, status, created_at, updated_at";

/// Uma linha de `prazos`, coluna por coluna.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrazoRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub title: String,
    pub due_local_date: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub deck_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
    pub page_id: Option<Uuid>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Entrada de `atualizar`. Mesma convenção de `BlocoPatchInput`
/// (`db::cronograma`): campo ausente (ou `null`) é "sem mudança" — o `UPDATE`
/// usa `COALESCE`. Mesma consequência aceita: não há, através deste patch,
/// como limpar `deckId`/`pageId` de volta para `NULL` uma vez preenchidos —
/// nenhum outro patch deste projeto resolve isso, e não é este que abre
/// exceção.
///
/// `status` entra aqui — marcar como concluído ou arquivar é só mais um
/// campo do patch, não um comando à parte.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrazoPatchInput {
    pub title: Option<String>,
    pub due_local_date: Option<String>,
    pub deck_id: Option<Uuid>,
    pub page_id: Option<Uuid>,
    pub status: Option<String>,
}

/// Um prazo já com a contagem regressiva calculada contra o dia de hoje —
/// o que `listar` devolve, nunca o que `criar`/`obter`/`atualizar` devolvem
/// (esses devolvem [`PrazoRow`] cru: a contagem só faz sentido no contexto de
/// uma listagem, contra UM "hoje" compartilhado por todos os itens dela).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrazoComContagem {
    #[serde(flatten)]
    pub prazo: PrazoRow,
    /// Ver [`dias_ate_o_prazo`]: positivo = faltam N dias, zero = é hoje,
    /// negativo = venceu há N dias. Aqui dentro de `futuros` o valor é
    /// sempre `>= 0`; dentro de `vencidos`, sempre `< 0` — a divisão em duas
    /// listas já comunica o sinal, este campo é o "quantos" exato.
    pub dias_restantes: i64,
}

/// `listar_prazos`. Só os prazos com `status = 'ativo'` — ver o comentário de
/// `status` na migração para o porquê de concluído/arquivado saírem da
/// contagem regressiva sem sair da tabela.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrazosListados {
    /// O dia local usado para classificar esta listagem — exposto para a UI
    /// nunca precisar confiar no próprio relógio para decidir se um item é
    /// "vencido": o backend já decidiu, e diz contra qual dia decidiu.
    pub hoje: String,
    /// Ordenados do mais próximo de hoje (o que venceu mais recentemente)
    /// para o mais antigo.
    pub vencidos: Vec<PrazoComContagem>,
    /// Ordenados do mais próximo de hoje (o mais urgente) para o mais
    /// distante.
    pub futuros: Vec<PrazoComContagem>,
}

pub struct PrazoRepository {
    pool: SqlitePool,
}

impl PrazoRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `criar_prazo`. `deckId`/`pageId` que não nomeiam uma linha existente
    /// surgem como `Error::Database` (violação de FK) — mesma escolha de
    /// `CronogramaRepository::criar_bloco`: não pré-checar, deixar a
    /// constraint reportar.
    pub async fn criar(
        &self,
        title: &str,
        due_local_date: &str,
        deck_id: Option<Uuid>,
        page_id: Option<Uuid>,
    ) -> Result<PrazoRow> {
        let title = validate_title(title)?;
        parse_local_date(due_local_date)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, PrazoRow>(&format!(
            "INSERT INTO prazos (id, title, due_local_date, deck_id, page_id) \
             VALUES ($1, $2, $3, $4, $5) RETURNING {PRAZO_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&title)
        .bind(due_local_date)
        .bind(deck_id.db())
        .bind(page_id.db())
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `obter_prazo`. Independe de `status` — um prazo concluído ou
    /// arquivado continua legível por id (a tela de edição precisa dele para
    /// reverter o status, por exemplo).
    pub async fn obter(&self, id: Uuid) -> Result<PrazoRow> {
        sqlx::query_as::<_, PrazoRow>(&format!("SELECT {PRAZO_COLUMNS} FROM prazos WHERE id = $1"))
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("prazo {id}")))
    }

    /// `atualizar_prazo`. Patch por `COALESCE` — ver o comentário de
    /// [`PrazoPatchInput`] para o que ele não faz (limpar `deckId`/`pageId`
    /// de volta para `NULL`).
    pub async fn atualizar(&self, id: Uuid, patch: PrazoPatchInput) -> Result<PrazoRow> {
        let title = patch.title.as_deref().map(validate_title).transpose()?;
        if let Some(due) = patch.due_local_date.as_deref() {
            parse_local_date(due)?;
        }
        if let Some(status) = patch.status.as_deref() {
            validate_status(status)?;
        }

        let row = sqlx::query_as::<_, PrazoRow>(&format!(
            "UPDATE prazos SET \
                 title = COALESCE($2, title), \
                 due_local_date = COALESCE($3, due_local_date), \
                 deck_id = COALESCE($4, deck_id), \
                 page_id = COALESCE($5, page_id), \
                 status = COALESCE($6, status) \
             WHERE id = $1 RETURNING {PRAZO_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&title)
        .bind(&patch.due_local_date)
        .bind(patch.deck_id.db())
        .bind(patch.page_id.db())
        .bind(&patch.status)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("prazo {id}")))?;

        Ok(row)
    }

    /// `remover_prazo`. Exclusão física — `prazos` não tem lixeira própria
    /// (o `status = 'arquivado'` já cobre "não quero mais ver isto sem
    /// apagar"; `remover` é para quando de fato não deve sobrar linha
    /// nenhuma). Não toca `decks`/`pages`: a FK aponta do prazo PARA o
    /// baralho/página, nunca o contrário, então apagar um prazo não pode
    /// arrastar o baralho ou a página ligados — não há caminho no schema
    /// para isso acontecer.
    pub async fn remover(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM prazos WHERE id = $1").bind(id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("prazo {id}")));
        }
        Ok(())
    }

    /// `listar_prazos`. Só `status = 'ativo'`, separados em vencidos/futuros
    /// contra o dia de hoje (relógio do sistema — ver o comentário do
    /// módulo). Banco vazio, ou sem nenhum prazo ativo, devolve as duas
    /// listas vazias — nunca erro.
    pub async fn listar(&self) -> Result<PrazosListados> {
        let hoje = chrono::Local::now().date_naive();
        let hoje_str = hoje.format("%Y-%m-%d").to_string();

        // ASC: já entrega `futuros` na ordem certa (mais próximo primeiro).
        // A parte vencida sai em ordem CRESCENTE de data (mais antiga
        // primeiro) e é revertida abaixo para também ficar "mais próximo de
        // hoje primeiro" — a mesma noção de proximidade nos dois sentidos.
        let ativos: Vec<PrazoRow> = sqlx::query_as(&format!(
            "SELECT {PRAZO_COLUMNS} FROM prazos WHERE status = 'ativo' ORDER BY due_local_date ASC"
        ))
        .fetch_all(&self.pool)
        .await?;

        let mut vencidos = Vec::new();
        let mut futuros = Vec::new();
        for prazo in ativos {
            let due = parse_local_date(&prazo.due_local_date)?;
            let dias_restantes = dias_ate_o_prazo(hoje, due);
            let item = PrazoComContagem { prazo, dias_restantes };
            if dias_restantes < 0 {
                vencidos.push(item);
            } else {
                futuros.push(item);
            }
        }
        vencidos.reverse();

        Ok(PrazosListados { hoje: hoje_str, vencidos, futuros })
    }
}

/// Pura: dias de calendário entre `hoje` e `prazo`, ambos dias LOCAIS já
/// resolvidos pelo chamador (mesma convenção de `local_date` no resto do
/// projeto — nunca um instante, nunca dividido por segundos).
///
/// Positivo = "faltam N dias" (prazo no futuro). **Zero = o prazo é HOJE**, e
/// isto é deliberadamente DIFERENTE de vencido — o dia ainda não acabou, e
/// `listar` classifica um `dias_restantes == 0` como `futuros`, nunca
/// `vencidos`. Negativo = o prazo passou há `|N|` dias — a definição de
/// "vencido" que este módulo usa, e ela nunca é gravada: recalculada toda
/// vez a partir de `due_local_date` e do dia de hoje (ver o comentário de
/// `status` em `0027_prazos.sql` para o porquê de não existir uma coluna
/// `vencido`).
///
/// Pura porque `NaiveDate::signed_duration_since` subtrai dias de calendário
/// direto — sem hora, sem fuso, sem instante — então virada de mês, ano
/// bissexto e horário de verão nunca entram na conta: dois `NaiveDate` não
/// carregam nenhum dos três, e a mesma dupla de datas produz sempre a mesma
/// diferença, testável com datas fixas sem depender do relógio nem do fuso de
/// quem roda o teste.
pub fn dias_ate_o_prazo(hoje: NaiveDate, prazo: NaiveDate) -> i64 {
    prazo.signed_duration_since(hoje).num_days()
}

fn parse_local_date(raw: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|err| Error::Invalid(format!("data local inválida: {raw:?} ({err})")))
}

fn validate_status(status: &str) -> Result<()> {
    if !VALID_STATUSES.contains(&status) {
        return Err(Error::Invalid(format!("status inválido: {status:?} (esperado um de {VALID_STATUSES:?})")));
    }
    Ok(())
}

/// Ao contrário de `db::cronograma::validate_title` (onde título vazio é
/// legítimo — o bloco do cronograma pode se identificar só pelo baralho ou
/// pela página ligada), aqui título vazio é rejeitado: um prazo É o título —
/// "faltam 12 dias" para uma linha sem nome não diz para o quê. O `CHECK
/// (length(trim(title)) > 0)` da migração cobre gravação direta por SQL; esta
/// função cobre o caminho normal, com uma mensagem legível em vez de
/// `Error::Database`.
fn validate_title(title: &str) -> Result<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("título do prazo não pode ser vazio".into()));
    }
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        return Err(Error::Invalid(format!("título maior que {MAX_TITLE_CHARS} caracteres")));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn data(raw: &str) -> NaiveDate {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn mesmo_dia_e_zero_dias_e_isso_e_diferente_de_vencido() {
        assert_eq!(dias_ate_o_prazo(data("2026-09-05"), data("2026-09-05")), 0);
    }

    #[test]
    fn um_dia_a_frente_e_um() {
        assert_eq!(dias_ate_o_prazo(data("2026-09-05"), data("2026-09-06")), 1);
    }

    #[test]
    fn prazo_no_passado_e_negativo() {
        assert_eq!(dias_ate_o_prazo(data("2026-09-05"), data("2026-09-01")), -4);
        assert_eq!(dias_ate_o_prazo(data("2026-09-05"), data("2026-09-04")), -1);
    }

    #[test]
    fn atravessa_virada_de_mes() {
        // 31/01 -> 01/02: um dia, não zero (mês não reseta a contagem).
        assert_eq!(dias_ate_o_prazo(data("2026-01-31"), data("2026-02-01")), 1);
    }

    /// 2028 é bissexto (divisível por 4, não por 100): fevereiro tem 29 dias,
    /// e 28/02 -> 01/03 precisa contar os DOIS dias que ficam no meio
    /// (29/02 e 01/03 em si), não os três que uma conta ingênua em "dia do
    /// ano" produziria confundindo com um ano comum.
    #[test]
    fn atravessa_29_de_fevereiro_em_ano_bissexto() {
        assert_eq!(dias_ate_o_prazo(data("2028-02-28"), data("2028-03-01")), 2);
        // O ano comum seguinte, mesma travessia, sem 29/02: só 1 dia — a
        // prova de que o bissexto acima não é um acidente de contagem.
        assert_eq!(dias_ate_o_prazo(data("2029-02-28"), data("2029-03-01")), 1);
    }

    /// A virada de horário de verão não pode mudar o resultado: são dois
    /// `NaiveDate`, sem hora nem fuso embutidos, então a mesma dupla de datas
    /// produz a mesma diferença não importa que o relógio de parede local
    /// (num fuso que observe DST — o Brasil não observa mais desde 2019, mas
    /// o usuário pode estar viajando, ou o app pode rodar noutro fuso) tenha
    /// andado uma hora para trás ou para frente no meio do intervalo. As
    /// datas abaixo só precisam ser uma travessia de calendário qualquer — o
    /// ponto do teste é a AUSÊNCIA de qualquer efeito de fuso na conta pura.
    #[test]
    fn virada_de_horario_de_verao_nao_afeta_a_conta_pura() {
        assert_eq!(dias_ate_o_prazo(data("2026-11-01"), data("2026-11-04")), 3);
        assert_eq!(dias_ate_o_prazo(data("2027-02-20"), data("2027-02-23")), 3);
    }

    #[test]
    fn validate_status_accepts_the_three_known_states_and_rejects_the_rest() {
        for status in VALID_STATUSES {
            assert!(validate_status(status).is_ok());
        }
        assert!(matches!(validate_status("vencido"), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_title_rejects_empty_and_whitespace_only() {
        assert!(matches!(validate_title(""), Err(Error::Invalid(_))));
        assert!(matches!(validate_title("   "), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_title_trims_and_accepts_a_real_title() {
        assert_eq!(validate_title("  Prova de Biologia  ").unwrap(), "Prova de Biologia");
    }

    #[test]
    fn validate_title_rejects_text_past_the_length_cap() {
        let longo = "x".repeat(MAX_TITLE_CHARS + 1);
        assert!(matches!(validate_title(&longo), Err(Error::Invalid(_))));
    }

    #[test]
    fn parse_local_date_accepts_iso_and_rejects_garbage() {
        assert!(parse_local_date("2026-09-05").is_ok());
        assert!(parse_local_date("05/09/2026").is_err());
        assert!(parse_local_date("").is_err());
    }
}
