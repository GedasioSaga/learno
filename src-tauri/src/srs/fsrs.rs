//! Agendador FSRS-6 — núcleo **puro** (zero I/O, zero `Utc::now()` por
//! dentro), espelhando `mod.rs` (SM-2 deste crate) na forma: o relógio
//! ("agora") e a semente do fuzz entram por parâmetro, nunca lidos de um
//! global. A referência de comportamento é a implementação `py-fsrs`
//! (open-spaced-repetition), reproduzida fórmula a fórmula — ver
//! `docs/…/BAR-fsrs.md` desta tarefa para o texto integral.
//!
//! Reaproveita [`super::Avaliacao`] (as quatro notas) e [`super::Fase`] (a
//! máquina de estados) do módulo-irmão em vez de duplicar vocabulário — o
//! resto (peso do modelo, memória, parâmetros) é específico do FSRS e não
//! existe no SM-2, então ganha tipos novos aqui.
//!
//! ## A máquina de estados (igual ao `review_card` da referência)
//!
//! ```text
//! (novo) ──(qualquer nota)──> Learning ──(good no último passo, ou easy,
//!                                          ou sem passo configurado)──> Review
//!              ↑                                                          │
//!              └──(again)──────────── volta ao passo 0 ────────────────┐  │
//!                                                                        │  │
//! Review ──(again, sem passo de reaprendizagem)──> Review (intervalo reduzido)
//! Review ──(again, com passo de reaprendizagem)───> Relearning ──(good no
//!    ↑                                                 último passo, ou
//!    └──(again)──── volta ao passo 0 ──────────────────  easy)──────────> Review
//! ```
//!
//! ## Decisões onde a especificação era ambígua ou o contrato não fechava
//!
//! 1. **[`super::Fase::New`] é tratado como sinônimo de "Learning, passo 0,
//!    memória vazia".** O FSRS de referência não tem um estado "New" — um
//!    `Card()` recém-criado já nasce em `State.Learning` com `step = 0` e
//!    `stability`/`difficulty` ausentes. Reaproveitar o enum inteiro de
//!    `mod.rs` (que tem quatro fases, uma a mais que o FSRS) exigia decidir
//!    o que fazer com a variante que o FSRS não usa; tratá-la como "ainda
//!    não revisado" é a leitura que não inventa um quinto comportamento.
//! 2. **Passos de aprendizagem/reaprendizagem guardados em segundos
//!    (`u32`), não como `chrono::Duration` cru.** A referência guarda
//!    `timedelta` (que aceita qualquer duração, inclusive hostil); somar um
//!    `Duration` absurdo a um `DateTime<Utc>` entra em pânico no `chrono`
//!    (`checked_add_signed` seguido de `.expect(...)` por baixo do `Add`).
//!    `u32` segundos tem o mesmo teto seguro que `mod.rs` já usa para
//!    minutos (na faixa de anos, nunca perto do limite de `DateTime`) e
//!    ainda reproduz "Hard = média de dois passos" com precisão de segundo
//!    — a referência guarda em microssegundos, mas nenhum vetor dourado
//!    desta tarefa exercita `Hard` (a sequência de `test_review_card` é só
//!    Good/Again), então a fração de segundo nunca é observável nos testes
//!    de aceite.
//! 3. **`estabilidade`/`dificuldade` vivem juntas dentro de
//!    [`Memoria`], não como dois `Option<f64>` soltos.** No py-fsrs os dois
//!    campos são sempre atribuídos ao mesmo tempo — a checagem é sempre
//!    "`stability is None or difficulty is None`", nunca um sem o outro.
//!    Modelar como um par único remove o estado impossível "só um dos dois
//!    preenchido" do tipo, em vez de confiar em disciplina de quem chama.
//! 4. **`ultima_revisao` mora dentro de [`Memoria`]**, pelo mesmo motivo:
//!    no `Card()` de referência, `last_review` só passa a existir depois da
//!    primeira revisão — exatamente quando `stability`/`difficulty` também
//!    passam a existir.
//! 5. **`next_interval` nunca propaga `NaN`/infinito.** A fórmula de
//!    referência não se preocupa com isso (parâmetros são validados na
//!    construção do `Scheduler` do Python); este módulo não valida
//!    [`Parametros`] (ver decisão 8) e por isso precisa de um piso próprio
//!    para não deixar um valor não-finito vazar para `Duration::days`.
//! 6. **Teto absoluto de intervalo ([`TETO_ABSOLUTO_INTERVALO_DIAS`])
//!    duplicado do valor que `mod.rs` já usa** (`ABSOLUTE_MAX_INTERVAL_DIAS`,
//!    privado naquele módulo, por isso a duplicação em vez de reaproveitar)
//!    — protege `Duration::days` de estourar com um
//!    `maximum_interval_dias` hostil vindo de fora, mesma razão que motivou
//!    o teto lá.
//! 7. **O PRNG do fuzz reescreve localmente o mesmo `splitmix64` de
//!    `mod.rs`** — não é uma dependência nova nem um algoritmo diferente, é
//!    o mesmo gerador de domínio público copiado porque a função de
//!    `mod.rs` é privada ao módulo dela e a tarefa restringe mudanças ali à
//!    declaração do módulo novo.
//! 8. **`elapsed_days` negativo (relógio hostil andando pra trás) não
//!    reproduz o `timedelta.days` do Python bit a bit.** `timedelta.days`
//!    arredonda para `-infinito`; `Duration::num_days` do `chrono` trunca
//!    para zero. A diferença só aparece com `agora` anterior a
//!    `ultima_revisao` — fora de qualquer vetor dourado — e o efeito
//!    prático aqui é tratar esse caso como "revisão no mesmo dia" (ramo de
//!    curto prazo), que é seguro e nunca entra em pânico.
//! 9. **Este módulo não valida os limites de `parametros.pesos`** (o
//!    `LOWER_BOUNDS_PARAMETERS`/`UPPER_BOUNDS_PARAMETERS` que o `Scheduler`
//!    do Python checa no construtor). O contrato pedido é "núcleo puro,
//!    sem banco, sem IPC" — validação de configuração vinda de fora
//!    pertenceria à peça que desserializa `Parametros` de uma linha de
//!    baralho, que é outro escopo. Em compensação, nenhuma fórmula aqui
//!    pode entrar em pânico mesmo com pesos fora da faixa documentada (ver
//!    decisão 5).

