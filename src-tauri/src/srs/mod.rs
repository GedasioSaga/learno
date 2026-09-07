//! Agendador de repetição espaçada — SM-2 como o Anki de verdade implementa,
//! não a fórmula de artigo de 1987. Kernel **puro**: zero `sqlx`, zero
//! `SqlitePool`, zero `Utc::now()` chamado por dentro. O relógio ("agora") e
//! a semente do jitter ("semente") entram por parâmetro — é isso que torna
//! "daqui a 6 dias" testável sem esperar 6 dias, e o fuzz testável sem mockar
//! um gerador global (regra do projeto: nenhuma aleatoriedade não injetada
//! em código testável).
//!
//! Quem monta [`EstadoDoCartao`] a partir de uma linha de `cards`
//! (`0011_notes_cards.sql`) e grava [`ProximoEstado`] de volta é outra peça
//! (repositório + comando IPC) — este módulo não sabe que um banco existe.
//!
//! ## A máquina de estados
//!
//! ```text
//! New ──(qualquer nota)──> Learning ──(good no último passo)──> Review
//!                              ↑                                   │
//!                              └──(again)──── volta ao passo 0 ────┘
//!
//! Review ──(again = lapso)──> Relearning ──(good no último passo)──> Review
//!                                  ↑                                    │
//!                                  └──(again)──── volta ao passo 0 ─────┘
//! ```
//!
//! `New` e `Learning` são tratados pelo mesmo código (`agendar_em_aprendizagem`):
//! um cartão novo é, para o agendador, um cartão de aprendizagem parado no
//! passo 0 que ainda não foi respondido.
//!
//! ## Decisões onde o Anki é ambíguo (ou onde o contrato desta peça não fechava)
//!
//! Ver a tabela completa no relatório desta peça; resumo aqui, perto do
//! código que cada uma afeta:
//!
//! 1. **"Hard" durante aprendizagem/reaprendizagem repete o passo atual**
//!    com o mesmo atraso configurado para aquele passo. O Anki de verdade
//!    faz a média entre o passo atual e o próximo (ou ×1.5 do atual, se não
//!    houver próximo) — a média foi deixada de fora por ser detalhe de UX
//!    (o quão cedo o cartão reaparece), não parte do contrato pedido, e por
//!    introduzir uma segunda fonte de arredondamento sem que a tarefa a
//!    especificasse.
//! 2. **"Easy" durante reaprendizagem gradua na hora usando o intervalo-alvo
//!    já calculado no momento do lapso** — o mesmo valor que "good" no
//!    último passo produziria. Não multiplica de novo pelo easy bonus:
//!    aquele bônus já é aplicado uma vez, no cálculo do intervalo pós-lapso.
//! 3. **Lapses só incrementa na transição Review → Relearning**, nunca a
//!    cada "again" dentro da própria reaprendizagem. Confundir os dois
//!    infla lapses e dispara leech cedo demais — o registro de reviravolta
//!    mais fácil de zerar sem perceber.
//! 4. **Leech é "múltiplo do limiar", não "primeira vez que atinge o
//!    limiar"** — `lapses % limiar == 0`. É o que o Anki de verdade faz:
//!    um cartão dessuspenso volta a ser marcado leech em 16, 24, 32...
//!    lapses, não só em 8. A tarefa pediu "como o Anki de verdade faz", e
//!    isto é o que distingue as duas leituras possíveis do enunciado.
//! 5. **`due` é sempre `agora + atraso`**, nunca function do `due` antigo.
//!    O contrato desta peça nem carrega o `due` anterior em
//!    [`EstadoDoCartao`] — de propósito: um cartão atrasado não ganha nem
//!    perde intervalo por causa do atraso (o Anki de mesa também não faz
//!    isso no scheduler clássico; a variante que dá bônus por atraso é
//!    doutro scheduler). Isto é o que resolve o caso de borda "cartão com
//!    due no passado": não existe "devido antigo" para se apegar, então
//!    atraso não pode vazar para o cálculo.
//! 6. **Fuzz é ±5% do intervalo, mínimo 1 dia, e só a partir de 2 dias.**
//!    O Anki de verdade usa uma tabela de faixas por tamanho de intervalo
//!    (2-7 / 7-30 / 30+, cada uma com sua própria proporção). Simplificado
//!    para uma faixa só — o contrato pedia "determinístico e testável",
//!    não a tabela exata do Anki.
//! 7. **`ease_factor` não tem teto** — só piso ([`EASE_FLOOR`], 130). Nem o
//!    schema (`cards.ease_factor`) nem o enunciado declaram um máximo, e
//!    inventar um seria arquitetura não pedida.
//! 8. **"Novo cartão" e "aprendendo" no mesmo dia** não têm tratamento de
//!    fuso/corte de meia-noite — `due` é timestamp absoluto (`agora +
//!    intervalo`), não um número de dia calendário com corte às 4h como o
//!    Anki desktop. Mais simples, e consistente com o resto do projeto
//!    (regra: "timestamp gravado como TEXT ISO UTC de largura fixa").
//! 9. **A escala do ease é ×100, não ×1000 — e os deltas de ease vieram
//!    reescalados junto.** `cards.ease_factor` (`0011_notes_cards.sql`)
//!    nasce com `DEFAULT 250`, e o comentário da própria coluna diz
//!    "stored as an integer times 100" — mas o mesmo comentário dá o
//!    exemplo "(2500 = 2.50)", que só fecha numa escala ×1000. As duas
//!    frases se contradizem dentro do mesmo comentário, e o enunciado
//!    desta peça herda a mesma mistura: pede "piso de 130" (só faz sentido
//!    em ×100 — 130/100 = 1.30, o piso real do Anki) mas também "ease
//!    -150"/"+150" (só fazem sentido em ×1000 — no Anki de verdade a régua
//!    é 2500/1300/±150/-200). Segui o DEFAULT da coluna como fonte da
//!    verdade (é dado de schema, não posso alterá-lo) e re-escalei os
//!    deltas do enunciado na mesma proporção (÷10), preservando a
//!    PORCENTAGEM real que o Anki aplica — 15%/15%/20% do fator — em vez do
//!    número literal: **hard -15, easy +15, lapso -20**, floor 130. Se a
//!    intenção fosse de fato ×1000, a linha a mudar é só o `DEFAULT` da
//!    migração (fora do meu escopo) mais estas três constantes.

