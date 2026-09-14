//! Repository do Cronograma (Fase 5) — `0024_cronograma.sql`: a meta semanal
//! (`weekly_study_goals`), o bloco planejado do dia (`study_plan_blocks`) e o
//! "6,5 / 8" da semana, lido através da view `study_day_totals` que a
//! migração já define.
//!
//! ## A decisão que a migração já tomou, e que este arquivo só executa
//!
//! `study_time_entries` NÃO recebe uma linha por sessão de pomodoro
//! concluída. `pomodoro_sessions` (0014) já É o registro de uma sessão de
//! timer — duplicá-la aqui criaria duas respostas para "quanto foi
//! executado". Em vez disso:
//!
//! - `pomodoro_sessions` ganhou (nesta migração) `local_date` e
//!   `utc_offset_minutes`, gravados pelo Rust no instante em que a sessão
//!   começa — ver `PomodoroRepository::start` em `db::pomodoro`, que é o
//!   único ponto de escrita dessas duas colunas.
//! - A view `study_day_totals` SOMA as duas fontes por dia local: os segundos
//!   de `pomodoro_sessions` (convertidos a minuto num lugar só) mais os
//!   minutos de `study_time_entries`. `semana` (abaixo) só lê essa soma já
//!   pronta — nunca recalcula a conversão segundo→minuto aqui.
//!
//! `study_time_entries` continua existindo para o que NÃO passa pelo timer:
//! revisão de cards, tempo no mapa mental, leitura — atividades sem execução
//! própria, cujo tempo só pode ser lançado à mão. O contrato de IPC fixado
//! para esta peça não expõe um comando de lançamento manual ainda (nenhum dos
//! seis métodos pedidos escreve em `study_time_entries`); a tabela e a view já
//! estão prontas para quando esse comando existir.
//!
//! ## XP de bloco cumprido: sai do Pomodoro ligado ao bloco
//!
//! Nenhum método daqui escreve em `study_time_entries`. A operação de domínio
//! que cumpre um bloco é o FOCO ligado a ele: `PomodoroRepository::start`
//! aceita `plan_block_id` ("Focar neste bloco"), e `finish` credita o XP do
//! bloco na mesma transação quando o tempo realizado alcança
//! `planned_minutes` (`GamificacaoRepository::creditar_xp_de_bloco_se_cumprido`).
//! Só tempo medido pelo timer conta, por decisão do usuário (13/09/2026).
//! `GamificacaoRepository::registrar_xp_bloco_cronograma` continua existindo
//! como reprocessamento.
//!
//! ## Fuso
//!
//! Toda data que atravessa este módulo (`inicio`, `dia`, `novoDia`) é uma data
//! de CALENDÁRIO local, já resolvida pelo chamador — a mesma convenção que
//! `0024_cronograma.sql` grava em `local_date`. Este repositório nunca deriva
//! dia a partir de instante UTC; ele só valida o formato e, para o início de
//! semana, que a data é de fato uma segunda-feira (o contrato fixa isso: "diz
//! sempre segunda-feira").
//!
//! ## Grade de horários (`0029_grade_horaria.sql`) — três peças que faltavam
//!
//! 1. **Fim do bloco.** `study_plan_blocks` grava início (opcional) e duração
//!    em minutos, nunca o fim. Uma grade (linha = faixa horária) precisa do
//!    fim para saber onde o bloco para de ocupar linha — e a decisão é
//!    DERIVAR ([`fim_local`]), nunca gravar: `fim = início + duração` é
//!    aritmética de mão única, sempre coerente, e uma coluna própria seria
//!    uma segunda verdade que todo `UPDATE` de `plannedMinutes` ou
//!    `startLocalTime` teria que lembrar de manter sincronizada — sem nenhum
//!    `CHECK` do banco capaz de pegar a divergência. `BlocoPlanejado` carrega
//!    o resultado em `end_local_time`/`crosses_midnight`, calculados depois
//!    da leitura (`#[sqlx(skip)]` — nunca vêm de coluna) por
//!    [`with_derived_fields`], chamado em toda saída deste módulo.
//!
//!    Bloco SEM `start_local_time`: não tem o que derivar — `end_local_time`
//!    fica `None`. Ele não desaparece da semana (`semana()` continua
//!    devolvendo o bloco, com seus minutos contando pro total do dia); só não
//!    ocupa linha nenhuma da grade horária, porque não tem hora de início
//!    para ancorar. Sumir em silêncio perderia dado aos olhos do usuário; a
//!    escolha aqui é o oposto — o dado sobrevive na lista do dia, e a fase 2
//!    (tela) decide como desenhar "sem horário" (uma faixa própria, uma lista
//!    ao lado da grade, etc. — decisão de UI, não deste módulo).
//!
//! 2. **Matéria.** `activity` continua sendo o TIPO de estudo (as cinco
//!    chaves fechadas do `CHECK`); o que faltava era o NOME — "Química",
//!    "Português" — que o usuário repete em várias células da semana.
//!    [`Materia`] (`study_subjects`) é uma entidade própria, e não um
//!    segundo campo de texto livre em `study_plan_blocks`, exatamente porque
//!    é reusada: recolorir ou renomear uma matéria precisa valer para toda
//!    célula que a usa, de uma vez, sem editar bloco por bloco. Por isso
//!    `study_plan_blocks.subject_id` é só o vínculo (`Option<Uuid>`, como
//!    `deck_id`/`page_id`) — a tela (fase 2) busca `listar_materias()` uma
//!    vez e resolve nome/cor por id, o mesmo desenho que já existe para
//!    `deck_id` (este módulo nunca fez `JOIN` para trazer nome de baralho
//!    dentro de `BlocoPlanejado`, e matéria segue o precedente). `title`
//!    continua existindo e continua sendo o que sobra se a matéria for
//!    apagada (`ON DELETE SET NULL`, mesmo raciocínio do comentário de
//!    `title` na migração original) — cabe a quem cria o bloco (fase 2)
//!    congelar `titulo = nome da matéria` no momento da criação, do jeito que
//!    já seria a convenção para `deckId`/`pageId`.
//!
//! 3. **Cor.** `Materia.color` só aceita uma das oito chaves de
//!    `PALETA_DE_RAMOS` (`src/features/mapa-mental/cores-de-ramo.ts`) — a
//!    MESMA lista, de propósito: são chaves para os tokens de
//!    `src/styles/theme.css` (cinco temas), nunca hex solto, e reusar a
//!    paleta que o mapa mental já validou (contraste ≥ 3:1 nos cinco temas)
//!    evita medir tudo de novo para um segundo consumidor. `VALID_SUBJECT_COLORS`
//!    abaixo é a cópia dessas oito chaves do lado do Rust — se um dia a
//!    paleta mudar, as duas listas precisam mudar juntas (não há um único
//!    lugar compartilhado entre Rust e TypeScript neste projeto).
//!
//! 4. **Semana modelo.** Sem motor de recorrência (regra, exceção, "toda
//!    terça exceto feriado" é projeto à parte) — o caminho mais barato que
//!    resolve o caso real ("a mesma semana, repetida") é
//!    [`CronogramaRepository::copiar_semana`]: copia os blocos de uma semana
//!    para outra, deslocando `local_date` pelo mesmo número de dias que
//!    separa os dois inícios de semana, com posição e id novos. NÃO é
//!    idempotente por decisão: rodar duas vezes sobre o mesmo destino duplica
//!    os blocos, porque limpar o destino antes apagaria qualquer
//!    customização que a pessoa já tivesse feito naquela semana — o preço de
//!    uma operação sempre segura (nunca apaga o que já existe) é confiar no
//!    chamador para não repetir a cópia.

// (Nota da fase 1 de "rotina diária", `0042_rotina_diaria.sql`: `Rotina`/
// `ItemDeRotina` mais abaixo são o MOLDE de um dia — nunca o plano em si.
// `CronogramaRepository::aplicar_rotina` é o único ponto que lê o molde e
// grava linhas de verdade em `study_plan_blocks`; editar a rotina depois
// não reescreve nenhum dia já aplicado, mesmo raciocínio do item 4 acima
// (`copiar_semana`) e de `weekly_study_goals`. Ver a migração para o porquê
// das três economias de schema, e o comentário de `aplicar_rotina` para
// como a assinatura já reserva espaço para intervalo (fase 2) e para o modo
// "substituir" (fase 3) sem precisar mudar de novo. Esta peça implementa só
// `dataInicio == dataFim` e o modo `PreencherDiasVazios`.)