use chrono::{DateTime, Duration, Utc};

use super::{Avaliacao, Fase};

/// Piso de estabilidade — nunca deixa a memória de um cartão chegar a zero
/// ou negativa, o que quebraria toda fórmula que divide ou eleva por ela.
const STABILITY_MIN: f64 = 0.001;
/// Faixa válida de dificuldade — 1 (mais fácil) a 10 (mais difícil).
const MIN_DIFFICULTY: f64 = 1.0;
const MAX_DIFFICULTY: f64 = 10.0;

/// Teto de segurança para o intervalo calculado, independente do que
/// [`Parametros::maximum_interval_dias`] configurar — mesma constante e
/// mesma razão que `ABSOLUTE_MAX_INTERVAL_DIAS` em `mod.rs` (decisão 6):
/// existe só para que `Duration::days` nunca chegue perto de estourar.
const TETO_ABSOLUTO_INTERVALO_DIAS: i64 = 3_650_000;

/// Os 21 pesos padrão do modelo FSRS-6, verbatim da referência
/// (`DEFAULT_PARAMETERS` em `fsrs/scheduler.py`). `pesos[20]` é o parâmetro
/// de decaimento (`FSRS_DEFAULT_DECAY = 0.1542`).
pub const PESOS_PADRAO: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/// Memória de um cartão já revisado ao menos uma vez: a estabilidade e a
/// dificuldade que o FSRS estimou, e quando essa estimativa foi feita (para
/// calcular `elapsed_days`/retrievability na próxima revisão). Ver decisão
/// 3/4 no cabeçalho do módulo para por que os três campos vivem juntos.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Memoria {
    pub estabilidade: f64,
    pub dificuldade: f64,
    pub ultima_revisao: DateTime<Utc>,
}

/// Estado de agendamento FSRS de um cartão — o que [`agendar`] recebe e
/// devolve (dentro de [`ProximoEstado`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EstadoCartao {
    /// Reaproveita [`Fase`] do SM-2; só `New`, `Learning`, `Review` e
    /// `Relearning` têm sentido aqui, e `New` é tratado como `Learning` no
    /// passo 0 (decisão 1).
    pub fase: Fase,
    /// Índice do passo de aprendizagem/reaprendizagem atual. Sem sentido em
    /// `Review` — quem monta o estado deve deixar `None` ali, espelhando
    /// `card.step = None` da referência.
    pub step: Option<u32>,
    /// `None` só para um cartão que nunca foi revisado (o `Card()` recém-
    /// criado da referência, com `stability`/`difficulty`/`last_review`
    /// todos ausentes).
    pub memoria: Option<Memoria>,
}

impl EstadoCartao {
    /// Um cartão nunca revisado: `Learning`, passo 0, sem memória — o
    /// equivalente exato de `Card()` na referência.
    #[must_use]
    pub fn novo() -> Self {
        Self {
            fase: Fase::Learning,
            step: Some(0),
            memoria: None,
        }
    }
}