use chrono::{DateTime, Duration, Utc};

pub mod fsrs;

/// Piso do ease factor, na escala ×100 que `cards.ease_factor` usa (130 =
/// 1.30 — ver decisão 9 no cabeçalho do módulo). Abaixo disto o cartão nunca
/// mais sairia do buraco: cada lapso multiplicaria o intervalo por um fator
/// cada vez menor, sem fundo.
pub const EASE_FLOOR: i32 = 130;

/// Teto de segurança para `interval_dias`, independente do que
/// [`OpcoesDeDeck::maximum_interval_dias`] configurar — ~10 mil anos.
/// Existe só para que `Duration::days` nunca chegue perto de estourar (o
/// limite real de `i64` milissegundos é ~292 milhões de anos), mesmo que
/// alguém grave um `maximum_interval_dias` absurdo nas opções do baralho.
const ABSOLUTE_MAX_INTERVAL_DIAS: i64 = 3_650_000;

/// Qual agendador um baralho usa para cartão NOVO — a escolha que o comando
/// IPC `set_deck_scheduling_options` grava em `decks.options` (chave
/// `agendador`) e que `db::notes::insert_card` lê para decidir com que
/// `cards.scheduler` um cartão nasce. `Sm2` é o default: um baralho que nunca
/// teve essa chave configurada continua se comportando exatamente como antes
/// desta peça — nenhum cartão existente muda de comportamento.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Agendador {
    #[default]
    Sm2,
    Fsrs,
}

impl Agendador {
    /// Mesmos literais que `cards.scheduler`/`review_log.scheduler` aceitam
    /// (`CHECK (scheduler IN ('sm2', 'fsrs'))` em `0011_notes_cards.sql` e
    /// `0012_review_log.sql`) — não um vocabulário novo.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Agendador::Sm2 => "sm2",
            Agendador::Fsrs => "fsrs",
        }
    }
}

/// Fase de agendamento de um cartão — o subconjunto de `cards.state`
/// (`0011_notes_cards.sql`) que este módulo entende. `suspended` fica de
/// fora: um cartão suspenso nunca chega a [`agendar`] — quem monta a fila de
/// estudo filtra isso antes, não este módulo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Fase {
    New,
    Learning,
    Review,
    /// Enquanto um cartão está aqui, [`EstadoDoCartao::interval_dias`] não é
    /// "o intervalo atual" — é o intervalo-alvo para quando a
    /// reaprendizagem terminar, calculado uma única vez no momento do
    /// lapso (ver decisão 2 no cabeçalho do módulo) e carregado sem
    /// recomputar a cada passo.
    Relearning,
}

/// Nota dada ao responder um cartão. Nomes em inglês de propósito: são a
/// mesma palavra que `review_log.rating` já usa em comentário
/// (`0012_review_log.sql`: "1=Again 2=Hard 3=Good 4=Easy") e que o contrato
/// IPC usa como string (`rating: again|hard|good|easy`) — quem traduzir a
/// `String` do frontend para este enum não inventa um vocabulário novo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Avaliacao {
    Again,
    Hard,
    Good,
    Easy,
}

/// Estado de agendamento de um cartão — o que [`agendar`] recebe e, com
/// campos atualizados, devolve dentro de [`ProximoEstado`]. Espelha a forma
/// da linha de `cards` de propósito: quem chama monta isto direto de um
/// `CardRow`, sem remapear nada.
///
/// É um struct plano, não um enum com dados por variante, porque
/// `ease_factor` e `lapses` precisam atravessar TODA fase inalterados até o
/// momento em que a fase seguinte de fato os usa — um enum por variante
/// duplicaria os dois campos em três dos quatro braços só para fazer esse
/// *passthrough*. Em compensação, nem todo campo é significativo em toda
/// fase: ver a nota de cada um.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EstadoDoCartao {
    pub fase: Fase,
    /// Sem sentido fora de `Review`/`Relearning` — nas fases `New` e
    /// `Learning` o chamador deve manter em `0` (é o que a coluna
    /// `cards.interval_days` já traz por padrão para um cartão nunca
    /// estudado). Em `Relearning`, ver a nota em [`Fase::Relearning`].
    pub interval_dias: i64,
    /// Escala ×100 (250 = 2.50), como `cards.ease_factor` guarda de fato —
    /// ver decisão 9 no cabeçalho do módulo para a contradição na própria
    /// migração que essa leitura resolve. Regra do projeto: nunca ponto
    /// flutuante para ease — a multiplicação repetida de um `f64` desviaria
    /// com o tempo de um jeito que ninguém notaria revisão a revisão.
    pub ease_factor: i32,
    /// Índice (0-based) do passo de aprendizagem/reaprendizagem atual.
    /// Sem sentido em `Review`.
    pub learning_step: u32,
    pub lapses: u32,
}