use std::collections::HashMap;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

/// Espelha o `CHECK (activity IN (...))` de `study_plan_blocks` e
/// `study_time_entries` — validado aqui também para que uma atividade
/// inválida vinda do IPC vire `Error::Invalid` legível, não um
/// `Error::Database` opaco (mesmo padrão de `VALID_KINDS` em `db::pomodoro`).
const VALID_ACTIVITIES: [&str; 5] = ["pomodoro", "review", "mindmap", "reading", "other"];

/// Teto de defesa contra entrada hostil de IPC — não é regra de produto, é
/// para um script na WebView não conseguir gravar um título de megabytes.
const MAX_TITLE_CHARS: usize = 500;

/// Um bloco não pode ser planejado por mais do que um dia inteiro — teto de
/// sanidade contra um `minutosPlanejados` absurdo vindo de entrada hostil.
const MAX_PLANNED_MINUTES_PER_BLOCK: i64 = 24 * 60;

/// Uma semana tem 10 080 minutos — nenhuma meta semanal legítima passa disso.
const MAX_WEEKLY_TARGET_MINUTES: i64 = 7 * 24 * 60;

/// Mesma paleta de `PALETA_DE_RAMOS` em `src/features/mapa-mental/cores-de-ramo.ts`
/// — ver o item 3 do comentário de módulo para o porquê de reusar em vez de
/// medir uma paleta nova.
const VALID_SUBJECT_COLORS: [&str; 8] =
    ["amber", "mint", "azul", "terracotta", "roxo", "emerald", "vermelho", "brown"];

/// Cor padrão de uma matéria criada sem `cor` explícita — a primeira da
/// paleta, sem significado além de "alguma cor válida sempre presente".
const DEFAULT_SUBJECT_COLOR: &str = "amber";

/// Mesmo teto de defesa de [`MAX_TITLE_CHARS`], para o mesmo motivo: entrada
/// hostil de IPC, não regra de produto. "Química", "Ed. Física" cabem longe
/// disso.
const MAX_SUBJECT_NAME_CHARS: usize = 200;

/// Mesmo teto de defesa de [`MAX_SUBJECT_NAME_CHARS`], mesmo motivo — nomes
/// de rotina reais ("Dia de semana", "Fim de semana") ficam bem abaixo.
const MAX_ROUTINE_NAME_CHARS: usize = 200;

/// Mesma máscara do `DEFAULT` da coluna `study_routines.default_weekdays`
/// na migração — repetida aqui porque `criar_rotina` grava explicitamente
/// (nunca deixa para o default do SQLite), mesmo raciocínio de
/// [`validate_title`] para `title`.
const DEFAULT_ROUTINE_WEEKDAYS: &str = "1111100";

const PLAN_BLOCK_COLUMNS: &str = "id, local_date, position, start_local_time, planned_minutes, \
     activity, pomodoro_cycles, title, deck_id, page_id, subject_id, created_at, updated_at";

const SUBJECT_COLUMNS: &str = "id, name, color, created_at, updated_at";

const ROUTINE_COLUMNS: &str = "id, name, default_weekdays, created_at, updated_at";

const ROUTINE_ITEM_COLUMNS: &str = "id, routine_id, start_local_time, planned_minutes, \
     activity, pomodoro_cycles, title, subject_id, created_at, updated_at";

/// Mirrors `BlocoPlanejado` no contrato de IPC fixado — uma linha de
/// `study_plan_blocks`, coluna por coluna.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocoPlanejado {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub local_date: String,
    pub position: String,
    pub start_local_time: Option<String>,
    pub planned_minutes: i64,
    pub activity: String,
    pub pomodoro_cycles: Option<i64>,
    pub title: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub deck_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
    pub page_id: Option<Uuid>,
    /// Vínculo com [`Materia`] — ver o item 2 do comentário de módulo. Só o
    /// id atravessa este struct; nome e cor vivem em `listar_materias()`.
    #[sqlx(try_from = "DbIdOpt")]
    pub subject_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// DERIVADO — nunca é coluna, nunca vem de `SELECT`. `#[sqlx(skip)]` faz
    /// o `FromRow` gerado preencher com `Default::default()` (`None`)
    /// incondicionalmente na leitura; [`with_derived_fields`] é quem calcula
    /// o valor de verdade, chamado em toda saída deste módulo. `None` quando
    /// `start_local_time` é `None` — ver o item 1 do comentário de módulo.
    #[sqlx(skip)]
    pub end_local_time: Option<String>,
    /// DERIVADO, junto com `end_local_time` — `true` quando o bloco atravessa
    /// a meia-noite (ex.: início 23:30, 90 minutos). Sempre `false` quando
    /// `end_local_time` é `None`.
    #[sqlx(skip)]
    pub crosses_midnight: bool,
}

/// Mirrors `Materia` no contrato de IPC fixado — uma linha de
/// `study_subjects`. `BlocoPlanejado` só carrega `subject_id`; é
/// `listar_materias()` que devolve esta struct, uma vez, para a tela
/// resolver nome e cor de cada bloco localmente — ver o item 2 do comentário
/// de módulo para o porquê disso em vez de um `JOIN` dentro deste módulo.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Materia {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub name: String,
    /// Uma das oito chaves de [`VALID_SUBJECT_COLORS`] — nunca hex, nunca
    /// texto livre (ver item 3 do comentário de módulo).
    pub color: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Entrada de `atualizar_materia`. Mesma convenção `COALESCE` de
/// [`BlocoPatchInput`]: campo ausente (ou `null`) é "sem mudança".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MateriaPatchInput {
    pub name: Option<String>,
    pub color: Option<String>,
}

/// Mirrors `Rotina` no contrato de IPC fixado — uma linha de
/// `study_routines`. Ver o item "rotina diária" do comentário de módulo:
/// isto é o MOLDE, nunca o plano em si.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rotina {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub name: String,
    /// Máscara de 7 posições ('0'/'1'), posição 1 = SEGUNDA — mesma
    /// convenção de `parse_week_start`. Só pré-preenche o diálogo de
    /// aplicar; nunca é consultada por `aplicar_rotina` nem por `semana()`.
    pub default_weekdays: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Entrada de `atualizar_rotina`. Mesma convenção `COALESCE` das demais
/// (`MateriaPatchInput`, `BlocoPatchInput`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotinaPatchInput {
    pub name: Option<String>,
    pub default_weekdays: Option<String>,
}

/// Mirrors `ItemDeRotina` no contrato de IPC fixado — uma linha de
/// `study_routine_items`. Sem `position`: `start_local_time` é obrigatório
/// aqui (ao contrário de `BlocoPlanejado`), então a hora já é a ordem — ver
/// a migração para a economia completa.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeRotina {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub routine_id: Uuid,
    pub start_local_time: String,
    pub planned_minutes: i64,
    pub activity: String,
    pub pomodoro_cycles: Option<i64>,
    pub title: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub subject_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Entrada de `atualizar_item_de_rotina`. Mesma convenção `COALESCE` de
/// [`BlocoPatchInput`], inclusive a mesma limitação: não há como limpar de
/// volta para `NULL` `pomodoroCycles`/`subjectId` através deste patch.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeRotinaPatchInput {
    pub start_local_time: Option<String>,
    pub planned_minutes: Option<i64>,
    pub activity: Option<String>,
    pub pomodoro_cycles: Option<i64>,
    pub title: Option<String>,
    pub subject_id: Option<Uuid>,
}

/// Modo como `aplicar_rotina` resolve um dia — ver o comentário daquele
/// método para o porquê deste enum já existir com um só braço.
///
/// Só `PreencherDiasVazios` existe nesta fase (fatia 1). `Substituir` é a
/// fatia 3 do plano (com o campo `incluir_hoje` do diálogo) e entra como
/// uma segunda variante do MESMO enum quando chegar a vez — o `match`
/// interno de `aplicar_rotina` ganha um braço novo, a assinatura da função
/// não muda.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModoDeAplicacaoDeRotina {
    PreencherDiasVazios,
}

/// Um dia que `aplicar_rotina` recusou-se a tocar por já ter bloco — nunca
/// um erro, porque em uma aplicação de intervalo (fatia 2) os outros dias
/// do intervalo continuam sendo aplicados normalmente. Nesta fatia (um dia
/// só) `dias_pulados` tem no máximo um elemento.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiaDeRotinaPulado {
    pub data: String,
    pub motivo: String,
}

