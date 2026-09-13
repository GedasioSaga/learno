//! A fila de estudo (Fase 4, Peça 3): liga o agendador puro de `crate::srs`
//! ao banco — `deck_counts`, `next_card`, `answer_card`, `deck_forecast`.
//!
//! Este módulo NÃO é dono de `decks`/`notes`/`note_types` (CRUD dessas
//! tabelas é de `db::decks`/`db::notes`, peça em paralelo) — só lê o
//! suficiente delas para montar a fila e responder um cartão, e reusa
//! `db::notes::NoteRow` em vez de duplicar o tipo.
//!
//! `crate::srs` (agendador SM-2 puro) também é de outra peça, publicada em
//! paralelo a esta: `agendar` não conhece JSON nem `String` de IPC, então a
//! ponte — desserializar `decks.options` em [`crate::srs::OpcoesDeDeck`]
//! ([`OpcoesDeDeckJson`]/[`parse_opcoes_de_deck`]) e traduzir a nota do
//! frontend em [`crate::srs::Avaliacao`] ([`avaliacao_da_string`]) — é
//! responsabilidade deste arquivo, exatamente como o comentário de módulo de
//! `crate::srs` prevê ("quem traduzir a `String` do frontend... é outra
//! peça").
//!
//! Três decisões de design que o pedido desta peça exige registrar:
//!
//! 1. **Ordem e limite da fila** (evitando os dois defeitos clássicos —
//!    `next_card` sempre devolvendo o mesmo cartão, ou nunca mostrando
//!    novos): prioridade estrita "aprendendo pronto agora" > "revisão do
//!    dia" > "novo", nessa ordem, e só dentro de cada categoria por
//!    `due`/`created_at` crescente — nunca aleatório, para que dois pedidos
//!    seguidos sem responder o cartão devolvam o mesmo (comportamento
//!    esperado), mas responder sempre avança a fila (o cartão respondido sai
//!    do topo porque seu `due`/`state` mudou). Cartões novos por dia têm um
//!    teto fixo ([`LIMITE_NOVOS_POR_DIA`]) contado por `review_log` — ver o
//!    comentário da constante para por que o teto é uma constante nesta
//!    peça, e não uma chave em `decks.options`.
//! 2. **"Hoje" é local, `due` é UTC (invariante I5)**: [`inicio_do_dia_local_em_utc`]
//!    é a única função que faz essa conversão, usando o fuso do SISTEMA
//!    (mesma escolha de `ipc::formula_commands::format_local_i5`) — um
//!    cartão que vence às 23h de terça em São Paulo vence terça na fila
//!    desta função, nunca quarta só porque em UTC já virou o dia.
//! 3. **Escrita atômica**: `answer_card` grava `cards`, insere em
//!    `review_log` E credita XP (`db::gamificacao::GamificacaoRepository::creditar_xp_na_transacao`)
//!    na MESMA transação — sem isso uma queda de energia entre as escritas
//!    deixaria o cartão reagendado sem nenhuma linha de histórico
//!    correspondente (e toda estatística que lê `review_log` mentiria), ou
//!    reagendado sem a contrapartida de XP. `db::cards` passa a depender de
//!    `db::gamificacao` por causa disto — o custo aceito para que "responder
//!    um cartão dá XP" seja garantido pela escrita em si, não por uma tela
//!    lembrar de pedir (ver o comentário de módulo de `db::gamificacao`).
//!
//! Cartão suspenso (`suspended_at IS NOT NULL` — inclusive os que
//! `NoteRepository::delete` suspende ao apagar a nota) ou enterrado
//! (`buried_until` no futuro) nunca entra na fila nem pode ser respondido —
//! todo método abaixo filtra ou checa os dois.

use std::collections::HashMap;

use chrono::{DateTime, Days, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::gamificacao::{GamificacaoRepository, XP_POR_REVISAO_CARTAO};
use crate::db::cloze::{segment_cloze, ClozeSegment};
use crate::db::ids::{DbId, IdBind};
use crate::db::notes::{NoteRow, NOTE_TYPE_KIND_CLOZE};
use crate::error::{Error, Result};
use crate::srs::{fsrs, Agendador, Avaliacao, EstadoDoCartao, Fase, OpcoesDeDeck};

/// Quantos cartões novos `next_card`/`deck_counts` introduzem por dia local,
/// por escopo de baralho consultado.
///
/// É uma CONSTANTE nesta peça, não uma chave lida de `decks.options`: aquele
/// JSON é compartilhado por referência com o preset de agendamento de
/// `crate::srs` (`OpcoesDeDeck`, Peça 1), e as duas peças escrevendo chaves
/// diferentes no mesmo blob sem se coordenar seria exatamente o tipo de
/// colisão que vale a pena evitar. Tornar isto configurável é trabalho de
/// Fase 6, quando `options` tiver um dono único de schema.
const LIMITE_NOVOS_POR_DIA: i64 = 20;

/// Teto de `dias` que `deck_forecast` aceita — entrada de comando IPC é
/// hostil, e `dias` dimensiona diretamente um `Vec` (`baldes`, abaixo); sem
/// teto, um `dias` gigante seria uma alocação arbitrária vinda de um script
/// na WebView. Dez anos é generoso para qualquer gráfico de previsão real.
const DECK_FORECAST_DIAS_MAXIMO: i64 = 3650;

/// Limiar de "maduro" que `deck_maturity` usa — CONVENÇÃO DO ANKI, não um
/// número escolhido por esta peça: no Anki, um cartão em `review` com
/// intervalo de **21 dias ou mais** é classificado "mature" (visível na
/// coluna "Card State"/`is:mature` do Browse, e nas estatísticas de
/// "Card Counts" do próprio app) — abaixo disso é "young". Este projeto
/// reusa o mesmo corte em vez de inventar outro: é a definição que qualquer
/// usuário vindo do Anki já reconhece, e não há uma segunda convenção de
/// mercado para "cartão maduro" para justificar um número diferente.
const INTERVALO_MADURO_DIAS: i64 = 21;

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub note_id: Uuid,
    /// Índice em `note_types.templates` para um tipo de nota PADRÃO
    /// (`note_types.kind = 'standard'`); NÚMERO DE LACUNA `cN` para um tipo
    /// CLOZE (`kind = 'cloze'`, `{{cN::texto}}` — ver `db::cloze`). O mesmo
    /// campo, dois significados — nunca ambíguo por LINHA, porque todo
    /// cartão pertence a exatamente uma nota, que pertence a exatamente um
    /// tipo de nota, cujo `kind` é fixo: quem lê este valor sempre sabe qual
    /// dos dois está vendo consultando `note_types.kind` daquela nota.
    ///
    /// DECISÃO — reusar em vez de abrir uma coluna nova
    /// (`cloze_number`, digamos): `UNIQUE (note_id, template_ordinal)`
    /// (`0011_notes_cards.sql`) já impede duas linhas para o mesmo (nota,
    /// ordinal) — exatamente a garantia que cloze também precisa (a lacuna
    /// número N nunca pode ter dois cartões). Uma coluna dedicada teria que
    /// reconstruir essa MESMA restrição do zero (uma segunda `UNIQUE`
    /// condicional, só quando o tipo é cloze); reusar herda a garantia de
    /// graça, sem migração de schema nenhuma além de `note_types.kind`
    /// (`0040_note_types_kind.sql`). O custo aceito: quem ler
    /// `template_ordinal` sem ver este comentário vê só um inteiro sem
    /// contexto — por isso ele mora aqui, no ÚNICO lugar onde toda leitura
    /// de `CardRow` passa, e não só em `db::notes` (que grava, mas não é o
    /// único módulo que lê este campo — este arquivo também lê, em
    /// `CardToStudy`).
    pub template_ordinal: i64,
    #[sqlx(try_from = "DbId")]
    pub deck_id: Uuid,
    pub state: String,
    pub due: Option<DateTime<Utc>>,
    pub scheduler: String,
    pub interval_days: i64,
    pub ease_factor: i64,
    pub fsrs_stability: Option<f64>,
    pub fsrs_difficulty: Option<f64>,
    /// Fonte de verdade DEDICADA de `crate::srs::fsrs::Memoria::ultima_revisao`
    /// — `NULL` até a primeira resposta sob FSRS, escrita só por
    /// `CardRepository::answer_card` (nunca por `updated_at`, que qualquer
    /// `UPDATE` nesta tabela também toca — ver `0039_cards_fsrs_last_review_at.sql`).
    pub fsrs_last_review_at: Option<DateTime<Utc>>,
    pub learning_step: i64,
    pub lapses: i64,
    pub reps: i64,
    pub is_leech: bool,
    pub flags: i64,
    pub suspended_at: Option<DateTime<Utc>>,
    pub buried_until: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `next_card()` do contrato de IPC: `{ card, note, fields, deckName }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardToStudy {
    pub card: CardRow,
    pub note: NoteRow,
    /// Os campos do cartão chaveados pelo NOME do campo. Todo nome listado
    /// em [`Self::field_names`] existe aqui; um campo sem valor gravado vem
    /// como `""`, nunca ausente. Ver [`campos_ordenados`].
    pub fields: HashMap<String, String>,
    /// Os nomes na ordem de `note_types.fields` — `field_names[0]` é a frente.
    ///
    /// O mapa acima dá o acesso por nome e perde a ordem; esta lista devolve
    /// a ordem. Os dois vêm da mesma passada, então não podem discordar.
    pub field_names: Vec<String>,
    pub deck_name: String,
    /// `Some` se e só se o tipo da nota é cloze (`note_types.kind =
    /// 'cloze'`): o primeiro campo (`field_names[0]`, a marcação
    /// `{{cN::...}}`) já quebrado em segmentos para a lacuna deste cartão
    /// (`card.template_ordinal`, que para cloze É o número da lacuna — ver
    /// [`CardRow::template_ordinal`]). `None` para todo tipo padrão.
    ///
    /// É o backend que renderiza, de propósito — a decisão "uma gramática
    /// só" está documentada no topo de `db::cloze`. A tela não interpreta
    /// `{{...}}`; ela lê esta lista. Para o TypeScript, `Some` é o
    /// discriminador de "este cartão é cloze": vem da mesma coluna `kind`
    /// que a store carrega, mas chega JUNTO com o cartão, sem a janela de
    /// corrida entre `nextCard` e `listNoteTypes`.
    pub cloze: Option<Vec<ClozeSegment>>,
}