/// Opções de agendamento de um baralho — o que `decks.options` (JSON,
/// `0010_decks_note_types.sql`) precisa desserializar para alimentar
/// [`agendar`]. Este módulo não faz a desserialização (não conhece JSON,
/// só a forma final); isso é trabalho do repositório de baralhos.
#[derive(Debug, Clone, PartialEq)]
pub struct OpcoesDeDeck {
    /// Atrasos em minutos de cada passo de aprendizagem, na ordem em que são
    /// percorridos. Anki padrão: `[1, 10]`. Uma lista vazia faz qualquer
    /// nota graduar na hora (decisão: um baralho configurado sem nenhum
    /// passo pula aprendizagem inteira, em vez de travar por falta de passo
    /// pra ficar).
    pub learning_steps_min: Vec<u32>,
    /// Mesma ideia, para depois de um lapso. Anki padrão: `[10]`.
    pub relearning_steps_min: Vec<u32>,
    /// Intervalo, em dias, ao graduar de aprendizagem com "good" no último
    /// passo. Anki padrão: 1.
    pub graduating_interval_dias: i64,
    /// Intervalo ao graduar com "easy" a qualquer momento da aprendizagem
    /// (pula os passos restantes). Anki padrão: 4.
    pub easy_interval_dias: i64,
    /// Bônus multiplicativo aplicado só em "easy" durante `Review`, na mesma
    /// escala ×100 do ease (130 = ×1.3). Anki padrão: 130.
    pub easy_bonus_pct: i32,
    /// Multiplicador aplicado ao intervalo em "hard" durante `Review`,
    /// escala ×100 (120 = ×1.2). Anki padrão: 120 — o mesmo 1.2 que o
    /// enunciado desta peça cita; deixado configurável em vez de fixo em
    /// código pela mesma razão que `easy_bonus_pct` é: as duas são a mesma
    /// categoria de número (multiplicador de intervalo em `Review`) e só
    /// uma delas vir do baralho seria uma inconsistência gratuita.
    pub hard_interval_pct: i32,
    /// "New Interval %" do Anki: fração do intervalo anterior que sobra ao
    /// sofrer um lapso, 0-100. Anki padrão: 0 (o intervalo some; o cartão
    /// reconstrói do zero em `Review`, respeitando `minimum_interval_dias`).
    pub lapse_new_interval_percent: u32,
    /// Piso de qualquer intervalo em `Review`, em dias. Anki padrão: 1.
    pub minimum_interval_dias: i64,
    /// Teto de qualquer intervalo em `Review`, em dias. Anki padrão: 36500
    /// (~100 anos). [`ABSOLUTE_MAX_INTERVAL_DIAS`] ainda se aplica por cima
    /// deste, então um valor absurdo aqui não estoura nada — só é ignorado.
    pub maximum_interval_dias: i64,
    /// Quantos lapsos marcam o cartão como leech. Anki padrão: 8. `0`
    /// desliga a detecção de leech inteiramente.
    pub leech_threshold: u32,
    /// Liga/desliga o jitter do intervalo. Ver decisão 6 no cabeçalho do
    /// módulo para a faixa usada.
    pub fuzz_habilitado: bool,
    /// Qual agendador este baralho usa para cartão NOVO — ver a doc de
    /// [`Agendador`]. Não afeta cartão já existente: `cards.scheduler` é
    /// gravado uma vez, na criação (`db::notes::insert_card`), e nunca
    /// reescrito só por mudar esta opção depois — ver a decisão documentada
    /// em `db::cards::CardRepository::answer_card`.
    pub agendador: Agendador,
    /// Retenção-alvo do FSRS, 0-1 — o mesmo campo que
    /// [`fsrs::Parametros::retencao_desejada`]. Anki/FSRS padrão: 0.9. Só faz
    /// sentido quando `agendador == Agendador::Fsrs`; ignorado no caminho
    /// SM-2.
    pub fsrs_retencao_desejada: f64,
    /// Os 21 pesos do modelo FSRS-6 — o mesmo campo que
    /// [`fsrs::Parametros::pesos`]. Padrão: [`fsrs::PESOS_PADRAO`]. Só faz
    /// sentido quando `agendador == Agendador::Fsrs`.
    pub fsrs_pesos: [f64; 21],
}

impl Default for OpcoesDeDeck {
    /// Os mesmos valores-padrão do Anki de mesa, para que um baralho recém-
    /// criado (`options = '{}'` na migração) se comporte do jeito que quem
    /// já usou Anki espera, sem precisar configurar nada primeiro.
    fn default() -> Self {
        Self {
            learning_steps_min: vec![1, 10],
            relearning_steps_min: vec![10],
            graduating_interval_dias: 1,
            easy_interval_dias: 4,
            easy_bonus_pct: 130,
            hard_interval_pct: 120,
            lapse_new_interval_percent: 0,
            minimum_interval_dias: 1,
            maximum_interval_dias: 36_500,
            leech_threshold: 8,
            fuzz_habilitado: true,
            agendador: Agendador::Sm2,
            fsrs_retencao_desejada: 0.9,
            fsrs_pesos: fsrs::PESOS_PADRAO,
        }
    }
}

/// O que [`agendar`] devolve: o novo [`EstadoDoCartao`] para persistir, a
/// próxima data de revisão (o que a coluna `cards.due` vai guardar), e se
/// esta resposta acabou de cruzar o limiar de leech.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProximoEstado {
    pub estado: EstadoDoCartao,
    pub proxima_revisao: DateTime<Utc>,
    /// `true` só na resposta exata em que `lapses` vira múltiplo de
    /// `leech_threshold` (ver decisão 4 no cabeçalho do módulo) — não é um
    /// espelho fiel de "este cartão é leech", que é sticky e mora no banco
    /// (`cards.is_leech`). Quem persiste faz
    /// `is_leech = is_leech_antigo || tornou_leech`.
    pub tornou_leech: bool,
}

/// O coração do módulo: dado o estado atual de um cartão, a nota dada agora,
/// as opções do baralho e o instante presente, decide o próximo estado.
///
/// Puro e total — nunca entra em pânico, para nenhuma combinação de
/// entradas, mesmo hostis (um `EstadoDoCartao` vindo de uma linha
/// corrompida, um `OpcoesDeDeck` com números absurdos). `semente` alimenta o
/// jitter determinístico do intervalo (decisão 6) — mesma semente, mesmo
/// resultado, sempre.
pub fn agendar(
    estado: &EstadoDoCartao,
    nota: Avaliacao,
    opcoes: &OpcoesDeDeck,
    agora: DateTime<Utc>,
    semente: u64,
) -> ProximoEstado {
    match estado.fase {
        Fase::New | Fase::Learning => agendar_em_aprendizagem(estado, nota, opcoes, agora, semente),
        Fase::Relearning => agendar_em_reaprendizagem(estado, nota, opcoes, agora),
        Fase::Review => agendar_em_revisao(estado, nota, opcoes, agora, semente),
    }
}

/// O que sai de um passo de aprendizagem/reaprendizagem: ou o cartão fica
/// numa fase de passos (com um novo índice e atraso em minutos), ou gradua.
enum ResultadoPasso {
    Permanece { proximo_passo: u32, atraso_min: u32 },
    Gradua,
}