/// `AplicacaoDeRotina` no contrato de IPC — o relatório que `aplicar_rotina`
/// devolve: quais dias ganharam blocos, quais foram pulados (e por quê), e
/// quantos blocos no total. Nunca um `bool` solto de sucesso: a idempotência
/// do "preencher vazios" só é visível através deste relatório.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AplicacaoDeRotina {
    pub dias_aplicados: Vec<String>,
    pub dias_pulados: Vec<DiaDeRotinaPulado>,
    pub total_blocos_criados: i64,
}

/// Um dia da faixa semanal — `DiaDaSemana` no contrato. `minutos_realizados`
/// já vem somado (timer + manual) da view `study_day_totals`; este struct só
/// carrega o resultado.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiaDaSemana {
    pub data: String,
    pub blocos: Vec<BlocoPlanejado>,
    pub minutos_realizados: i64,
}

/// `SemanaDeEstudo` no contrato — sempre sete dias, `inicio` até `inicio + 6`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanaDeEstudo {
    pub inicio: String,
    pub meta_minutos: i64,
    pub dias: Vec<DiaDaSemana>,
}

/// Entrada de `atualizar_bloco`. Mesma convenção de `MindmapNodePatchInput`
/// (`db::mindmap`): um campo ausente (ou `null`) significa "sem mudança" — o
/// `UPDATE` usa `COALESCE`. Consequência aceita: não há, através deste patch,
/// como limpar de volta para `NULL` um campo opcional já preenchido
/// (`startLocalTime`, `pomodoroCycles`, `deckId`, `pageId`) — isso exigiria
/// duplo-`Option`, e nenhum outro patch deste projeto se dá a esse trabalho.
///
/// `local_date`/`position` não entram aqui de propósito: mover um bloco de
/// dia ou de lugar na lista é `mover_bloco`, não um patch de conteúdo.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocoPatchInput {
    pub start_local_time: Option<String>,
    pub planned_minutes: Option<i64>,
    pub activity: Option<String>,
    pub pomodoro_cycles: Option<i64>,
    pub title: Option<String>,
    pub deck_id: Option<Uuid>,
    pub page_id: Option<Uuid>,
    pub subject_id: Option<Uuid>,
}

pub struct CronogramaRepository {
    pool: SqlitePool,
}