/// Parâmetros de agendamento FSRS — o equivalente FSRS de
/// [`super::OpcoesDeDeck`] no SM-2. Este módulo não valida os limites de
/// `pesos` (decisão 9); quem desserializa de um baralho real decide se
/// valida antes de chamar [`agendar`].
#[derive(Debug, Clone, PartialEq)]
pub struct Parametros {
    /// Os 21 pesos do modelo (`w[0..=20]` na notação da referência).
    pub pesos: [f64; 21],
    /// Retenção-alvo, 0 a 1 exclusive-ish (Anki padrão: 0.9). Controla o
    /// quão apertado [`proximo_intervalo`] agenda a próxima revisão.
    pub retencao_desejada: f64,
    /// Atrasos (em segundos) de cada passo de aprendizagem, na ordem em que
    /// são percorridos. Padrão da referência: `[60, 600]` (1 min, 10 min).
    /// Ver decisão 2 no cabeçalho do módulo para por que é `u32` segundos e
    /// não `Duration`.
    pub learning_steps_seg: Vec<u32>,
    /// Mesma ideia, para depois de um lapso. Padrão da referência: `[600]`
    /// (10 min).
    pub relearning_steps_seg: Vec<u32>,
    /// Teto de qualquer intervalo em dias. Padrão da referência: 36500
    /// (~100 anos). [`TETO_ABSOLUTO_INTERVALO_DIAS`] ainda se aplica por
    /// cima (decisão 6).
    pub maximum_interval_dias: i64,
    /// Liga/desliga o fuzz determinístico do intervalo (ver
    /// [`fuzz_intervalo`]).
    pub fuzz_habilitado: bool,
}

impl Default for Parametros {
    /// Os mesmos padrões do `Scheduler()` sem argumentos, na referência.
    fn default() -> Self {
        Self {
            pesos: PESOS_PADRAO,
            retencao_desejada: 0.9,
            learning_steps_seg: vec![60, 600],
            relearning_steps_seg: vec![600],
            maximum_interval_dias: 36_500,
            fuzz_habilitado: true,
        }
    }
}

/// O que [`agendar`] devolve: o novo [`EstadoCartao`] e a próxima data de
/// revisão. Ao contrário do SM-2, o FSRS não tem noção de "leech" — essa
/// política é responsabilidade de quem monta a fila de estudo, se quiser
/// aplicá-la por cima.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProximoEstado {
    pub estado: EstadoCartao,
    pub proxima_revisao: DateTime<Utc>,
}

/// O coração do módulo: dado o estado FSRS atual de um cartão, a nota dada
/// agora, os parâmetros do modelo e o instante presente, decide o próximo
/// estado. Puro e total — nunca entra em pânico para nenhuma combinação de
/// entradas (ver decisões 5/6/9). `fuzz_semente` alimenta o jitter
/// determinístico do intervalo — mesma semente, mesmo resultado, sempre.
pub fn agendar(
    estado: &EstadoCartao,
    nota: Avaliacao,
    parametros: &Parametros,
    agora: DateTime<Utc>,
    fuzz_semente: u64,
) -> ProximoEstado {
    match estado.fase {
        Fase::New | Fase::Learning => revisar_em_passos(
            parametros,
            Fase::Learning,
            &parametros.learning_steps_seg,
            estado.step.unwrap_or(0),
            estado.memoria,
            nota,
            agora,
            fuzz_semente,
        ),
        Fase::Relearning => revisar_em_passos(
            parametros,
            Fase::Relearning,
            &parametros.relearning_steps_seg,
            estado.step.unwrap_or(0),
            estado.memoria,
            nota,
            agora,
            fuzz_semente,
        ),
        Fase::Review => match estado.memoria {
            Some(memoria) => revisar_em_revisao(parametros, memoria, nota, agora, fuzz_semente),
            // Estado hostil/corrompido: `Review` sem memória nunca deveria
            // acontecer (é sempre montada junto — decisão 3), mas a função
            // é total, então trata como se o cartão nunca tivesse sido
            // revisado, igual a um cartão novo caindo direto em Learning.
            None => revisar_em_passos(
                parametros,
                Fase::Learning,
                &parametros.learning_steps_seg,
                0,
                None,
                nota,
                agora,
                fuzz_semente,
            ),
        },
    }
}

/// O que sai de um passo de aprendizagem/reaprendizagem: ou o cartão fica
/// numa fase de passos (com novo índice e atraso), ou gradua.
enum ResultadoPasso {
    Permanece { proximo_passo: u32, atraso_seg: u32 },
    Gradua,
}

/// Avança (ou não) um índice de passo — compartilhado entre `Learning` e
/// `Relearning`, que só diferem na lista de passos que usam. Reproduz
/// `review_card` da referência bloco a bloco, incluindo o caso de borda em
/// que a lista de passos encolheu desde a última vez que o cartão foi
/// agendado (`card.step >= len(steps)` com nota diferente de `Again`).
fn avancar_passo_fsrs(passos: &[u32], passo_atual: u32, nota: Avaliacao) -> ResultadoPasso {
    if passos.is_empty() || (passo_atual as usize >= passos.len() && nota != Avaliacao::Again) {
        return ResultadoPasso::Gradua;
    }

    match nota {
        Avaliacao::Again => ResultadoPasso::Permanece {
            proximo_passo: 0,
            atraso_seg: passos[0],
        },
        Avaliacao::Hard => {
            // O guard acima garante `passo_atual < passos.len()` em todo
            // outro ramo (só `Again` chega aqui sem essa garantia, e não
            // cai neste braço).
            let atraso_seg = if passo_atual == 0 && passos.len() == 1 {
                vezes_um_e_meio_seg(passos[0])
            } else if passo_atual == 0 && passos.len() >= 2 {
                media_seg(passos[0], passos[1])
            } else {
                passos[passo_atual as usize]
            };
            ResultadoPasso::Permanece {
                proximo_passo: passo_atual,
                atraso_seg,
            }
        }
        Avaliacao::Good => {
            let proximo = passo_atual.saturating_add(1);
            match passos.get(proximo as usize) {
                Some(&atraso_seg) => ResultadoPasso::Permanece {
                    proximo_passo: proximo,
                    atraso_seg,
                },
                None => ResultadoPasso::Gradua,
            }
        }
        Avaliacao::Easy => ResultadoPasso::Gradua,
    }
}