/// Avança (ou não) um índice de passo dentro de uma lista de atrasos —
/// compartilhado entre `Learning` e `Relearning`, que só diferem na lista de
/// passos que usam (`learning_steps_min` vs `relearning_steps_min`).
///
/// Nunca indexa fora da lista, mesmo que `passo_atual` esteja desatualizado
/// em relação a ela (a lista pode ter encolhido entre uma resposta e a
/// outra, se alguém editar as opções do baralho no meio do caminho) — o
/// `min` no braço de `Hard` é a defesa contra isso.
fn avancar_passo(passos: &[u32], passo_atual: u32, nota: Avaliacao) -> ResultadoPasso {
    if passos.is_empty() {
        // Sem passo nenhum configurado não há onde "ficar" — qualquer nota
        // gradua na hora (ver a doc de `learning_steps_min`).
        return ResultadoPasso::Gradua;
    }
    match nota {
        Avaliacao::Again => ResultadoPasso::Permanece {
            proximo_passo: 0,
            atraso_min: passos[0],
        },
        Avaliacao::Hard => {
            // `u32 as usize`: alargamento puro em qualquer plataforma de
            // 32/64 bits (as que este app roda) — nunca trunca.
            let indice = (passo_atual as usize).min(passos.len() - 1);
            ResultadoPasso::Permanece {
                proximo_passo: indice as u32,
                atraso_min: passos[indice],
            }
        }
        Avaliacao::Good => {
            let proximo = passo_atual as usize + 1;
            match passos.get(proximo) {
                Some(&atraso_min) => ResultadoPasso::Permanece {
                    proximo_passo: proximo as u32,
                    atraso_min,
                },
                None => ResultadoPasso::Gradua,
            }
        }
        Avaliacao::Easy => ResultadoPasso::Gradua,
    }
}

fn agendar_em_aprendizagem(
    estado: &EstadoDoCartao,
    nota: Avaliacao,
    opcoes: &OpcoesDeDeck,
    agora: DateTime<Utc>,
    semente: u64,
) -> ProximoEstado {
    match avancar_passo(&opcoes.learning_steps_min, estado.learning_step, nota) {
        ResultadoPasso::Permanece { proximo_passo, atraso_min } => ProximoEstado {
            estado: EstadoDoCartao {
                fase: Fase::Learning,
                interval_dias: 0,
                ease_factor: estado.ease_factor,
                learning_step: proximo_passo,
                lapses: estado.lapses,
            },
            proxima_revisao: agora + Duration::minutes(i64::from(atraso_min)),
            tornou_leech: false,
        },
        ResultadoPasso::Gradua => {
            // "Easy" gradua com o intervalo maior mesmo no meio dos passos;
            // qualquer outro caminho até aqui (good no último passo, ou
            // lista de passos vazia) usa o intervalo de graduação normal.
            let dias_base = if nota == Avaliacao::Easy {
                opcoes.easy_interval_dias
            } else {
                opcoes.graduating_interval_dias
            };
            let dias = fuzz_intervalo(clamp_intervalo(dias_base, opcoes), opcoes, semente);
            ProximoEstado {
                estado: EstadoDoCartao {
                    fase: Fase::Review,
                    interval_dias: dias,
                    ease_factor: estado.ease_factor,
                    learning_step: 0,
                    lapses: estado.lapses,
                },
                proxima_revisao: agora + Duration::days(dias),
                tornou_leech: false,
            }
        }
    }
}

fn agendar_em_reaprendizagem(
    estado: &EstadoDoCartao,
    nota: Avaliacao,
    opcoes: &OpcoesDeDeck,
    agora: DateTime<Utc>,
) -> ProximoEstado {
    match avancar_passo(&opcoes.relearning_steps_min, estado.learning_step, nota) {
        ResultadoPasso::Permanece { proximo_passo, atraso_min } => ProximoEstado {
            estado: EstadoDoCartao {
                fase: Fase::Relearning,
                // Decisão 2/3 do cabeçalho: o intervalo-alvo já foi
                // calculado no momento do lapso e não muda enquanto o
                // cartão cicla pelos passos — só `lapses` já reflete aquele
                // evento, e não é reincrementado aqui.
                interval_dias: estado.interval_dias,
                ease_factor: estado.ease_factor,
                learning_step: proximo_passo,
                lapses: estado.lapses,
            },
            proxima_revisao: agora + Duration::minutes(i64::from(atraso_min)),
            tornou_leech: false,
        },
        ResultadoPasso::Gradua => {
            // O intervalo-alvo já saiu clampado e com fuzz do momento do
            // lapso (`agendar_em_revisao`, braço `Again`) — reaplicar
            // qualquer um dos dois aqui moveria o cartão duas vezes pro
            // mesmo lado do dado.
            let dias = estado.interval_dias;
            ProximoEstado {
                estado: EstadoDoCartao {
                    fase: Fase::Review,
                    interval_dias: dias,
                    ease_factor: estado.ease_factor,
                    learning_step: 0,
                    lapses: estado.lapses,
                },
                proxima_revisao: agora + Duration::days(dias),
                tornou_leech: false,
            }
        }
    }
}