/// `deck_counts()` do contrato de IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCounts {
    pub novos: i64,
    pub aprendendo: i64,
    pub revisar: i64,
}

/// `deck_maturity()` do contrato de IPC: quanto de UM baralho (`deck_id`
/// exato — sem descer para subbaralhos, ao contrário de `deck_counts`/
/// `next_card`/`deck_forecast`, porque "este baralho está maduro" e "esta
/// trilha, que anexa este `deck_id` específico, está madura" são a mesma
/// pergunta, e a Trilha aponta para um baralho por id, não para uma árvore)
/// já foi de fato aprendido, para a peça de Trilha que vai decidir se uma
/// etapa pode ser considerada dominada.
///
/// `maduros + jovens + novos + suspensos` pode ser MENOR que `total`:
/// cartões em `state = 'learning'` (primeira aprendizagem, ainda não
/// chegaram a `review` nem uma vez) não caem em nenhum dos quatro — não são
/// "novos" (já foram respondidos ao menos uma vez) nem "jovens" (a definição
/// pedida para esta peça é literalmente "em revisão/reaprendizado", e
/// `learning` não é nenhum dos dois). Ver o comentário de
/// `CardRepository::deck_maturity` para por que isso é a leitura mais
/// simples do pedido, e não um bug: o `learning` residual ainda entra no
/// TOTAL e no denominador de `fracao_maduros`, então um baralho cheio de
/// cartões em primeira aprendizagem não aparenta estar mais maduro do que é.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckMaturity {
    /// Todo cartão do baralho, qualquer `state` — inclusive `suspended` e
    /// `learning` (ver o comentário acima sobre por que os quatro campos
    /// abaixo nem sempre somam a este total).
    pub total: i64,
    /// `state = 'review'` com `interval_days >= INTERVALO_MADURO_DIAS`.
    pub maduros: i64,
    /// `state IN ('review', 'relearning')` com `interval_days <
    /// INTERVALO_MADURO_DIAS` — um cartão em `relearning` sempre tem
    /// `interval_days = 0` enquanto dura o relapso (`crate::srs` grava
    /// `interval_dias: 0` explicitamente nos dois agendadores ao entrar em
    /// reaprendizagem), então ele cai aqui por construção, nunca em
    /// `maduros`, mesmo que o intervalo anterior ao lapso fosse alto.
    pub jovens: i64,
    /// `state = 'new'` — nunca respondido.
    pub novos: i64,
    /// `state = 'suspended'`.
    pub suspensos: i64,
    /// `maduros / (total - suspensos)`, ou `0.0` (nunca `NaN`) quando esse
    /// denominador é zero (baralho vazio, ou 100% suspenso). Ver a decisão
    /// de excluir suspensos do denominador no comentário de
    /// `CardRepository::deck_maturity`.
    pub fracao_maduros: f64,
}

/// `answer_card()` do contrato de IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerOutcome {
    pub proxima_revisao: DateTime<Utc>,
    pub intervalo_dias: i64,
    pub estado: String,
}

/// Um dia de `deck_forecast()`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiaPrevisto {
    /// `"YYYY-MM-DD"`, calendário LOCAL — ver o comentário de módulo sobre I5.
    pub data: String,
    pub quantidade: i64,
}

/// Resolve o "escopo" de baralhos de uma consulta numa CTE recursiva só, sem
/// round-trip prévio para juntar ids em Rust. Quando `$1` é um id, o escopo é
/// ele mesmo + seus descendentes ativos — Anki estuda um baralho pai junto
/// com seus subbaralhos, e este projeto segue o mesmo hábito (decisão que
/// `db::decks` deliberadamente deixou para "quem implementar aquele lado do
/// contrato" — ver o comentário de módulo de `db::decks`). Quando `$1` é
/// nulo, a âncora vira "toda raiz ativa" e a mesma recursão desce a árvore
/// inteira a partir de cada raiz, cobrindo todo baralho ativo SEM duplicar
/// linha — cada baralho tem exatamente um caminho até sua raiz numa árvore
/// bem formada, então o `UNION ALL` nunca visita o mesmo id duas vezes.
const ESCOPO_BARALHOS_CTE: &str = "WITH RECURSIVE escopo AS ( \
     SELECT id FROM decks WHERE deleted_at IS NULL AND parent_id IS NULL AND $1 IS NULL \
     UNION ALL \
     SELECT id FROM decks WHERE deleted_at IS NULL AND id = $1 AND $1 IS NOT NULL \
     UNION ALL \
     SELECT d.id FROM decks d JOIN escopo e ON d.parent_id = e.id WHERE d.deleted_at IS NULL \
 )";

const CAMPOS_CARD_ROW: &str = "id, note_id, template_ordinal, deck_id, state, due, scheduler, interval_days, \
     ease_factor, fsrs_stability, fsrs_difficulty, fsrs_last_review_at, learning_step, lapses, reps, is_leech, flags, \
     suspended_at, buried_until, created_at, updated_at";

pub struct CardRepository {
    pool: SqlitePool,
}