/// `round((a + b) / 2)` em segundos, sem estourar `u32` na soma
/// intermediária (feita em `u64`) — a média de dois valores não pode
/// exceder o maior dos dois, então sempre cabe de volta em `u32`;
/// `unwrap_or(u32::MAX)` documenta esse invariante sem assumi-lo às cegas.
fn media_seg(a: u32, b: u32) -> u32 {
    let media = (u64::from(a) + u64::from(b)) / 2;
    u32::try_from(media).unwrap_or(u32::MAX)
}

/// `a * 1.5` em segundos. Feito em `u64` porque `a * 3` pode passar de
/// `u32::MAX` para um passo hostilmente grande; `try_from` com fallback
/// para `u32::MAX` é a resposta "satura" — o mesmo espírito das
/// `saturating_*` que o resto do crate usa para entrada hostil.
fn vezes_um_e_meio_seg(a: u32) -> u32 {
    let vezes = u64::from(a) * 3 / 2;
    u32::try_from(vezes).unwrap_or(u32::MAX)
}

/// Atualiza estabilidade e dificuldade antes de decidir o próximo passo —
/// reproduz o `if stability is None or difficulty is None / elif
/// days_since_last_review < 1 / else` da referência, comum aos três braços
/// de `review_card` (`Learning`, `Review`, `Relearning`).
fn atualizar_memoria(
    pesos: &[f64; 21],
    decay: f64,
    factor: f64,
    memoria: Option<Memoria>,
    nota: Avaliacao,
    agora: DateTime<Utc>,
) -> (f64, f64) {
    match memoria {
        None => (
            estabilidade_inicial(pesos, nota),
            dificuldade_inicial(pesos, nota, true),
        ),
        Some(m) => {
            let dias_desde = (agora - m.ultima_revisao).num_days();
            if dias_desde < 1 {
                (
                    estabilidade_curto_prazo(pesos, m.estabilidade, nota),
                    proxima_dificuldade(pesos, m.dificuldade, nota),
                )
            } else {
                let r = retrievability(decay, factor, dias_desde.max(0), m.estabilidade);
                (
                    proxima_estabilidade(pesos, m.dificuldade, m.estabilidade, r, nota),
                    proxima_dificuldade(pesos, m.dificuldade, nota),
                )
            }
        }
    }
}

/// Braço comum de `Learning`/`Relearning`: atualiza memória, decide o
/// próximo passo, e monta o [`ProximoEstado`] correspondente.
#[allow(clippy::too_many_arguments)]
fn revisar_em_passos(
    parametros: &Parametros,
    fase_dos_passos: Fase,
    passos: &[u32],
    passo_atual: u32,
    memoria: Option<Memoria>,
    nota: Avaliacao,
    agora: DateTime<Utc>,
    fuzz_semente: u64,
) -> ProximoEstado {
    let decay = -parametros.pesos[20];
    let factor = 0.9_f64.powf(1.0 / decay) - 1.0;

    let (estabilidade, dificuldade) =
        atualizar_memoria(&parametros.pesos, decay, factor, memoria, nota, agora);
    let nova_memoria = Memoria {
        estabilidade,
        dificuldade,
        ultima_revisao: agora,
    };

    match avancar_passo_fsrs(passos, passo_atual, nota) {
        ResultadoPasso::Permanece {
            proximo_passo,
            atraso_seg,
        } => ProximoEstado {
            estado: EstadoCartao {
                fase: fase_dos_passos,
                step: Some(proximo_passo),
                memoria: Some(nova_memoria),
            },
            // Alargamento puro `u32 -> i64`: nunca trunca.
            proxima_revisao: agora + Duration::seconds(i64::from(atraso_seg)),
        },
        ResultadoPasso::Gradua => {
            let dias = intervalo_com_fuzz(decay, factor, estabilidade, parametros, fuzz_semente);
            ProximoEstado {
                estado: EstadoCartao {
                    fase: Fase::Review,
                    step: None,
                    memoria: Some(nova_memoria),
                },
                proxima_revisao: agora + Duration::days(dias),
            }
        }
    }
}