impl CronogramaRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `semana_de_estudo`. Monta os sete dias de `inicio` a `inicio + 6`,
    /// cada um com seus blocos planejados (`study_plan_blocks`) e o total
    /// realizado (`study_day_totals.done_minutes`, timer + manual já
    /// somados). A meta é a de `inicio` se houver uma, senão a da última
    /// semana anterior que tinha uma — ver o comentário de
    /// `weekly_study_goals` na migração.
    pub async fn semana(&self, inicio: &str) -> Result<SemanaDeEstudo> {
        let start = parse_week_start(inicio)?;
        let end = start + Duration::days(6);
        let end_str = end.format("%Y-%m-%d").to_string();

        let meta_minutos: i64 = sqlx::query_scalar(
            "SELECT target_minutes FROM weekly_study_goals \
             WHERE week_start_date <= $1 ORDER BY week_start_date DESC LIMIT 1",
        )
        .bind(inicio)
        .fetch_optional(&self.pool)
        .await?
        .unwrap_or(0);

        let blocos_crus: Vec<BlocoPlanejado> = sqlx::query_as(&format!(
            "SELECT {PLAN_BLOCK_COLUMNS} FROM study_plan_blocks \
             WHERE local_date BETWEEN $1 AND $2 ORDER BY local_date, position"
        ))
        .bind(inicio)
        .bind(&end_str)
        .fetch_all(&self.pool)
        .await?;
        let blocos =
            blocos_crus.into_iter().map(with_derived_fields).collect::<Result<Vec<_>>>()?;

        let realizados: Vec<(String, i64)> = sqlx::query_as(
            "SELECT local_date, done_minutes FROM study_day_totals WHERE local_date BETWEEN $1 AND $2",
        )
        .bind(inicio)
        .bind(&end_str)
        .fetch_all(&self.pool)
        .await?;
        let mut realizados_por_dia: HashMap<String, i64> = realizados.into_iter().collect();

        let mut blocos_por_dia: HashMap<String, Vec<BlocoPlanejado>> = HashMap::new();
        for bloco in blocos {
            blocos_por_dia.entry(bloco.local_date.clone()).or_default().push(bloco);
        }

        let mut dias = Vec::with_capacity(7);
        for offset in 0..7i64 {
            let dia = (start + Duration::days(offset)).format("%Y-%m-%d").to_string();
            let blocos_do_dia = blocos_por_dia.remove(&dia).unwrap_or_default();
            let minutos_realizados = realizados_por_dia.remove(&dia).unwrap_or(0);
            dias.push(DiaDaSemana { data: dia, blocos: blocos_do_dia, minutos_realizados });
        }

        Ok(SemanaDeEstudo { inicio: inicio.to_string(), meta_minutos, dias })
    }

    /// `definir_meta_semanal`. Uma meta por semana: definir de novo é UPDATE
    /// (`ON CONFLICT`), nunca uma segunda linha — mesmo contrato que o
    /// `UNIQUE (week_start_date)` da migração já força.
    pub async fn definir_meta_semanal(&self, inicio: &str, meta_minutos: i64) -> Result<()> {
        parse_week_start(inicio)?;
        if meta_minutos <= 0 {
            return Err(Error::Invalid("meta semanal precisa ser maior que zero minutos".into()));
        }
        if meta_minutos > MAX_WEEKLY_TARGET_MINUTES {
            return Err(Error::Invalid(format!(
                "meta semanal maior que uma semana inteira ({MAX_WEEKLY_TARGET_MINUTES} minutos)"
            )));
        }

        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO weekly_study_goals (id, week_start_date, target_minutes) VALUES ($1, $2, $3) \
             ON CONFLICT (week_start_date) DO UPDATE SET target_minutes = excluded.target_minutes",
        )
        .bind(id.db())
        .bind(inicio)
        .bind(meta_minutos)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// `criar_bloco`. Entra como o último bloco ativo do dia — mesmo esquema
    /// de `DeckRepository::next_position_under`, com `local_date` no lugar de
    /// `parent_id` como escopo de irmãos. `startLocalTime` e
    /// `pomodoroCycles` são opcionais: ausentes, nascem `NULL` (quem os
    /// define depois é `atualizar_bloco`); passados, entram já no `INSERT` —
    /// é o caminho que a rotina diária usa em `aplicar_rotina` para não
    /// precisar de um segundo round-trip por bloco (ver o comentário de
    /// módulo, seção "rotina diária").
    ///
    /// `deckId`/`pageId`/`subjectId` que não nomeiam uma linha existente
    /// surgem como `Error::Database` (violação de FK) — mesma escolha de
    /// `DeckRepository::create` para `parent_id`: não pré-checar, deixar a
    /// constraint reportar.
    #[allow(clippy::too_many_arguments)]
    pub async fn criar_bloco(
        &self,
        dia: &str,
        atividade: &str,
        minutos_planejados: i64,
        start_local_time: Option<String>,
        pomodoro_cycles: Option<i64>,
        titulo: Option<String>,
        deck_id: Option<Uuid>,
        page_id: Option<Uuid>,
        subject_id: Option<Uuid>,
    ) -> Result<BlocoPlanejado> {
        parse_local_date(dia)?;
        validate_activity(atividade)?;
        validate_planned_minutes(minutos_planejados)?;
        if let Some(start) = start_local_time.as_deref() {
            validate_local_time(start)?;
        }
        if let Some(cycles) = pomodoro_cycles {
            if cycles <= 0 {
                return Err(Error::Invalid("ciclos de pomodoro precisa ser maior que zero".into()));
            }
        }
        let title = validate_title(titulo)?;

        let new_position = next_position_in_day(&self.pool, dia).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, BlocoPlanejado>(&format!(
            "INSERT INTO study_plan_blocks \
                 (id, local_date, position, start_local_time, planned_minutes, activity, pomodoro_cycles, title, deck_id, page_id, subject_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING {PLAN_BLOCK_COLUMNS}"
        ))
        .bind(id.db())
        .bind(dia)
        .bind(&new_position)
        .bind(&start_local_time)
        .bind(minutos_planejados)
        .bind(atividade)
        .bind(pomodoro_cycles)
        .bind(&title)
        .bind(deck_id.db())
        .bind(page_id.db())
        .bind(subject_id.db())
        .fetch_one(&self.pool)
        .await?;

        with_derived_fields(row)
    }

    /// `mover_bloco`. Reposiciona (troca de dia, e/ou troca de vizinho) na
    /// mesma família de `BlockRepository::move_block`: índice fracionário
    /// entre os dois vizinhos do NOVO dia, `aposBlocoId = None` significa
    /// "primeiro do dia".
    pub async fn mover_bloco(
        &self,
        bloco_id: Uuid,
        novo_dia: &str,
        apos_bloco_id: Option<Uuid>,
    ) -> Result<BlocoPlanejado> {
        parse_local_date(novo_dia)?;

        let mut tx = self.pool.begin().await?;

        // Confirma que o bloco existe antes de tocar em qualquer coisa — um
        // `mover_bloco` de id desconhecido vira `NotFound`, não a confusão de
        // um `UPDATE` de zero linhas.
        fetch_bloco_tx(&mut tx, bloco_id).await?;

        let siblings = siblings_in_day_tx(&mut tx, novo_dia, Some(bloco_id)).await?;
        let new_position = position_between(&siblings, apos_bloco_id)?;

        let row = sqlx::query_as::<_, BlocoPlanejado>(&format!(
            "UPDATE study_plan_blocks SET local_date = $2, position = $3 WHERE id = $1 RETURNING {PLAN_BLOCK_COLUMNS}"
        ))
        .bind(bloco_id.db())
        .bind(novo_dia)
        .bind(&new_position)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        with_derived_fields(row)
    }

    /// `atualizar_bloco`. Patch por `COALESCE` — ver o comentário de
    /// [`BlocoPatchInput`] para o que ele não faz (limpar campo opcional de
    /// volta para `NULL`).
    ///
    /// Validação de campo isolado só (`activity` é uma das cinco válidas,
    /// `plannedMinutes`/`pomodoroCycles` positivos): a combinação entre eles
    /// — `pomodoro_cycles` só faz sentido com `activity = 'pomodoro'` e
    /// dividindo `planned_minutes` exato — fica para o `CHECK` da migração
    /// reportar como `Error::Database` se o patch deixar as três colunas
    /// inconsistentes entre si. Pré-checar essa combinação aqui exigiria ler
    /// a linha atual antes de decidir, e o ganho (uma mensagem mais bonita)
    /// não paga a segunda ida ao banco em todo `UPDATE`.
    pub async fn atualizar_bloco(&self, bloco_id: Uuid, patch: BlocoPatchInput) -> Result<BlocoPlanejado> {
        if let Some(activity) = patch.activity.as_deref() {
            validate_activity(activity)?;
        }
        if let Some(minutes) = patch.planned_minutes {
            validate_planned_minutes(minutes)?;
        }
        if let Some(cycles) = patch.pomodoro_cycles {
            if cycles <= 0 {
                return Err(Error::Invalid("ciclos de pomodoro precisa ser maior que zero".into()));
            }
        }
        if let Some(start) = patch.start_local_time.as_deref() {
            validate_local_time(start)?;
        }
        if let Some(title) = patch.title.as_deref() {
            validate_title_len(title)?;
        }

        let row = sqlx::query_as::<_, BlocoPlanejado>(&format!(
            "UPDATE study_plan_blocks SET \
                 start_local_time = COALESCE($2, start_local_time), \
                 planned_minutes = COALESCE($3, planned_minutes), \
                 activity = COALESCE($4, activity), \
                 pomodoro_cycles = COALESCE($5, pomodoro_cycles), \
                 title = COALESCE($6, title), \
                 deck_id = COALESCE($7, deck_id), \
                 page_id = COALESCE($8, page_id), \
                 subject_id = COALESCE($9, subject_id) \
             WHERE id = $1 RETURNING {PLAN_BLOCK_COLUMNS}"
        ))
        .bind(bloco_id.db())
        .bind(&patch.start_local_time)
        .bind(patch.planned_minutes)
        .bind(&patch.activity)
        .bind(patch.pomodoro_cycles)
        .bind(&patch.title)
        .bind(patch.deck_id.db())
        .bind(patch.page_id.db())
        .bind(patch.subject_id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("bloco planejado {bloco_id}")))?;

        with_derived_fields(row)
    }

    /// `remover_bloco`. Exclusão física — `study_plan_blocks` não tem
    /// `deleted_at` (a migração não previu lixeira para plano de semana), e
    /// `study_time_entries.plan_block_id`/`pomodoro_sessions.plan_block_id`
    /// são `ON DELETE SET NULL`: o fato de tempo realizado sobrevive à
    /// remoção do plano, só perde o vínculo — mesmo raciocínio do comentário
    /// da migração.
    pub async fn remover_bloco(&self, bloco_id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM study_plan_blocks WHERE id = $1").bind(bloco_id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("bloco planejado {bloco_id}")));
        }
        Ok(())
    }

    /// `criar_materia`. `cor` ausente vira [`DEFAULT_SUBJECT_COLOR`] — mesmo
    /// tratamento de `titulo` em `criar_bloco` (o chamador não é obrigado a
    /// escolher uma cor no primeiro momento).
    pub async fn criar_materia(&self, nome: &str, cor: Option<String>) -> Result<Materia> {
        let name = validate_subject_name(nome)?;
        let color = cor.unwrap_or_else(|| DEFAULT_SUBJECT_COLOR.to_string());
        validate_subject_color(&color)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, Materia>(&format!(
            "INSERT INTO study_subjects (id, name, color) VALUES ($1, $2, $3) RETURNING {SUBJECT_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&name)
        .bind(&color)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_materias`. Ordenada por nome — é uma lista pequena de
    /// referência (a tela busca uma vez e resolve `subjectId` localmente, ver
    /// o item 2 do comentário de módulo), então a ordem que mais ajuda quem
    /// escolhe numa lista é alfabética, não a de criação.
    pub async fn listar_materias(&self) -> Result<Vec<Materia>> {
        let rows =
            sqlx::query_as(&format!("SELECT {SUBJECT_COLUMNS} FROM study_subjects ORDER BY name COLLATE NOCASE"))
                .fetch_all(&self.pool)
                .await?;
        Ok(rows)
    }

    /// `atualizar_materia`. Patch por `COALESCE`, mesma convenção de
    /// `atualizar_bloco`. Renomear ou recolorir aqui vale para toda célula da
    /// grade que referencia esta matéria, sem tocar em `study_plan_blocks` —
    /// é exatamente o problema que criar a entidade resolve (item 2 do
    /// comentário de módulo).
    pub async fn atualizar_materia(&self, materia_id: Uuid, patch: MateriaPatchInput) -> Result<Materia> {
        let name = patch.name.as_deref().map(validate_subject_name).transpose()?;
        if let Some(color) = patch.color.as_deref() {
            validate_subject_color(color)?;
        }

        let row = sqlx::query_as::<_, Materia>(&format!(
            "UPDATE study_subjects SET name = COALESCE($2, name), color = COALESCE($3, color) \
             WHERE id = $1 RETURNING {SUBJECT_COLUMNS}"
        ))
        .bind(materia_id.db())
        .bind(&name)
        .bind(&patch.color)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("matéria {materia_id}")))?;

        Ok(row)
    }

    /// `remover_materia`. `study_plan_blocks.subject_id` é `ON DELETE SET
    /// NULL` (ver a migração): apagar a matéria não apaga nenhum bloco, só
    /// solta o vínculo — o `title` congelado de cada bloco é o que sobra,
    /// mesmo raciocínio de `deck_id`/`page_id` em `remover_bloco`.
    pub async fn remover_materia(&self, materia_id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM study_subjects WHERE id = $1").bind(materia_id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("matéria {materia_id}")));
        }
        Ok(())
    }

    /// `copiar_semana` — a "semana modelo" do item 4 do comentário de
    /// módulo. Copia todo bloco de `semana_origem_inicio` para
    /// `semana_destino_inicio`, deslocando `local_date` pelo mesmo número de
    /// dias que separa os dois inícios de semana (sempre múltiplo de 7, já
    /// que os dois são validados como segunda-feira), com id e posição
    /// novos — nunca reaproveita id nem `position` do original, exatamente
    /// como `PageRepository::duplicate`.
    ///
    /// NÃO apaga nada no destino antes de copiar (ver o item 4 do comentário
    /// de módulo): repetir a chamada duplica os blocos. `weekly_study_goals`
    /// não é copiada — a herança que `semana()` já faz (meta da última
    /// semana anterior que tinha uma) cobre o caso comum sem precisar
    /// duplicar a meta aqui.
    pub async fn copiar_semana(&self, semana_origem_inicio: &str, semana_destino_inicio: &str) -> Result<Vec<BlocoPlanejado>> {
        let origem = parse_week_start(semana_origem_inicio)?;
        let destino = parse_week_start(semana_destino_inicio)?;
        if origem == destino {
            return Err(Error::Invalid(
                "semana de origem e semana de destino não podem ser a mesma".into(),
            ));
        }
        let origem_fim = (origem + Duration::days(6)).format("%Y-%m-%d").to_string();

        let blocos_origem: Vec<BlocoPlanejado> = sqlx::query_as(&format!(
            "SELECT {PLAN_BLOCK_COLUMNS} FROM study_plan_blocks \
             WHERE local_date BETWEEN $1 AND $2 ORDER BY local_date, position"
        ))
        .bind(semana_origem_inicio)
        .bind(&origem_fim)
        .fetch_all(&self.pool)
        .await?;

        let mut tx = self.pool.begin().await?;
        let mut copiados = Vec::with_capacity(blocos_origem.len());

        for bloco in &blocos_origem {
            // `local_date` de cada bloco já passou pelo `CHECK` da migração
            // ao ser gravado — `parse_local_date` aqui não deveria falhar
            // nunca, mas o erro é propagado como qualquer outro em vez de um
            // `unwrap`, pelo mesmo motivo de `position::parse` (regra 3):
            // este valor veio do banco, não é constante do próprio código.
            let dia_origem = parse_local_date(&bloco.local_date)?;
            let offset_dias = dia_origem.signed_duration_since(origem).num_days();
            let novo_dia = (destino + Duration::days(offset_dias)).format("%Y-%m-%d").to_string();

            let nova_posicao = next_position_in_day_tx(&mut tx, &novo_dia).await?;
            let novo_id = Uuid::now_v7();

            let novo = sqlx::query_as::<_, BlocoPlanejado>(&format!(
                "INSERT INTO study_plan_blocks \
                     (id, local_date, position, start_local_time, planned_minutes, activity, pomodoro_cycles, title, deck_id, page_id, subject_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING {PLAN_BLOCK_COLUMNS}"
            ))
            .bind(novo_id.db())
            .bind(&novo_dia)
            .bind(&nova_posicao)
            .bind(&bloco.start_local_time)
            .bind(bloco.planned_minutes)
            .bind(&bloco.activity)
            .bind(bloco.pomodoro_cycles)
            .bind(&bloco.title)
            .bind(bloco.deck_id.db())
            .bind(bloco.page_id.db())
            .bind(bloco.subject_id.db())
            .fetch_one(&mut *tx)
            .await?;

            copiados.push(with_derived_fields(novo)?);
        }

        tx.commit().await?;
        Ok(copiados)
    }

    /// `criar_rotina`. `defaultWeekdays` ausente cai em
    /// [`DEFAULT_ROUTINE_WEEKDAYS`] — mesmo tratamento de `cor` em
    /// `criar_materia` (o chamador não é obrigado a escolher os dias logo de
    /// cara).
    pub async fn criar_rotina(&self, nome: &str, default_weekdays: Option<String>) -> Result<Rotina> {
        let name = validate_routine_name(nome)?;
        let weekdays = default_weekdays.unwrap_or_else(|| DEFAULT_ROUTINE_WEEKDAYS.to_string());
        validate_weekdays_mask(&weekdays)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, Rotina>(&format!(
            "INSERT INTO study_routines (id, name, default_weekdays) VALUES ($1, $2, $3) RETURNING {ROUTINE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&name)
        .bind(&weekdays)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_rotinas`. Ordenada por nome — lista pequena de referência,
    /// mesmo raciocínio de `listar_materias`.
    pub async fn listar_rotinas(&self) -> Result<Vec<Rotina>> {
        let rows = sqlx::query_as(&format!("SELECT {ROUTINE_COLUMNS} FROM study_routines ORDER BY name COLLATE NOCASE"))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows)
    }

    /// `atualizar_rotina`. Patch por `COALESCE`, mesma convenção de
    /// `atualizar_materia`.
    pub async fn atualizar_rotina(&self, rotina_id: Uuid, patch: RotinaPatchInput) -> Result<Rotina> {
        let name = patch.name.as_deref().map(validate_routine_name).transpose()?;
        if let Some(mask) = patch.default_weekdays.as_deref() {
            validate_weekdays_mask(mask)?;
        }

        let row = sqlx::query_as::<_, Rotina>(&format!(
            "UPDATE study_routines SET name = COALESCE($2, name), default_weekdays = COALESCE($3, default_weekdays) \
             WHERE id = $1 RETURNING {ROUTINE_COLUMNS}"
        ))
        .bind(rotina_id.db())
        .bind(&name)
        .bind(&patch.default_weekdays)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("rotina {rotina_id}")))?;

        Ok(row)
    }

    /// `remover_rotina`. `study_routine_items.routine_id` é `ON DELETE
    /// CASCADE` (ver a migração) — apagar a rotina apaga seus itens junto,
    /// nunca deixa órfão. Nunca toca em `study_plan_blocks`: a rotina é só o
    /// molde, dias já aplicados são linhas independentes (comentário de
    /// módulo, seção "rotina diária").
    pub async fn remover_rotina(&self, rotina_id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM study_routines WHERE id = $1").bind(rotina_id.db()).execute(&self.pool).await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("rotina {rotina_id}")));
        }
        Ok(())
    }

    /// `criar_item_de_rotina`. Sem `position`: a hora é a ordem (ver a
    /// migração) — ao contrário de `criar_bloco`, não há "próxima posição"
    /// para calcular.
    #[allow(clippy::too_many_arguments)]
    pub async fn criar_item_de_rotina(
        &self,
        rotina_id: Uuid,
        start_local_time: &str,
        minutos_planejados: i64,
        atividade: &str,
        pomodoro_cycles: Option<i64>,
        titulo: Option<String>,
        subject_id: Option<Uuid>,
    ) -> Result<ItemDeRotina> {
        validate_local_time(start_local_time)?;
        validate_planned_minutes(minutos_planejados)?;
        validate_activity(atividade)?;
        if let Some(cycles) = pomodoro_cycles {
            if cycles <= 0 {
                return Err(Error::Invalid("ciclos de pomodoro precisa ser maior que zero".into()));
            }
        }
        let title = validate_title(titulo)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, ItemDeRotina>(&format!(
            "INSERT INTO study_routine_items \
                 (id, routine_id, start_local_time, planned_minutes, activity, pomodoro_cycles, title, subject_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {ROUTINE_ITEM_COLUMNS}"
        ))
        .bind(id.db())
        .bind(rotina_id.db())
        .bind(start_local_time)
        .bind(minutos_planejados)
        .bind(atividade)
        .bind(pomodoro_cycles)
        .bind(&title)
        .bind(subject_id.db())
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// `listar_itens_de_rotina`. Ordenada por `start_local_time` — a hora É
    /// a ordem do dia (ver a migração), não há `position` para orquestrar.
    pub async fn listar_itens_de_rotina(&self, rotina_id: Uuid) -> Result<Vec<ItemDeRotina>> {
        let rows = sqlx::query_as(&format!(
            "SELECT {ROUTINE_ITEM_COLUMNS} FROM study_routine_items WHERE routine_id = $1 ORDER BY start_local_time"
        ))
        .bind(rotina_id.db())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// `atualizar_item_de_rotina`. Patch por `COALESCE`, mesma convenção de
    /// `atualizar_bloco` — inclusive a mesma limitação: não há como limpar
    /// de volta para `NULL` `pomodoroCycles`/`subjectId` através deste
    /// patch.
    pub async fn atualizar_item_de_rotina(&self, item_id: Uuid, patch: ItemDeRotinaPatchInput) -> Result<ItemDeRotina> {
        if let Some(start) = patch.start_local_time.as_deref() {
            validate_local_time(start)?;
        }
        if let Some(minutes) = patch.planned_minutes {
            validate_planned_minutes(minutes)?;
        }
        if let Some(activity) = patch.activity.as_deref() {
            validate_activity(activity)?;
        }
        if let Some(cycles) = patch.pomodoro_cycles {
            if cycles <= 0 {
                return Err(Error::Invalid("ciclos de pomodoro precisa ser maior que zero".into()));
            }
        }
        if let Some(title) = patch.title.as_deref() {
            validate_title_len(title)?;
        }

        let row = sqlx::query_as::<_, ItemDeRotina>(&format!(
            "UPDATE study_routine_items SET \
                 start_local_time = COALESCE($2, start_local_time), \
                 planned_minutes = COALESCE($3, planned_minutes), \
                 activity = COALESCE($4, activity), \
                 pomodoro_cycles = COALESCE($5, pomodoro_cycles), \
                 title = COALESCE($6, title), \
                 subject_id = COALESCE($7, subject_id) \
             WHERE id = $1 RETURNING {ROUTINE_ITEM_COLUMNS}"
        ))
        .bind(item_id.db())
        .bind(&patch.start_local_time)
        .bind(patch.planned_minutes)
        .bind(&patch.activity)
        .bind(patch.pomodoro_cycles)
        .bind(&patch.title)
        .bind(patch.subject_id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("item de rotina {item_id}")))?;

        Ok(row)
    }

    /// `remover_item_de_rotina`.
    pub async fn remover_item_de_rotina(&self, item_id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM study_routine_items WHERE id = $1")
            .bind(item_id.db())
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("item de rotina {item_id}")));
        }
        Ok(())
    }

    /// `aplicar_rotina`. Lê os itens de `rotina_id` (já ordenados por hora,
    /// ver [`listar_itens_de_rotina`]) e materializa um bloco real em
    /// `study_plan_blocks` para cada um, no dia pedido — ver a seção "rotina
    /// diária" do comentário de módulo para o porquê de nunca ser virtual.
    ///
    /// ASSINATURA PENSADA PARA AS FATIAS 2 E 3 (não implementadas aqui):
    ///
    /// - `data_inicio`/`data_fim` já são dois parâmetros, não um `dia`
    ///   único: a fatia 2 (aplicar a um intervalo) só precisa deixar de
    ///   exigir que sejam iguais — nenhum chamador desta função muda de
    ///   forma. Esta fatia aceita SÓ o caso `data_inicio == data_fim`
    ///   (`Error::Invalid` caso contrário) — um dia por vez.
    /// - `modo` já é [`ModoDeAplicacaoDeRotina`], não um booleano solto — a
    ///   fatia 3 (substituir) entra como uma segunda variante do mesmo enum,
    ///   com o próprio campo `incluir_hoje` do diálogo dentro dela; o
    ///   `match` interno ganha um braço novo, a assinatura não muda.
    /// - `hoje_local` já é obrigatório mesmo só um dia sendo aceito: é o
    ///   dado que decide a recusa abaixo, e a fatia 2 reusa exatamente esta
    ///   mesma comparação por dia dentro do laço do intervalo.
    ///
    /// TRANSACIONAL: todos os blocos do dia entram numa única transação —
    /// se a inserção de um item no meio do laço falhar (por exemplo um
    /// `CHECK` do banco), nenhum dos anteriores fica gravado. `tx.commit()`
    /// só roda depois do último `INSERT`; qualquer `?` antes disso derruba a
    /// função sem commitar, e o `Drop` do `Transaction` do sqlx dispara o
    /// `ROLLBACK`.
    ///
    /// IDEMPOTENTE: um dia que já tem QUALQUER bloco (da própria rotina, de
    /// outra, ou lançado à mão) é pulado inteiro e reportado em
    /// `dias_pulados` — nunca criado por cima, nunca duplicado. É o oposto
    /// deliberado de `copiar_semana` (não idempotente por decisão, ver seu
    /// comentário) — aqui a idempotência é o próprio contrato.
    pub async fn aplicar_rotina(
        &self,
        rotina_id: Uuid,
        data_inicio: &str,
        data_fim: &str,
        modo: ModoDeAplicacaoDeRotina,
        hoje_local: &str,
    ) -> Result<AplicacaoDeRotina> {
        let inicio = parse_local_date(data_inicio)?;
        let fim = parse_local_date(data_fim)?;
        parse_local_date(hoje_local)?;

        if inicio != fim {
            return Err(Error::Invalid(
                "aplicar a um intervalo de dias ainda não é suportado nesta fase; dataInicio e dataFim precisam ser o mesmo dia".into(),
            ));
        }
        // `hoje_local` e `data_inicio` são strings `YYYY-MM-DD` de largura
        // fixa: a comparação lexicográfica É a cronológica, mesma invariante
        // de `local_date` em `0024_cronograma.sql`.
        if data_inicio < hoje_local {
            return Err(Error::Invalid(format!(
                "não é possível aplicar rotina a um dia passado: {data_inicio} é anterior a hoje ({hoje_local})"
            )));
        }

        match modo {
            ModoDeAplicacaoDeRotina::PreencherDiasVazios => {}
        }

        let rotina_existe: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM study_routines WHERE id = $1").bind(rotina_id.db()).fetch_optional(&self.pool).await?;
        if rotina_existe.is_none() {
            return Err(Error::NotFound(format!("rotina {rotina_id}")));
        }

        let itens = self.listar_itens_de_rotina(rotina_id).await?;
        if itens.is_empty() {
            return Err(Error::Invalid(format!("rotina {rotina_id} não tem itens para aplicar")));
        }

        let mut tx = self.pool.begin().await?;

        let ja_tem_bloco: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM study_plan_blocks WHERE local_date = $1")
            .bind(data_inicio)
            .fetch_one(&mut *tx)
            .await?;

        if ja_tem_bloco > 0 {
            tx.commit().await?;
            return Ok(AplicacaoDeRotina {
                dias_aplicados: Vec::new(),
                dias_pulados: vec![DiaDeRotinaPulado {
                    data: data_inicio.to_string(),
                    motivo: "o dia já tem pelo menos um bloco planejado".into(),
                }],
                total_blocos_criados: 0,
            });
        }

        let mut criados = 0i64;
        for item in &itens {
            let nova_posicao = next_position_in_day_tx(&mut tx, data_inicio).await?;
            let novo_id = Uuid::now_v7();

            sqlx::query(
                "INSERT INTO study_plan_blocks \
                     (id, local_date, position, start_local_time, planned_minutes, activity, pomodoro_cycles, title, subject_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(novo_id.db())
            .bind(data_inicio)
            .bind(&nova_posicao)
            .bind(&item.start_local_time)
            .bind(item.planned_minutes)
            .bind(&item.activity)
            .bind(item.pomodoro_cycles)
            .bind(&item.title)
            .bind(item.subject_id.db())
            .execute(&mut *tx)
            .await?;

            criados += 1;
        }

        tx.commit().await?;

        Ok(AplicacaoDeRotina {
            dias_aplicados: vec![data_inicio.to_string()],
            dias_pulados: Vec::new(),
            total_blocos_criados: criados,
        })
    }
}

fn parse_local_date(raw: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|err| Error::Invalid(format!("data local inválida: {raw:?} ({err})")))
}

/// Como [`parse_local_date`], mais a exigência do contrato: início de semana
/// é sempre segunda-feira. `week_start_date` alimenta o `BETWEEN` de sete
/// dias e a herança de meta entre semanas — uma data fora do padrão
/// desalinharia os dois sem que nenhum `CHECK` do banco pegasse (a migração
/// não trava dia da semana, é decisão de app, não de schema).
fn parse_week_start(raw: &str) -> Result<NaiveDate> {
    let date = parse_local_date(raw)?;
    if date.weekday() != chrono::Weekday::Mon {
        return Err(Error::Invalid(format!(
            "início de semana precisa ser uma segunda-feira: {raw:?} é {:?}",
            date.weekday()
        )));
    }
    Ok(date)
}

fn validate_activity(activity: &str) -> Result<()> {
    if !VALID_ACTIVITIES.contains(&activity) {
        return Err(Error::Invalid(format!(
            "atividade inválida: {activity:?} (esperada uma de {VALID_ACTIVITIES:?})"
        )));
    }
    Ok(())
}

fn validate_local_time(raw: &str) -> Result<()> {
    NaiveTime::parse_from_str(raw, "%H:%M")
        .map(|_| ())
        .map_err(|err| Error::Invalid(format!("hora local inválida: {raw:?} ({err})")))
}

fn validate_planned_minutes(minutes: i64) -> Result<()> {
    if minutes <= 0 {
        return Err(Error::Invalid("minutos planejados precisa ser maior que zero".into()));
    }
    if minutes > MAX_PLANNED_MINUTES_PER_BLOCK {
        return Err(Error::Invalid(format!(
            "minutos planejados maior que um dia inteiro ({MAX_PLANNED_MINUTES_PER_BLOCK} minutos)"
        )));
    }
    Ok(())
}

fn validate_title_len(title: &str) -> Result<()> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(Error::Invalid(format!("título maior que {MAX_TITLE_CHARS} caracteres")));
    }
    Ok(())
}