impl CardRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// `deck_counts`: quantos cartões cada categoria tem prontos para HOJE
    /// (fuso local), respeitando o teto diário de novos. `aprendendo` e
    /// `revisar` contam tudo que vence até o fim do dia local — não só o que
    /// já está pronto neste segundo — para o badge da UI mostrar a carga do
    /// dia inteiro; `next_card` (abaixo) é mais estrito e só entrega um
    /// cartão de aprendizado quando o `due` de fato já passou.
    pub async fn deck_counts(&self, deck_id: Option<Uuid>) -> Result<DeckCounts> {
        let agora = Utc::now();
        let inicio_de_amanha = inicio_do_dia_local_em_utc(agora, 1);

        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT \
                 COALESCE(SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN state IN ('learning', 'relearning') AND due IS NOT NULL AND due < $2 THEN 1 ELSE 0 END), 0), \
                 COALESCE(SUM(CASE WHEN state = 'review' AND due IS NOT NULL AND due < $2 THEN 1 ELSE 0 END), 0) \
             FROM cards \
             WHERE deck_id IN (SELECT id FROM escopo) \
               AND suspended_at IS NULL \
               AND (buried_until IS NULL OR buried_until <= $3)"
        );
        let (novos_total, aprendendo, revisar): (i64, i64, i64) = sqlx::query_as(&sql)
            .bind(deck_id.db())
            .bind(formatar_timestamp(inicio_de_amanha))
            .bind(formatar_timestamp(agora))
            .fetch_one(&self.pool)
            .await?;

        let estudados_hoje = self.novos_estudados_hoje(deck_id, agora).await?;
        let novos = (LIMITE_NOVOS_POR_DIA - estudados_hoje).max(0).min(novos_total);

        Ok(DeckCounts { novos, aprendendo, revisar })
    }

    /// `deck_maturity`: quanto de UM baralho específico (`deck_id` exato, sem
    /// escopo de subbaralhos — ver o comentário de [`DeckMaturity`]) já
    /// amadureceu. Erra com `Error::NotFound` se `deck_id` não existir —
    /// mesma convenção de `DeckRepository::get` (lê "independente de estar
    /// na lixeira", sem filtrar `deleted_at`; um baralho na lixeira ainda tem
    /// maturidade real, só não aparece na árvore).
    ///
    /// DECISÃO — denominador de `fracao_maduros` exclui suspensos: um cartão
    /// suspenso não está sendo aprendido nem esquecido, é uma pausa
    /// deliberada do usuário; contá-lo no denominador penalizaria a fração
    /// por uma escolha do usuário, não por desempenho de memória. O custo
    /// aceito: um baralho quase todo suspenso mostra uma fração alta com base
    /// em poucos cartões — aceitável porque `total`/`suspensos` continuam
    /// expostos para quem quiser essa nuance.
    pub async fn deck_maturity(&self, deck_id: Uuid) -> Result<DeckMaturity> {
        let existe: Option<i64> = sqlx::query_scalar("SELECT 1 FROM decks WHERE id = $1")
            .bind(deck_id.db())
            .fetch_optional(&self.pool)
            .await?;
        if existe.is_none() {
            return Err(Error::NotFound(format!("baralho {deck_id}")));
        }

        let sql = "SELECT \
                COUNT(*), \
                COALESCE(SUM(CASE WHEN state = 'review' AND interval_days >= $2 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state IN ('review', 'relearning') AND interval_days < $2 THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN state = 'suspended' THEN 1 ELSE 0 END), 0) \
             FROM cards WHERE deck_id = $1";
        let (total, maduros, jovens, novos, suspensos): (i64, i64, i64, i64, i64) = sqlx::query_as(sql)
            .bind(deck_id.db())
            .bind(INTERVALO_MADURO_DIAS)
            .fetch_one(&self.pool)
            .await?;

        let denominador = total - suspensos;
        let fracao_maduros = if denominador > 0 {
            // Alargamento para calcular uma RAZÃO de exibição, nunca
            // realimentado numa soma/média posterior — contagem de cartões
            // neste app fica a ordens de grandeza de distância de 2^53 (onde
            // `f64` deixaria de representar todo `i64` com exatidão), então
            // não há perda de precisão prática neste `as`.
            maduros as f64 / denominador as f64
        } else {
            0.0
        };

        Ok(DeckMaturity { total, maduros, jovens, novos, suspensos, fracao_maduros })
    }

    /// `next_card`: o próximo cartão a estudar, ou `None` quando a fila está
    /// vazia (nada pronto, nada vencendo hoje, e ou não há cartão novo ou o
    /// teto diário já foi atingido).
    pub async fn next_card(&self, deck_id: Option<Uuid>) -> Result<Option<CardToStudy>> {
        let agora = Utc::now();

        let candidato = match self.buscar_pronto_agora(deck_id, agora).await? {
            Some(card) => Some(card),
            None => match self.buscar_revisao_do_dia(deck_id, agora).await? {
                Some(card) => Some(card),
                None => {
                    let estudados_hoje = self.novos_estudados_hoje(deck_id, agora).await?;
                    if estudados_hoje >= LIMITE_NOVOS_POR_DIA {
                        None
                    } else {
                        self.buscar_novo(deck_id, agora).await?
                    }
                }
            },
        };

        match candidato {
            Some(card) => self.montar_card_to_study(card).await.map(Some),
            None => Ok(None),
        }
    }

    /// `answer_card`: aplica `crate::srs::agendar` e grava o resultado — o
    /// novo estado do cartão e a linha de `review_log` correspondente — numa
    /// única transação (ver ponto 3 do comentário de módulo).
    pub async fn answer_card(&self, card_id: Uuid, rating: &str) -> Result<AnswerOutcome> {
        let nota = avaliacao_da_string(rating)?;
        let agora = Utc::now();

        let mut tx = self.pool.begin().await?;

        let card = sqlx::query_as::<_, CardRow>(&format!("SELECT {CAMPOS_CARD_ROW} FROM cards WHERE id = $1"))
            .bind(card_id.db())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| Error::NotFound(format!("cartão {card_id}")))?;

        if card.suspended_at.is_some() {
            return Err(Error::Invalid("cartão suspenso não pode ser respondido".into()));
        }
        if card.buried_until.is_some_and(|ate| ate > agora) {
            return Err(Error::Invalid("cartão enterrado não pode ser respondido antes do prazo".into()));
        }

        let fase_atual = fase_da_string(&card.state)?;
        let opcoes = fetch_deck_options(&mut tx, card.deck_id).await?;
        let semente = semente_do_fuzz(card_id, agora);

        // Despacha pelo `scheduler` GRAVADO NO CARTÃO, nunca pelo que o
        // baralho está configurado a usar agora — é isso que resolve a
        // decisão de migração deste arquivo (ver o comentário logo abaixo,
        // no braço "fsrs"): um cartão nasce com um agendador
        // (`db::notes::insert_card`) e morre com ele, mesmo que o baralho
        // troque de preset no meio do caminho.
        let resposta: RespostaAgendada = match card.scheduler.as_str() {
            "sm2" => {
                let ease_factor = i32::try_from(card.ease_factor)
                    .map_err(|_| Error::Invalid(format!("fator de facilidade corrompido no cartão {card_id}")))?;
                let learning_step = u32::try_from(card.learning_step)
                    .map_err(|_| Error::Invalid(format!("passo de aprendizado corrompido no cartão {card_id}")))?;
                let lapses = u32::try_from(card.lapses)
                    .map_err(|_| Error::Invalid(format!("contagem de lapsos corrompida no cartão {card_id}")))?;

                let estado_atual = EstadoDoCartao {
                    fase: fase_atual,
                    interval_dias: card.interval_days,
                    ease_factor,
                    learning_step,
                    lapses,
                };
                let proximo = crate::srs::agendar(&estado_atual, nota, &opcoes, agora, semente);

                RespostaAgendada {
                    estado_str: fase_para_string(proximo.estado.fase),
                    proxima_revisao: proximo.proxima_revisao,
                    interval_dias: proximo.estado.interval_dias,
                    ease_factor: i64::from(proximo.estado.ease_factor),
                    learning_step: i64::from(proximo.estado.learning_step),
                    lapses: i64::from(proximo.estado.lapses),
                    is_leech: card.is_leech || proximo.tornou_leech,
                    // SM-2 não toca a memória FSRS — passa os valores antigos
                    // adiante intocados (quase sempre `None`, a menos que
                    // este cartão já tenha sido FSRS um dia — ver a decisão
                    // do braço "fsrs" abaixo).
                    fsrs_stability: card.fsrs_stability,
                    fsrs_difficulty: card.fsrs_difficulty,
                    fsrs_last_review_at: card.fsrs_last_review_at,
                    scheduler: "sm2",
                }
            }
            "fsrs" => {
                // DECISÃO DE MIGRAÇÃO SM-2 → FSRS (pedida pela tarefa desta
                // peça): um cartão que JÁ EXISTE e já tem histórico continua
                // no agendador com que nasceu — `cards.scheduler` só é
                // gravado uma vez, na criação (`db::notes::insert_card`), e
                // nunca reescrito por trocar `decks.options.agendador`
                // depois. Mudar o preset do baralho para FSRS afeta só
                // cartão criado DAQUI PRA FRENTE; o cartão SM-2 antigo
                // termina a vida dele em SM-2.
                //
                // Alternativa descartada: DERIVAR uma `Memoria` FSRS
                // plausível a partir do estado SM-2 (`ease_factor`,
                // `interval_days`, `lapses`) na hora em que o cartão
                // encontrasse `scheduler = 'fsrs'` pela primeira vez. Rejeitada
                // porque não existe uma fórmula de conversão testável contra
                // NENHUMA referência — nem `py-fsrs` (o vetor dourado desta
                // peça) nem o Anki de verdade documentam publicamente uma
                // regra "SM-2 ease/interval → FSRS stability/difficulty"
                // única; qualquer heurística inventada aqui seria uma
                // segunda fonte de comportamento não verificável, exatamente
                // o oposto do padrão que `fsrs.rs` estabelece (fórmula a
                // fórmula contra referência). "Nunca corrompe" com "não
                // migra" é a leitura mais simples da regra dura desta
                // tarefa; a leitura "converte" fica para quando alguém tiver
                // uma fórmula de conversão para verificar contra alguma
                // referência.
                //
                // Isto NUNCA é alcançado por um cartão SM-2 existente: este
                // branch só roda quando `card.scheduler == "fsrs"`, e essa
                // coluna não muda sozinha — só existe aqui porque
                // `db::notes::insert_card` já gravou `scheduler = 'fsrs'` no
                // nascimento do cartão. A prova em teste:
                // `tests/db_cards.rs::trocar_o_baralho_para_fsrs_nao_migra_cartao_sm2_existente_so_afeta_o_novo`.
                let learning_step = if fase_atual == Fase::Review {
                    None
                } else {
                    Some(u32::try_from(card.learning_step).map_err(|_| {
                        Error::Invalid(format!("passo de aprendizado corrompido no cartão {card_id}"))
                    })?)
                };
                // `ultima_revisao` vem de `cards.fsrs_last_review_at` — uma
                // coluna DEDICADA (`0039_cards_fsrs_last_review_at.sql`),
                // NUNCA de `card.updated_at`. `updated_at` é escrito pelo
                // trigger `cards_set_updated_at` em QUALQUER `UPDATE` nesta
                // tabela, não só numa revisão — hoje só `answer_card` e o
                // soft-delete de nota tocam uma linha respondível, mas
                // `buried_until` já é lido por `next_card`/`deck_counts`/
                // `deck_forecast` sem nenhum comando ainda escrevendo nele; o
                // dia em que "enterrar cartão" (ou mover de baralho) existir
                // e tocar um cartão FSRS por fora daqui, ler `updated_at`
                // contaria `elapsed_days` a partir daquele toque em vez da
                // última revisão real — sem erro nenhum, só uma estabilidade/
                // dificuldade errada na resposta seguinte. Prova em teste:
                // `tests/db_cards.rs::responder_um_cartao_fsrs_duas_vezes_usa_a_ultima_revisao_real_nao_um_toque_qualquer_na_linha`.
                let memoria = match (card.fsrs_stability, card.fsrs_difficulty, card.fsrs_last_review_at) {
                    (Some(estabilidade), Some(dificuldade), Some(ultima_revisao)) => {
                        Some(fsrs::Memoria { estabilidade, dificuldade, ultima_revisao })
                    }
                    // Nem todos os três presentes é estado corrompido/
                    // impossível (decisão 3 de `crate::srs::fsrs`: os três
                    // campos sempre nascem juntos, gravados na mesma
                    // `UPDATE` — ver abaixo) — tratar como "cartão nunca
                    // revisado sob FSRS" é mais seguro que inventar o valor
                    // que falta.
                    _ => None,
                };
                let estado_atual = fsrs::EstadoCartao { fase: fase_atual, step: learning_step, memoria };
                let parametros = parametros_fsrs_de_opcoes(&opcoes);
                let proximo = fsrs::agendar(&estado_atual, nota, &parametros, agora, semente);
                // `fsrs::agendar` sempre devolve `memoria: Some(..)` em
                // qualquer um dos seus braços (ver `fsrs.rs`) — o
                // `ok_or_else` é defesa contra um invariante interno daquele
                // módulo mudar sem que este arquivo perceba, não um caminho
                // que hoje é alcançável.
                let nova_memoria = proximo
                    .estado
                    .memoria
                    .ok_or_else(|| Error::Invalid(format!("agendador FSRS não produziu memória para o cartão {card_id}")))?;

                RespostaAgendada {
                    estado_str: fase_para_string(proximo.estado.fase),
                    proxima_revisao: proximo.proxima_revisao,
                    // Espelha o braço SM-2 (`agendar_em_aprendizagem`/
                    // `agendar_em_reaprendizagem` em `crate::srs`, que gravam
                    // `interval_dias: 0` explicitamente): `interval_dias` só
                    // tem sentido quando a fase RESULTANTE é `Review` — em
                    // `Learning`/`Relearning` o atraso até `proxima_revisao`
                    // é em SEGUNDOS (um passo), não em dias, e reportar
                    // `(proxima_revisao - agora).num_days()` ali mostraria um
                    // número de dias (quase sempre `0`, mas não sempre: um
                    // `learning_steps_min` acima de 1440 já basta) para um
                    // cartão que continua em aprendizagem.
                    interval_dias: if proximo.estado.fase == Fase::Review {
                        (proximo.proxima_revisao - agora).num_days()
                    } else {
                        0
                    },
                    // FSRS não usa ease factor — mantém o valor antigo do
                    // cartão intocado (é o `DEFAULT 250` da migração para um
                    // cartão que nunca foi SM-2).
                    ease_factor: card.ease_factor,
                    learning_step: i64::from(proximo.estado.step.unwrap_or(0)),
                    // Esta peça não estende contagem de lapso/leech ao FSRS
                    // (fora do escopo pedido) — mantém intocado.
                    lapses: card.lapses,
                    is_leech: card.is_leech,
                    fsrs_stability: Some(nova_memoria.estabilidade),
                    fsrs_difficulty: Some(nova_memoria.dificuldade),
                    fsrs_last_review_at: Some(nova_memoria.ultima_revisao),
                    scheduler: "fsrs",
                }
            }
            outro => {
                // `cards.scheduler` tem `CHECK (scheduler IN ('sm2', 'fsrs'))`
                // (`0011_notes_cards.sql`) — este braço só é alcançável com
                // um banco corrompido por fora do schema (edição manual,
                // migração futura mal escrita). Recusar é mais seguro que
                // silenciosamente tratar como SM-2.
                return Err(Error::Invalid(format!("agendador '{outro}' não é suportado por answer_card")));
            }
        };

        let due_formatado = formatar_timestamp(resposta.proxima_revisao);
        // Contador que só cresce ao longo da vida do cartão (quantas vezes já
        // foi respondido, independente de qual agendador) — saturar no teto é
        // a resposta certa aqui (regra do projeto: contador que para no teto
        // é o caso correto de `saturating_*`), nunca lido de volta numa
        // fórmula que amplificaria o erro.
        let novo_reps = card.reps.saturating_add(1);

        // `formatar_timestamp` na escrita (não o `DateTime<Utc>` cru) pelo
        // mesmo motivo de `due`/`&due_formatado` logo abaixo: este arquivo
        // não confia no `Encode<Sqlite>` que o sqlx deriva para
        // `DateTime<Utc>` para o formato exato gravado — só na leitura
        // (`Decode`, que `CardRow` já usa para `due`/`created_at`/etc.).
        let fsrs_last_review_at_formatado = resposta.fsrs_last_review_at.map(formatar_timestamp);

        sqlx::query(
            "UPDATE cards SET state = $2, due = $3, interval_days = $4, ease_factor = $5, \
                    learning_step = $6, lapses = $7, reps = $8, is_leech = $9, fsrs_stability = $10, \
                    fsrs_difficulty = $11, fsrs_last_review_at = $12 \
             WHERE id = $1",
        )
        .bind(card_id.db())
        .bind(resposta.estado_str)
        .bind(&due_formatado)
        .bind(resposta.interval_dias)
        .bind(resposta.ease_factor)
        .bind(resposta.learning_step)
        .bind(resposta.lapses)
        .bind(novo_reps)
        .bind(resposta.is_leech)
        .bind(resposta.fsrs_stability)
        .bind(resposta.fsrs_difficulty)
        .bind(&fsrs_last_review_at_formatado)
        .execute(&mut *tx)
        .await?;

        // Antes/depois de ease só faz sentido para SM-2; antes/depois de
        // memória FSRS só faz sentido para FSRS — a outra dupla vai `NULL`
        // (as colunas de `review_log` são nullable exatamente para isto:
        // `0012_review_log.sql`), nunca um número que não significa nada
        // para o agendador real desta resposta.
        let (ease_factor_before, ease_factor_after) = if resposta.scheduler == "sm2" {
            (Some(card.ease_factor), Some(resposta.ease_factor))
        } else {
            (None, None)
        };
        let (fsrs_stability_before, fsrs_stability_after, fsrs_difficulty_before, fsrs_difficulty_after) =
            if resposta.scheduler == "fsrs" {
                (card.fsrs_stability, resposta.fsrs_stability, card.fsrs_difficulty, resposta.fsrs_difficulty)
            } else {
                (None, None, None, None)
            };

        // Id gerado ANTES do `INSERT` (não `Uuid::now_v7().db()` inline como
        // antes) porque a referência do evento de XP abaixo é exatamente
        // este id — a mesma linha que está sendo gravada agora, não uma
        // consulta posterior para redescobri-la.
        let review_log_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO review_log \
                 (id, card_id, rating, state_before, state_after, interval_before, interval_after, \
                  ease_factor_before, ease_factor_after, fsrs_stability_before, fsrs_stability_after, \
                  fsrs_difficulty_before, fsrs_difficulty_after, scheduler) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(review_log_id.db())
        .bind(card_id.db())
        .bind(avaliacao_como_rating(nota))
        .bind(&card.state)
        .bind(resposta.estado_str)
        .bind(card.interval_days)
        .bind(resposta.interval_dias)
        .bind(ease_factor_before)
        .bind(ease_factor_after)
        .bind(fsrs_stability_before)
        .bind(fsrs_stability_after)
        .bind(fsrs_difficulty_before)
        .bind(fsrs_difficulty_after)
        .bind(resposta.scheduler)
        .execute(&mut *tx)
        .await?;

        // XP é CONSEQUÊNCIA de responder o cartão, não uma chamada separada
        // que uma tela precisaria lembrar de fazer (ver o comentário de
        // módulo de `db::gamificacao` — a causa raiz que esta peça corrige).
        // MESMA transação que gravou `cards`/`review_log` acima: se este
        // `INSERT` falhar de verdade, o erro sobe com `?` e a função retorna
        // sem chamar `tx.commit()` — a transação inteira reverte (nenhuma
        // das duas escritas acima fica gravada) em vez de deixar o cartão
        // reagendado sem a contrapartida de XP. Decisão e alternativa
        // descartada comentadas em
        // `GamificacaoRepository::creditar_xp_na_transacao`.
        GamificacaoRepository::creditar_xp_na_transacao(
            &mut tx,
            XP_POR_REVISAO_CARTAO,
            "card_review",
            &review_log_id.hyphenated().to_string(),
        )
        .await?;

        tx.commit().await?;

        Ok(AnswerOutcome {
            proxima_revisao: resposta.proxima_revisao,
            intervalo_dias: resposta.interval_dias,
            estado: resposta.estado_str.to_string(),
        })
    }

    /// `deck_forecast`: quantos cartões (aprendizado/reaprendizagem/revisão,
    /// não suspensos) vencem em cada um dos próximos `dias` dias LOCAIS,
    /// dobrando tudo que já está vencido no dia 0 — mesmo comportamento do
    /// gráfico de previsão do Anki, que não tenta desenhar "dias negativos".
    /// Cartões novos ficam de fora: `due` deles é sempre `NULL` até a
    /// primeira resposta, então não há previsão a fazer sobre eles aqui.
    pub async fn deck_forecast(&self, deck_id: Option<Uuid>, dias: i64) -> Result<Vec<DiaPrevisto>> {
        if !(1..=DECK_FORECAST_DIAS_MAXIMO).contains(&dias) {
            return Err(Error::Invalid(format!(
                "dias precisa estar entre 1 e {DECK_FORECAST_DIAS_MAXIMO}, recebido {dias}"
            )));
        }
        // `dias` já foi validado positivo e limitado a poucos milhares acima
        // — cabe em `usize`/`u64` sem checagem adicional, mas propagamos o
        // erro em vez de `unwrap`/`expect` mesmo assim (regra 3): mais barato
        // que justificar por que um `try_from` "nunca falha" aqui.
        let dias_usize = usize::try_from(dias).map_err(|_| Error::Invalid("dias inválido".into()))?;
        let dias_u64 = u64::try_from(dias).map_err(|_| Error::Invalid("dias inválido".into()))?;

        let agora = Utc::now();
        let hoje_local = agora.with_timezone(&Local).date_naive();
        let limite_superior = inicio_do_dia_local_em_utc(agora, dias_u64);

        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT due FROM cards \
             WHERE deck_id IN (SELECT id FROM escopo) \
               AND state IN ('learning', 'relearning', 'review') \
               AND suspended_at IS NULL \
               AND due IS NOT NULL \
               AND due < $2"
        );
        let vencimentos: Vec<DateTime<Utc>> = sqlx::query_scalar(&sql)
            .bind(deck_id.db())
            .bind(formatar_timestamp(limite_superior))
            .fetch_all(&self.pool)
            .await?;

        let mut baldes = vec![0i64; dias_usize];
        for due in vencimentos {
            let data_local = due.with_timezone(&Local).date_naive();
            let deslocamento = (data_local - hoje_local).num_days().max(0);
            if let Some(balde) = usize::try_from(deslocamento).ok().and_then(|indice| baldes.get_mut(indice)) {
                *balde += 1;
            }
        }

        let previsao = baldes
            .into_iter()
            .enumerate()
            .map(|(indice, quantidade)| {
                // `indice` vem de `enumerate()` sobre um vetor de tamanho
                // `dias_usize`, construído a partir de `dias_u64` logo acima
                // — a mesma contagem de dias, então volta a caber em `u64`
                // sem checagem (alargar `usize -> u64` nunca perde valor:
                // `u64` é tão largo quanto `usize` em qualquer alvo suportado).
                let data = hoje_local + Days::new(indice as u64);
                DiaPrevisto { data: data.format("%Y-%m-%d").to_string(), quantidade }
            })
            .collect();

        Ok(previsao)
    }

    async fn buscar_pronto_agora(&self, deck_id: Option<Uuid>, agora: DateTime<Utc>) -> Result<Option<CardRow>> {
        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT {CAMPOS_CARD_ROW} FROM cards \
             WHERE deck_id IN (SELECT id FROM escopo) \
               AND state IN ('learning', 'relearning') \
               AND suspended_at IS NULL \
               AND (buried_until IS NULL OR buried_until <= $2) \
               AND due IS NOT NULL AND due <= $2 \
             ORDER BY due ASC \
             LIMIT 1"
        );
        Ok(sqlx::query_as::<_, CardRow>(&sql).bind(deck_id.db()).bind(formatar_timestamp(agora)).fetch_optional(&self.pool).await?)
    }

    async fn buscar_revisao_do_dia(&self, deck_id: Option<Uuid>, agora: DateTime<Utc>) -> Result<Option<CardRow>> {
        let inicio_de_amanha = inicio_do_dia_local_em_utc(agora, 1);
        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT {CAMPOS_CARD_ROW} FROM cards \
             WHERE deck_id IN (SELECT id FROM escopo) \
               AND state = 'review' \
               AND suspended_at IS NULL \
               AND (buried_until IS NULL OR buried_until <= $2) \
               AND due IS NOT NULL AND due < $3 \
             ORDER BY due ASC \
             LIMIT 1"
        );
        Ok(sqlx::query_as::<_, CardRow>(&sql)
            .bind(deck_id.db())
            .bind(formatar_timestamp(agora))
            .bind(formatar_timestamp(inicio_de_amanha))
            .fetch_optional(&self.pool)
            .await?)
    }

    async fn buscar_novo(&self, deck_id: Option<Uuid>, agora: DateTime<Utc>) -> Result<Option<CardRow>> {
        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT {CAMPOS_CARD_ROW} FROM cards \
             WHERE deck_id IN (SELECT id FROM escopo) \
               AND state = 'new' \
               AND suspended_at IS NULL \
               AND (buried_until IS NULL OR buried_until <= $2) \
             ORDER BY created_at ASC, id ASC \
             LIMIT 1"
        );
        Ok(sqlx::query_as::<_, CardRow>(&sql).bind(deck_id.db()).bind(formatar_timestamp(agora)).fetch_optional(&self.pool).await?)
    }

    /// Quantos cartões, no escopo dado, tiveram sua PRIMEIRA resposta hoje
    /// (fuso local) — `state_before = 'new'` só acontece uma vez na vida de
    /// um cartão, então isto é literalmente "quantos novos já entraram na
    /// fila hoje", sem precisar de `DISTINCT`.
    async fn novos_estudados_hoje(&self, deck_id: Option<Uuid>, agora: DateTime<Utc>) -> Result<i64> {
        let inicio_de_hoje = inicio_do_dia_local_em_utc(agora, 0);
        let inicio_de_amanha = inicio_do_dia_local_em_utc(agora, 1);
        let sql = format!(
            "{ESCOPO_BARALHOS_CTE} \
             SELECT COUNT(*) FROM review_log r \
             JOIN cards c ON c.id = r.card_id \
             WHERE c.deck_id IN (SELECT id FROM escopo) \
               AND r.state_before = 'new' \
               AND r.reviewed_at >= $2 AND r.reviewed_at < $3"
        );
        Ok(sqlx::query_scalar(&sql)
            .bind(deck_id.db())
            .bind(formatar_timestamp(inicio_de_hoje))
            .bind(formatar_timestamp(inicio_de_amanha))
            .fetch_one(&self.pool)
            .await?)
    }

    async fn montar_card_to_study(&self, card: CardRow) -> Result<CardToStudy> {
        let note = sqlx::query_as::<_, NoteRow>(
            "SELECT id, note_type_id, deck_id, field_values, tags, source_block_id, source_text_frozen, \
                    deleted_at, created_at, updated_at \
             FROM notes WHERE id = $1",
        )
        .bind(card.note_id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("nota {} do cartão {}", card.note_id, card.id)))?;

        let (nomes_dos_campos, kind): (serde_json::Value, String) =
            sqlx::query_as("SELECT fields, kind FROM note_types WHERE id = $1")
                .bind(note.note_type_id.db())
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| Error::NotFound(format!("tipo de nota {}", note.note_type_id)))?;

        let deck_name: String = sqlx::query_scalar("SELECT name FROM decks WHERE id = $1")
            .bind(card.deck_id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("baralho {}", card.deck_id)))?;

        let (field_names, fields) = campos_ordenados(&nomes_dos_campos, &note.field_values);
        let cloze = (kind == NOTE_TYPE_KIND_CLOZE).then(|| segmentos_cloze_do_cartao(&card, &field_names, &fields));

        Ok(CardToStudy { card, note, fields, field_names, deck_name, cloze })
    }
}