/// Braço `Review` de `review_card`: atualiza memória e decide o intervalo
/// (ou desvia para `Relearning` em caso de lapso com passos configurados).
fn revisar_em_revisao(
    parametros: &Parametros,
    memoria: Memoria,
    nota: Avaliacao,
    agora: DateTime<Utc>,
    fuzz_semente: u64,
) -> ProximoEstado {
    let decay = -parametros.pesos[20];
    let factor = 0.9_f64.powf(1.0 / decay) - 1.0;

    let dias_desde = (agora - memoria.ultima_revisao).num_days();
    let nova_estabilidade = if dias_desde < 1 {
        estabilidade_curto_prazo(&parametros.pesos, memoria.estabilidade, nota)
    } else {
        let r = retrievability(decay, factor, dias_desde.max(0), memoria.estabilidade);
        proxima_estabilidade(
            &parametros.pesos,
            memoria.dificuldade,
            memoria.estabilidade,
            r,
            nota,
        )
    };
    let nova_dificuldade = proxima_dificuldade(&parametros.pesos, memoria.dificuldade, nota);
    let nova_memoria = Memoria {
        estabilidade: nova_estabilidade,
        dificuldade: nova_dificuldade,
        ultima_revisao: agora,
    };

    if nota == Avaliacao::Again && !parametros.relearning_steps_seg.is_empty() {
        return ProximoEstado {
            estado: EstadoCartao {
                fase: Fase::Relearning,
                step: Some(0),
                memoria: Some(nova_memoria),
            },
            proxima_revisao: agora
                + Duration::seconds(i64::from(parametros.relearning_steps_seg[0])),
        };
    }

    // `Again` sem passo de reaprendizagem configurado, ou `Hard`/`Good`/
    // `Easy`: sempre fica em `Review`, intervalo recalculado.
    let dias = intervalo_com_fuzz(decay, factor, nova_estabilidade, parametros, fuzz_semente);
    ProximoEstado {
        estado: EstadoCartao {
            fase: Fase::Review,
            step: None,
            memoria: Some(nova_memoria),
        },
        proxima_revisao: agora + Duration::days(dias),
    }
}

fn intervalo_com_fuzz(
    decay: f64,
    factor: f64,
    estabilidade: f64,
    parametros: &Parametros,
    fuzz_semente: u64,
) -> i64 {
    let dias = proximo_intervalo(
        decay,
        factor,
        parametros.retencao_desejada,
        estabilidade,
        parametros.maximum_interval_dias,
    );
    fuzz_intervalo(dias, parametros, fuzz_semente)
}

fn nota_valor(nota: Avaliacao) -> i32 {
    match nota {
        Avaliacao::Again => 1,
        Avaliacao::Hard => 2,
        Avaliacao::Good => 3,
        Avaliacao::Easy => 4,
    }
}

/// `clamp_stability` da referência: só piso, sem teto. `NaN.max(x) == x`
/// pela semântica de `f64::max` do Rust (minNum/maxNum do IEEE 754), então
/// isto nunca entra em pânico mesmo com uma estabilidade não-finita vinda
/// de uma fórmula hostil — ao contrário de `f64::clamp`, que pania em NaN.
fn clamp_stability(estabilidade: f64) -> f64 {
    estabilidade.max(STABILITY_MIN)
}

/// `clamp_difficulty` da referência. `f64::clamp` só pania se os limites
/// forem invertidos ou `NaN` — `MIN_DIFFICULTY`/`MAX_DIFFICULTY` são
/// constantes fixas e válidas, então isto nunca pania; uma `dificuldade`
/// não-finita apenas propaga `NaN` de volta (mesmo comportamento da
/// referência, que não trata esse caso).
fn clamp_difficulty(dificuldade: f64) -> f64 {
    dificuldade.clamp(MIN_DIFFICULTY, MAX_DIFFICULTY)
}

/// `_initial_stability`: `clamp_stability(w[rating - 1])`.
fn estabilidade_inicial(pesos: &[f64; 21], nota: Avaliacao) -> f64 {
    let indice = (nota_valor(nota) - 1) as usize; // 0..=3, sempre dentro de `pesos`.
    clamp_stability(pesos[indice])
}

/// `_initial_difficulty`: `w[4] - e^(w[5] * (rating - 1)) + 1`, com clamp
/// opcional (decisão do BAR: o clamp É pulado quando esta função é chamada
/// de dentro de `_next_difficulty` para o termo `a1`).
fn dificuldade_inicial(pesos: &[f64; 21], nota: Avaliacao, clamp: bool) -> f64 {
    let r = f64::from(nota_valor(nota));
    let d = pesos[4] - (pesos[5] * (r - 1.0)).exp() + 1.0;
    if clamp {
        clamp_difficulty(d)
    } else {
        d
    }
}