/// `None` vira título vazio (o `DEFAULT ''` da coluna) — ver o comentário de
/// `title` na migração: ele existe mesmo sem `deckId`/`pageId`, então o valor
/// precisa ser gravado explicitamente pelo `INSERT`, não deixado para o
/// default do SQLite (este código sempre lista a coluna).
fn validate_title(titulo: Option<String>) -> Result<String> {
    let title = titulo.unwrap_or_default();
    validate_title_len(&title)?;
    Ok(title)
}

/// Não-vazio (depois de aparado) e dentro do teto — mesma forma de
/// [`validate_title_len`], mas o nome de uma matéria não tem um "vazio
/// legítimo" equivalente ao `title` opcional de um bloco: uma matéria sem
/// nome não serve pra nada numa lista de escolha.
fn validate_subject_name(nome: &str) -> Result<String> {
    let trimmed = nome.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("nome da matéria não pode ser vazio".into()));
    }
    if trimmed.chars().count() > MAX_SUBJECT_NAME_CHARS {
        return Err(Error::Invalid(format!("nome da matéria maior que {MAX_SUBJECT_NAME_CHARS} caracteres")));
    }
    Ok(trimmed.to_string())
}

fn validate_subject_color(color: &str) -> Result<()> {
    if !VALID_SUBJECT_COLORS.contains(&color) {
        return Err(Error::Invalid(format!(
            "cor de matéria inválida: {color:?} (esperada uma de {VALID_SUBJECT_COLORS:?})"
        )));
    }
    Ok(())
}