/// Os segmentos de `CardToStudy::cloze` para um cartão de tipo cloze: o
/// PRIMEIRO campo da ordem (a marcação, por posição — a mesma convenção
/// "`field_names[0]` é a frente" que o resto da struct segue; ver
/// `db::notes::CLOZE_NOTE_TYPE_NAME`) resolvido para a lacuna
/// `card.template_ordinal`.
///
/// Total, como `db::cloze`: um `template_ordinal` negativo ou acima de `u32`
/// (linha corrompida) vira `0`, que nunca é lacuna válida — o resultado é
/// "tudo visível, nenhuma lacuna", que a tela mostra como estado próprio, em
/// vez de um erro que derrubaria a sessão inteira por causa de um cartão.
fn segmentos_cloze_do_cartao(card: &CardRow, field_names: &[String], fields: &HashMap<String, String>) -> Vec<ClozeSegment> {
    let texto = field_names.first().and_then(|nome| fields.get(nome)).map(String::as_str).unwrap_or_default();
    let numero_da_lacuna = u32::try_from(card.template_ordinal).unwrap_or(0);
    segment_cloze(texto, numero_da_lacuna)
}

#[cfg(test)]
mod testes_de_cloze {
    use super::*;

    fn cartao_com_ordinal(template_ordinal: i64) -> CardRow {
        let agora = Utc::now();
        CardRow {
            id: Uuid::new_v4(),
            note_id: Uuid::new_v4(),
            template_ordinal,
            deck_id: Uuid::new_v4(),
            state: "new".into(),
            due: None,
            scheduler: "sm2".into(),
            interval_days: 0,
            ease_factor: 2500,
            fsrs_stability: None,
            fsrs_difficulty: None,
            fsrs_last_review_at: None,
            learning_step: 0,
            lapses: 0,
            reps: 0,
            is_leech: false,
            flags: 0,
            suspended_at: None,
            buried_until: None,
            created_at: agora,
            updated_at: agora,
        }
    }