/// `_next_difficulty`: reversão à média entre a dificuldade inicial de um
/// "Easy" hipotético (sem clamp) e a dificuldade atual amortecida pela nota
/// dada.
fn proxima_dificuldade(pesos: &[f64; 21], dificuldade: f64, nota: Avaliacao) -> f64 {
    let r = f64::from(nota_valor(nota));
    let a1 = dificuldade_inicial(pesos, Avaliacao::Easy, false);
    let delta_dificuldade = -(pesos[6] * (r - 3.0));
    let amortecimento = (10.0 - dificuldade) * delta_dificuldade / 9.0;
    let a2 = dificuldade + amortecimento;
    let reversao_a_media = pesos[7] * a1 + (1.0 - pesos[7]) * a2;
    clamp_difficulty(reversao_a_media)
}

/// `get_card_retrievability`: probabilidade estimada de recordar, dado
/// quantos dias se passaram desde a última revisão.
fn retrievability(decay: f64, factor: f64, elapsed_days: i64, estabilidade: f64) -> f64 {
    // `elapsed_days` já vem não-negativo de quem chama (decisão 8); widening
    // puro `i64 -> f64` na prática (dias de estudo nunca chegam perto de
    // 2^53).
    let dias = elapsed_days as f64;
    (1.0 + factor * dias / estabilidade).powf(decay)
}

/// `_short_term_stability`: usada quando a revisão acontece no mesmo dia da
/// anterior (`days_since_last_review < 1`). O piso de 1.0 no incremento só
/// vale fora de `Again` (decisão do BAR).
fn estabilidade_curto_prazo(pesos: &[f64; 21], estabilidade: f64, nota: Avaliacao) -> f64 {
    let r = f64::from(nota_valor(nota));
    let incremento = (pesos[17] * (r - 3.0 + pesos[18])).exp() * estabilidade.powf(-pesos[19]);
    let incremento = match nota {
        Avaliacao::Again => incremento,
        Avaliacao::Hard | Avaliacao::Good | Avaliacao::Easy => incremento.max(1.0),
    };
    clamp_stability(estabilidade * incremento)
}

/// `_next_recall_stability`: usada em `Hard`/`Good`/`Easy` quando a revisão
/// acontece em dia diferente da anterior.
fn proxima_estabilidade_recall(
    pesos: &[f64; 21],
    dificuldade: f64,
    estabilidade: f64,
    retrievability: f64,
    nota: Avaliacao,
) -> f64 {
    let hard_penalty = if nota == Avaliacao::Hard {
        pesos[15]
    } else {
        1.0
    };
    let easy_bonus = if nota == Avaliacao::Easy {
        pesos[16]
    } else {
        1.0
    };

    estabilidade
        * (1.0
            + pesos[8].exp()
                * (11.0 - dificuldade)
                * estabilidade.powf(-pesos[9])
                * (((1.0 - retrievability) * pesos[10]).exp() - 1.0)
                * hard_penalty
                * easy_bonus)
}

/// `_next_forget_stability`: usada em `Again` quando a revisão acontece em
/// dia diferente da anterior (o lapso "de verdade", não o `Again` dentro de
/// `Learning`/`Relearning`, que passa por `estabilidade_curto_prazo`).
fn proxima_estabilidade_esquecimento(
    pesos: &[f64; 21],
    dificuldade: f64,
    estabilidade: f64,
    retrievability: f64,
) -> f64 {
    let longo_prazo = pesos[11]
        * dificuldade.powf(-pesos[12])
        * (((estabilidade + 1.0).powf(pesos[13])) - 1.0)
        * ((1.0 - retrievability) * pesos[14]).exp();
    let curto_prazo = estabilidade / (pesos[17] * pesos[18]).exp();

    longo_prazo.min(curto_prazo)
}

/// `_next_stability`: despacha para esquecimento (`Again`) ou recall
/// (`Hard`/`Good`/`Easy`), sempre clampando o resultado.
fn proxima_estabilidade(
    pesos: &[f64; 21],
    dificuldade: f64,
    estabilidade: f64,
    retrievability: f64,
    nota: Avaliacao,
) -> f64 {
    let s = if nota == Avaliacao::Again {
        proxima_estabilidade_esquecimento(pesos, dificuldade, estabilidade, retrievability)
    } else {
        proxima_estabilidade_recall(pesos, dificuldade, estabilidade, retrievability, nota)
    };
    clamp_stability(s)
}