/// Como [`validate_subject_name`], mesma forma, mensagem própria — o nome
/// de uma rotina também não tem "vazio legítimo".
fn validate_routine_name(nome: &str) -> Result<String> {
    let trimmed = nome.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid("nome da rotina não pode ser vazio".into()));
    }
    if trimmed.chars().count() > MAX_ROUTINE_NAME_CHARS {
        return Err(Error::Invalid(format!("nome da rotina maior que {MAX_ROUTINE_NAME_CHARS} caracteres")));
    }
    Ok(trimmed.to_string())
}

/// Espelha o `CHECK` de `study_routines.default_weekdays` (7 caracteres,
/// cada um '0' ou '1', posição 1 = segunda) — validado aqui pelo mesmo
/// motivo de [`validate_activity`]: erro de IPC vira `Error::Invalid`
/// legível, não `Error::Database` opaco. `str::len()` conta bytes, não
/// `char`s, mas os únicos bytes válidos aqui são ASCII '0'/'1', então os
/// dois se equivalem.
fn validate_weekdays_mask(mask: &str) -> Result<()> {
    let valido = mask.len() == 7 && mask.bytes().all(|b| b == b'0' || b == b'1');
    if !valido {
        return Err(Error::Invalid(format!(
            "máscara de dias da semana inválida: {mask:?} (esperado 7 caracteres '0'/'1', posição 1 = segunda)"
        )));
    }
    Ok(())
}