    fn campos(texto: &str) -> (Vec<String>, HashMap<String, String>) {
        let nomes = vec!["Texto".to_string(), "Extra".to_string()];
        let mapa = HashMap::from([("Texto".to_string(), texto.to_string()), ("Extra".to_string(), String::new())]);
        (nomes, mapa)
    }

    #[test]
    fn usa_o_primeiro_campo_e_o_ordinal_como_numero_da_lacuna() {
        let (nomes, mapa) = campos("{{c1::A}} e {{c2::B}}");
        let segmentos = segmentos_cloze_do_cartao(&cartao_com_ordinal(2), &nomes, &mapa);
        let escondidos: Vec<&str> = segmentos.iter().filter(|s| s.hidden).map(|s| s.text.as_str()).collect();
        assert_eq!(escondidos, vec!["B"], "o cartão de ordinal 2 esconde a lacuna c2, não a c1");
    }

    #[test]
    fn ordinal_negativo_nao_derruba_e_nao_esconde_nada() {
        let (nomes, mapa) = campos("{{c1::A}}");
        let segmentos = segmentos_cloze_do_cartao(&cartao_com_ordinal(-7), &nomes, &mapa);
        assert!(segmentos.iter().all(|s| !s.hidden));
    }

    #[test]
    fn tipo_sem_campo_nenhum_devolve_lista_vazia() {
        let segmentos = segmentos_cloze_do_cartao(&cartao_com_ordinal(1), &[], &HashMap::new());
        assert!(segmentos.is_empty());
    }
}