fn agendar_em_revisao(
    estado: &EstadoDoCartao,
    nota: Avaliacao,
    opcoes: &OpcoesDeDeck,
    agora: DateTime<Utc>,
    semente: u64,
) -> ProximoEstado {
    match nota {
        Avaliacao::Again => {
            // Contador de eventos que só cresce: saturar no teto é a
            // resposta certa aqui (nunca vai ser lido de volta numa fórmula
            // que amplificaria o erro — só é comparado por `%` para leech).
            let lapses = estado.lapses.saturating_add(1);
            let alvo = clamp_intervalo(
                multiplicar_arredondado(estado.interval_dias, i64::from(opcoes.lapse_new_interval_percent), 100),
                opcoes,
            );
            let alvo = fuzz_intervalo(alvo, opcoes, semente);
            // `saturating_sub` seguido de `.max(EASE_FLOOR)` é seguro mesmo
            // no extremo: se a subtração saturar em `i32::MIN`, o `.max`
            // que vem logo depois já corrige pro piso — a saturação nunca
            // sobrevive pra virar um número "razoável" e errado.
            let ease_factor = estado.ease_factor.saturating_sub(20).max(EASE_FLOOR);
            // `is_multiple_of(0)` já devolve `false` para qualquer `lapses`
            // não-zero (e `lapses` aqui é sempre >= 1, pós-incremento) — o
            // `> 0` explícito de antes era redundante, clippy pegou.
            let tornou_leech = lapses.is_multiple_of(opcoes.leech_threshold);

            if opcoes.relearning_steps_min.is_empty() {
                // Sem passo de reaprendizagem configurado, o lapso vai
                // direto pro intervalo reduzido em `Review` — não há onde
                // "reaprender" (mesma decisão de `avancar_passo` para lista
                // vazia, aplicada aqui porque este braço nunca chama
                // aquela função).
                ProximoEstado {
                    estado: EstadoDoCartao {
                        fase: Fase::Review,
                        interval_dias: alvo,
                        ease_factor,
                        learning_step: 0,
                        lapses,
                    },
                    proxima_revisao: agora + Duration::days(alvo),
                    tornou_leech,
                }
            } else {
                ProximoEstado {
                    estado: EstadoDoCartao {
                        fase: Fase::Relearning,
                        interval_dias: alvo,
                        ease_factor,
                        learning_step: 0,
                        lapses,
                    },
                    proxima_revisao: agora + Duration::minutes(i64::from(opcoes.relearning_steps_min[0])),
                    tornou_leech,
                }
            }
        }
        Avaliacao::Hard => {
            let candidato = multiplicar_arredondado(estado.interval_dias, i64::from(opcoes.hard_interval_pct), 100);
            let dias = crescer_pelo_menos_um_dia(candidato, estado.interval_dias, opcoes, semente);
            let ease_factor = estado.ease_factor.saturating_sub(15).max(EASE_FLOOR);
            revisao_sem_lapso(estado, dias, ease_factor, agora)
        }
        Avaliacao::Good => {
            let candidato = multiplicar_arredondado(estado.interval_dias, i64::from(estado.ease_factor), 100);
            let dias = crescer_pelo_menos_um_dia(candidato, estado.interval_dias, opcoes, semente);
            revisao_sem_lapso(estado, dias, estado.ease_factor, agora)
        }
        Avaliacao::Easy => {
            let base = multiplicar_arredondado(estado.interval_dias, i64::from(estado.ease_factor), 100);
            let candidato = multiplicar_arredondado(base, i64::from(opcoes.easy_bonus_pct), 100);
            let dias = crescer_pelo_menos_um_dia(candidato, estado.interval_dias, opcoes, semente);
            // Sem teto declarado (decisão 7) — só o piso vale.
            let ease_factor = estado.ease_factor.saturating_add(15);
            revisao_sem_lapso(estado, dias, ease_factor, agora)
        }
    }
}

/// Monta o `ProximoEstado` comum a Hard/Good/Easy: fica em `Review`, sem
/// lapso, sem virar leech.
fn revisao_sem_lapso(estado: &EstadoDoCartao, interval_dias: i64, ease_factor: i32, agora: DateTime<Utc>) -> ProximoEstado {
    ProximoEstado {
        estado: EstadoDoCartao {
            fase: Fase::Review,
            interval_dias,
            ease_factor,
            learning_step: 0,
            lapses: estado.lapses,
        },
        proxima_revisao: agora + Duration::days(interval_dias),
        tornou_leech: false,
    }
}

/// Clampa ao piso/teto configurados, garante crescimento de pelo menos um
/// dia sobre o intervalo anterior (um multiplicador pequeno não pode
/// arredondar pra baixo a ponto de repetir o mesmo intervalo — Hard/Good/
/// Easy sempre avançam), e aplica o fuzz por cima.
fn crescer_pelo_menos_um_dia(candidato: i64, interval_anterior: i64, opcoes: &OpcoesDeDeck, semente: u64) -> i64 {
    let com_piso_de_crescimento = candidato.max(interval_anterior.saturating_add(1));
    fuzz_intervalo(clamp_intervalo(com_piso_de_crescimento, opcoes), opcoes, semente)
}