/// Fim (`HH:MM`) e se atravessou a meia-noite, dado o início e a duração
/// planejada em minutos — pura, sem I/O. Ver o item 1 do comentário de
/// módulo para a decisão de derivar em vez de gravar.
///
/// `minutos_planejados` fora de `1..=MAX_PLANNED_MINUTES_PER_BLOCK` devolve
/// `Error::Invalid` em vez de estourar a construção do `TimeDelta` — esta
/// função não presume que só chega aqui valor já validado por
/// `validate_planned_minutes` (ela é `pub` e testada isoladamente).
///
/// MEIA-NOITE: um bloco iniciado às 23:30 com 90 minutos planejados termina,
/// em relógio de parede, às 01:00 — mas de qual dia? A resposta aqui é: o
/// horário devolvido é sempre o relógio de parede (`01:00`, nunca "dia
/// seguinte, 01:00"), e o `bool` avisa que houve virada. O bloco continua
/// pertencendo inteiro ao `local_date` em que começou (esta função não sabe
/// de datas, só de hora) — quem desenha a grade decide se corta a barra no
/// fim da última linha do dia ou se desenha uma continuação; este módulo não
/// tem opinião sobre pixel.
pub fn fim_local(inicio: NaiveTime, minutos_planejados: i64) -> Result<(NaiveTime, bool)> {
    if minutos_planejados <= 0 {
        return Err(Error::Invalid("duração precisa ser maior que zero minutos para calcular o fim".into()));
    }
    let delta = Duration::try_minutes(minutos_planejados).ok_or_else(|| {
        Error::Invalid(format!("duração fora de faixa para calcular o fim: {minutos_planejados} minutos"))
    })?;
    let (fim, segundos_ignorados) = inicio.overflowing_add_signed(delta);
    Ok((fim, segundos_ignorados != 0))
}

/// Preenche `end_local_time`/`crosses_midnight` a partir de
/// `start_local_time`/`planned_minutes` — chamado em toda saída deste módulo
/// que devolve um [`BlocoPlanejado`], para a regra valer sempre, e não só
/// onde alguém lembrar de chamar [`fim_local`] na mão.
fn with_derived_fields(mut bloco: BlocoPlanejado) -> Result<BlocoPlanejado> {
    let Some(inicio_raw) = bloco.start_local_time.as_deref() else {
        return Ok(bloco);
    };
    let inicio = NaiveTime::parse_from_str(inicio_raw, "%H:%M").map_err(|err| {
        Error::Invalid(format!("hora de início corrompida no banco: {inicio_raw:?} ({err})"))
    })?;
    let (fim, atravessa) = fim_local(inicio, bloco.planned_minutes)?;
    bloco.end_local_time = Some(fim.format("%H:%M").to_string());
    bloco.crosses_midnight = atravessa;
    Ok(bloco)
}

async fn next_position_in_day(pool: &SqlitePool, local_date: &str) -> Result<String> {
    let last: Option<String> = sqlx::query_scalar(
        "SELECT position FROM study_plan_blocks WHERE local_date = $1 ORDER BY position DESC LIMIT 1",
    )
    .bind(local_date)
    .fetch_optional(pool)
    .await?;

    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

/// Como [`next_position_in_day`], mas dentro de uma transação já aberta —
/// [`CronogramaRepository::copiar_semana`] insere vários blocos no mesmo dia
/// de destino em sequência, e cada um precisa ver a posição que o anterior
/// acabou de gravar (leitura fora da transação não veria o `INSERT` ainda
/// não commitado).
async fn next_position_in_day_tx(tx: &mut Transaction<'_, Sqlite>, local_date: &str) -> Result<String> {
    let last: Option<String> = sqlx::query_scalar(
        "SELECT position FROM study_plan_blocks WHERE local_date = $1 ORDER BY position DESC LIMIT 1",
    )
    .bind(local_date)
    .fetch_optional(&mut **tx)
    .await?;

    let last_index = last.as_deref().map(position::parse).transpose()?;
    position::between(last_index.as_ref(), None)
}

async fn fetch_bloco_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<BlocoPlanejado> {
    sqlx::query_as::<_, BlocoPlanejado>(&format!("SELECT {PLAN_BLOCK_COLUMNS} FROM study_plan_blocks WHERE id = $1"))
        .bind(id.db())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("bloco planejado {id}")))
}

async fn siblings_in_day_tx(
    tx: &mut Transaction<'_, Sqlite>,
    local_date: &str,
    exclude_id: Option<Uuid>,
) -> Result<Vec<(Uuid, String)>> {
    // Leitura escalar de par (id, position): `DbId` no lugar de `Uuid`,
    // convertido de volta ao devolver — ver `db::blocks::active_siblings_tx`,
    // mesmo desenho.
    let rows: Vec<(DbId, String)> = sqlx::query_as(
        "SELECT id, position FROM study_plan_blocks \
         WHERE local_date = $1 AND id IS DISTINCT FROM $2 ORDER BY position",
    )
    .bind(local_date)
    .bind(exclude_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, position)| (Uuid::from(id), position)).collect())
}