/// Espelha os campos de `crate::srs::OpcoesDeDeck` em forma desserializável —
/// aquele módulo é deliberadamente cego a `serde` ("este módulo não faz a
/// desserialização... isso é trabalho do repositório de baralhos", doc de
/// `OpcoesDeDeck`), então a ponte mora aqui. Defaults idênticos aos de
/// `OpcoesDeDeck::default()` (checados em teste, abaixo) para um baralho
/// recém-criado (`options = '{}'`) se comportar como o Anki de fábrica sem
/// precisar de nenhuma chave presente no JSON.
///
/// `pub` (não privado ao módulo): é também o tipo de leitura/escrita dos
/// comandos IPC `get_deck_scheduling_options`/`set_deck_scheduling_options`
/// (`ipc::deck_commands`) — o mesmo shape que `decks.options` guarda vira, sem
/// tradução, o contrato que a UI vai ler e gravar. Precisa ser `pub` (não só
/// `pub(crate)`): um comando `#[tauri::command]` é `pub fn` alcançável de
/// fora do crate, e o lint `private_interfaces` (que o portão de `-D
/// warnings` da regra 1 promove a erro) recusa um tipo menos visível que a
/// função na assinatura dela. Campos `pub` pelo mesmo motivo — e para bater
/// com a convenção do resto do crate (`DeckRow`, `CardRow`: toda struct que
/// atravessa a fronteira IPC tem campo público).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct OpcoesDeDeckJson {
    pub learning_steps_min: Vec<u32>,
    pub relearning_steps_min: Vec<u32>,
    pub graduating_interval_dias: i64,
    pub easy_interval_dias: i64,
    pub easy_bonus_pct: i32,
    pub hard_interval_pct: i32,
    pub lapse_new_interval_percent: u32,
    pub minimum_interval_dias: i64,
    pub maximum_interval_dias: i64,
    pub leech_threshold: u32,
    pub fuzz_habilitado: bool,
    /// `"sm2"` | `"fsrs"` — qualquer outro valor (chave ausente incluída) cai
    /// para `"sm2"` na conversão para [`OpcoesDeDeck`] ([`Agendador::Sm2`]),
    /// nunca em erro: um valor desconhecido aqui é tratado como "ainda não
    /// escolheu", não como JSON corrompido (que já tem seu próprio fallback
    /// em [`parse_opcoes_de_deck`]).
    pub agendador: String,
    pub fsrs_retencao_desejada: f64,
    pub fsrs_pesos: [f64; 21],
}

impl Default for OpcoesDeDeckJson {
    fn default() -> Self {
        let padrao = OpcoesDeDeck::default();
        Self {
            learning_steps_min: padrao.learning_steps_min,
            relearning_steps_min: padrao.relearning_steps_min,
            graduating_interval_dias: padrao.graduating_interval_dias,
            easy_interval_dias: padrao.easy_interval_dias,
            easy_bonus_pct: padrao.easy_bonus_pct,
            hard_interval_pct: padrao.hard_interval_pct,
            lapse_new_interval_percent: padrao.lapse_new_interval_percent,
            minimum_interval_dias: padrao.minimum_interval_dias,
            maximum_interval_dias: padrao.maximum_interval_dias,
            leech_threshold: padrao.leech_threshold,
            fuzz_habilitado: padrao.fuzz_habilitado,
            agendador: padrao.agendador.as_str().to_string(),
            fsrs_retencao_desejada: padrao.fsrs_retencao_desejada,
            fsrs_pesos: padrao.fsrs_pesos,
        }
    }
}

impl From<OpcoesDeDeckJson> for OpcoesDeDeck {
    fn from(json: OpcoesDeDeckJson) -> Self {
        OpcoesDeDeck {
            learning_steps_min: json.learning_steps_min,
            relearning_steps_min: json.relearning_steps_min,
            graduating_interval_dias: json.graduating_interval_dias,
            easy_interval_dias: json.easy_interval_dias,
            easy_bonus_pct: json.easy_bonus_pct,
            hard_interval_pct: json.hard_interval_pct,
            lapse_new_interval_percent: json.lapse_new_interval_percent,
            minimum_interval_dias: json.minimum_interval_dias,
            maximum_interval_dias: json.maximum_interval_dias,
            leech_threshold: json.leech_threshold,
            fuzz_habilitado: json.fuzz_habilitado,
            // Qualquer string que não seja exatamente "fsrs" (incluindo lixo,
            // maiúscula errada, ou o próprio "sm2") cai em `Agendador::Sm2` —
            // o valor seguro por padrão, documentado no campo `agendador` de
            // `OpcoesDeDeckJson`.
            agendador: if json.agendador == "fsrs" { Agendador::Fsrs } else { Agendador::Sm2 },
            fsrs_retencao_desejada: json.fsrs_retencao_desejada,
            fsrs_pesos: json.fsrs_pesos,
        }
    }
}

impl From<OpcoesDeDeck> for OpcoesDeDeckJson {
    /// O inverso de `From<OpcoesDeDeckJson> for OpcoesDeDeck` — usado só para
    /// devolver ao chamador do comando IPC `get_deck_scheduling_options` a
    /// visão JÁ NORMALIZADA das opções (depois de `parse_opcoes_de_deck` já
    /// ter aplicado o fallback de default), nunca o JSON cru de
    /// `decks.options`.
    fn from(opcoes: OpcoesDeDeck) -> Self {
        Self {
            learning_steps_min: opcoes.learning_steps_min,
            relearning_steps_min: opcoes.relearning_steps_min,
            graduating_interval_dias: opcoes.graduating_interval_dias,
            easy_interval_dias: opcoes.easy_interval_dias,
            easy_bonus_pct: opcoes.easy_bonus_pct,
            hard_interval_pct: opcoes.hard_interval_pct,
            lapse_new_interval_percent: opcoes.lapse_new_interval_percent,
            minimum_interval_dias: opcoes.minimum_interval_dias,
            maximum_interval_dias: opcoes.maximum_interval_dias,
            leech_threshold: opcoes.leech_threshold,
            fuzz_habilitado: opcoes.fuzz_habilitado,
            agendador: opcoes.agendador.as_str().to_string(),
            fsrs_retencao_desejada: opcoes.fsrs_retencao_desejada,
            fsrs_pesos: opcoes.fsrs_pesos,
        }
    }
}

/// Um JSON corrompido ou de forma inesperada não pode derrubar o
/// agendamento de um cartão — cai para o preset padrão, o mesmo raciocínio
/// de "uma célula não pode derrubar a view" que
/// `ipc::formula_commands::json_to_value` já aplica.
///
/// `pub(crate)`: também é como `db::decks::DeckRepository::get_scheduling_options`
/// (comando IPC) lê a config de um baralho, e como `db::notes::insert_card`
/// decide com que `scheduler` um cartão nasce (item 3 desta peça).
pub(crate) fn parse_opcoes_de_deck(raw: &serde_json::Value) -> OpcoesDeDeck {
    serde_json::from_value::<OpcoesDeDeckJson>(raw.clone()).unwrap_or_default().into()
}