/// `_next_interval`: intervalo em dias inteiros para atingir a retenção
/// desejada com a estabilidade dada, arredondado meia-para-longe-do-zero
/// (igual ao `f64::round` do Rust — ver decisão do BAR), e clampado ao piso
/// de 1 dia e ao teto configurado.
fn proximo_intervalo(
    decay: f64,
    factor: f64,
    retencao_desejada: f64,
    estabilidade: f64,
    maximo_dias: i64,
) -> i64 {
    let bruto = (estabilidade / factor) * (retencao_desejada.powf(1.0 / decay) - 1.0);

    // Só chega a não-finito com parâmetros hostis (`factor == 0.0`, que
    // exige `decay == 0.0`, fora da faixa documentada no BAR para `w[20]`).
    // Cair no piso de 1 dia em vez de propagar NaN/infinito é o que mantém
    // esta função total (decisão 5/9).
    let dias = if bruto.is_finite() {
        // `as i64`: o cast de float pra inteiro do Rust satura desde 1.45
        // (nunca UB), e `bruto` fica na faixa de dias de estudo — nunca
        // perto do alcance de `i64` mesmo antes do clamp abaixo.
        bruto.round() as i64
    } else {
        1
    };

    dias.max(1)
        .min(maximo_dias.max(1))
        .min(TETO_ABSOLUTO_INTERVALO_DIAS)
}

/// Mesmas faixas de fuzz da referência (`FUZZ_RANGES`): 15% de folga entre
/// 2.5 e 7 dias, 10% entre 7 e 20, 5% acima de 20 — a fórmula exata é o
/// contrato aqui (item do BAR), diferente do fuzz fixo em ±5% que o SM-2
/// deste crate usa em `mod.rs` (lá era simplificação deliberada; aqui não).
fn fuzz_intervalo(dias: i64, parametros: &Parametros, semente: u64) -> i64 {
    const FAIXAS: [(f64, f64, f64); 3] = [
        (2.5, 7.0, 0.15),
        (7.0, 20.0, 0.10),
        (20.0, f64::INFINITY, 0.05),
    ];

    // A referência compara `interval_days < 2.5` com um valor inteiro; como
    // `dias` já é um `i64` (intervalos são sempre dias inteiros), isso
    // equivale a `dias <= 2` — nunca existe um `dias` fracionário de 2.5.
    if !parametros.fuzz_habilitado || dias <= 2 {
        return dias;
    }

    let dias_f = dias as f64; // alargamento: `dias` já está limitado pelo teto absoluto, cabe em f64 sem perda relevante.
    let delta = 1.0
        + FAIXAS
            .iter()
            .map(|&(inicio, fim, fator)| fator * (dias_f.min(fim) - inicio).max(0.0))
            .sum::<f64>();

    // `as i64`: ver o comentário de segurança em `proximo_intervalo` — o
    // cast satura (nunca UB), e estes valores ficam a poucas unidades de
    // `dias`, que já está limitado ao teto absoluto.
    let minimo = ((dias_f - delta).round() as i64).max(2);
    let maximo = ((dias_f + delta).round() as i64)
        .min(parametros.maximum_interval_dias.max(1))
        .min(TETO_ABSOLUTO_INTERVALO_DIAS);
    let minimo = minimo.min(maximo);

    // `amplitude_bruta` é sempre >= 1 (`minimo <= maximo`, garantido acima)
    // e no máximo `TETO_ABSOLUTO_INTERVALO_DIAS`, que cabe em `u64` sem
    // ambiguidade — `try_from` com fallback documenta isso sem assumir.
    let amplitude_bruta = maximo.saturating_sub(minimo).saturating_add(1);
    let amplitude = u64::try_from(amplitude_bruta).unwrap_or(1).max(1);

    let bruto = splitmix64(semente ^ dias_para_semente(dias));
    // `bruto % amplitude` é sempre estritamente menor que `amplitude`, que
    // por construção cabe em `i64` (no máximo `TETO_ABSOLUTO_INTERVALO_DIAS`)
    // — o `try_from` seguinte nunca falha de verdade, mas o fallback é a
    // defesa contra assumir isso sem prova.
    let deslocamento = i64::try_from(bruto % amplitude).unwrap_or(0);

    (minimo + deslocamento).min(TETO_ABSOLUTO_INTERVALO_DIAS)
}

/// `dias` chega aqui sempre `>= 3` (guardado por `fuzz_intervalo`), então
/// cabe em `u64` sem ambiguidade — só serve para dar ao hash uma entrada
/// que varia com o tamanho do intervalo, não só com a semente.
fn dias_para_semente(dias: i64) -> u64 {
    u64::try_from(dias).unwrap_or(0)
}