/// Mesmo par `neighbours_for`/`position_between` de `db::blocks`, reescrito
/// aqui porque aquelas funções são privadas ao módulo de blocos e o escopo
/// (irmãos de um `local_date`, não de `(page_id, parent_block_id)`) é
/// diferente o bastante para não valer a pena generalizar por um único
/// segundo uso.
fn neighbours_for(siblings: &[(Uuid, String)], apos_bloco_id: Option<Uuid>) -> Result<(Option<&str>, Option<&str>)> {
    match apos_bloco_id {
        None => Ok((None, siblings.first().map(|(_, p)| p.as_str()))),
        Some(after_id) => {
            let index = siblings
                .iter()
                .position(|(id, _)| *id == after_id)
                .ok_or_else(|| Error::Invalid("bloco de referência não é irmão ativo no dia de destino".into()))?;
            let before = siblings[index].1.as_str();
            let after = siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after))
        }
    }
}

fn position_between(siblings: &[(Uuid, String)], apos_bloco_id: Option<Uuid>) -> Result<String> {
    let (before_raw, after_raw) = neighbours_for(siblings, apos_bloco_id)?;
    let before = before_raw.map(position::parse).transpose()?;
    let after = after_raw.map(position::parse).transpose()?;
    position::between(before.as_ref(), after.as_ref())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn sibling(id: Uuid, pos: &str) -> (Uuid, String) {
        (id, pos.to_string())
    }

    #[test]
    fn parse_local_date_accepts_iso_and_rejects_garbage() {
        assert!(parse_local_date("2026-09-01").is_ok());
        assert!(parse_local_date("01/09/2026").is_err());
        assert!(parse_local_date("").is_err());
    }

    #[test]
    fn parse_week_start_accepts_a_monday_and_rejects_any_other_weekday() {
        // 2026-08-31 é uma segunda-feira.
        assert!(parse_week_start("2026-08-31").is_ok());
        // 2026-09-01 é terça.
        assert!(matches!(parse_week_start("2026-09-01"), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_activity_accepts_the_five_known_kinds_and_rejects_the_rest() {
        for kind in VALID_ACTIVITIES {
            assert!(validate_activity(kind).is_ok());
        }
        assert!(matches!(validate_activity("almoço"), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_planned_minutes_rejects_zero_and_more_than_a_day() {
        assert!(validate_planned_minutes(25).is_ok());
        assert!(matches!(validate_planned_minutes(0), Err(Error::Invalid(_))));
        assert!(matches!(validate_planned_minutes(-5), Err(Error::Invalid(_))));
        assert!(matches!(validate_planned_minutes(MAX_PLANNED_MINUTES_PER_BLOCK + 1), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_title_defaults_none_to_empty_string() {
        assert_eq!(validate_title(None).unwrap(), "");
        assert_eq!(validate_title(Some("Biologia".into())).unwrap(), "Biologia");
    }

    #[test]
    fn validate_subject_name_trims_rejects_blank_and_rejects_too_long() {
        assert_eq!(validate_subject_name("  Química  ").unwrap(), "Química");
        assert!(matches!(validate_subject_name(""), Err(Error::Invalid(_))));
        assert!(matches!(validate_subject_name("   "), Err(Error::Invalid(_))));
        let longo = "x".repeat(MAX_SUBJECT_NAME_CHARS + 1);
        assert!(matches!(validate_subject_name(&longo), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_subject_color_accepts_the_eight_palette_keys_and_rejects_the_rest() {
        for cor in VALID_SUBJECT_COLORS {
            assert!(validate_subject_color(cor).is_ok());
        }
        assert!(matches!(validate_subject_color("#ff0000"), Err(Error::Invalid(_))));
        assert!(matches!(validate_subject_color("red"), Err(Error::Invalid(_))));
    }

    #[test]
    fn fim_local_adds_the_planned_minutes_within_the_same_day() {
        let inicio = NaiveTime::parse_from_str("08:00", "%H:%M").unwrap();
        let (fim, atravessa) = fim_local(inicio, 60).unwrap();
        assert_eq!(fim.format("%H:%M").to_string(), "09:00");
        assert!(!atravessa);
    }

    /// O caso central do item 1 do comentário de módulo: início 23:45 mais
    /// 30 minutos termina, em relógio de parede, às 00:15 — do dia seguinte,
    /// por isso a flag.
    #[test]
    fn fim_local_crossing_midnight_wraps_the_clock_and_flags_it() {
        let inicio = NaiveTime::parse_from_str("23:45", "%H:%M").unwrap();
        let (fim, atravessa) = fim_local(inicio, 30).unwrap();
        assert_eq!(fim.format("%H:%M").to_string(), "00:15");
        assert!(atravessa);
    }

    /// Borda que o tipo permite (`MAX_PLANNED_MINUTES_PER_BLOCK` = um dia
    /// inteiro) mas o caminho feliz normal não vê: um bloco de 24h volta
    /// exatamente ao horário de início, e ainda assim atravessou a
    /// meia-noite — não é o mesmo caso que "não atravessou nada".
    #[test]
    fn fim_local_a_full_day_block_wraps_back_to_the_same_clock_time_and_still_crosses() {
        let inicio = NaiveTime::parse_from_str("00:00", "%H:%M").unwrap();
        let (fim, atravessa) = fim_local(inicio, 24 * 60).unwrap();
        assert_eq!(fim.format("%H:%M").to_string(), "00:00");
        assert!(atravessa);
    }

    #[test]
    fn fim_local_rejects_zero_and_negative_minutes() {
        let inicio = NaiveTime::parse_from_str("10:00", "%H:%M").unwrap();
        assert!(matches!(fim_local(inicio, 0), Err(Error::Invalid(_))));
        assert!(matches!(fim_local(inicio, -5), Err(Error::Invalid(_))));
    }

    #[test]
    fn with_derived_fields_leaves_a_block_without_a_start_time_untouched() {
        let bloco = BlocoPlanejado {
            id: Uuid::now_v7(),
            local_date: "2026-08-31".into(),
            position: position::first(),
            start_local_time: None,
            planned_minutes: 30,
            activity: "reading".into(),
            pomodoro_cycles: None,
            title: String::new(),
            deck_id: None,
            page_id: None,
            subject_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            end_local_time: None,
            crosses_midnight: false,
        };

        let resultado = with_derived_fields(bloco).unwrap();

        assert!(resultado.end_local_time.is_none());
        assert!(!resultado.crosses_midnight);
    }

    #[test]
    fn validate_title_rejects_text_past_the_length_cap() {
        let longo = "x".repeat(MAX_TITLE_CHARS + 1);
        assert!(matches!(validate_title(Some(longo)), Err(Error::Invalid(_))));
    }

    #[test]
    fn neighbours_for_none_is_open_below_the_current_first() {
        let a = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        let (before, after) = neighbours_for(&siblings, None).unwrap();

        assert_eq!(before, None);
        assert_eq!(after, Some("10"));
    }

    #[test]
    fn neighbours_for_after_sits_between_the_named_sibling_and_the_next() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let siblings = vec![sibling(a, "10"), sibling(b, "20")];

        let (before, after) = neighbours_for(&siblings, Some(a)).unwrap();

        assert_eq!(before, Some("10"));
        assert_eq!(after, Some("20"));
    }

    #[test]
    fn neighbours_for_after_an_unknown_sibling_is_rejected() {
        let a = Uuid::now_v7();
        let stranger = Uuid::now_v7();
        let siblings = vec![sibling(a, "10")];

        assert!(neighbours_for(&siblings, Some(stranger)).is_err());
    }

    #[test]
    fn neighbours_for_on_an_empty_day_has_no_bounds() {
        let siblings: Vec<(Uuid, String)> = Vec::new();
        assert_eq!(neighbours_for(&siblings, None).unwrap(), (None, None));
    }

    #[test]
    fn position_between_produces_a_value_strictly_inside_the_gap() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let low = position::first();
        let high = position::between(Some(&position::parse(&low).unwrap()), None).unwrap();
        let siblings = vec![sibling(a, &low), sibling(b, &high)];

        let placed = position_between(&siblings, Some(a)).unwrap();

        assert!(placed.as_str() > low.as_str());
        assert!(placed.as_str() < high.as_str());
    }
}