/// `dias * numerador / denominador`, arredondado ao inteiro mais próximo, em
/// `i128` para nunca estourar mesmo com `dias`/`numerador` hostis (uma linha
/// de banco corrompida, um ease absurdo) — só desce pra `i64` depois de já
/// clampado ao alcance dele, então o `as` final não trunca nada.
///
/// `denominador` é sempre `100` nos pontos onde isto é chamado — escala do
/// ease (decisão 9) e percentual do "New Interval%" acabam sendo o mesmo
/// número por coincidência, mas o valor nunca vem de fora, então não precisa
/// de validação de zero.
fn multiplicar_arredondado(dias: i64, numerador: i64, denominador: i64) -> i64 {
    let bruto = i128::from(dias) * i128::from(numerador);
    let metade_do_denominador = i128::from(denominador) / 2;
    let arredondado = (bruto + metade_do_denominador) / i128::from(denominador);
    arredondado.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

fn clamp_intervalo(dias: i64, opcoes: &OpcoesDeDeck) -> i64 {
    let minimo = opcoes.minimum_interval_dias.max(1);
    let maximo = opcoes.maximum_interval_dias.max(minimo).min(ABSOLUTE_MAX_INTERVAL_DIAS);
    dias.clamp(minimo, maximo)
}

/// Jitter pequeno e determinístico (decisão 6 do cabeçalho): mesma
/// `semente` e mesmo `dias`, sempre o mesmo desvio. Sem jitter abaixo de 2
/// dias — o Anki também não aplica fuzz ali, porque um desvio de ±1 dia
/// sobre um intervalo de 1 dia arriscaria zerar ou negativar o resultado.
fn fuzz_intervalo(dias: i64, opcoes: &OpcoesDeDeck, semente: u64) -> i64 {
    if !opcoes.fuzz_habilitado || dias < 2 {
        return dias;
    }
    // 5% do intervalo, no mínimo 1 dia. `dias` já está limitado por
    // `ABSOLUTE_MAX_INTERVAL_DIAS` (3.65 milhões) quando chega aqui, então
    // `dias * 5 / 100` cabe em i64 sem esforço — ainda assim a conta é
    // feita em i128 para não precisar reabrir esta prova se aquele teto um
    // dia crescer.
    let faixa: i64 = ((i128::from(dias) * 5 / 100).max(1)) as i64;
    let bruto = splitmix64(semente ^ dias_para_semente(dias));
    // `faixa` é sempre >= 1 por causa do `.max(1)` acima e no máximo
    // ~182_500 (5% de `ABSOLUTE_MAX_INTERVAL_DIAS`) — `as u64` é um
    // alargamento de um valor já provado não-negativo, nunca trunca.
    let amplitude: u64 = 2 * (faixa as u64) + 1;
    // `bruto % amplitude` é sempre estritamente menor que `amplitude`, que
    // por construção cabe em i64 (no máximo ~365_001) — o `as i64` seguinte
    // não trunca.
    let deslocamento = (bruto % amplitude) as i64 - faixa;
    clamp_intervalo(dias + deslocamento, opcoes)
}

/// `dias` chega aqui sempre `>= 2` (guardado por `fuzz_intervalo`), então
/// cabe em `u64` sem ambiguidade — é só para dar ao hash uma entrada que
/// varia com o tamanho do intervalo, não só com a semente.
fn dias_para_semente(dias: i64) -> u64 {
    u64::try_from(dias).unwrap_or(0)
}

/// Gerador determinístico puro — não é para uso criptográfico, só para
/// espalhar o jitter do fuzz sem empilhar todo cartão vencendo no mesmo dia
/// no mesmo desvio. Mesma entrada, mesma saída, sempre: é o que torna o
/// teste de determinismo do fuzz possível sem mockar um RNG (SplitMix64,
/// domínio público).
fn splitmix64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here
    // (mesmo padrão de `db::position`).
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn agendador_default_e_sm2_e_baralho_recem_criado_nao_muda_de_comportamento() {
        assert_eq!(Agendador::default(), Agendador::Sm2);
        assert_eq!(OpcoesDeDeck::default().agendador, Agendador::Sm2);
        assert_eq!(Agendador::Sm2.as_str(), "sm2");
        assert_eq!(Agendador::Fsrs.as_str(), "fsrs");
    }

    #[test]
    fn opcoes_de_deck_default_traz_a_retencao_e_os_pesos_padrao_do_fsrs() {
        let padrao = OpcoesDeDeck::default();
        assert!((padrao.fsrs_retencao_desejada - 0.9).abs() < 1e-9);
        assert_eq!(padrao.fsrs_pesos, fsrs::PESOS_PADRAO);
    }

    fn agora_fixo() -> DateTime<Utc> {
        // Uma data qualquer, longe de "agora" de verdade — prova de que o
        // agendador não lê o relógio do sistema por baixo dos panos.
        "2030-06-15T12:00:00Z".parse().unwrap()
    }

    fn cartao_novo() -> EstadoDoCartao {
        EstadoDoCartao {
            fase: Fase::New,
            interval_dias: 0,
            ease_factor: 250,
            learning_step: 0,
            lapses: 0,
        }
    }

    fn cartao_em_revisao(interval_dias: i64, ease_factor: i32) -> EstadoDoCartao {
        EstadoDoCartao {
            fase: Fase::Review,
            interval_dias,
            ease_factor,
            learning_step: 0,
            lapses: 0,
        }
    }

    fn opcoes_sem_fuzz() -> OpcoesDeDeck {
        OpcoesDeDeck {
            fuzz_habilitado: false,
            ..OpcoesDeDeck::default()
        }
    }

    // ---- matriz: New × 4 notas -------------------------------------------

    #[test]
    fn novo_com_again_vai_para_learning_no_passo_zero() {
        let out = agendar(&cartao_novo(), Avaliacao::Again, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Learning);
        assert_eq!(out.estado.learning_step, 0);
        assert_eq!(out.proxima_revisao, agora_fixo() + Duration::minutes(1));
    }

    #[test]
    fn novo_com_hard_repete_o_passo_zero() {
        let out = agendar(&cartao_novo(), Avaliacao::Hard, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Learning);
        assert_eq!(out.estado.learning_step, 0);
        assert_eq!(out.proxima_revisao, agora_fixo() + Duration::minutes(1));
    }

    /// "Primeiro cartão do dia": o caso trivial, mas o que prova que campos
    /// zerados de um cartão nunca estudado (interval 0, lapses 0, passo 0)
    /// não quebram o primeiro `good`.
    #[test]
    fn primeiro_good_do_dia_avanca_para_o_segundo_passo_de_aprendizagem() {
        let out = agendar(&cartao_novo(), Avaliacao::Good, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Learning);
        assert_eq!(out.estado.learning_step, 1);
        assert_eq!(out.proxima_revisao, agora_fixo() + Duration::minutes(10));
    }

    #[test]
    fn novo_com_easy_gradua_na_hora_com_o_intervalo_facil() {
        let opcoes = opcoes_sem_fuzz();
        let out = agendar(&cartao_novo(), Avaliacao::Easy, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, opcoes.easy_interval_dias);
        assert_eq!(out.proxima_revisao, agora_fixo() + Duration::days(opcoes.easy_interval_dias));
    }

    // ---- matriz: Learning × 4 notas (segundo passo em diante) ------------

    fn cartao_no_segundo_passo() -> EstadoDoCartao {
        EstadoDoCartao {
            fase: Fase::Learning,
            interval_dias: 0,
            ease_factor: 250,
            learning_step: 1,
            lapses: 0,
        }
    }

    #[test]
    fn learning_com_again_volta_ao_passo_zero() {
        let out = agendar(&cartao_no_segundo_passo(), Avaliacao::Again, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Learning);
        assert_eq!(out.estado.learning_step, 0);
    }

    #[test]
    fn learning_com_hard_repete_o_passo_atual() {
        let out = agendar(&cartao_no_segundo_passo(), Avaliacao::Hard, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Learning);
        assert_eq!(out.estado.learning_step, 1);
        assert_eq!(out.proxima_revisao, agora_fixo() + Duration::minutes(10));
    }

    #[test]
    fn learning_com_good_no_ultimo_passo_gradua_com_o_intervalo_de_graduacao() {
        let opcoes = opcoes_sem_fuzz();
        let out = agendar(&cartao_no_segundo_passo(), Avaliacao::Good, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, opcoes.graduating_interval_dias);
        assert_eq!(out.estado.ease_factor, 250, "ease não muda ao graduar — só reflete o que o cartão já tinha");
    }

    #[test]
    fn learning_com_easy_pula_os_passos_restantes() {
        let opcoes = opcoes_sem_fuzz();
        let out = agendar(&cartao_no_segundo_passo(), Avaliacao::Easy, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, opcoes.easy_interval_dias);
    }

    #[test]
    fn learning_sem_nenhum_passo_configurado_gradua_em_qualquer_nota() {
        let opcoes = OpcoesDeDeck {
            learning_steps_min: vec![],
            ..opcoes_sem_fuzz()
        };
        for nota in [Avaliacao::Again, Avaliacao::Hard, Avaliacao::Good, Avaliacao::Easy] {
            let out = agendar(&cartao_novo(), nota, &opcoes, agora_fixo(), 1);
            assert_eq!(out.estado.fase, Fase::Review, "nota {nota:?} deveria graduar sem passos configurados");
        }
    }

    // ---- matriz: Review × 4 notas -----------------------------------------

    #[test]
    fn revisao_com_again_vira_lapso_e_vai_para_relearning() {
        let cartao = cartao_em_revisao(10, 250);
        let out = agendar(&cartao, Avaliacao::Again, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Relearning);
        assert_eq!(out.estado.lapses, 1);
        assert_eq!(out.estado.ease_factor, 230, "ease cai 20 no lapso (escala x100 — decisão 9): 250 - 20 = 230");
        // ease_factor abaixo do piso 130 é corrigido pelo `.max(EASE_FLOOR)`
        // — este teste em particular usa ease inicial 250 só pra ver a
        // subtração pura; o piso tem teste dedicado abaixo.
    }

    #[test]
    fn revisao_com_hard_multiplica_por_1_2_e_reduz_ease_em_15() {
        let cartao = cartao_em_revisao(10, 250);
        let out = agendar(&cartao, Avaliacao::Hard, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, 12, "10 * 1.2 = 12");
        assert_eq!(out.estado.ease_factor, 235, "250 - 15 = 235 (escala x100 — decisão 9), sem piso ainda");
    }

    #[test]
    fn revisao_com_good_multiplica_pelo_ease_e_mantem_ease() {
        let cartao = cartao_em_revisao(10, 250);
        let out = agendar(&cartao, Avaliacao::Good, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, 25, "10 * 2.50 = 25");
        assert_eq!(out.estado.ease_factor, 250);
    }

    #[test]
    fn revisao_com_easy_multiplica_pelo_ease_e_pelo_bonus_e_soma_15_ao_ease() {
        let cartao = cartao_em_revisao(10, 250);
        let opcoes = opcoes_sem_fuzz();
        let out = agendar(&cartao, Avaliacao::Easy, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, 33, "round(10 * 2.50 * 1.30) = round(32.5) = 33");
        assert_eq!(out.estado.ease_factor, 265, "250 + 15 = 265 (escala x100 — decisão 9), sem teto");
    }

    // ---- matriz: Relearning × 4 notas -------------------------------------

    fn cartao_em_relearning(learning_step: u32) -> EstadoDoCartao {
        EstadoDoCartao {
            fase: Fase::Relearning,
            interval_dias: 3, // intervalo-alvo já calculado no momento do lapso
            ease_factor: 130,
            learning_step,
            lapses: 1,
        }
    }

    #[test]
    fn relearning_com_again_reinicia_o_passo_sem_incrementar_lapses() {
        let out = agendar(&cartao_em_relearning(0), Avaliacao::Again, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Relearning);
        assert_eq!(out.estado.learning_step, 0);
        assert_eq!(out.estado.lapses, 1, "again DENTRO da reaprendizagem não é um segundo lapso");
    }

    #[test]
    fn relearning_com_hard_repete_o_passo_atual_sem_mexer_no_intervalo_alvo() {
        let out = agendar(&cartao_em_relearning(0), Avaliacao::Hard, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Relearning);
        assert_eq!(out.estado.interval_dias, 3, "intervalo-alvo não muda respondendo hard em relearning");
    }

    #[test]
    fn relearning_com_good_no_ultimo_passo_gradua_com_o_intervalo_alvo() {
        let out = agendar(&cartao_em_relearning(0), Avaliacao::Good, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, 3);
        assert_eq!(out.estado.lapses, 1);
    }

    #[test]
    fn relearning_com_easy_gradua_na_hora_com_o_intervalo_alvo() {
        let out = agendar(&cartao_em_relearning(0), Avaliacao::Easy, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.fase, Fase::Review);
        assert_eq!(out.estado.interval_dias, 3);
    }

    #[test]
    fn ciclo_completo_de_relapso_ate_voltar_para_review() {
        let opcoes = opcoes_sem_fuzz();
        let em_revisao = cartao_em_revisao(20, 250);

        let lapso = agendar(&em_revisao, Avaliacao::Again, &opcoes, agora_fixo(), 1);
        assert_eq!(lapso.estado.fase, Fase::Relearning);
        assert_eq!(lapso.estado.interval_dias, 1, "New Interval% padrão é 0, piso de 1 dia");

        let passo1 = agendar(&lapso.estado, Avaliacao::Good, &opcoes, agora_fixo(), 1);
        assert_eq!(passo1.estado.fase, Fase::Review, "relearning_steps_min padrão tem 1 passo só");
        assert_eq!(passo1.estado.interval_dias, 1);
        assert_eq!(passo1.estado.lapses, 1, "um lapso só no ciclo inteiro");
    }

    // ---- casos de borda ----------------------------------------------------

    #[test]
    fn ease_no_piso_nao_desce_mais_com_hard_repetido() {
        let cartao = cartao_em_revisao(10, EASE_FLOOR);
        let out = agendar(&cartao, Avaliacao::Hard, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.ease_factor, EASE_FLOOR);
    }

    #[test]
    fn ease_no_piso_nao_desce_mais_com_lapso() {
        let cartao = cartao_em_revisao(10, EASE_FLOOR);
        let out = agendar(&cartao, Avaliacao::Again, &opcoes_sem_fuzz(), agora_fixo(), 1);
        assert_eq!(out.estado.ease_factor, EASE_FLOOR);
    }

    #[test]
    fn intervalo_nao_passa_do_maximo_configurado() {
        let opcoes = OpcoesDeDeck {
            maximum_interval_dias: 100,
            ..opcoes_sem_fuzz()
        };
        let cartao = cartao_em_revisao(90, 400); // 90 * 4.00 = 360, bem acima de 100
        let out = agendar(&cartao, Avaliacao::Good, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.interval_dias, 100);
    }

    #[test]
    fn intervalo_absurdo_nas_opcoes_nao_afeta_o_teto_de_seguranca() {
        // Opções hostis (maximum_interval_dias = i64::MAX) não podem fazer
        // `Duration::days` estourar — o teto absoluto do módulo protege
        // mesmo quando a configuração externa não protege nada.
        let opcoes = OpcoesDeDeck {
            maximum_interval_dias: i64::MAX,
            ..opcoes_sem_fuzz()
        };
        let cartao = cartao_em_revisao(i64::MAX / 2, i64::MAX as i32 / 1000);
        let out = agendar(&cartao, Avaliacao::Good, &opcoes, agora_fixo(), 1);
        assert!(out.estado.interval_dias <= ABSOLUTE_MAX_INTERVAL_DIAS);
        // E a data resultante de fato foi calculada, sem panicar.
        assert!(out.proxima_revisao > agora_fixo());
    }

    #[test]
    fn lapso_no_multiplo_do_limiar_marca_leech() {
        let opcoes = OpcoesDeDeck {
            leech_threshold: 8,
            ..opcoes_sem_fuzz()
        };
        let cartao = EstadoDoCartao {
            fase: Fase::Review,
            interval_dias: 10,
            ease_factor: 250,
            learning_step: 0,
            lapses: 7,
        };
        let out = agendar(&cartao, Avaliacao::Again, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.lapses, 8);
        assert!(out.tornou_leech, "8º lapso deve marcar leech");
    }

    #[test]
    fn lapso_fora_do_multiplo_nao_marca_leech() {
        let opcoes = OpcoesDeDeck {
            leech_threshold: 8,
            ..opcoes_sem_fuzz()
        };
        let cartao = EstadoDoCartao {
            fase: Fase::Review,
            interval_dias: 10,
            ease_factor: 250,
            learning_step: 0,
            lapses: 5,
        };
        let out = agendar(&cartao, Avaliacao::Again, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.lapses, 6);
        assert!(!out.tornou_leech);
    }

    #[test]
    fn segundo_multiplo_do_limiar_marca_leech_de_novo() {
        // Decisão 4 do cabeçalho: o Anki de verdade remarca em CADA
        // múltiplo, não só na primeira vez que o limiar é atingido.
        let opcoes = OpcoesDeDeck {
            leech_threshold: 8,
            ..opcoes_sem_fuzz()
        };
        let cartao = EstadoDoCartao {
            fase: Fase::Review,
            interval_dias: 10,
            ease_factor: 250,
            learning_step: 0,
            lapses: 15,
        };
        let out = agendar(&cartao, Avaliacao::Again, &opcoes, agora_fixo(), 1);
        assert_eq!(out.estado.lapses, 16);
        assert!(out.tornou_leech, "16 também é múltiplo de 8");
    }

    #[test]
    fn cartao_atrasado_agenda_a_partir_de_agora_nao_do_devido_antigo() {
        // Não existe "devido antigo" no contrato de entrada — este teste
        // prova que dar um `agora` muito à frente do que qualquer devido
        // razoável teria sido não muda a fórmula: o resultado é sempre
        // `agora + intervalo`, nunca function de quanto tempo se passou.
        let cartao = cartao_em_revisao(10, 250);
        let daqui_um_ano = agora_fixo() + Duration::days(365);
        let out = agendar(&cartao, Avaliacao::Good, &opcoes_sem_fuzz(), daqui_um_ano, 1);
        assert_eq!(out.estado.interval_dias, 25);
        assert_eq!(out.proxima_revisao, daqui_um_ano + Duration::days(25));
    }

    #[test]
    fn fuzz_e_deterministico_para_a_mesma_semente() {
        let opcoes = OpcoesDeDeck {
            fuzz_habilitado: true,
            ..OpcoesDeDeck::default()
        };
        let cartao = cartao_em_revisao(30, 250);

        let a = agendar(&cartao, Avaliacao::Good, &opcoes, agora_fixo(), 42);
        let b = agendar(&cartao, Avaliacao::Good, &opcoes, agora_fixo(), 42);
        assert_eq!(a.estado.interval_dias, b.estado.interval_dias);
        assert_eq!(a.proxima_revisao, b.proxima_revisao);
    }

    #[test]
    fn fuzz_varia_para_sementes_diferentes() {
        let opcoes = OpcoesDeDeck {
            fuzz_habilitado: true,
            ..OpcoesDeDeck::default()
        };
        let cartao = cartao_em_revisao(100, 250);

        let resultados: std::collections::HashSet<i64> =
            (0..20u64).map(|semente| agendar(&cartao, Avaliacao::Good, &opcoes, agora_fixo(), semente).estado.interval_dias).collect();
        assert!(resultados.len() > 1, "20 sementes diferentes deveriam produzir mais de um intervalo distinto");
    }

    #[test]
    fn fuzz_nunca_mexe_em_intervalo_menor_que_dois_dias() {
        let opcoes = OpcoesDeDeck {
            fuzz_habilitado: true,
            ..OpcoesDeDeck::default()
        };
        for semente in 0..50u64 {
            assert_eq!(fuzz_intervalo(1, &opcoes, semente), 1);
            assert_eq!(fuzz_intervalo(0, &opcoes, semente), 0);
        }
    }

    #[test]
    fn fuzz_respeita_o_teto_mesmo_perto_do_maximo_configurado() {
        let opcoes = OpcoesDeDeck {
            fuzz_habilitado: true,
            maximum_interval_dias: 100,
            ..OpcoesDeDeck::default()
        };
        for semente in 0..50u64 {
            let dias = fuzz_intervalo(100, &opcoes, semente);
            assert!(dias <= 100, "semente {semente} produziu {dias}, acima do teto");
            assert!(dias >= opcoes.minimum_interval_dias);
        }
    }
}