/// Cópia local do mesmo gerador determinístico de `mod.rs` (decisão 7 do
/// cabeçalho: a função de lá é privada, então este é o mesmo algoritmo de
/// domínio público — SplitMix64 — reescrito aqui, não uma dependência
/// nova). Não é para uso criptográfico, só para espalhar o jitter do fuzz.
fn splitmix64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod testes {
    // Regra 3 isenta `#[cfg(test)]` da proibição de unwrap/expect; o lint
    // do clippy não conhece essa isenção, por isso o `allow` explícito
    // (mesmo padrão do módulo `tests` em `mod.rs`).
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use chrono::TimeZone;

    fn tolerancia(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    /// `test_review_card` da referência: sequência exata de 13 avaliações
    /// sobre um cartão novo, sem fuzz, cada revisão acontecendo exatamente
    /// no `due` da anterior. Os intervalos registrados (em dias) precisam
    /// bater exatamente com o vetor dourado.
    #[test]
    fn reproduz_test_review_card() {
        let parametros = Parametros {
            fuzz_habilitado: false,
            ..Parametros::default()
        };
        let notas = [
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Again,
            Avaliacao::Again,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
            Avaliacao::Good,
        ];

        let mut estado = EstadoCartao::novo();
        let mut agora = Utc.with_ymd_and_hms(2022, 11, 29, 12, 30, 0).unwrap();
        let mut intervalos = Vec::with_capacity(notas.len());

        for nota in notas {
            let proximo = agendar(&estado, nota, &parametros, agora, 1);
            let ivl = (proximo.proxima_revisao - agora).num_days();
            intervalos.push(ivl);
            estado = proximo.estado;
            agora = proximo.proxima_revisao;
        }

        assert_eq!(intervalos, vec![0, 2, 11, 46, 163, 498, 0, 0, 2, 4, 7, 12, 21]);
    }

    /// `test_memo_state` da referência: seis avaliações com o tempo
    /// avançando por um `ivl_history` fixo (não pelo `due` calculado),
    /// terminando em uma estabilidade e dificuldade conhecidas.
    #[test]
    fn reproduz_test_memo_state() {
        let parametros = Parametros {
            fuzz_habilitado: false, // fuzz nunca toca stability/difficulty; desligado só por limpeza do teste.
            ..Parametros::default()
        };
        let notas_e_avancos = [
            (Avaliacao::Again, 0),
            (Avaliacao::Good, 0),
            (Avaliacao::Good, 1),
            (Avaliacao::Good, 3),
            (Avaliacao::Good, 8),
            (Avaliacao::Good, 21),
        ];

        let mut estado = EstadoCartao::novo();
        let mut agora = Utc.with_ymd_and_hms(2022, 11, 29, 12, 30, 0).unwrap();

        for (nota, avanco_dias) in notas_e_avancos {
            agora += Duration::days(avanco_dias);
            estado = agendar(&estado, nota, &parametros, agora, 1).estado;
        }

        let memoria = estado.memoria.expect("cartão revisado 6 vezes deve ter memória");
        assert!(
            tolerancia(memoria.estabilidade, 53.62691, 1e-4),
            "stability esperada 53.62691, obtida {}",
            memoria.estabilidade
        );
        assert!(
            tolerancia(memoria.dificuldade, 6.3574867, 1e-4),
            "difficulty esperada 6.3574867, obtida {}",
            memoria.dificuldade
        );
    }

    /// `test_repeated_correct_reviews` da referência: 10 revisões `Easy`
    /// seguidas, separadas por 1 microssegundo (efetivamente no mesmo dia),
    /// devem levar a dificuldade exatamente ao piso 1.0.
    #[test]
    fn reproduz_test_repeated_correct_reviews() {
        let parametros = Parametros::default();
        let mut estado = EstadoCartao::novo();
        let base = Utc.with_ymd_and_hms(2022, 11, 29, 12, 30, 0).unwrap();

        for i in 0..10i64 {
            let agora = base + Duration::microseconds(i);
            estado = agendar(&estado, Avaliacao::Easy, &parametros, agora, 1).estado;
        }

        let memoria = estado.memoria.expect("10 revisões devem deixar memória");
        assert_eq!(memoria.dificuldade, 1.0);
    }

    // ---- casos de borda, além dos três vetores dourados exigidos --------

    #[test]
    fn estabilidade_nunca_fica_abaixo_do_piso() {
        // `Again` repetido, sempre um dia depois (fora do ramo de curto
        // prazo), é o caminho que mais aperta a estabilidade para baixo.
        let parametros = Parametros {
            fuzz_habilitado: false,
            ..Parametros::default()
        };
        let mut estado = EstadoCartao::novo();
        let mut agora = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();

        for _ in 0..50 {
            let proximo = agendar(&estado, Avaliacao::Again, &parametros, agora, 7);
            estado = proximo.estado;
            agora = proximo.proxima_revisao + Duration::days(1);
        }

        let memoria = estado.memoria.expect("cartão revisado deve ter memória");
        assert!(memoria.estabilidade >= STABILITY_MIN);
    }

    #[test]
    fn cartao_novo_sem_memoria_usa_estabilidade_e_dificuldade_iniciais() {
        let parametros = Parametros {
            fuzz_habilitado: false,
            ..Parametros::default()
        };
        let estado = EstadoCartao::novo();
        let agora = Utc.with_ymd_and_hms(2025, 3, 10, 8, 0, 0).unwrap();

        let proximo = agendar(&estado, Avaliacao::Good, &parametros, agora, 1);
        let memoria = proximo
            .estado
            .memoria
            .expect("primeira revisão sempre grava memória");

        assert!(tolerancia(memoria.estabilidade, PESOS_PADRAO[2], 1e-9));
        assert_eq!(proximo.estado.fase, Fase::Learning);
        assert_eq!(proximo.estado.step, Some(1));
    }
}