/// O que os dois braços de `answer_card` (SM-2 e FSRS) produzem, num shape só
/// — o que deixa a escrita em `cards`/`review_log` (comum aos dois) escrita
/// uma única vez, em vez de duplicada por agendador. Campos irrelevantes
/// para o agendador que respondeu (ex.: `ease_factor` sob FSRS) carregam o
/// valor ANTIGO do cartão, intocado — nunca um placeholder inventado.
struct RespostaAgendada {
    estado_str: &'static str,
    proxima_revisao: DateTime<Utc>,
    interval_dias: i64,
    ease_factor: i64,
    learning_step: i64,
    lapses: i64,
    is_leech: bool,
    fsrs_stability: Option<f64>,
    fsrs_difficulty: Option<f64>,
    /// Junto com os dois campos acima, os três de `crate::srs::fsrs::Memoria`
    /// — nunca `card.updated_at` (ver o comentário no braço "fsrs" de
    /// `answer_card` e `0039_cards_fsrs_last_review_at.sql`).
    fsrs_last_review_at: Option<DateTime<Utc>>,
    /// `"sm2"` | `"fsrs"` — o que de fato respondeu esta revisão, gravado
    /// verbatim em `review_log.scheduler` (item 2 desta peça: "grave a
    /// verdadeira").
    scheduler: &'static str,
}

/// Traduz `OpcoesDeDeck` (preset do baralho) para `crate::srs::fsrs::Parametros`
/// — o par FSRS de [`fetch_deck_options`]. Passos de aprendizagem/
/// reaprendizagem e teto de intervalo são REAPROVEITADOS do mesmo preset que
/// o SM-2 usa (só a UNIDADE muda: minutos vira segundos) — o pedido desta
/// peça só acrescenta `agendador`, `fsrs_retencao_desejada` e `fsrs_pesos` a
/// `OpcoesDeDeck` (ver `crate::srs::OpcoesDeDeck`), então os demais campos do
/// FSRS vêm dos mesmos números que o baralho já configura para o SM-2, em vez
/// de duplicar uma segunda cópia de "passos de aprendizagem" que ninguém
/// escreveria de forma consistente entre os dois agendadores do mesmo
/// baralho.
fn parametros_fsrs_de_opcoes(opcoes: &OpcoesDeDeck) -> fsrs::Parametros {
    fsrs::Parametros {
        pesos: opcoes.fsrs_pesos,
        retencao_desejada: opcoes.fsrs_retencao_desejada,
        // `u32::saturating_mul`: minutos hostilmente grandes (configuração
        // corrompida) saturam no teto em vez de dar overflow — é um atraso
        // (valor final, nunca realimentado numa média ou soma), então
        // saturar é a resposta certa aqui (regra do projeto).
        learning_steps_seg: opcoes.learning_steps_min.iter().map(|min| min.saturating_mul(60)).collect(),
        relearning_steps_seg: opcoes.relearning_steps_min.iter().map(|min| min.saturating_mul(60)).collect(),
        maximum_interval_dias: opcoes.maximum_interval_dias,
        fuzz_habilitado: opcoes.fuzz_habilitado,
    }
}

async fn fetch_deck_options(tx: &mut Transaction<'_, Sqlite>, deck_id: Uuid) -> Result<OpcoesDeDeck> {
    let raw: serde_json::Value = sqlx::query_scalar("SELECT options FROM decks WHERE id = $1")
        .bind(deck_id.db())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("baralho {deck_id}")))?;
    Ok(parse_opcoes_de_deck(&raw))
}

/// I5: meia-noite LOCAL (fuso do sistema, não UTC) do dia `agora +
/// deslocamento_dias`, convertida de volta para UTC — o único jeito de
/// comparar "hoje"/"amanhã" contra `due`/`reviewed_at` (TEXT UTC) sem que um
/// cartão que vence às 23h de terça em São Paulo apareça como vencendo
/// quarta, só porque em UTC já é quarta.
fn inicio_do_dia_local_em_utc(agora_utc: DateTime<Utc>, deslocamento_dias: u64) -> DateTime<Utc> {
    let hoje_local = agora_utc.with_timezone(&Local).date_naive();
    let dia_alvo = hoje_local + Days::new(deslocamento_dias);
    let meia_noite_ingenua = NaiveDateTime::new(dia_alvo, NaiveTime::MIN);

    match Local.from_local_datetime(&meia_noite_ingenua) {
        chrono::LocalResult::Single(instante) => instante.with_timezone(&Utc),
        // Horário duplicado (fim do horário de verão): a ocorrência mais
        // cedo é a leitura conservadora — nunca ATRASA o corte de "hoje".
        chrono::LocalResult::Ambiguous(mais_cedo, _mais_tarde) => mais_cedo.with_timezone(&Utc),
        // Horário inexistente (início do horário de verão pulando a meia-
        // noite): não há meia-noite local literal; interpretar os mesmos
        // números como UTC é a aproximação mais simples, e o Brasil não usa
        // horário de verão desde 2019 — este ramo não dispara nesta
        // aplicação hoje, só protege contra um usuário rodando com outro
        // fuso do sistema operacional.
        chrono::LocalResult::None => Utc.from_utc_datetime(&meia_noite_ingenua),
    }
}

/// Mesmo formato que os defaults de coluna usam
/// (`strftime('%Y-%m-%dT%H:%M:%fZ')` nas migrações): ISO 8601 UTC de largura
/// fixa com 3 casas de milissegundo. Formatado à mão em vez de confiar no
/// `Encode<Sqlite>` que o sqlx deriva para `DateTime<Utc>` — `db::ids`
/// documenta exatamente essa classe de armadilha (o tipo do sqlx e o formato
/// que o schema espera divergindo em silêncio); aqui o texto gravado é
/// sempre este, byte a byte, então `ORDER BY due` (lexicográfico) sempre
/// concorda com a ordem cronológica real.
fn formatar_timestamp(instante: DateTime<Utc>) -> String {
    instante.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Semente determinística-por-chamada para o jitter de `crate::srs::agendar`:
/// mistura os primeiros 8 bytes do id do cartão (estáveis) com os
/// nanossegundos do instante da resposta (variam a cada chamada), para que
/// dois cartões respondidos no mesmo segundo não recebam exatamente o mesmo
/// desvio, sem precisar de um gerador de números aleatórios global.
fn semente_do_fuzz(card_id: Uuid, agora: DateTime<Utc>) -> u64 {
    let bytes = card_id.as_bytes();
    let primeiros_oito: [u8; 8] = bytes[0..8].try_into().unwrap_or([0; 8]);
    let do_id = u64::from_le_bytes(primeiros_oito);
    let nanos = agora.timestamp_nanos_opt().unwrap_or(0);
    let dos_nanos = u64::try_from(nanos).unwrap_or(0);
    do_id ^ dos_nanos
}

fn avaliacao_da_string(raw: &str) -> Result<Avaliacao> {
    match raw {
        "again" => Ok(Avaliacao::Again),
        "hard" => Ok(Avaliacao::Hard),
        "good" => Ok(Avaliacao::Good),
        "easy" => Ok(Avaliacao::Easy),
        // Entrada de comando IPC é hostil (alcançável por script na WebView)
        // — uma nota desconhecida vira erro, nunca um fallback silencioso
        // para `Again`.
        other => Err(Error::Invalid(format!("nota de resposta inválida: '{other}' (esperado again|hard|good|easy)"))),
    }
}

/// 1=Again 2=Hard 3=Good 4=Easy — convenção do Anki, já citada em comentário
/// por `0012_review_log.sql` (`CHECK (rating BETWEEN 1 AND 4)`) e pelo
/// próprio módulo `crate::srs`.
fn avaliacao_como_rating(nota: Avaliacao) -> i64 {
    match nota {
        Avaliacao::Again => 1,
        Avaliacao::Hard => 2,
        Avaliacao::Good => 3,
        Avaliacao::Easy => 4,
    }
}

fn fase_da_string(raw: &str) -> Result<Fase> {
    match raw {
        "new" => Ok(Fase::New),
        "learning" => Ok(Fase::Learning),
        "review" => Ok(Fase::Review),
        "relearning" => Ok(Fase::Relearning),
        // 'suspended' é um estado real de `cards.state`
        // (`NoteRepository::delete` grava exatamente esse valor ao suspender
        // os cartões de uma nota apagada) — mas nunca chega em `agendar`: um
        // cartão suspenso já é rejeitado antes, pela checagem de
        // `suspended_at` em `answer_card`. Se chegar aqui mesmo assim
        // (checagem futura removida por engano, por exemplo), recusar é mais
        // seguro que inventar um mapeamento que `crate::srs::Fase` não tem.
        other => Err(Error::Invalid(format!("estado de cartão '{other}' não pode ser respondido por answer_card"))),
    }
}

fn fase_para_string(fase: Fase) -> &'static str {
    match fase {
        Fase::New => "new",
        Fase::Learning => "learning",
        Fase::Review => "review",
        Fase::Relearning => "relearning",
    }
}

/// Alinha os valores de `notes.field_values` (objeto JSON, ex.:
/// `{"Frente": "..."}`) aos nomes declarados em `note_types.fields` (array
/// JSON, ex.: `["Frente", "Verso"]`), devolvendo os nomes NA ORDEM e o mapa
/// nome → valor.
///
/// Um campo sem valor gravado vira string vazia em vez de faltar no mapa —
/// "uma célula não pode derrubar a view" (mesmo raciocínio de
/// `ipc::formula_commands::json_to_value`): o cartão continua estudável mesmo
/// com uma nota incompleta. A invariante que isto garante, e que a tela de
/// estudo depende: **todo nome em `field_names` existe como chave em
/// `fields`**.
///
/// Devolvia só `Vec<String>` (os valores em ordem) até a tela de estudo
/// aparecer com "(sem conteúdo)" para um cartão íntegro no banco: o
/// TypeScript declarava `Record<string, string>` e indexava por nome, e
/// indexar um array por nome devolve `undefined` sem erro nenhum. A ordem
/// sozinha não bastava, e o mapa sozinho perde a ordem — por isso os dois
/// saem daqui juntos, da mesma passada, sem chance de discordarem.
fn campos_ordenados(
    nomes_dos_campos: &serde_json::Value,
    valores: &serde_json::Value,
) -> (Vec<String>, HashMap<String, String>) {
    let nomes: Vec<String> = nomes_dos_campos
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|nome| nome.as_str())
        .map(str::to_string)
        .collect();

    let mapa = nomes
        .iter()
        .map(|nome| {
            let valor = valores.get(nome).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            (nome.clone(), valor)
        })
        .collect();

    (nomes, mapa)
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn campos_ordenados_segue_a_ordem_do_tipo_de_nota_e_preenche_lacuna_com_vazio() {
        let nomes = serde_json::json!(["Frente", "Verso", "Extra"]);
        let valores = serde_json::json!({ "Verso": "resposta", "Frente": "pergunta" });

        let (ordem, mapa) = campos_ordenados(&nomes, &valores);

        assert_eq!(ordem, vec!["Frente".to_string(), "Verso".to_string(), "Extra".to_string()]);
        assert_eq!(mapa.get("Frente").map(String::as_str), Some("pergunta"));
        assert_eq!(mapa.get("Verso").map(String::as_str), Some("resposta"));
        assert_eq!(mapa.get("Extra").map(String::as_str), Some(""), "campo sem valor vem vazio, não ausente");
    }

    /// A invariante de que a tela de estudo depende para não voltar a mostrar
    /// "(sem conteúdo)": todo nome anunciado na ordem existe no mapa.
    #[test]
    fn campos_ordenados_garante_que_todo_nome_da_ordem_existe_no_mapa() {
        let nomes = serde_json::json!(["Frente", "Verso", "Fonte"]);
        let valores = serde_json::json!({ "Frente": "pergunta", "Ignorado": "não declarado no tipo" });

        let (ordem, mapa) = campos_ordenados(&nomes, &valores);

        assert!(ordem.iter().all(|nome| mapa.contains_key(nome)));
        assert_eq!(mapa.len(), ordem.len(), "valor não declarado no tipo de nota não entra no mapa");
    }

    #[test]
    fn campos_ordenados_com_lista_de_nomes_corrompida_nao_causa_panic() {
        let nomes = serde_json::json!("isto não é uma lista");
        let valores = serde_json::json!({});

        let (ordem, mapa) = campos_ordenados(&nomes, &valores);

        assert_eq!(ordem, Vec::<String>::new());
        assert!(mapa.is_empty());
    }

    /// O teste que prova a COSTURA, não o tipo Rust: serializa e olha as
    /// chaves que chegam no JSON. É o único que teria pegado o defeito
    /// original, em que `fields` viajava como lista e o TypeScript indexava
    /// por nome.
    #[test]
    fn card_to_study_serializa_fields_como_mapa_e_field_names_como_lista() {
        let nomes = serde_json::json!(["Frente", "Verso"]);
        let valores = serde_json::json!({ "Frente": "pergunta", "Verso": "resposta" });
        let (field_names, fields) = campos_ordenados(&nomes, &valores);

        let json = serde_json::to_value(serde_json::json!({ "fields": fields, "fieldNames": field_names })).unwrap();

        assert_eq!(json["fields"]["Frente"], serde_json::json!("pergunta"));
        assert_eq!(json["fieldNames"], serde_json::json!(["Frente", "Verso"]));
        assert!(json["fields"].is_object(), "fields precisa ser objeto; como lista, o TS lê undefined");
    }

    #[test]
    fn fase_ida_e_volta_bate_com_o_check_constraint_de_cards_state() {
        for (texto, fase) in [
            ("new", Fase::New),
            ("learning", Fase::Learning),
            ("review", Fase::Review),
            ("relearning", Fase::Relearning),
        ] {
            assert_eq!(fase_da_string(texto).unwrap(), fase);
            assert_eq!(fase_para_string(fase), texto);
        }
    }

    #[test]
    fn estado_suspenso_e_rejeitado_em_vez_de_mapeado() {
        assert!(fase_da_string("suspended").is_err());
        assert!(fase_da_string("qualquer-coisa").is_err());
    }

    #[test]
    fn avaliacao_da_string_aceita_o_vocabulario_do_contrato_e_rejeita_o_resto() {
        assert_eq!(avaliacao_da_string("again").unwrap(), Avaliacao::Again);
        assert_eq!(avaliacao_da_string("hard").unwrap(), Avaliacao::Hard);
        assert_eq!(avaliacao_da_string("good").unwrap(), Avaliacao::Good);
        assert_eq!(avaliacao_da_string("easy").unwrap(), Avaliacao::Easy);
        assert!(avaliacao_da_string("meh").is_err());
    }

    #[test]
    fn avaliacao_como_rating_bate_com_o_check_constraint_de_review_log() {
        assert_eq!(avaliacao_como_rating(Avaliacao::Again), 1);
        assert_eq!(avaliacao_como_rating(Avaliacao::Hard), 2);
        assert_eq!(avaliacao_como_rating(Avaliacao::Good), 3);
        assert_eq!(avaliacao_como_rating(Avaliacao::Easy), 4);
    }

    #[test]
    fn parse_opcoes_de_deck_de_json_vazio_bate_com_o_default_do_agendador() {
        let opcoes = parse_opcoes_de_deck(&serde_json::json!({}));
        assert_eq!(opcoes, OpcoesDeDeck::default());
    }

    #[test]
    fn parse_opcoes_de_deck_de_json_corrompido_cai_para_o_padrao_em_vez_de_falhar() {
        let opcoes = parse_opcoes_de_deck(&serde_json::json!("isto não é um objeto"));
        assert_eq!(opcoes, OpcoesDeDeck::default());
    }

    #[test]
    fn parse_opcoes_de_deck_le_uma_chave_presente_e_usa_default_nas_ausentes() {
        let opcoes = parse_opcoes_de_deck(&serde_json::json!({ "leech_threshold": 4 }));
        assert_eq!(opcoes.leech_threshold, 4);
        assert_eq!(opcoes.easy_interval_dias, OpcoesDeDeck::default().easy_interval_dias);
    }

    #[test]
    fn formatar_timestamp_bate_byte_a_byte_com_o_default_das_migracoes() {
        let instante = DateTime::parse_from_rfc3339("2026-09-05T10:00:05.123Z").unwrap().with_timezone(&Utc);
        assert_eq!(formatar_timestamp(instante), "2026-09-05T10:00:05.123Z");
    }

    #[test]
    fn inicio_do_dia_local_avanca_um_dia_inteiro() {
        let agora = DateTime::parse_from_rfc3339("2026-09-05T15:30:00Z").unwrap().with_timezone(&Utc);
        let hoje = inicio_do_dia_local_em_utc(agora, 0);
        let amanha = inicio_do_dia_local_em_utc(agora, 1);

        assert_eq!(amanha - hoje, chrono::Duration::days(1));
        assert!(hoje <= agora, "meia-noite de hoje não pode ser depois do instante atual");
    }

    #[test]
    fn semente_do_fuzz_varia_com_o_instante_para_o_mesmo_cartao() {
        let card_id = Uuid::now_v7();
        let t1 = DateTime::parse_from_rfc3339("2026-09-05T10:00:00.000000001Z").unwrap().with_timezone(&Utc);
        let t2 = DateTime::parse_from_rfc3339("2026-09-05T10:00:00.000000002Z").unwrap().with_timezone(&Utc);

        assert_ne!(semente_do_fuzz(card_id, t1), semente_do_fuzz(card_id, t2));
    }

    #[test]
    fn dia_previsto_tem_igualdade_estrutural_para_comparacao_direta_em_teste() {
        let a = DiaPrevisto { data: "2026-09-05".into(), quantidade: 3 };
        let b = DiaPrevisto { data: "2026-09-05".into(), quantidade: 3 };
        assert_eq!(a, b);
    }
}
