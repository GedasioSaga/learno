//! Repositório da Trilha (Fase 6, TRL-*) — `0023_trilha.sql`.
//!
//! Leia o comentário de topo daquela migração antes de mexer aqui: ele é a
//! especificação desta peça. O resumo que este arquivo segue à risca:
//!
//! - **etapa** é uma página-registro (`pages` com `database_id` setado) — não
//!   existe tabela de etapa aqui, só leitura de `pages`.
//! - **flecha** é `database_record_dependencies` (0020), a MESMA aresta de
//!   "B bloqueada por A" que a view Tabela usa (TRL-003). Este arquivo nunca
//!   grava naquela tabela pela metade — só lê.
//! - **raia** é um valor da propriedade de agrupamento (TRL-007), já gravado
//!   em `database_record_values`. `trail_lanes` guarda só o que esse valor
//!   não sabe: ordem vertical e recolhimento. "Renomear uma raia" e "mover
//!   uma etapa de raia" escrevem em `database_record_values` — e isso passa
//!   **sempre** por `db::record_values::RecordValueRepository`, o único
//!   caminho de escrita daquela tabela (I4). Nenhuma linha SQL crua contra
//!   `database_record_values` existe neste arquivo.
//! - **O EIXO É DEPENDÊNCIA, NUNCA TEMPO.** A coluna de cada etapa
//!   (`level`) é derivada do grafo de flechas a cada leitura
//!   ([`calcular_niveis_topologicos`]), nunca gravada.
//!
//! `db::position` (índice fracionário) é reusado para a ordem das raias e
//! para a ordem dos materiais de uma etapa — a mesma convenção que
//! `db::pages`/`db::blocks`/`db::cronograma` já usam para irmãos.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::databases::DatabaseRepository;
use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::pages::{PageRepository, PageRow};
use crate::db::position;
use crate::db::record_values::{RecordValueChangeInput, RecordValueRepository};
use crate::db::sql;
use crate::error::{Error, Result};

/// Espelha `state IN ('in_progress', 'done')` de `trail_step_progress` —
/// validado aqui para que um valor fora dessa lista vire `Error::Invalid`
/// legível, não um `Error::Database` opaco (mesmo padrão de
/// `VALID_ACTIVITIES` em `db::cronograma`).
const VALID_PROGRESS_STATES: [&str; 2] = ["in_progress", "done"];

/// Espelha `kind IN ('page', 'deck', 'book')` de `trail_step_materials`.
const VALID_MATERIAL_KINDS: [&str; 3] = ["page", "deck", "book"];

/// `trail_views` — a configuração de uma view Trilha. `group_property_id`
/// ausente é a raia única sem título (TRL-014, estado válido, não erro).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguracaoTrilha {
    #[sqlx(try_from = "DbId")]
    pub view_id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    pub group_property_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `trail_lanes` — uma raia: só a ordem vertical e o recolhimento, nunca a
/// lista de etapas (ver o comentário de topo do arquivo).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Raia {
    #[sqlx(try_from = "DbId")]
    pub view_id: Uuid,
    pub lane_value: String,
    pub position: String,
    pub is_collapsed: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Uma etapa como a tela Trilha precisa dela: dados da página-registro,
/// mais três campos que NENHUMA coluna guarda porque são derivados a cada
/// leitura — `level`/`in_cycle` (TRL-002/TRL-005, ver
/// [`calcular_niveis_topologicos`]) e `is_unlocked` (TRL-006: "calculado,
/// não marcado à mão").
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Etapa {
    pub id: Uuid,
    pub title: String,
    pub icon: Option<String>,
    /// O texto puro do valor da propriedade de agrupamento (ou `""` para
    /// "sem raia") — a mesma forma que `trail_lanes.lane_value` guarda, ver
    /// o comentário da migração sobre por que os dois lados precisam
    /// concordar exatamente nessa forma.
    pub lane_value: String,
    /// `pages.position` (índice fracionário) desta etapa — chega aqui só
    /// para o frontend poder ordenar verticalmente por ela dentro da raia
    /// (hoje cai para `title.localeCompare`, que trava qualquer inversão
    /// sem renomear). Mesma coluna que `move_page` já escreve; nada nasce
    /// aqui, só passa a ser lido.
    pub position: String,
    pub level: i64,
    pub in_cycle: bool,
    pub is_unlocked: bool,
    /// Derivado, nada gravado (0035): onde esta etapa está em relação às
    /// decisões que a alimentam — ver [`avaliar_desbloqueio`].
    pub situacao_no_caminho: SituacaoNoCaminho,
    /// `None` = não iniciada (I1: ausência de linha em
    /// `trail_step_progress`, nunca um valor).
    pub state: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Onde uma etapa está em relação aos caminhos de decisão que a alimentam
/// (0035) — campo derivado de [`Etapa`], nada gravado. Ver o comentário de
/// [`avaliar_desbloqueio`] para a regra completa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SituacaoNoCaminho {
    /// Nenhuma flecha de entrada está morta, ou a etapa não tem flecha de
    /// entrada nenhuma. Estado de nascença de toda etapa comum.
    Ativo,
    /// Ao menos uma flecha de entrada tem rótulo cuja decisão de origem
    /// ainda não escolheu — a etapa está "em suspenso" esperando a escolha.
    AguardandoEscolha,
    /// A etapa tem flecha de entrada, e TODAS estão mortas (rótulo que
    /// perdeu a escolha, ou origem também descartada). Continua visível, na
    /// mesma coluna topológica — nunca escondida, nunca apagada (0035).
    Descartado,
}

/// O resultado de [`avaliar_desbloqueio`] para uma etapa: se ela está
/// disponível, e por quê (ou por que não).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Desbloqueio {
    pub is_unlocked: bool,
    pub situacao: SituacaoNoCaminho,
}

/// Uma flecha (`database_record_dependencies`): `blocking_id` precisa estar
/// com `state = 'done'` para que `blocked_id` fique disponível — a menos que
/// `path_label` esteja preenchido, caso em que ela só conta enquanto a
/// decisão de origem (`blocking_id`) escolher exatamente este rótulo (ver
/// [`avaliar_desbloqueio`], 0035).
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flecha {
    #[sqlx(try_from = "DbId")]
    pub blocked_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub blocking_id: Uuid,
    /// O rótulo do caminho, ou `None` para pré-requisito incondicional.
    /// Só pode ser `Some` quando `blocking_id` é uma decisão (0035).
    pub path_label: Option<String>,
}

/// `trail_step_progress`, devolvido por `marcar_progresso_etapa`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressoDaEtapa {
    #[sqlx(try_from = "DbId")]
    pub step_id: Uuid,
    pub state: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// `trail_decisions` — presença da linha = esta etapa RAMIFICA (é uma
/// decisão), ver o comentário de topo de `0035_trilha_decisao_e_caminhos.sql`
/// para o porquê de ser tabela própria e não valor de propriedade.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decisao {
    #[sqlx(try_from = "DbId")]
    pub step_id: Uuid,
    /// `None` = ainda não escolheu (estado de nascença, válido).
    pub chosen_label: Option<String>,
    pub chosen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `trail_step_materials` — o que uma etapa manda estudar.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDaEtapa {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub step_id: Uuid,
    pub kind: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub page_id: Option<Uuid>,
    #[sqlx(try_from = "DbIdOpt")]
    pub deck_id: Option<Uuid>,
    pub position: String,
    pub created_at: DateTime<Utc>,
}

/// `obter_trilha`'s retorno: a cena inteira de uma vez — a tela monta tudo
/// a partir daqui, como `get_mindmap` (`db::mindmap`) já faz para o mapa
/// mental.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trilha {
    pub configuracao: ConfiguracaoTrilha,
    pub raias: Vec<Raia>,
    pub etapas: Vec<Etapa>,
    pub flechas: Vec<Flecha>,
    pub materiais: Vec<MaterialDaEtapa>,
    /// As decisões cujas etapas pertencem a ESTA trilha — não a união (que
    /// inclui decisões fora dela, usada só internamente para classificar
    /// flechas de entrada vindas de fora, ver [`obter_trilha`]).
    pub decisoes: Vec<Decisao>,
}

/// O que [`TrilhaRepository::prever_troca_de_caminho`] devolve: o impacto de
/// trocar (ou zerar) a escolha de uma decisão, SEM gravar nada — a tela usa
/// isto para avisar antes de escrever de verdade.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactoDaTroca {
    /// Etapas hoje descartadas que passariam a `ativo`/`aguardandoEscolha`.
    pub entram_no_caminho: Vec<Uuid>,
    /// Etapas hoje `ativo`/`aguardandoEscolha` que passariam a `descartado`.
    pub saem_do_caminho: Vec<Uuid>,
    /// Subconjunto de `saemDoCaminho` que tem progresso registrado
    /// (`in_progress` ou `done`) — nada seria apagado, mas o usuário precisa
    /// saber que existe progresso "atrás" do caminho abandonado.
    pub saem_com_progresso: Vec<Uuid>,
    /// Subconjunto de `saemDoCaminho` já concluído (`done`).
    pub saem_concluidas: Vec<Uuid>,
}

/// `criar_trilha_completa`'s retorno: o `database_id` (que `Trilha` sozinha
/// não carrega — `ConfiguracaoTrilha` só guarda `view_id`) mais a cena vazia
/// pronta para a tela abrir, na mesma forma que `obter_trilha` devolveria
/// para essa trilha recém-nascida (raias e etapas vazias, TRL-014).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrilhaRecemCriada {
    pub database_id: Uuid,
    pub trilha: Trilha,
}

/// Uma linha de [`TrilhaRepository::listar_trilhas`] — o suficiente para o
/// painel da seção montar a lista de troca e guardar o ponteiro
/// (`containerPageId` + `viewId`) no `localStorage`, sem carregar a trilha
/// inteira (etapas, flechas, materiais) só para desenhar um nome numa lista.
/// `nome` vem de `databases.name`, não de `database_views.name` — os dois
/// nascem iguais em `criar_trilha_completa` e o painel os mantém iguais ao
/// renomear (`rename_database` + `rename_view` juntos), mas é a database
/// quem `rename_database` edita, então é ela quem esta consulta lê.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrilhaResumo {
    #[sqlx(try_from = "DbId")]
    pub view_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub database_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub container_page_id: Uuid,
    pub nome: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// O nível topológico de uma etapa — ver [`calcular_niveis_topologicos`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NivelTopologico {
    pub nivel: i64,
    pub em_ciclo: bool,
}

/// Marcador fora da faixa normal de nível (que é sempre `>= 0`) para uma
/// etapa em ciclo, ou que depende de uma. Nunca é confundido com um nível de
/// verdade, e não exige saber o maior nível já atribuído no grafo.
const NIVEL_EM_CICLO: i64 = -1;

/// TRL-002: o nível topológico de cada etapa, derivado das flechas
/// (bloqueadora -> bloqueada). Uma etapa sem nenhuma flecha entrando fica no
/// nível 0; qualquer outra fica um nível depois da mais profunda das que a
/// bloqueiam.
///
/// Implementado como Kahn's algorithm (fila de grau de entrada), não DFS
/// recursivo: cada nó só é enfileirado depois que TODA bloqueadora dele já
/// foi processada, então "nível da bloqueadora mais funda + 1" já está
/// disponível no instante em que o nível do nó é fixado — sem recursão,
/// então sem risco de estouro de pilha numa cadeia longa.
///
/// CICLO (TRL-005) é o caso que este algoritmo precisa não travar: o banco
/// permite gravar `A bloqueia B` e `B bloqueia A`. Os dois nunca têm grau de
/// entrada zero (cada um está esperando o outro), então a fila nunca os
/// alcança — nem os que dependem deles, transitivamente. Em vez de deixar a
/// fila estagnar num laço, os nós que sobram depois que ela esvazia são
/// exatamente esses: cada um recebe `em_ciclo = true` e o nível-marcador
/// [`NIVEL_EM_CICLO`], para a UI desenhá-los numa coluna própria sem
/// confundir com um nível de verdade.
///
/// "Os nós que sobram" são os que a fila nunca CHEGOU A TIRAR — não os que
/// nunca receberam nível. A diferença só aparece num ciclo que tem entrada de
/// fora dele: `A ⇄ B`, com uma terceira etapa apontando para `A`. Processar
/// essa terceira grava um nível PROVISÓRIO em `A` (o algoritmo relaxa o nível
/// de todo filho ao visitar o pai, muito antes de fixá-lo), e `A` continua
/// esperando `B` para sempre. Enquanto o critério foi "tem nível?", esse `A`
/// escapava da detecção e voltava com `em_ciclo = false` e um nível
/// inventado — o desenho mostrava uma coluna plausível para um grafo que não
/// tem ordem nenhuma. Um ciclo isolado era pego porque ninguém de fora
/// gravava nível provisório nele, e foi por isso que o defeito sobreviveu:
/// o teste que existia usava exatamente esse caso.
pub fn calcular_niveis_topologicos(etapa_ids: &[Uuid], flechas: &[Flecha]) -> HashMap<Uuid, NivelTopologico> {
    let known: HashSet<Uuid> = etapa_ids.iter().copied().collect();

    // `filhos[bloqueadora]` = quem ela desbloqueia; `grau_entrada[bloqueada]`
    // = quantas bloqueadoras essa etapa ainda espera. Uma flecha cujo
    // qualquer lado não está em `etapa_ids` é ignorada: não é deste grafo
    // (ver `obter_trilha`, que já filtra `flechas` a arestas intra-trilha).
    let mut filhos: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let mut grau_entrada: HashMap<Uuid, usize> = etapa_ids.iter().map(|id| (*id, 0)).collect();

    for flecha in flechas {
        if !known.contains(&flecha.blocked_id) || !known.contains(&flecha.blocking_id) {
            continue;
        }
        filhos.entry(flecha.blocking_id).or_default().push(flecha.blocked_id);
        *grau_entrada.entry(flecha.blocked_id).or_insert(0) += 1;
    }

    let mut niveis: HashMap<Uuid, i64> = HashMap::new();
    let mut fila: VecDeque<Uuid> = grau_entrada
        .iter()
        .filter(|(_, grau)| **grau == 0)
        .map(|(id, _)| *id)
        .collect();
    for id in &fila {
        niveis.insert(*id, 0);
    }

    // Quem a fila conseguiu TIRAR — ou seja, quem teve todas as bloqueadoras
    // processadas e por isso tem nível definitivo. Ver o comentário acima
    // sobre por que "recebeu nível" não serve como critério.
    let mut finalizados: HashSet<Uuid> = HashSet::new();

    while let Some(no) = fila.pop_front() {
        finalizados.insert(no);
        let nivel_do_no = niveis.get(&no).copied().unwrap_or(0);
        let Some(filhos_do_no) = filhos.get(&no) else { continue };
        for &filho in filhos_do_no {
            let candidato = nivel_do_no + 1;
            let entrada = niveis.entry(filho).or_insert(candidato);
            if candidato > *entrada {
                *entrada = candidato;
            }
            if let Some(grau) = grau_entrada.get_mut(&filho) {
                *grau -= 1;
                if *grau == 0 {
                    fila.push_back(filho);
                }
            }
        }
    }

    etapa_ids
        .iter()
        .map(|id| match (finalizados.contains(id), niveis.get(id)) {
            (true, Some(nivel)) => (*id, NivelTopologico { nivel: *nivel, em_ciclo: false }),
            // Sem nível ou com nível só provisório: preso num ciclo, ou atrás
            // de um. O nível provisório é descartado de propósito — ele é a
            // metade de uma conta que nunca fechou.
            _ => (*id, NivelTopologico { nivel: NIVEL_EM_CICLO, em_ciclo: true }),
        })
        .collect()
}

/// Como uma flecha de entrada conta para o desbloqueio da etapa que ela
/// alimenta — passo intermediário de [`avaliar_desbloqueio`], nunca exposto
/// fora deste módulo (a API pública só precisa do resultado por etapa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClassificacaoDaFlecha {
    /// Sem rótulo, ou rótulo cuja decisão escolheu exatamente este rótulo.
    /// Conta para o desbloqueio: exige a bloqueadora `done`.
    Viva,
    /// Rótulo cuja decisão ainda não escolheu. NÃO conta como satisfeita —
    /// não dá pra saber se este ramo é o escolhido — mas também não é morta:
    /// a etapa fica `aguardandoEscolha`, não `descartado`.
    Pendente,
    /// Rótulo cuja decisão JÁ escolheu outro, ou que vem de uma etapa
    /// também descartada. IGNORADA para todo o resto — é o que permite dois
    /// caminhos se reencontrarem (0035).
    Morta,
}

/// Classifica uma única flecha de entrada, olhando o estado JÁ CALCULADO das
/// etapas que vieram antes dela na ordem de Kahn (`resultado_parcial`) — se
/// `blocking_id` não está lá ainda (fora do conjunto conhecido, ou ainda não
/// processada), é tratada como "não descartada": postura conservadora, igual
/// à de `calcular_niveis_topologicos` para nó fora do grafo.
fn classificar_flecha(
    flecha: &Flecha,
    resultado_parcial: &HashMap<Uuid, Desbloqueio>,
    escolhas: &HashMap<Uuid, Option<String>>,
) -> ClassificacaoDaFlecha {
    let origem_descartada =
        resultado_parcial.get(&flecha.blocking_id).is_some_and(|d| d.situacao == SituacaoNoCaminho::Descartado);
    if origem_descartada {
        return ClassificacaoDaFlecha::Morta;
    }
    let Some(rotulo) = flecha.path_label.as_deref() else {
        return ClassificacaoDaFlecha::Viva;
    };
    // Rótulo cuja origem não está (mais) marcada como decisão — só
    // alcançável pela via que o comentário de 0035 documenta (exclusão
    // definitiva da página da decisão) — degrada para pré-requisito
    // incondicional, nunca bloqueia para sempre.
    match escolhas.get(&flecha.blocking_id) {
        None => ClassificacaoDaFlecha::Viva,
        Some(None) => ClassificacaoDaFlecha::Pendente,
        Some(Some(escolhido)) if escolhido == rotulo => ClassificacaoDaFlecha::Viva,
        Some(Some(_)) => ClassificacaoDaFlecha::Morta,
    }
}

/// 0035: a mesma regra de desbloqueio de TRL-006, estendida para caminhos de
/// decisão — a única implementação que existe no crate (ver o risco #1 do
/// desenho: `obter_trilha` e `marcar_progresso_etapa`/`etapa_esta_desbloqueada`
/// convergem nesta função, para nunca mais divergir de escopo).
///
/// Roda na MESMA ordem de Kahn de [`calcular_niveis_topologicos`] — e pela
/// mesma razão: `descartada(E)` depende da classificação das flechas que
/// entram em E, que por sua vez depende de saber se a ETAPA DE ORIGEM já é
/// descartada, então uma bloqueadora só pode ser avaliada depois que TODAS
/// as etapas que a alimentam já foram resolvidas.
///
/// `etapa_ids` é o universo cujo resultado este cálculo devolve (as etapas
/// da trilha sendo lida, ou só a etapa que uma checagem pontual pediu —
/// sempre acompanhada do grafo INTEIRO da database, nunca uma fatia, porque
/// "descartada" propaga por dependência transitiva). `flechas` é toda
/// dependência que aponta para dentro de `etapa_ids` (mesmo de fora dele —
/// ver o comentário de `obter_trilha` sobre por que "desbloqueada" é uma
/// pergunta global). `escolhas` mapeia `step_id de decisão -> chosen_label`
/// (a CHAVE presente já diz "isto é uma decisão"; o valor `None` diz "ainda
/// não escolheu") — cobre a UNIÃO de `etapa_ids` com toda bloqueadora de
/// fora, para uma decisão na lixeira continuar sendo lida como decisão (ver
/// o comentário de `obter_trilha`). `concluidas` é o conjunto de
/// bloqueadoras com `state = 'done'`.
///
/// Etapa em ciclo (ou que depende de um) nunca é alcançada pela fila — a
/// mesma razão de `calcular_niveis_topologicos` — e por isso NUNCA recebe
/// `situacao = Descartado`: sem uma ordem válida, propagar descarte por cima
/// de um ciclo seria "descartar por engano" (0035 é explícito sobre isso).
/// `is_unlocked` continua sendo calculado normalmente para ela (o pior caso
/// é ficar bloqueada, nunca desbloquear por engano).
pub fn avaliar_desbloqueio(
    etapa_ids: &[Uuid],
    flechas: &[Flecha],
    escolhas: &HashMap<Uuid, Option<String>>,
    concluidas: &HashSet<Uuid>,
) -> HashMap<Uuid, Desbloqueio> {
    let known: HashSet<Uuid> = etapa_ids.iter().copied().collect();

    // Toda flecha que entra numa etapa conhecida — inclusive vinda de fora
    // do conjunto, ver o comentário da função.
    let mut entrando: HashMap<Uuid, Vec<&Flecha>> = HashMap::new();
    for flecha in flechas {
        if known.contains(&flecha.blocked_id) {
            entrando.entry(flecha.blocked_id).or_default().push(flecha);
        }
    }

    // A ORDEM de avaliação só precisa das arestas INTRA-conjunto: uma
    // bloqueadora fora de `etapa_ids` nunca é avaliada aqui (ver
    // `classificar_flecha`), então não há nada para esperar dela.
    let mut filhos: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let mut grau_entrada: HashMap<Uuid, usize> = etapa_ids.iter().map(|id| (*id, 0)).collect();
    for flecha in flechas {
        if known.contains(&flecha.blocked_id) && known.contains(&flecha.blocking_id) {
            filhos.entry(flecha.blocking_id).or_default().push(flecha.blocked_id);
            *grau_entrada.entry(flecha.blocked_id).or_insert(0) += 1;
        }
    }

    let avaliar_no = |resultado: &HashMap<Uuid, Desbloqueio>, id: Uuid, em_ciclo: bool| -> Desbloqueio {
        let Some(incoming) = entrando.get(&id).filter(|lista| !lista.is_empty()) else {
            return Desbloqueio { is_unlocked: true, situacao: SituacaoNoCaminho::Ativo };
        };

        let mut todas_mortas = true;
        let mut alguma_pendente = false;
        let mut satisfeita = true;
        for flecha in incoming.iter().copied() {
            match classificar_flecha(flecha, resultado, escolhas) {
                ClassificacaoDaFlecha::Morta => {}
                ClassificacaoDaFlecha::Pendente => {
                    todas_mortas = false;
                    alguma_pendente = true;
                    satisfeita = false;
                }
                ClassificacaoDaFlecha::Viva => {
                    todas_mortas = false;
                    if !concluidas.contains(&flecha.blocking_id) {
                        satisfeita = false;
                    }
                }
            }
        }

        // Em ciclo, `todas_mortas` nunca vira `Descartado` (comentário da
        // função) — mas `is_unlocked` continua honesto: se de fato não sobra
        // nenhuma flecha viva satisfeita, a etapa continua bloqueada, só não
        // é EXIBIDA como descartada.
        let descartada = todas_mortas;
        let situacao = if descartada && !em_ciclo {
            SituacaoNoCaminho::Descartado
        } else if alguma_pendente {
            SituacaoNoCaminho::AguardandoEscolha
        } else {
            SituacaoNoCaminho::Ativo
        };
        Desbloqueio { is_unlocked: !descartada && satisfeita, situacao }
    };

    let mut resultado: HashMap<Uuid, Desbloqueio> = HashMap::new();
    let mut fila: VecDeque<Uuid> = grau_entrada.iter().filter(|(_, grau)| **grau == 0).map(|(id, _)| *id).collect();

    while let Some(id) = fila.pop_front() {
        let desbloqueio = avaliar_no(&resultado, id, false);
        resultado.insert(id, desbloqueio);
        if let Some(filhos_do_no) = filhos.get(&id) {
            for &filho in filhos_do_no {
                if let Some(grau) = grau_entrada.get_mut(&filho) {
                    *grau -= 1;
                    if *grau == 0 {
                        fila.push_back(filho);
                    }
                }
            }
        }
    }

    // Sobrou alguém: está em ciclo, ou depende (transitivamente) de um —
    // avaliado localmente, sem propagar `Descartado` (comentário da função).
    // O empréstimo imutável de `avaliar_no` termina antes do `insert`
    // seguinte, então as duas chamadas não se sobrepõem — sem precisar de
    // `entry` nem de clonar o mapa parcial.
    for id in etapa_ids {
        if !resultado.contains_key(id) {
            let desbloqueio = avaliar_no(&resultado, *id, true);
            resultado.insert(*id, desbloqueio);
        }
    }

    resultado
}

fn validate_progress_state(state: &str) -> Result<()> {
    if !VALID_PROGRESS_STATES.contains(&state) {
        return Err(Error::Invalid(format!(
            "estado de progresso inválido: {state:?} (esperado um de {VALID_PROGRESS_STATES:?})"
        )));
    }
    Ok(())
}

/// Espelha os dois `CHECK` de `trail_step_materials` em Rust, para que um
/// par kind/alvo errado vire `Error::Invalid` legível em vez do
/// `Error::Database` opaco que a constraint já barraria de qualquer forma —
/// mesmo raciocínio de `create_edge_tx` em `db::mindmap`.
fn validate_material_kind_and_target(
    kind: &str,
    page_id: Option<Uuid>,
    deck_id: Option<Uuid>,
    step_id: Uuid,
) -> Result<()> {
    if !VALID_MATERIAL_KINDS.contains(&kind) {
        return Err(Error::Invalid(format!(
            "tipo de material inválido: {kind:?} (esperado um de {VALID_MATERIAL_KINDS:?})"
        )));
    }
    if kind == "deck" {
        if deck_id.is_none() || page_id.is_some() {
            return Err(Error::Invalid("material do tipo deck precisa de deckId e não pode ter pageId".into()));
        }
        return Ok(());
    }
    if page_id.is_none() || deck_id.is_some() {
        return Err(Error::Invalid(format!("material do tipo {kind} precisa de pageId e não pode ter deckId")));
    }
    if page_id == Some(step_id) {
        return Err(Error::Invalid("um material não pode apontar para a própria etapa".into()));
    }
    Ok(())
}

/// Espelha o `CHECK`/gatilho de 0035 (`trim(path_label) <> ''`) em Rust, para
/// que um rótulo vazio vire `Error::Invalid` legível antes de bater na
/// constraint — mesmo padrão de `validate_material_kind_and_target`.
fn validate_path_label(rotulo: &str) -> Result<()> {
    if rotulo.trim().is_empty() {
        return Err(Error::Invalid("rótulo de caminho não pode ser vazio".into()));
    }
    Ok(())
}

pub struct TrilhaRepository {
    pool: SqlitePool,
}

impl TrilhaRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// A trilha inteira de uma `trail_views.view_id`: raias na ordem,
    /// etapas com nível/desbloqueio já calculados, flechas entre as etapas
    /// desta trilha, e os materiais de cada etapa. Uma trilha recém-criada
    /// (sem raia, sem etapa) é estado válido — as listas simplesmente vêm
    /// vazias, nunca um erro.
    pub async fn obter_trilha(&self, view_id: Uuid) -> Result<Trilha> {
        let (configuracao, database_id) = fetch_view_context(&self.pool, view_id).await?;
        let raias = fetch_lanes(&self.pool, view_id).await?;

        let bases = fetch_step_bases(&self.pool, database_id, configuracao.group_property_id).await?;
        let etapa_ids: Vec<Uuid> = bases.iter().map(|base| base.id).collect();
        let known: HashSet<Uuid> = etapa_ids.iter().copied().collect();

        // Toda dependência que aponta PARA uma etapa desta trilha — mesmo
        // que a bloqueadora seja de outra database — porque "desbloqueada"
        // é uma pergunta global sobre `blocking_id.state`, não uma pergunta
        // limitada ao que esta tela desenha (mesma resposta que
        // `etapa_esta_desbloqueada` dá para uma etapa isolada).
        let todas_dependencias = fetch_dependencies_into(&self.pool, &etapa_ids).await?;

        // As flechas DESENHADAS são só as que ligam duas etapas desta
        // trilha — uma dependência apontando para fora não tem segundo nó
        // pra UI plotar (mesmo filtro que `ensure_nodes_belong_to_mindmap_tx`
        // aplica no mapa mental, por um motivo análogo).
        let flechas: Vec<Flecha> =
            todas_dependencias.iter().filter(|dep| known.contains(&dep.blocking_id)).cloned().collect();

        let bloqueadoras_ids: Vec<Uuid> = todas_dependencias.iter().map(|dep| dep.blocking_id).collect();
        let concluidas = fetch_done_set(&self.pool, &bloqueadoras_ids).await?;

        // Decisões da UNIÃO desta trilha com toda bloqueadora de fora dela —
        // senão uma decisão fora da tela (etapa na lixeira, por exemplo)
        // seria lida como "não é decisão" e degradaria o rótulo dela para
        // incondicional silenciosamente (0035, comentário de `criar_flecha`
        // sobre 0007/DBS-119 é o precedente do mesmo cuidado).
        let mut universo_decisoes = etapa_ids.clone();
        universo_decisoes.extend(bloqueadoras_ids.iter().copied());
        let todas_decisoes = fetch_decisions(&self.pool, &universo_decisoes).await?;
        let escolhas: HashMap<Uuid, Option<String>> =
            todas_decisoes.iter().map(|d| (d.step_id, d.chosen_label.clone())).collect();

        let niveis = calcular_niveis_topologicos(&etapa_ids, &flechas);
        let desbloqueios = avaliar_desbloqueio(&etapa_ids, &todas_dependencias, &escolhas, &concluidas);

        let etapas = bases
            .into_iter()
            .map(|base| {
                let nivel = niveis.get(&base.id).copied().unwrap_or(NivelTopologico { nivel: 0, em_ciclo: false });
                let desbloqueio = desbloqueios
                    .get(&base.id)
                    .copied()
                    .unwrap_or(Desbloqueio { is_unlocked: true, situacao: SituacaoNoCaminho::Ativo });
                Etapa {
                    id: base.id,
                    title: base.title,
                    icon: base.icon,
                    lane_value: base.lane_value,
                    position: base.position,
                    level: nivel.nivel,
                    in_cycle: nivel.em_ciclo,
                    is_unlocked: desbloqueio.is_unlocked,
                    situacao_no_caminho: desbloqueio.situacao,
                    state: base.state,
                    started_at: base.started_at,
                    completed_at: base.completed_at,
                }
            })
            .collect();

        let materiais = fetch_materials(&self.pool, &etapa_ids).await?;

        // Só as decisões QUE PERTENCEM a esta trilha — o resto de
        // `todas_decisoes` (bloqueadoras de fora) não tem nó nenhum nesta
        // tela para desenhar.
        let decisoes = todas_decisoes.into_iter().filter(|d| known.contains(&d.step_id)).collect();

        Ok(Trilha { configuracao, raias, etapas, flechas, materiais, decisoes })
    }

    /// Nasce a configuração da Trilha para uma view já existente — a
    /// migração exige (via gatilho `BEFORE INSERT`) que `view_id` já
    /// referencie uma `database_views` com `view_type = 'trail'`; criar essa
    /// linha genérica de view não é escopo desta peça (arquivo próprio de
    /// database/view, ainda não escrito neste crate). Sem raia nenhuma
    /// ainda — `criar_raia` é chamada separadamente, como o comentário da
    /// migração já documenta ("criar uma Trilha é inserir em `trail_views`
    /// antes de inserir raia").
    pub async fn criar_trilha(&self, view_id: Uuid, group_property_id: Option<Uuid>) -> Result<ConfiguracaoTrilha> {
        sqlx::query_as::<_, ConfiguracaoTrilha>(
            "INSERT INTO trail_views (view_id, group_property_id) VALUES ($1, $2) \
             RETURNING view_id, group_property_id, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(group_property_id.db())
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Toda trilha do workspace, para o painel de troca (item 1 do pedido —
    /// hoje só existe UMA, presa no ponteiro do `localStorage`). Varre
    /// `trail_views` inteira em vez de pedir "a trilha de tal página": listar
    /// as trilhas é justamente descobrir QUAIS páginas olhar, não algo que se
    /// possa fazer uma página de cada vez (ver o comentário de
    /// `localizacao.ts` no frontend sobre essa limitação, que este método
    /// fecha). `p.deleted_at IS NULL` tira as trilhas cujo container foi
    /// apagado (lixeira) — mesma regra que `apagarTrilha` usa no frontend.
    pub async fn listar_trilhas(&self) -> Result<Vec<TrilhaResumo>> {
        sqlx::query_as::<_, TrilhaResumo>(
            "SELECT tv.view_id, d.id AS database_id, d.container_page_id, d.name AS nome, \
                    tv.created_at, tv.updated_at \
             FROM trail_views tv \
             JOIN database_views dv ON dv.id = tv.view_id \
             JOIN databases d ON d.id = dv.database_id \
             JOIN pages p ON p.id = d.container_page_id \
             WHERE p.deleted_at IS NULL \
             ORDER BY tv.created_at",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Configura (ou remove) DEPOIS DA CRIAÇÃO a propriedade que agrupa a
    /// trilha em raias — a trava que o item 3 do pedido pede para abrir.
    /// `criar_trilha`/`criar_trilha_completa` só gravam `group_property_id`
    /// na LINHA QUE NASCE; sem este método, uma trilha criada com `null` (o
    /// único caminho que a UI oferecia até esta entrega) ficava PARA SEMPRE
    /// em "uma raia só" — `criar_raia`/`renomear_raia`/`mover_etapa_para_raia`
    /// recusam com `Error::Invalid` sem uma propriedade configurada, e não
    /// havia como configurá-la fora da criação.
    ///
    /// `Some(id)` exige que `id` nomeie uma propriedade da MESMA database
    /// desta trilha: `fetch_step_bases` casa `record_id` E `property_id` no
    /// `LEFT JOIN`, então uma propriedade de OUTRA database nunca teria
    /// `database_record_values` para os registros daqui — a trilha aceitaria
    /// a configuração e toda etapa mostraria `laneValue = ""` para sempre,
    /// silenciosamente. `None` devolve a trilha ao estado de raia única
    /// (TRL-014) sem apagar raia nem etapa nenhuma — mesmo efeito observável
    /// que `deleteProperty` já produz quando apaga a propriedade em uso (ver
    /// o comentário de `deleteProperty` em `lib/ipc.ts`).
    pub async fn definir_propriedade_de_agrupamento(
        &self,
        view_id: Uuid,
        group_property_id: Option<Uuid>,
    ) -> Result<ConfiguracaoTrilha> {
        let (_configuracao, database_id) = fetch_view_context(&self.pool, view_id).await?;

        if let Some(property_id) = group_property_id {
            let database_repo = DatabaseRepository::new(self.pool.clone());
            let pertence_a_esta_database =
                database_repo.list_properties(database_id).await?.iter().any(|propriedade| propriedade.id == property_id);
            if !pertence_a_esta_database {
                return Err(Error::Invalid(
                    "esta propriedade não pertence à database desta trilha".into(),
                ));
            }
        }

        sqlx::query_as::<_, ConfiguracaoTrilha>(
            "UPDATE trail_views SET group_property_id = $2 WHERE view_id = $1 \
             RETURNING view_id, group_property_id, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(group_property_id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("trilha {view_id}")))
    }

    /// Cria a raia como a última da view — mesmo esquema de
    /// `PageRepository::next_position_under`/`CronogramaRepository::criar_bloco`.
    /// `lane_value` duplicado nesta view vira `Error::Database` (violação da
    /// PK `(view_id, lane_value)`) — não pré-checado, a constraint já é a
    /// fonte da verdade.
    pub async fn criar_raia(&self, view_id: Uuid, lane_value: &str) -> Result<Raia> {
        let last_position: Option<String> =
            sqlx::query_scalar("SELECT position FROM trail_lanes WHERE view_id = $1 ORDER BY position DESC LIMIT 1")
                .bind(view_id.db())
                .fetch_optional(&self.pool)
                .await?;
        let last_index = last_position.as_deref().map(position::parse).transpose()?;
        let new_position = position::between(last_index.as_ref(), None)?;

        sqlx::query_as::<_, Raia>(
            "INSERT INTO trail_lanes (view_id, lane_value, position) VALUES ($1, $2, $3) \
             RETURNING view_id, lane_value, position, is_collapsed, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(lane_value)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Renomeia uma raia — o que, sob este schema, é DUAS operações em DUAS
    /// transações separadas, e é importante entender por quê:
    ///
    /// 1. Reescreve o valor da propriedade de agrupamento em cada etapa que
    ///    estava na raia antiga. Isto é uma escrita em
    ///    `database_record_values`, e I4 exige que ela passe pelo único
    ///    caminho — `RecordValueRepository::apply_record_value_changes` —
    ///    que abre a PRÓPRIA transação. Não há como aninhar essa chamada
    ///    dentro de uma transação que este método também controla sem
    ///    duplicar a lógica de escrita que I4 existe para centralizar.
    /// 2. Move a linha de configuração da raia (posição, recolhimento) da
    ///    chave antiga para a nova, numa transação deste repositório.
    ///
    /// As duas juntas NÃO são atômicas entre si — se o passo 2 falhar depois
    /// do passo 1 ter sido commitado, as etapas já mostram o novo nome mas
    /// `trail_lanes` ainda guarda posição/recolhimento sob a chave antiga.
    /// Não é corrupção (a leitura de `obter_trilha` deriva a raia do valor
    /// gravado, não da linha de `trail_lanes`) — é, na pior hipótese, uma
    /// raia "órfã" com config velha e nenhuma etapa, que a UI mostra vazia
    /// até alguém tentar renomear de novo ou apagá-la. Aceito porque a
    /// alternativa (escrever `database_record_values` por SQL cru aqui,
    /// pulando I4) é pior: pularia cascata de fórmula e automação
    /// silenciosamente para todo `renomear_raia`.
    pub async fn renomear_raia(&self, view_id: Uuid, valor_atual: &str, novo_valor: &str) -> Result<Raia> {
        if valor_atual == novo_valor {
            return fetch_lane(&self.pool, view_id, valor_atual).await;
        }

        let (configuracao, database_id) = fetch_view_context(&self.pool, view_id).await?;
        let group_property_id = configuracao.group_property_id.ok_or_else(|| {
            Error::Invalid("esta trilha não tem propriedade de agrupamento — não há raia para renomear".into())
        })?;

        let etapa_ids =
            fetch_step_ids_with_lane_value(&self.pool, database_id, group_property_id, valor_atual).await?;
        if !etapa_ids.is_empty() {
            let record_repo = RecordValueRepository::new(self.pool.clone());
            let value = if novo_valor.is_empty() { JsonValue::Null } else { JsonValue::String(novo_valor.to_string()) };
            let changes = etapa_ids
                .into_iter()
                .map(|record_id| RecordValueChangeInput { record_id, property_id: group_property_id, value: value.clone() })
                .collect();
            record_repo.apply_record_value_changes(changes).await?;
        }

        let mut tx = self.pool.begin().await?;

        let ja_existe: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM trail_lanes WHERE view_id = $1 AND lane_value = $2)")
                .bind(view_id.db())
                .bind(novo_valor)
                .fetch_one(&mut *tx)
                .await?;
        if ja_existe {
            return Err(Error::Invalid(format!("já existe uma raia chamada {novo_valor:?} nesta trilha")));
        }

        let row = sqlx::query_as::<_, Raia>(
            "UPDATE trail_lanes SET lane_value = $3 WHERE view_id = $1 AND lane_value = $2 \
             RETURNING view_id, lane_value, position, is_collapsed, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(valor_atual)
        .bind(novo_valor)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("raia {valor_atual:?} na trilha {view_id}")))?;

        tx.commit().await?;
        Ok(row)
    }

    /// Reposiciona a raia entre duas vizinhas da mesma view —
    /// `apos_lane_value = None` significa "primeira da lista". Mesmo par
    /// vizinho-antes/vizinho-depois + índice fracionário de
    /// `CronogramaRepository::mover_bloco`, reescrito aqui porque a chave de
    /// irmão é `lane_value` (texto), não um id.
    pub async fn reordenar_raia(&self, view_id: Uuid, lane_value: &str, apos_lane_value: Option<&str>) -> Result<Raia> {
        let mut tx = self.pool.begin().await?;

        ensure_lane_exists_tx(&mut tx, view_id, lane_value).await?;
        let siblings = fetch_lane_siblings_tx(&mut tx, view_id, lane_value).await?;
        let new_position = position_between_lanes(&siblings, apos_lane_value)?;

        let row = sqlx::query_as::<_, Raia>(
            "UPDATE trail_lanes SET position = $3 WHERE view_id = $1 AND lane_value = $2 \
             RETURNING view_id, lane_value, position, is_collapsed, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(lane_value)
        .bind(&new_position)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(row)
    }

    /// TRL-008: recolher some do canvas mas continua na tela com o contador
    /// (contado na hora pela UI a partir de `Etapa.lane_value`, não guardado
    /// aqui).
    pub async fn definir_raia_recolhida(&self, view_id: Uuid, lane_value: &str, recolhida: bool) -> Result<Raia> {
        sqlx::query_as::<_, Raia>(
            "UPDATE trail_lanes SET is_collapsed = $3 WHERE view_id = $1 AND lane_value = $2 \
             RETURNING view_id, lane_value, position, is_collapsed, created_at, updated_at",
        )
        .bind(view_id.db())
        .bind(lane_value)
        .bind(recolhida)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("raia {lane_value:?} na trilha {view_id}")))
    }

    /// Apaga a raia. As etapas que estavam nela NÃO são apagadas nem
    /// escondidas — ficam SEM raia (TRL-014: ausência de valor na
    /// propriedade de agrupamento, a mesma forma que uma etapa recém-criada
    /// com `lane_value = ""` já tem), e a UI já sabe desenhar essa faixa
    /// "sem raia" (`layout.ts`) para etapa sem valor nenhum.
    ///
    /// Ordem — grava o valor vazio em cada etapa da raia ANTES de apagar a
    /// linha de `trail_lanes`, mesmo raciocínio de `renomear_raia`: se a
    /// segunda escrita falhar depois da primeira ter comitado, sobra uma
    /// raia "órfã" com posição/recolhimento mas zero etapas — estado
    /// estranho, não corrompido (a leitura deriva a raia do VALOR gravado,
    /// não da linha de configuração). Na ordem inversa, uma falha no meio
    /// deixaria etapas apontando para um `lane_value` cuja linha de
    /// `trail_lanes` já não existe — a leitura ainda funcionaria (mesmo
    /// motivo), mas ninguém poderia mais recolher ou reordenar aquela raia
    /// sem primeiro recriá-la com o mesmo nome.
    ///
    /// As DUAS escritas não são atômicas entre si pelo mesmo motivo de
    /// `renomear_raia`: a primeira passa por `RecordValueRepository` (I4),
    /// que abre a própria transação, e não há como aninhá-la dentro da
    /// transação que apagaria a linha de `trail_lanes` sem duplicar a
    /// lógica de escrita que I4 existe para centralizar.
    ///
    /// Sem `group_property_id` configurado nesta trilha, nenhuma etapa pode
    /// ter `lane_value` gravado em `database_record_values` para esta
    /// propriedade (ela nem existe) — `fetch_step_bases` já devolveria `""`
    /// para todo mundo nesse caso — então a primeira escrita é pulada, não
    /// um erro: `criar_raia` não exige agrupamento configurado (comentário
    /// daquele método), e apagar uma raia nomeada sem agrupamento só remove
    /// a linha de configuração mesmo.
    ///
    /// NÃO é idempotente, ao contrário de `apagar_flecha`: apagar a mesma
    /// raia duas vezes é `Error::NotFound`, como `reordenar_raia`/
    /// `definir_raia_recolhida` já fazem — não existe fluxo real da UI que
    /// repita esta ação (arrastar a mesma flecha de novo é comum; clicar
    /// "apagar raia" duas vezes na mesma raia não é).
    pub async fn remover_raia(&self, view_id: Uuid, lane_value: &str) -> Result<()> {
        let (configuracao, database_id) = fetch_view_context(&self.pool, view_id).await?;

        if let Some(group_property_id) = configuracao.group_property_id {
            let etapa_ids = fetch_step_ids_with_lane_value(&self.pool, database_id, group_property_id, lane_value).await?;
            if !etapa_ids.is_empty() {
                let record_repo = RecordValueRepository::new(self.pool.clone());
                let changes = etapa_ids
                    .into_iter()
                    .map(|record_id| RecordValueChangeInput { record_id, property_id: group_property_id, value: JsonValue::Null })
                    .collect();
                record_repo.apply_record_value_changes(changes).await?;
            }
        }

        let result = sqlx::query("DELETE FROM trail_lanes WHERE view_id = $1 AND lane_value = $2")
            .bind(view_id.db())
            .bind(lane_value)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("raia {lane_value:?} na trilha {view_id}")));
        }
        Ok(())
    }

    /// TRL-009: mover uma etapa de raia é gravar outro valor na propriedade
    /// de agrupamento — não existe `trail_lanes.step_id` para atualizar.
    /// Passa por `RecordValueRepository` (I4), a mesma ponte que
    /// `renomear_raia` usa. `lane_value = ""` limpa a propriedade (I1: vazio
    /// é ausência de linha), que é a operação certa para "tirar da raia
    /// nomeada e devolver para 'sem raia'".
    pub async fn mover_etapa_para_raia(&self, step_id: Uuid, view_id: Uuid, lane_value: &str) -> Result<()> {
        let (configuracao, _database_id) = fetch_view_context(&self.pool, view_id).await?;
        let group_property_id = configuracao.group_property_id.ok_or_else(|| {
            Error::Invalid("esta trilha não tem propriedade de agrupamento — não há raia para mover a etapa".into())
        })?;

        let value = if lane_value.is_empty() { JsonValue::Null } else { JsonValue::String(lane_value.to_string()) };
        let record_repo = RecordValueRepository::new(self.pool.clone());
        record_repo
            .apply_record_value_changes(vec![RecordValueChangeInput { record_id: step_id, property_id: group_property_id, value }])
            .await?;
        Ok(())
    }

    /// TRL-006: marca a etapa como em andamento ou concluída.
    ///
    /// DECISÃO (comentada porque o pedido desta peça exige uma): concluir
    /// uma etapa BLOQUEADA (alguma bloqueadora ainda não está `done`) é
    /// RECUSADO com `Error::Invalid`. `in_progress`, ao contrário, é sempre
    /// aceito mesmo bloqueada — o usuário pode querer adiantar leitura de
    /// material antes de a bloqueadora terminar, e isso não corrompe nada.
    /// A razão de barrar só `done`: é o estado que TRL-006 usa para
    /// calcular "desbloqueada" de toda etapa seguinte — aceitar `done` sem
    /// checar tornaria esse cálculo mentiroso rio abaixo, exatamente o que
    /// a arquitetura da Trilha existe para nunca deixar acontecer.
    pub async fn marcar_progresso_etapa(&self, step_id: Uuid, state: &str) -> Result<ProgressoDaEtapa> {
        validate_progress_state(state)?;

        let mut tx = self.pool.begin().await?;
        ensure_step_exists_tx(&mut tx, step_id).await?;

        if state == "done" {
            let desbloqueio = compute_desbloqueio_tx(&mut tx, step_id).await?;
            // Descartada é uma recusa DIFERENTE de "bloqueada": bloqueada
            // ainda pode liberar (basta a bloqueadora terminar); descartada
            // nunca vai liberar por este caminho enquanto a escolha não
            // mudar — 0035 pede uma mensagem própria que nomeie a decisão.
            if desbloqueio.situacao == SituacaoNoCaminho::Descartado {
                let titulo = find_discarding_decision_title_tx(&mut tx, step_id).await?;
                let nome_da_decisao = titulo.unwrap_or_else(|| "uma decisão".to_string());
                return Err(Error::Invalid(format!("esta etapa está fora do caminho escolhido em «{nome_da_decisao}»")));
            }
            if !desbloqueio.is_unlocked {
                return Err(Error::Invalid(
                    "não é possível concluir uma etapa bloqueada: conclua antes as etapas que a bloqueiam".into(),
                ));
            }
        }

        let row = sqlx::query_as::<_, ProgressoDaEtapa>(
            "INSERT INTO trail_step_progress (step_id, state, completed_at) \
             VALUES ($1, $2, CASE WHEN $2 = 'done' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END) \
             ON CONFLICT (step_id) DO UPDATE SET \
                 state = excluded.state, \
                 completed_at = CASE WHEN excluded.state = 'done' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END \
             RETURNING step_id, state, started_at, completed_at, updated_at",
        )
        .bind(step_id.db())
        .bind(state)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(row)
    }

    /// Desmarca — zera de volta para "não iniciada" (I1: ausência de linha).
    /// Idempotente, como `record_values::delete_value_row`: desmarcar uma
    /// etapa que nunca foi iniciada afeta zero linhas e não é erro.
    pub async fn desmarcar_progresso_etapa(&self, step_id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM trail_step_progress WHERE step_id = $1").bind(step_id.db()).execute(&self.pool).await?;
        Ok(())
    }

    /// A pergunta que a tela faz o tempo todo, isolada: uma etapa sem
    /// nenhuma bloqueadora nasce desbloqueada; com bloqueadoras, só quando
    /// TODAS têm `state = 'done'`. Mesmo cálculo que `obter_trilha` faz por
    /// etapa, aqui para uma só.
    pub async fn etapa_esta_desbloqueada(&self, step_id: Uuid) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        ensure_step_exists_tx(&mut tx, step_id).await?;
        compute_is_unlocked_tx(&mut tx, step_id).await
    }

    /// Anexa um material à etapa, como o último da lista (índice
    /// fracionário). `pageId`/`deckId` que não nomeiam uma linha existente
    /// surgem como `Error::Database` (violação de FK) — mesma escolha de
    /// `CronogramaRepository::criar_bloco` para `deckId`/`pageId`: não
    /// pré-checar, deixar a constraint reportar.
    pub async fn anexar_material_etapa(
        &self,
        step_id: Uuid,
        kind: &str,
        page_id: Option<Uuid>,
        deck_id: Option<Uuid>,
    ) -> Result<MaterialDaEtapa> {
        validate_material_kind_and_target(kind, page_id, deck_id, step_id)?;

        let last_position: Option<String> = sqlx::query_scalar(
            "SELECT position FROM trail_step_materials WHERE step_id = $1 ORDER BY position DESC LIMIT 1",
        )
        .bind(step_id.db())
        .fetch_optional(&self.pool)
        .await?;
        let last_index = last_position.as_deref().map(position::parse).transpose()?;
        let new_position = position::between(last_index.as_ref(), None)?;

        let id = Uuid::now_v7();
        sqlx::query_as::<_, MaterialDaEtapa>(
            "INSERT INTO trail_step_materials (id, step_id, kind, page_id, deck_id, position) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             RETURNING id, step_id, kind, page_id, deck_id, position, created_at",
        )
        .bind(id.db())
        .bind(step_id.db())
        .bind(kind)
        .bind(page_id.db())
        .bind(deck_id.db())
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await
        .map_err(Error::from)
    }

    /// Remove o material. Não derruba a etapa nem a leitura da trilha se o
    /// alvo (baralho ou página) já tiver sido apagado antes — `ON DELETE
    /// CASCADE` de `trail_step_materials.deck_id`/`.page_id` (0023) já
    /// remove a linha sozinho nesse caso, e este método só existe para a
    /// remoção EXPLÍCITA, pelo id do vínculo.
    pub async fn remover_material_etapa(&self, material_id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM trail_step_materials WHERE id = $1").bind(material_id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("material {material_id}")));
        }
        Ok(())
    }

    // -- flecha (database_record_dependencies) -----------------------------

    /// Cria a flecha entre dois registros — a MESMA aresta de
    /// `database_record_dependencies` (0020) que TRL-003 desenha e DBS-119
    /// documenta. Antes desta peça, nenhum caminho de produção escrevia
    /// aqui: os únicos INSERTs eram fixture de teste (`tests/db_trilha.rs`).
    ///
    /// Regras, cada uma com teste em `tests/db_trilha.rs`:
    ///
    /// - os dois ids precisam ser REGISTROS (`pages.database_id` setado) da
    ///   MESMA database. Ligar a etapa de uma trilha a um registro de outra
    ///   database produziria uma flecha que `obter_trilha` nunca desenha
    ///   (ela filtra por `database_id`, ver o comentário de topo do
    ///   arquivo) — `Error::Invalid` legível em vez de deixar a flecha
    ///   nascer fantasma.
    /// - auto-referência (A bloqueia A) já tem `CHECK (blocked_id <>
    ///   blocking_id)` na migração `0020`; barrada aqui ANTES de bater na
    ///   constraint, para a mensagem nomear o problema em vez de vazar o
    ///   erro cru do SQLite — mesmo padrão de
    ///   `validate_material_kind_and_target`.
    /// - criar a MESMA flecha duas vezes é IDEMPOTENTE (`ON CONFLICT DO
    ///   NOTHING` na PK `(blocked_id, blocking_id)`), não erro: o usuário
    ///   arrastando a mesma ligação de novo não fez nada errado.
    /// - CICLO (A bloqueia B, B bloqueia A) é PERMITIDO DE PROPÓSITO — a
    ///   decisão já foi tomada e não é desta peça reabrir.
    ///   `calcular_niveis_topologicos` já trata ciclo (marca `in_cycle` em
    ///   toda etapa presa nele, ver o comentário daquela função); barrar a
    ///   aresta que fecha o ciclo aqui tornaria esse tratamento código
    ///   morto, e o comentário do topo de `0023_trilha.sql` já documenta que
    ///   ciclo de tamanho >= 2 é responsabilidade do Rust, não do schema —
    ///   "responsabilidade do Rust" aqui significa DEIXAR entrar e desenhar
    ///   direito, não recusar. Contraintuitivo o bastante para merecer este
    ///   parágrafo: um teste cria o ciclo por esta mesma função e confirma
    ///   que `obter_trilha` devolve `in_cycle = true` nas etapas envolvidas.
    ///
    /// `path_label` (0035) é o rótulo do caminho: só aceito quando
    /// `blocking_id` já é uma decisão (`Error::Invalid` legível, espelhando
    /// o gatilho `database_record_dependencies_rotulo_valido_*` de 0035
    /// ANTES de bater na constraint), e nunca vazio. Re-arrastar a MESMA
    /// flecha com `path_label = None` NUNCA apaga um rótulo já gravado —
    /// `COALESCE(excluded.path_label, ...)` preserva o que já estava lá;
    /// desrotular é operação explícita de `renomear_caminho`, não efeito
    /// colateral de arrastar de novo.
    pub async fn criar_flecha(&self, blocked_id: Uuid, blocking_id: Uuid, path_label: Option<String>) -> Result<Flecha> {
        if blocked_id == blocking_id {
            return Err(Error::Invalid(format!("uma etapa não pode bloquear a si mesma: {blocked_id}")));
        }
        if let Some(rotulo) = path_label.as_deref() {
            validate_path_label(rotulo)?;
        }

        let mut tx = self.pool.begin().await?;
        ensure_same_database_record_tx(&mut tx, blocked_id, blocking_id).await?;
        if path_label.is_some() {
            ensure_is_decision_tx(&mut tx, blocking_id).await?;
        }

        let flecha = sqlx::query_as::<_, Flecha>(
            "INSERT INTO database_record_dependencies (blocked_id, blocking_id, path_label) VALUES ($1, $2, $3) \
             ON CONFLICT (blocked_id, blocking_id) DO UPDATE SET \
                 path_label = COALESCE(excluded.path_label, database_record_dependencies.path_label) \
             RETURNING blocked_id, blocking_id, path_label",
        )
        .bind(blocked_id.db())
        .bind(blocking_id.db())
        .bind(path_label)
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(flecha)
    }

    /// Apaga a flecha. IDEMPOTENTE de propósito, como
    /// `desmarcar_progresso_etapa`/`RecordValueRepository::delete_value_row`:
    /// apagar uma flecha que já não existe (corrida, duplo clique no
    /// desfazer) não é um erro do usuário, é a mesma intenção já satisfeita.
    pub async fn apagar_flecha(&self, blocked_id: Uuid, blocking_id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM database_record_dependencies WHERE blocked_id = $1 AND blocking_id = $2")
            .bind(blocked_id.db())
            .bind(blocking_id.db())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // -- decisão e caminhos (0035) --------------------------------------------

    /// Marca a etapa como decisão — a PRESENÇA da linha em `trail_decisions`
    /// é a marcação (ver o comentário de topo de 0035 sobre por que não é
    /// valor de propriedade). Exige que a página seja um REGISTRO (mesma
    /// checagem de `criar_flecha`, via `fetch_record_database_id_tx`):
    /// decisão numa página que não é registro nunca apareceria na trilha.
    /// IDEMPOTENTE — marcar duas vezes não é erro do usuário, mesmo padrão
    /// de `criar_flecha`.
    pub async fn marcar_etapa_como_decisao(&self, step_id: Uuid) -> Result<Decisao> {
        let mut tx = self.pool.begin().await?;
        fetch_record_database_id_tx(&mut tx, step_id).await?;

        sqlx::query("INSERT INTO trail_decisions (step_id) VALUES ($1) ON CONFLICT (step_id) DO NOTHING")
            .bind(step_id.db())
            .execute(&mut *tx)
            .await?;

        let decisao = sqlx::query_as::<_, Decisao>(
            "SELECT step_id, chosen_label, chosen_at, created_at, updated_at FROM trail_decisions WHERE step_id = $1",
        )
        .bind(step_id.db())
        .fetch_one(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(decisao)
    }

    /// Desfaz a marcação de decisão. RECUSA enquanto existir flecha rotulada
    /// saindo dela — aceitar em silêncio transformaria todo ramo em
    /// pré-requisito obrigatório de uma vez, mudando a regra de desbloqueio
    /// que 0035 existe para nunca deixar acontecer por acidente. Sem
    /// caminhos, é `DELETE` idempotente (zero linhas não é erro), como
    /// `desmarcar_progresso_etapa`.
    ///
    /// A guarda mora AQUI, no Rust, e não num gatilho `BEFORE DELETE`: um
    /// `RAISE(ABORT)` ali poderia abortar a exclusão definitiva da página, e
    /// o SQLite não garante a ordem do `ON DELETE CASCADE` de `pages` (a
    /// aresta rotulada e a linha de `trail_decisions` podem cair em qualquer
    /// ordem).
    pub async fn desmarcar_etapa_como_decisao(&self, step_id: Uuid) -> Result<()> {
        let caminhos: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT path_label) FROM database_record_dependencies \
             WHERE blocking_id = $1 AND path_label IS NOT NULL",
        )
        .bind(step_id.db())
        .fetch_one(&self.pool)
        .await?;
        if caminhos > 0 {
            return Err(Error::Invalid(format!(
                "esta decisão tem {caminhos} caminho(s) — remova ou desrotule os caminhos antes de desfazer a decisão"
            )));
        }

        sqlx::query("DELETE FROM trail_decisions WHERE step_id = $1").bind(step_id.db()).execute(&self.pool).await?;
        Ok(())
    }

    /// Escolhe (`Some`) ou zera (`None`) o caminho de uma decisão — um
    /// comando só para as duas gestões, porque o gate de alcançabilidade do
    /// frontend exige cada comando ter um chamador de tela, e "escolher" e
    /// "desescolher" são o mesmo botão visto de dois estados.
    ///
    /// Rótulo inexistente vira `Error::Invalid` legível, checado ANTES do
    /// `UPDATE` — espelha `trail_decisions_escolha_precisa_existir_*` (0035)
    /// pela mesma razão de sempre: a mensagem do gatilho não nomeia nada.
    pub async fn escolher_caminho(&self, decision_id: Uuid, path_label: Option<String>) -> Result<Decisao> {
        if let Some(rotulo) = path_label.as_deref() {
            validate_path_label(rotulo)?;
            let existe: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM database_record_dependencies WHERE blocking_id = $1 AND path_label = $2)",
            )
            .bind(decision_id.db())
            .bind(rotulo)
            .fetch_one(&self.pool)
            .await?;
            if !existe {
                return Err(Error::Invalid(format!("nenhuma flecha sai desta decisão com o rótulo {rotulo:?}")));
            }
        }

        sqlx::query_as::<_, Decisao>(
            "UPDATE trail_decisions SET \
                 chosen_label = $2, \
                 chosen_at = CASE WHEN $2 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END \
             WHERE step_id = $1 \
             RETURNING step_id, chosen_label, chosen_at, created_at, updated_at",
        )
        .bind(decision_id.db())
        .bind(path_label)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("decisão {decision_id}")))
    }

    /// Renomeia um caminho — reescreve o rótulo em TODAS as flechas que
    /// saem da decisão com `rotulo_atual`, numa transação, e devolve quantas
    /// mudaram. `novo_rotulo = None` DISSOLVE o caminho: as flechas viram
    /// pré-requisitos incondicionais (ação explícita do usuário — a tela usa
    /// `prever_troca_de_caminho` antes para avisar o impacto).
    ///
    /// Se a escolha da decisão apontava para `rotulo_atual`, o gatilho de
    /// limpeza de 0035 (`caminho_rerotulado_limpa_escolha`) zera a escolha
    /// NO MEIO desta mesma transação — e este método a restaura para
    /// `novo_rotulo` logo em seguida (quando `novo_rotulo` é `Some`), para
    /// "renomear" não se comportar como "dissolver e recriar" aos olhos do
    /// usuário. Dissolver (`None`) não restaura nada, de propósito.
    pub async fn renomear_caminho(
        &self,
        decision_id: Uuid,
        rotulo_atual: &str,
        novo_rotulo: Option<String>,
    ) -> Result<u64> {
        if let Some(novo) = novo_rotulo.as_deref() {
            validate_path_label(novo)?;
        }

        let mut tx = self.pool.begin().await?;
        ensure_is_decision_tx(&mut tx, decision_id).await?;

        let escolha_antes: Option<String> =
            sqlx::query_scalar::<_, Option<String>>("SELECT chosen_label FROM trail_decisions WHERE step_id = $1")
                .bind(decision_id.db())
                .fetch_one(&mut *tx)
                .await?;

        let resultado = sqlx::query(
            "UPDATE database_record_dependencies SET path_label = $3 WHERE blocking_id = $1 AND path_label = $2",
        )
        .bind(decision_id.db())
        .bind(rotulo_atual)
        .bind(novo_rotulo.clone())
        .execute(&mut *tx)
        .await?;
        let linhas_afetadas = resultado.rows_affected();

        if linhas_afetadas > 0 && escolha_antes.as_deref() == Some(rotulo_atual) {
            if let Some(novo) = novo_rotulo.as_deref() {
                sqlx::query(
                    "UPDATE trail_decisions SET chosen_label = $2, chosen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     WHERE step_id = $1",
                )
                .bind(decision_id.db())
                .bind(novo)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        Ok(linhas_afetadas)
    }

    /// LEITURA PURA — não grava nada. Simula trocar (ou zerar) a escolha de
    /// uma decisão e devolve o impacto: quem entraria no caminho, quem
    /// sairia, e — o que importa de verdade — quem tem PROGRESSO entre quem
    /// sairia, para a tela avisar antes de o usuário confirmar. Nenhum
    /// progresso é apagado por esta chamada nem pela troca de verdade
    /// (`escolher_caminho`) — só a leitura muda.
    pub async fn prever_troca_de_caminho(&self, decision_id: Uuid, novo_rotulo: Option<String>) -> Result<ImpactoDaTroca> {
        if let Some(rotulo) = novo_rotulo.as_deref() {
            validate_path_label(rotulo)?;
        }

        let database_id = {
            let mut tx = self.pool.begin().await?;
            let id = fetch_record_database_id_tx(&mut tx, decision_id).await?;
            ensure_is_decision_tx(&mut tx, decision_id).await?;
            tx.commit().await?;
            id
        };

        let bases = fetch_step_bases(&self.pool, database_id, None).await?;
        let etapa_ids: Vec<Uuid> = bases.iter().map(|base| base.id).collect();
        let todas_dependencias = fetch_dependencies_into(&self.pool, &etapa_ids).await?;
        let bloqueadoras_ids: Vec<Uuid> = todas_dependencias.iter().map(|dep| dep.blocking_id).collect();
        let concluidas = fetch_done_set(&self.pool, &bloqueadoras_ids).await?;

        let mut universo_decisoes = etapa_ids.clone();
        universo_decisoes.extend(bloqueadoras_ids.iter().copied());
        let todas_decisoes = fetch_decisions(&self.pool, &universo_decisoes).await?;
        let escolhas_atuais: HashMap<Uuid, Option<String>> =
            todas_decisoes.iter().map(|decisao| (decisao.step_id, decisao.chosen_label.clone())).collect();

        // As duas rodadas do cálculo diferem SÓ na escolha desta decisão —
        // tudo o mais (grafo, progresso) é o mesmo, porque nada disto é
        // gravado de verdade.
        let mut escolhas_simuladas = escolhas_atuais.clone();
        escolhas_simuladas.insert(decision_id, novo_rotulo);

        let situacao_atual = avaliar_desbloqueio(&etapa_ids, &todas_dependencias, &escolhas_atuais, &concluidas);
        let situacao_simulada = avaliar_desbloqueio(&etapa_ids, &todas_dependencias, &escolhas_simuladas, &concluidas);

        let progresso_por_etapa: HashMap<Uuid, Option<String>> =
            bases.into_iter().map(|base| (base.id, base.state)).collect();
        let tem_progresso = |id: &Uuid| progresso_por_etapa.get(id).is_some_and(Option::is_some);
        let esta_concluida = |id: &Uuid| progresso_por_etapa.get(id).and_then(|state| state.as_deref()) == Some("done");

        let mut entram_no_caminho = Vec::new();
        let mut saem_do_caminho = Vec::new();
        let mut saem_com_progresso = Vec::new();
        let mut saem_concluidas = Vec::new();

        for id in &etapa_ids {
            let estava_descartada = situacao_atual.get(id).is_some_and(|d| d.situacao == SituacaoNoCaminho::Descartado);
            let fica_descartada = situacao_simulada.get(id).is_some_and(|d| d.situacao == SituacaoNoCaminho::Descartado);
            if estava_descartada && !fica_descartada {
                entram_no_caminho.push(*id);
            } else if !estava_descartada && fica_descartada {
                saem_do_caminho.push(*id);
                if tem_progresso(id) {
                    saem_com_progresso.push(*id);
                }
                if esta_concluida(id) {
                    saem_concluidas.push(*id);
                }
            }
        }

        Ok(ImpactoDaTroca { entram_no_caminho, saem_do_caminho, saem_com_progresso, saem_concluidas })
    }

    // -- criar a trilha inteira num passo ------------------------------------

    /// "Criar uma trilha de estudos" num comando só — o usuário não deveria
    /// precisar aprender o que é uma database, uma propriedade e uma view
    /// para isso. Sob este schema são TRÊS escritas em ordem certa (a
    /// quarta, `criar_raia`, fica de fora de propósito: TRL-014 já trata
    /// "sem raia nenhuma" como estado válido de nascença, e a tela chama
    /// `criar_raia` à parte quando o usuário nomear a primeira raia):
    ///
    /// 1. `DatabaseRepository::create_database` — a database dentro da
    ///    página `container_page_id`;
    /// 2. `DatabaseRepository::create_view` com `view_type = "trail"` —
    ///    reusado em vez de duplicado, exatamente como o pedido desta peça
    ///    exige;
    /// 3. `Self::criar_trilha` — a linha de `trail_views` que a migração
    ///    `0023` exige via gatilho `BEFORE INSERT` (view já tem que existir).
    ///
    /// # Por que isto NÃO é uma única transação SQL, apesar do pedido pedir
    /// exatamente isso
    ///
    /// `DatabaseRepository::create_database`/`::create_view`
    /// (`db/databases.rs`, métodos `create_database`/`create_view`) recebem
    /// `&self.pool` diretamente — não um `&mut Transaction<'_, Sqlite>` nem
    /// um executor genérico. Cada chamada consome sua PRÓPRIA conexão do
    /// pool (`MAX_POOL_CONNECTIONS = 10`, `db::pool`) e comita sozinha antes
    /// de devolver a linha. Não existe como inscrever essas duas escritas
    /// dentro da transação que este método abre para o passo 3 sem uma das
    /// duas coisas que o pedido desta peça pede para NÃO fazer aqui:
    ///
    ///   (a) mudar `db::databases.rs` para aceitar um executor genérico —
    ///       fora do escopo desta peça (arquivo não listado entre os que
    ///       são meus nesta tarefa);
    ///   (b) duplicar aqui o SQL de `INSERT INTO databases`/`INSERT INTO
    ///       database_views` que `db::databases.rs` já escreve — o pedido
    ///       explicitamente prefere RELATAR o problema a duplicar.
    ///
    /// RELATADO, então, em vez de contornado: com as duas fechadas, a
    /// garantia que resta é COMPENSAÇÃO, não `ROLLBACK`. Se o passo 2 ou o
    /// passo 3 falhar depois que um passo anterior já comitou na própria
    /// conexão, este método apaga o que já tinha sido criado
    /// (`DatabaseRepository::delete_database`, que por `ON DELETE CASCADE`
    /// já leva a view e, por ela, `trail_views` junto — ver o comentário de
    /// `delete_database`) antes de devolver o erro. No caminho comum (sem o
    /// processo cair no meio) o resultado observável é o mesmo que a versão
    /// transacional prometeria — "se qualquer passo falhar, nada fica
    /// gravado" — mas a garantia não é idêntica: uma queda do processo
    /// exatamente entre os passos deixaria a database/view órfãs sem a
    /// configuração da Trilha, porque não existe `ROLLBACK` automático que
    /// cubra conexões diferentes do pool. Um teste em `tests/db_trilha.rs`
    /// prova o caminho comum (falha forçada no passo 3, nada sobra), não a
    /// queda de processo — que exigiria matar o processo no meio de um
    /// teste, fora do alcance de `cargo test`.
    pub async fn criar_trilha_completa(
        &self,
        container_page_id: Uuid,
        database_name: &str,
        view_name: &str,
        group_property_id: Option<Uuid>,
    ) -> Result<TrilhaRecemCriada> {
        let database_repo = DatabaseRepository::new(self.pool.clone());

        let database = database_repo.create_database(container_page_id, database_name).await?;

        let view = match database_repo.create_view(database.id, view_name, "trail", None).await {
            Ok(view) => view,
            Err(err) => {
                // Compensação, não rollback — ver o comentário acima. O erro
                // de limpeza (se houver) não substitui o erro original: quem
                // chama precisa saber por que a criação falhou, não que a
                // limpeza também falhou.
                let _ = database_repo.delete_database(database.id).await;
                return Err(err);
            }
        };

        match self.criar_trilha(view.id, group_property_id).await {
            Ok(configuracao) => {
                // Trilha recém-criada não tem etapa nenhuma, então também não
                // tem decisão nenhuma: decisão é uma linha presa a uma etapa.
                let trilha = Trilha {
                    configuracao,
                    raias: Vec::new(),
                    etapas: Vec::new(),
                    flechas: Vec::new(),
                    materiais: Vec::new(),
                    decisoes: Vec::new(),
                };
                Ok(TrilhaRecemCriada { database_id: database.id, trilha })
            }
            Err(err) => {
                let _ = database_repo.delete_database(database.id).await;
                Err(err)
            }
        }
    }

    // -- criar etapa ----------------------------------------------------------

    /// Cria a etapa (um registro da database — decisão da 0007, "etapa é
    /// página-registro") e já a coloca numa raia, num comando só. Hoje seriam
    /// duas chamadas manuais na ordem certa
    /// (`DatabaseRepository::create_record` + `Self::mover_etapa_para_raia`);
    /// este método reusa as duas em vez de duplicar a lógica de nenhuma —
    /// mesmo caminho de escrita de raia que `mover_etapa_para_raia` já usa
    /// (I4, via `RecordValueRepository`), sem inventar um segundo.
    ///
    /// `lane_value = ""` (sem raia, TRL-014) PULA a segunda escrita de
    /// propósito, em vez de chamar `mover_etapa_para_raia(id, view_id, "")`:
    /// uma etapa recém-criada já nasce sem valor na propriedade de
    /// agrupamento (I1 — ausência de linha É "sem raia"), então gravar ""
    /// explicitamente seria uma escrita que não muda nada — e, numa trilha
    /// sem `group_property_id` configurado, `mover_etapa_para_raia` recusaria
    /// mesmo essa escrita vazia com `Error::Invalid` (ver o comentário
    /// daquele método), o que aqui seria um falso positivo: a etapa já está
    /// exatamente onde "sem raia" pede, sem nenhuma raia ter sido nomeada.
    pub async fn criar_etapa(&self, view_id: Uuid, title: &str, lane_value: &str) -> Result<Etapa> {
        let (configuracao, database_id) = fetch_view_context(&self.pool, view_id).await?;

        // A recusa vem ANTES da primeira escrita, e essa ordem é o ponto.
        //
        // `create_record` comita sozinho (o `DatabaseRepository` recebe o pool,
        // não uma transação), e `mover_etapa_para_raia` recusa quando a trilha
        // não tem propriedade de agrupamento. Na ordem inversa — criar e só
        // depois descobrir a recusa — a página-registro ficava gravada para
        // sempre, sem raia, aparecendo em `obter_trilha` como etapa fantasma,
        // enquanto a tela recebia um erro e concluía que nada tinha mudado.
        //
        // E o caso é alcançável em uso normal, não teórico: `criar_raia` NÃO
        // exige `group_property_id` para nomear uma raia em `trail_lanes`,
        // então dá para nomear "T.I." numa trilha sem agrupamento e em
        // seguida pedir uma etapa nela.
        if !lane_value.is_empty() && configuracao.group_property_id.is_none() {
            return Err(Error::Invalid(
                "esta trilha não tem propriedade de agrupamento — crie a etapa sem raia ou configure o agrupamento antes"
                    .into(),
            ));
        }

        let database_repo = DatabaseRepository::new(self.pool.clone());
        let page = database_repo.create_record(database_id, title).await?;

        if !lane_value.is_empty() {
            self.mover_etapa_para_raia(page.id, view_id, lane_value).await?;
        }

        // Relê pela mesma `obter_trilha` que a tela usa, em vez de montar a
        // `Etapa` à mão aqui: nível/desbloqueio de uma etapa recém-criada SEM
        // flecha nenhuma são triviais (nível 0, desbloqueada — nenhuma
        // bloqueadora ainda), mas calculá-los de novo aqui duplicaria a
        // mesma lógica que `obter_trilha` já centraliza, e uma trilha em que
        // a etapa nasce como TEMPLATE (`is_template`) nunca aconteceria por
        // este caminho (`create_record` sempre cria registro comum), então
        // não há surpresa em reler.
        let trilha = self.obter_trilha(view_id).await?;
        trilha.etapas.into_iter().find(|etapa| etapa.id == page.id).ok_or_else(|| {
            Error::NotFound(format!("etapa recém-criada {} não apareceu na leitura seguinte da trilha", page.id))
        })
    }

    // -- remover etapa ---------------------------------------------------------

    /// Apaga (manda para a lixeira) a etapa. REVERSÍVEL — mesmo esquema que
    /// o frontend já usa para a página-container inteira (`apagarTrilha`,
    /// via `trash_page` genérico, ver `store.ts`): nenhuma exclusão
    /// definitiva mora aqui, e restaurar depois é `PageRepository::restore`
    /// (comando `restore_page`), que já existe e não precisa de nada
    /// específico da Trilha para funcionar.
    ///
    /// A escrita de verdade é `PageRepository::trash` — REUSADA, não
    /// duplicada: este método não sabe fazer soft-delete de página, só sabe
    /// o que é específico da Trilha em cima dele. Duas decisões de cascata,
    /// cada uma comentada porque o pedido desta peça exige as duas:
    ///
    /// 1. **Flechas apagadas, nas duas direções.** Toda linha de
    ///    `database_record_dependencies` que toca esta etapa — como
    ///    bloqueada (`blocked_id`) OU como bloqueadora (`blocking_id`) — é
    ///    removida antes do soft-delete da página. Justificativa: `trash`
    ///    só grava `deleted_at`, a linha da página continua existindo, e por
    ///    isso o `ON DELETE CASCADE` de `pages` (0020) NUNCA dispara aqui —
    ///    ele só roda em exclusão DEFINITIVA. Sem esta limpeza, a flecha
    ///    ficaria uma referência morta que nenhuma tela alcança para apagar
    ///    à mão: `fetch_step_bases` já filtra `deleted_at IS NULL`, então a
    ///    etapa some do conjunto conhecido de `obter_trilha` e
    ///    `apagar_flecha` (que precisa dos dois lados visíveis) nunca mais
    ///    tem como mirar aquela aresta. Numa cadeia A -> B -> C (A bloqueia
    ///    B, B bloqueia C), apagar B sem limpar a flecha B->C deixaria C
    ///    bloqueada PARA SEMPRE — a bloqueadora nunca mais fica `done` por
    ///    um caminho que ninguém consegue mais acionar — até o dia (se
    ///    algum dia vier) em que B for restaurada. Um cadeado invisível é
    ///    pior que apagar a aresta.
    /// 2. **Nenhuma religação automática.** A NÃO passa a bloquear C.
    ///    Sintetizar essa aresta por trás do usuário não tem como se
    ///    justificar aqui: `apagar_flecha` é, em toda esta base, uma ação
    ///    SEMPRE explícita e isolada — nenhum outro método deste arquivo
    ///    cria uma aresta que o usuário não pediu — e inventar uma exceção
    ///    só para este caminho multiplicaria flechas-surpresa exatamente em
    ///    cadeias longas, onde apagar uma etapa do meio é mais comum. Depois
    ///    de remover B, C fica sem bloqueadora nenhuma (nível 0,
    ///    desbloqueada) — se o usuário quiser mesmo que A bloqueie C, arrasta
    ///    a flecha de novo (`criar_flecha`), do mesmo jeito que criaria
    ///    qualquer outra dependência nova.
    ///
    /// **Progresso, materiais e a marcação de decisão da própria etapa são
    /// DEIXADOS INTACTOS** — `trail_step_progress`, `trail_step_materials` e
    /// `trail_decisions` têm `ON DELETE CASCADE` de `pages` (0023/0035), e
    /// pela mesma razão do item 1 esse `CASCADE` não dispara num soft
    /// delete. Isto é o comportamento CERTO para uma operação reversível:
    /// restaurar a etapa (`restore_page`) devolve o progresso, os materiais
    /// e a marcação de decisão exatamente como estavam, sem esta peça
    /// precisar reimplementar nada disso. Quando a etapa for excluída de
    /// vez pela Lixeira (`permanently_delete_page`), aí sim o `CASCADE`
    /// finalmente os leva embora — e a limpeza de flechas do item 1 já
    /// garante que nenhuma aresta rotulada sobrevive para aquele momento.
    ///
    /// **Etapa que é uma DECISÃO com caminhos escolhidos**: ao contrário de
    /// `desmarcar_etapa_como_decisao`, aqui NÃO existe recusa. Aquele método
    /// recusa porque desfaria a marcação de decisão MANTENDO a etapa e as
    /// flechas rotuladas que saem dela — o que degradaria cada caminho em
    /// pré-requisito incondicional em silêncio. Aqui a etapa INTEIRA está
    /// saindo do grafo, e o item 1 já apaga toda flecha rotulada que sai
    /// dela: os gatilhos de 0035
    /// (`database_record_dependencies_caminho_apagado_limpa_escolha`) zeram
    /// `chosen_label`/`chosen_at` sozinhos quando a última flecha de um
    /// rótulo cai, então nenhuma decisão (nem a desta etapa, nem uma de fora
    /// que apontava rótulo para dentro dela) fica presa a uma escolha órfã.
    /// Não sobra nada para recusar.
    pub async fn remover_etapa(&self, step_id: Uuid) -> Result<PageRow> {
        let mut tx = self.pool.begin().await?;
        fetch_record_database_id_tx(&mut tx, step_id).await?;

        // Checado ANTES de apagar qualquer flecha: se a etapa já estivesse
        // na lixeira, `PageRepository::trash` recusaria mais adiante (mesma
        // mensagem), mas essa recusa viria DEPOIS de a transação abaixo já
        // ter apagado as flechas — um efeito colateral sobrevivendo a uma
        // chamada que, no fim, falhou. Falhar aqui, antes do `DELETE`,
        // mantém a transação sem nada para comitar.
        let ja_na_lixeira: bool =
            sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM pages WHERE id = $1").bind(step_id.db()).fetch_one(&mut *tx).await?;
        if ja_na_lixeira {
            return Err(Error::Invalid("página já está na lixeira".into()));
        }

        sqlx::query("DELETE FROM database_record_dependencies WHERE blocked_id = $1 OR blocking_id = $1")
            .bind(step_id.db())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        PageRepository::new(self.pool.clone()).trash(step_id).await
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ViewContextRow {
    #[sqlx(try_from = "DbId")]
    view_id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    group_property_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[sqlx(try_from = "DbId")]
    database_id: Uuid,
}

/// A configuração da trilha, mais a database que ela agrupa (via
/// `database_views.database_id` — `trail_views.view_id` referencia
/// `database_views(id)` diretamente).
async fn fetch_view_context(pool: &SqlitePool, view_id: Uuid) -> Result<(ConfiguracaoTrilha, Uuid)> {
    let row = sqlx::query_as::<_, ViewContextRow>(
        "SELECT tv.view_id, tv.group_property_id, tv.created_at, tv.updated_at, dv.database_id \
         FROM trail_views tv JOIN database_views dv ON dv.id = tv.view_id \
         WHERE tv.view_id = $1",
    )
    .bind(view_id.db())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| Error::NotFound(format!("trilha {view_id}")))?;

    let configuracao = ConfiguracaoTrilha {
        view_id: row.view_id,
        group_property_id: row.group_property_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
    Ok((configuracao, row.database_id))
}

async fn fetch_lanes(pool: &SqlitePool, view_id: Uuid) -> Result<Vec<Raia>> {
    sqlx::query_as::<_, Raia>(
        "SELECT view_id, lane_value, position, is_collapsed, created_at, updated_at \
         FROM trail_lanes WHERE view_id = $1 ORDER BY position",
    )
    .bind(view_id.db())
    .fetch_all(pool)
    .await
    .map_err(Error::from)
}

async fn fetch_lane(pool: &SqlitePool, view_id: Uuid, lane_value: &str) -> Result<Raia> {
    sqlx::query_as::<_, Raia>(
        "SELECT view_id, lane_value, position, is_collapsed, created_at, updated_at \
         FROM trail_lanes WHERE view_id = $1 AND lane_value = $2",
    )
    .bind(view_id.db())
    .bind(lane_value)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| Error::NotFound(format!("raia {lane_value:?} na trilha {view_id}")))
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct StepBaseRow {
    #[sqlx(try_from = "DbId")]
    id: Uuid,
    title: String,
    icon: Option<String>,
    lane_value: String,
    /// Ver o comentário de [`Etapa::position`] — mesma coluna, mesmo motivo.
    position: String,
    state: Option<String>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

/// Toda etapa de uma database: registros ativos (`deleted_at IS NULL`), que
/// não são template (DBS-103 — um template nunca é etapa de trilha), com o
/// valor de raia já resolvido via `LEFT JOIN` e o progresso já resolvido via
/// `LEFT JOIN`.
///
/// `v.property_id = $2` com `group_property_id = None` liga `NULL` (via
/// `DbIdOpt`) — `coluna = NULL` nunca é verdadeiro em SQL, então o `JOIN`
/// nunca casa nada e `lane_value` cai para `''` em toda etapa, que é o
/// comportamento certo para uma trilha sem propriedade de agrupamento
/// (TRL-014: raia única sem título).
async fn fetch_step_bases(pool: &SqlitePool, database_id: Uuid, group_property_id: Option<Uuid>) -> Result<Vec<StepBaseRow>> {
    sqlx::query_as::<_, StepBaseRow>(
        "SELECT p.id, p.title, p.icon, \
                COALESCE(json_extract(v.value, '$'), '') AS lane_value, \
                p.position, pr.state, pr.started_at, pr.completed_at \
         FROM pages p \
         LEFT JOIN database_record_values v ON v.record_id = p.id AND v.property_id = $2 \
         LEFT JOIN trail_step_progress pr ON pr.step_id = p.id \
         WHERE p.database_id = $1 AND p.is_template = 0 AND p.deleted_at IS NULL \
         ORDER BY p.position",
    )
    .bind(database_id.db())
    .bind(group_property_id.db())
    .fetch_all(pool)
    .await
    .map_err(Error::from)
}

/// Todo id de etapa cujo valor da propriedade de agrupamento é exatamente
/// `lane_value` — usado por `renomear_raia` para saber quem reescrever.
/// `lane_value = ""` é tratado à parte (sem propriedade gravada, não
/// `json_extract(...) = ''`, que nunca casaria: I1 proíbe string vazia
/// gravada).
async fn fetch_step_ids_with_lane_value(
    pool: &SqlitePool,
    database_id: Uuid,
    group_property_id: Uuid,
    lane_value: &str,
) -> Result<Vec<Uuid>> {
    let rows: Vec<DbId> = if lane_value.is_empty() {
        sqlx::query_scalar(
            "SELECT p.id FROM pages p \
             LEFT JOIN database_record_values v ON v.record_id = p.id AND v.property_id = $2 \
             WHERE p.database_id = $1 AND p.is_template = 0 AND p.deleted_at IS NULL AND v.value IS NULL",
        )
        .bind(database_id.db())
        .bind(group_property_id.db())
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT p.id FROM pages p \
             JOIN database_record_values v ON v.record_id = p.id AND v.property_id = $2 \
             WHERE p.database_id = $1 AND p.is_template = 0 AND p.deleted_at IS NULL \
               AND json_extract(v.value, '$') = $3",
        )
        .bind(database_id.db())
        .bind(group_property_id.db())
        .bind(lane_value)
        .fetch_all(pool)
        .await?
    };
    Ok(rows.into_iter().map(Uuid::from).collect())
}

/// Toda dependência (`database_record_dependencies`) que aponta PARA uma das
/// `etapa_ids` — sem filtrar a bloqueadora, ver o comentário de
/// `obter_trilha` sobre por que "desbloqueada" precisa olhar o grafo
/// inteiro. Fatiado por `sql::MAX_BIND_PARAMS`, mesma convenção de
/// `db::sql`.
async fn fetch_dependencies_into(pool: &SqlitePool, etapa_ids: &[Uuid]) -> Result<Vec<Flecha>> {
    if etapa_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut dependencias = Vec::new();
    for chunk in etapa_ids.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!(
            "SELECT blocked_id, blocking_id, path_label FROM database_record_dependencies WHERE blocked_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, Flecha>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        dependencias.extend(query.fetch_all(pool).await?);
    }
    Ok(dependencias)
}

/// `trail_decisions` de todas as `ids` que forem decisão — as que não forem
/// simplesmente não aparecem no resultado (I1: mesma convenção de
/// `fetch_done_set`, que também devolve só quem casa). Fatiado do mesmo jeito.
async fn fetch_decisions(pool: &SqlitePool, ids: &[Uuid]) -> Result<Vec<Decisao>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let unique: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let mut decisoes = Vec::new();
    for chunk in unique.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!(
            "SELECT step_id, chosen_label, chosen_at, created_at, updated_at \
             FROM trail_decisions WHERE step_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, Decisao>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        decisoes.extend(query.fetch_all(pool).await?);
    }
    Ok(decisoes)
}

/// Quais, entre `ids`, têm `trail_step_progress.state = 'done'` — usado
/// tanto para bloqueadoras quanto (indiretamente) para o cálculo de
/// desbloqueio. Fatiado do mesmo jeito que `fetch_dependencies_into`.
async fn fetch_done_set(pool: &SqlitePool, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let unique: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let mut done = HashSet::new();
    for chunk in unique.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!("SELECT step_id FROM trail_step_progress WHERE state = 'done' AND step_id IN ({placeholders})");
        let mut query = sqlx::query_scalar(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        let rows: Vec<DbId> = query.fetch_all(pool).await?;
        done.extend(rows.into_iter().map(Uuid::from));
    }
    Ok(done)
}

async fn fetch_materials(pool: &SqlitePool, etapa_ids: &[Uuid]) -> Result<Vec<MaterialDaEtapa>> {
    if etapa_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut materiais = Vec::new();
    for chunk in etapa_ids.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!(
            "SELECT id, step_id, kind, page_id, deck_id, position, created_at \
             FROM trail_step_materials WHERE step_id IN ({placeholders}) ORDER BY step_id, position"
        );
        let mut query = sqlx::query_as::<_, MaterialDaEtapa>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        materiais.extend(query.fetch_all(pool).await?);
    }
    Ok(materiais)
}

async fn ensure_step_exists_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pages WHERE id = $1)").bind(step_id.db()).fetch_one(&mut **tx).await?;
    if !exists {
        return Err(Error::NotFound(format!("etapa {step_id}")));
    }
    Ok(())
}

/// O `database_id` de uma página, exigindo que ela EXISTA e que SEJA um
/// registro (`database_id` setado) — as duas condições que `criar_flecha`
/// precisa antes de decidir se as duas pontas pertencem à mesma database.
async fn fetch_record_database_id_tx(tx: &mut Transaction<'_, Sqlite>, page_id: Uuid) -> Result<Uuid> {
    let row: Option<DbIdOpt> =
        sqlx::query_scalar("SELECT database_id FROM pages WHERE id = $1").bind(page_id.db()).fetch_optional(&mut **tx).await?;
    match row {
        None => Err(Error::NotFound(format!("etapa {page_id}"))),
        Some(DbIdOpt(None)) => {
            Err(Error::Invalid(format!("{page_id} não é um registro de database (sem database_id) — não pode ter flecha")))
        }
        Some(DbIdOpt(Some(database_id))) => Ok(database_id),
    }
}

/// TRL-003/DBS-119: as duas pontas de uma flecha precisam ser registros da
/// MESMA database — ver o comentário de `TrilhaRepository::criar_flecha`
/// para o porquê (uma flecha entre databases diferentes nunca apareceria em
/// `obter_trilha`, que filtra por database).
async fn ensure_same_database_record_tx(tx: &mut Transaction<'_, Sqlite>, blocked_id: Uuid, blocking_id: Uuid) -> Result<()> {
    let blocked_database = fetch_record_database_id_tx(tx, blocked_id).await?;
    let blocking_database = fetch_record_database_id_tx(tx, blocking_id).await?;
    if blocked_database != blocking_database {
        return Err(Error::Invalid(format!(
            "as etapas {blocked_id} e {blocking_id} não são da mesma database — essa flecha nunca apareceria em obter_trilha"
        )));
    }
    Ok(())
}

/// Espelha o gatilho `database_record_dependencies_rotulo_valido_*` de 0035
/// em Rust: rótulo de caminho só existe em flecha que SAI de uma decisão.
async fn ensure_is_decision_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<()> {
    let existe: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM trail_decisions WHERE step_id = $1)")
        .bind(step_id.db())
        .fetch_one(&mut **tx)
        .await?;
    if !existe {
        return Err(Error::Invalid(format!(
            "{step_id} não é uma decisão — rótulo de caminho só existe em flecha que sai de uma decisão"
        )));
    }
    Ok(())
}

async fn fetch_blocking_ids_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<Vec<Uuid>> {
    let rows: Vec<DbId> = sqlx::query_scalar("SELECT blocking_id FROM database_record_dependencies WHERE blocked_id = $1")
        .bind(step_id.db())
        .fetch_all(&mut **tx)
        .await?;
    Ok(rows.into_iter().map(Uuid::from).collect())
}

/// Todo id de página-registro de uma database (mesmo filtro de
/// `fetch_step_bases`: sem template, sem lixeira) — só os ids, para o
/// universo que [`compute_desbloqueio_tx`] passa a [`avaliar_desbloqueio`].
async fn fetch_step_ids_for_database_tx(tx: &mut Transaction<'_, Sqlite>, database_id: Uuid) -> Result<Vec<Uuid>> {
    let rows: Vec<DbId> = sqlx::query_scalar(
        "SELECT id FROM pages WHERE database_id = $1 AND is_template = 0 AND deleted_at IS NULL",
    )
    .bind(database_id.db())
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(Uuid::from).collect())
}

/// Mesma consulta de [`fetch_dependencies_into`], dentro de uma transação —
/// duplicada (em vez de genérica sobre o executor) para não arriscar a
/// ginástica de lifetime de um `Executor` genérico reusado em várias
/// consultas sequenciais dentro do mesmo `tx`.
async fn fetch_dependencies_into_tx(tx: &mut Transaction<'_, Sqlite>, etapa_ids: &[Uuid]) -> Result<Vec<Flecha>> {
    if etapa_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut dependencias = Vec::new();
    for chunk in etapa_ids.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!(
            "SELECT blocked_id, blocking_id, path_label FROM database_record_dependencies WHERE blocked_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, Flecha>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        dependencias.extend(query.fetch_all(&mut **tx).await?);
    }
    Ok(dependencias)
}

/// Mesma consulta de [`fetch_done_set`], dentro de uma transação.
async fn fetch_done_set_tx(tx: &mut Transaction<'_, Sqlite>, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let unique: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let mut done = HashSet::new();
    for chunk in unique.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!("SELECT step_id FROM trail_step_progress WHERE state = 'done' AND step_id IN ({placeholders})");
        let mut query = sqlx::query_scalar(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        let rows: Vec<DbId> = query.fetch_all(&mut **tx).await?;
        done.extend(rows.into_iter().map(Uuid::from));
    }
    Ok(done)
}

/// Mesma consulta de [`fetch_decisions`], dentro de uma transação.
async fn fetch_decisions_tx(tx: &mut Transaction<'_, Sqlite>, ids: &[Uuid]) -> Result<Vec<Decisao>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let unique: Vec<Uuid> = ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();
    let mut decisoes = Vec::new();
    for chunk in unique.chunks(sql::MAX_BIND_PARAMS) {
        let placeholders = sql::in_placeholders(chunk.len());
        let query_sql = format!(
            "SELECT step_id, chosen_label, chosen_at, created_at, updated_at \
             FROM trail_decisions WHERE step_id IN ({placeholders})"
        );
        let mut query = sqlx::query_as::<_, Decisao>(&query_sql);
        for id in chunk {
            query = query.bind(id.db());
        }
        decisoes.extend(query.fetch_all(&mut **tx).await?);
    }
    Ok(decisoes)
}

/// A MESMA regra de [`avaliar_desbloqueio`] usada por `obter_trilha`, agora
/// para UMA etapa dentro de uma transação — fecha o risco #1 do desenho de
/// 0035 (duas implementações de desbloqueio que divergiam de escopo): esta é
/// a ÚNICA, e `marcar_progresso_etapa`/`etapa_esta_desbloqueada` só chamam
/// esta função, nunca reimplementam o cálculo.
async fn compute_desbloqueio_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<Desbloqueio> {
    let database_id: DbIdOpt =
        sqlx::query_scalar("SELECT database_id FROM pages WHERE id = $1").bind(step_id.db()).fetch_one(&mut **tx).await?;

    let Some(database_id) = Option::<Uuid>::from(database_id) else {
        // Página comum (não é registro de nenhuma database): o conceito de
        // decisão não se aplica a ela (só um registro pode ser decisão, ver
        // 0035) — cálculo direto de sempre, sem cascata de descarte.
        let bloqueadoras = fetch_blocking_ids_tx(tx, step_id).await?;
        for bloqueadora in bloqueadoras {
            let state: Option<String> = sqlx::query_scalar("SELECT state FROM trail_step_progress WHERE step_id = $1")
                .bind(bloqueadora.db())
                .fetch_optional(&mut **tx)
                .await?;
            if state.as_deref() != Some("done") {
                return Ok(Desbloqueio { is_unlocked: false, situacao: SituacaoNoCaminho::Ativo });
            }
        }
        return Ok(Desbloqueio { is_unlocked: true, situacao: SituacaoNoCaminho::Ativo });
    };

    // É registro: reconstrói o grafo INTEIRO da database dentro da MESMA
    // transação — necessário porque "descartada" propaga por dependência
    // transitiva, e não dá para responder por uma etapa isolada sem saber a
    // classificação das que a alimentam (mesmo motivo de `obter_trilha`).
    let etapa_ids = fetch_step_ids_for_database_tx(tx, database_id).await?;
    let todas_dependencias = fetch_dependencies_into_tx(tx, &etapa_ids).await?;
    let bloqueadoras_ids: Vec<Uuid> = todas_dependencias.iter().map(|dep| dep.blocking_id).collect();
    let concluidas = fetch_done_set_tx(tx, &bloqueadoras_ids).await?;

    let mut universo_decisoes = etapa_ids.clone();
    universo_decisoes.extend(bloqueadoras_ids.iter().copied());
    let todas_decisoes = fetch_decisions_tx(tx, &universo_decisoes).await?;
    let escolhas: HashMap<Uuid, Option<String>> =
        todas_decisoes.iter().map(|decisao| (decisao.step_id, decisao.chosen_label.clone())).collect();

    let mapa = avaliar_desbloqueio(&etapa_ids, &todas_dependencias, &escolhas, &concluidas);
    mapa.get(&step_id)
        .copied()
        .ok_or_else(|| Error::NotFound(format!("etapa {step_id} não apareceu no cálculo de desbloqueio da própria database")))
}

async fn compute_is_unlocked_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<bool> {
    Ok(compute_desbloqueio_tx(tx, step_id).await?.is_unlocked)
}

/// Acha o título da decisão "responsável" por uma etapa estar descartada —
/// sobe a cadeia de flechas mortas (BFS, com `visitados` contra ciclo) até
/// achar a primeira cujo rótulo bate DIRETAMENTE com uma decisão que já
/// escolheu outro caminho. Usada só para a mensagem de erro de
/// `marcar_progresso_etapa` (0035, item 8 do desenho); se não achar (não
/// deveria acontecer numa etapa de fato `Descartado`), devolve `None` e a
/// chamadora cai para uma mensagem genérica em vez de travar.
async fn find_discarding_decision_title_tx(tx: &mut Transaction<'_, Sqlite>, step_id: Uuid) -> Result<Option<String>> {
    let mut visitados: HashSet<Uuid> = HashSet::new();
    let mut fila: VecDeque<Uuid> = VecDeque::from([step_id]);

    while let Some(atual) = fila.pop_front() {
        if !visitados.insert(atual) {
            continue;
        }
        let entradas: Vec<(DbId, Option<String>)> =
            sqlx::query_as("SELECT blocking_id, path_label FROM database_record_dependencies WHERE blocked_id = $1")
                .bind(atual.db())
                .fetch_all(&mut **tx)
                .await?;
        for (blocking_id_raw, rotulo) in entradas {
            let blocking_id = Uuid::from(blocking_id_raw);
            if let Some(rotulo) = rotulo {
                let escolha: Option<Option<String>> =
                    sqlx::query_scalar("SELECT chosen_label FROM trail_decisions WHERE step_id = $1")
                        .bind(blocking_id.db())
                        .fetch_optional(&mut **tx)
                        .await?;
                if let Some(Some(escolhido)) = escolha {
                    if escolhido != rotulo {
                        let titulo: Option<String> = sqlx::query_scalar("SELECT title FROM pages WHERE id = $1")
                            .bind(blocking_id.db())
                            .fetch_optional(&mut **tx)
                            .await?;
                        return Ok(titulo);
                    }
                }
            }
            fila.push_back(blocking_id);
        }
    }
    Ok(None)
}

async fn ensure_lane_exists_tx(tx: &mut Transaction<'_, Sqlite>, view_id: Uuid, lane_value: &str) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM trail_lanes WHERE view_id = $1 AND lane_value = $2)")
            .bind(view_id.db())
            .bind(lane_value)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(Error::NotFound(format!("raia {lane_value:?} na trilha {view_id}")));
    }
    Ok(())
}

async fn fetch_lane_siblings_tx(
    tx: &mut Transaction<'_, Sqlite>,
    view_id: Uuid,
    exclude_lane_value: &str,
) -> Result<Vec<(String, String)>> {
    sqlx::query_as(
        "SELECT lane_value, position FROM trail_lanes WHERE view_id = $1 AND lane_value <> $2 ORDER BY position",
    )
    .bind(view_id.db())
    .bind(exclude_lane_value)
    .fetch_all(&mut **tx)
    .await
    .map_err(Error::from)
}

/// Mesmo par vizinho-antes/vizinho-depois de `db::cronograma::neighbours_for`,
/// reescrito aqui porque a chave de irmão é `lane_value` (texto), não um id
/// — pequeno demais para valer a pena generalizar por um segundo uso.
fn lane_neighbours<'a>(
    siblings: &'a [(String, String)],
    apos_lane_value: Option<&str>,
) -> Result<(Option<&'a str>, Option<&'a str>)> {
    match apos_lane_value {
        None => Ok((None, siblings.first().map(|(_, p)| p.as_str()))),
        Some(after) => {
            let index = siblings
                .iter()
                .position(|(value, _)| value == after)
                .ok_or_else(|| Error::Invalid("raia de referência não existe nesta trilha".into()))?;
            let before = siblings[index].1.as_str();
            let after_position = siblings.get(index + 1).map(|(_, p)| p.as_str());
            Ok((Some(before), after_position))
        }
    }
}

fn position_between_lanes(siblings: &[(String, String)], apos_lane_value: Option<&str>) -> Result<String> {
    let (before_raw, after_raw) = lane_neighbours(siblings, apos_lane_value)?;
    let before = before_raw.map(position::parse).transpose()?;
    let after = after_raw.map(position::parse).transpose()?;
    position::between(before.as_ref(), after.as_ref())
}

#[cfg(test)]
mod tests {
    // Regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa isenção, então ela é escrita aqui — mesmo
    // padrão de `db::position`/`db::cronograma`.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn flecha(bloqueada: Uuid, bloqueadora: Uuid) -> Flecha {
        Flecha { blocked_id: bloqueada, blocking_id: bloqueadora, path_label: None }
    }

    fn flecha_com_rotulo(bloqueada: Uuid, bloqueadora: Uuid, rotulo: &str) -> Flecha {
        Flecha { blocked_id: bloqueada, blocking_id: bloqueadora, path_label: Some(rotulo.to_string()) }
    }

    /// O caso que decide o desenho inteiro (0035): D ramifica em Sim -> A e
    /// Não -> B, e os dois caminhos se REENCONTRAM em Z (A e B bloqueiam Z).
    /// Escolher "Sim" e concluir D e A precisa desbloquear Z mesmo com B (o
    /// ramo abandonado) nunca tendo sido concluído — senão o reencontro trava
    /// para sempre e a feature inteira é inútil.
    #[test]
    fn avaliar_desbloqueio_reencontro_de_dois_caminhos_libera_com_o_ramo_escolhido() {
        let d = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let z = Uuid::now_v7();
        let etapas = [d, a, b, z];
        let flechas =
            vec![flecha_com_rotulo(a, d, "Sim"), flecha_com_rotulo(b, d, "Não"), flecha(z, a), flecha(z, b)];
        let escolhas: HashMap<Uuid, Option<String>> = [(d, Some("Sim".to_string()))].into_iter().collect();
        let concluidas: HashSet<Uuid> = [d, a].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &flechas, &escolhas, &concluidas);

        assert!(resultado[&z].is_unlocked, "Z precisa desbloquear com o ramo escolhido concluído");
        assert_eq!(resultado[&z].situacao, SituacaoNoCaminho::Ativo);
        assert_eq!(resultado[&a].situacao, SituacaoNoCaminho::Ativo, "caminho escolhido");
        assert_eq!(resultado[&b].situacao, SituacaoNoCaminho::Descartado, "caminho abandonado, visível e cinza");
        assert!(!resultado[&b].is_unlocked);
    }

    /// Sem escolha ainda, nenhum dos dois caminhos deve liberar — e a etapa
    /// fica marcada `aguardandoEscolha`, não `ativo` nem `descartado`.
    #[test]
    fn avaliar_desbloqueio_decisao_pendente_marca_aguardando_escolha_e_nao_desbloqueia() {
        let d = Uuid::now_v7();
        let a = Uuid::now_v7();
        let etapas = [d, a];
        let flechas = vec![flecha_com_rotulo(a, d, "Sim")];
        let escolhas: HashMap<Uuid, Option<String>> = [(d, None)].into_iter().collect();
        let concluidas: HashSet<Uuid> = [d].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &flechas, &escolhas, &concluidas);

        assert_eq!(resultado[&a].situacao, SituacaoNoCaminho::AguardandoEscolha);
        assert!(!resultado[&a].is_unlocked, "decisão ainda não escolhida não pode liberar o ramo");
    }

    /// Uma decisão sem NENHUM caminho nomeado ainda não pode virar um beco:
    /// ela se comporta como etapa comum (0035 — "decisão sem caminho é
    /// estado válido de nascença").
    #[test]
    fn avaliar_desbloqueio_decisao_sem_caminho_nenhum_se_comporta_como_etapa_comum() {
        let d = Uuid::now_v7();
        let etapas = [d];
        let escolhas: HashMap<Uuid, Option<String>> = [(d, None)].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &[], &escolhas, &HashSet::new());

        assert!(resultado[&d].is_unlocked, "decisão sem flecha de entrada nasce disponível, igual etapa comum");
        assert_eq!(resultado[&d].situacao, SituacaoNoCaminho::Ativo);
    }

    /// Ciclo com rótulo dentro dele: não trava (a garantia que já existia
    /// para `calcular_niveis_topologicos`) e NUNCA marca `Descartado`, mesmo
    /// que o rótulo não bata com a escolha — "conservador, nunca descarta
    /// por engano" (0035).
    #[test]
    fn avaliar_desbloqueio_ciclo_com_rotulo_nao_trava_e_nunca_marca_descartado() {
        let d = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let etapas = [d, a, b];
        // d ramifica para a (rótulo "Sim", não escolhido); a e b fecham
        // ciclo entre si.
        let flechas = vec![flecha_com_rotulo(a, d, "Sim"), flecha(b, a), flecha(a, b)];
        let escolhas: HashMap<Uuid, Option<String>> = [(d, Some("Não".to_string()))].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &flechas, &escolhas, &HashSet::new());

        assert_ne!(resultado[&a].situacao, SituacaoNoCaminho::Descartado);
        assert_ne!(resultado[&b].situacao, SituacaoNoCaminho::Descartado);
        assert!(!resultado[&a].is_unlocked && !resultado[&b].is_unlocked, "continuam bloqueadas, só não descartadas");
    }

    /// Rótulo cuja origem não é (mais) uma decisão conhecida — só alcançável
    /// via exclusão definitiva da página da decisão — degrada para
    /// pré-requisito incondicional em vez de bloquear para sempre.
    #[test]
    fn avaliar_desbloqueio_rotulo_orfao_vira_pre_requisito_incondicional() {
        let d = Uuid::now_v7();
        let a = Uuid::now_v7();
        let etapas = [d, a];
        let flechas = vec![flecha_com_rotulo(a, d, "Sim")];
        // `d` NÃO está no mapa de escolhas: não é (mais) uma decisão.
        let escolhas: HashMap<Uuid, Option<String>> = HashMap::new();
        let concluidas: HashSet<Uuid> = [d].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &flechas, &escolhas, &concluidas);

        assert!(resultado[&a].is_unlocked, "órfão vira incondicional: d concluída já basta");
        assert_eq!(resultado[&a].situacao, SituacaoNoCaminho::Ativo);
    }

    /// "Sim" levando a duas etapas em paralelo é UM caminho, duas flechas —
    /// as duas precisam se comportar como o mesmo ramo (0035: "não existe
    /// índice único sobre (blocking_id, path_label)").
    #[test]
    fn avaliar_desbloqueio_duas_flechas_com_o_mesmo_rotulo_sao_o_mesmo_caminho() {
        let d = Uuid::now_v7();
        let a = Uuid::now_v7();
        let c = Uuid::now_v7();
        let etapas = [d, a, c];
        let flechas = vec![flecha_com_rotulo(a, d, "Sim"), flecha_com_rotulo(c, d, "Sim")];
        let escolhas: HashMap<Uuid, Option<String>> = [(d, Some("Sim".to_string()))].into_iter().collect();
        let concluidas: HashSet<Uuid> = [d].into_iter().collect();

        let resultado = avaliar_desbloqueio(&etapas, &flechas, &escolhas, &concluidas);

        assert!(resultado[&a].is_unlocked && resultado[&c].is_unlocked, "as duas pontas do mesmo caminho liberam juntas");
    }

    #[test]
    fn etapa_solta_fica_no_nivel_zero() {
        let a = Uuid::now_v7();
        let niveis = calcular_niveis_topologicos(&[a], &[]);

        assert_eq!(niveis[&a], NivelTopologico { nivel: 0, em_ciclo: false });
    }

    #[test]
    fn cadeia_simples_incrementa_um_nivel_por_elo() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let c = Uuid::now_v7();
        // a bloqueia b, b bloqueia c.
        let flechas = vec![flecha(b, a), flecha(c, b)];

        let niveis = calcular_niveis_topologicos(&[a, b, c], &flechas);

        assert_eq!(niveis[&a].nivel, 0);
        assert_eq!(niveis[&b].nivel, 1);
        assert_eq!(niveis[&c].nivel, 2);
        assert!(!niveis[&a].em_ciclo && !niveis[&b].em_ciclo && !niveis[&c].em_ciclo);
    }

    /// Árvore que se junta: A e B bloqueiam a MESMA etapa C. O nível de C
    /// precisa ser o da mais funda das duas + 1, não o de qualquer uma
    /// isolada.
    #[test]
    fn duas_bloqueadoras_da_mesma_etapa_usam_a_mais_funda() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let c = Uuid::now_v7();
        let d = Uuid::now_v7();
        // a bloqueia b (b fica nível 1); a e b bloqueiam c e d.
        let flechas = vec![flecha(b, a), flecha(c, a), flecha(c, b), flecha(d, b)];

        let niveis = calcular_niveis_topologicos(&[a, b, c, d], &flechas);

        assert_eq!(niveis[&a].nivel, 0);
        assert_eq!(niveis[&b].nivel, 1);
        // c é bloqueada por a (nível 0) E por b (nível 1) — usa o maior + 1.
        assert_eq!(niveis[&c].nivel, 2);
        assert_eq!(niveis[&d].nivel, 2);
    }

    /// TRL-005, o caso que importa: ciclo de tamanho dois não trava o
    /// algoritmo (sem laço infinito, sem estouro de pilha) e as duas etapas
    /// ficam marcadas `em_ciclo`.
    #[test]
    fn ciclo_de_dois_nao_trava_e_marca_as_duas_etapas() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        // a bloqueia b, e b bloqueia a.
        let flechas = vec![flecha(b, a), flecha(a, b)];

        let niveis = calcular_niveis_topologicos(&[a, b], &flechas);

        assert!(niveis[&a].em_ciclo);
        assert!(niveis[&b].em_ciclo);
        assert_eq!(niveis[&a].nivel, NIVEL_EM_CICLO);
        assert_eq!(niveis[&b].nivel, NIVEL_EM_CICLO);
    }

    /// O mesmo, com um ciclo de três (A→B→C→A), e uma quarta etapa isolada
    /// que não pode ser contaminada pelo ciclo alheio.
    #[test]
    fn ciclo_de_tres_nao_trava_e_nao_contamina_etapa_isolada() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let c = Uuid::now_v7();
        let isolada = Uuid::now_v7();
        let flechas = vec![flecha(b, a), flecha(c, b), flecha(a, c)];

        let niveis = calcular_niveis_topologicos(&[a, b, c, isolada], &flechas);

        assert!(niveis[&a].em_ciclo && niveis[&b].em_ciclo && niveis[&c].em_ciclo);
        assert_eq!(niveis[&isolada], NivelTopologico { nivel: 0, em_ciclo: false });
    }

    /// Quem depende de um ciclo (sem estar NELE) também não tem nível
    /// topológico válido — nunca teria grau de entrada zero, porque espera
    /// por uma etapa que nunca termina de ser processada.
    #[test]
    fn etapa_que_depende_de_um_ciclo_tambem_fica_em_ciclo() {
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let rio_abaixo = Uuid::now_v7();
        let flechas = vec![flecha(b, a), flecha(a, b), flecha(rio_abaixo, b)];

        let niveis = calcular_niveis_topologicos(&[a, b, rio_abaixo], &flechas);

        assert!(niveis[&rio_abaixo].em_ciclo);
    }

    /// O ciclo COM ENTRADA DE FORA — o caso que passou batido por muito tempo.
    ///
    /// `entrada` aponta para `a`, e `a ⇄ b`. Processar `entrada` grava um
    /// nível PROVISÓRIO em `a` (o algoritmo relaxa o nível do filho ao visitar
    /// o pai, antes de fixá-lo), e `a` nunca chega a grau zero porque espera
    /// `b` para sempre. Enquanto o critério de ciclo foi "recebeu nível?",
    /// esse `a` voltava com `em_ciclo = false` e um nível inventado: o desenho
    /// mostrava uma coluna plausível para um grafo que não tem ordem nenhuma.
    ///
    /// Os testes de ciclo acima não pegavam isto porque os ciclos deles são
    /// isolados — ninguém de fora grava nível provisório neles. É a diferença
    /// entre "recebeu nível" e "teve o nível FIXADO".
    #[test]
    fn ciclo_alcancado_de_fora_continua_marcado_como_ciclo() {
        let entrada = Uuid::now_v7();
        let a = Uuid::now_v7();
        let b = Uuid::now_v7();
        let flechas = vec![flecha(a, entrada), flecha(b, a), flecha(a, b)];

        let niveis = calcular_niveis_topologicos(&[entrada, a, b], &flechas);

        assert!(niveis[&a].em_ciclo, "a recebeu nível provisório de `entrada`, mas continua preso no ciclo com b");
        assert!(niveis[&b].em_ciclo);
        assert_eq!(niveis[&a].nivel, NIVEL_EM_CICLO, "o nível provisório precisa ser descartado, não exibido");
        assert_eq!(niveis[&b].nivel, NIVEL_EM_CICLO);
        // Quem está FORA do ciclo continua com nível de verdade.
        assert_eq!(niveis[&entrada], NivelTopologico { nivel: 0, em_ciclo: false });
    }

    #[test]
    fn flecha_com_ponta_fora_do_conjunto_de_etapas_e_ignorada() {
        let a = Uuid::now_v7();
        let fora = Uuid::now_v7();
        let flechas = vec![flecha(a, fora)];

        let niveis = calcular_niveis_topologicos(&[a], &flechas);

        assert_eq!(niveis[&a], NivelTopologico { nivel: 0, em_ciclo: false });
    }

    #[test]
    fn validate_progress_state_aceita_as_duas_e_recusa_o_resto() {
        assert!(validate_progress_state("in_progress").is_ok());
        assert!(validate_progress_state("done").is_ok());
        assert!(matches!(validate_progress_state("not_started"), Err(Error::Invalid(_))));
        assert!(matches!(validate_progress_state(""), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_material_kind_and_target_exige_deck_id_so_para_kind_deck() {
        let etapa = Uuid::now_v7();
        let deck = Uuid::now_v7();
        let pagina = Uuid::now_v7();

        assert!(validate_material_kind_and_target("deck", None, Some(deck), etapa).is_ok());
        assert!(matches!(
            validate_material_kind_and_target("deck", Some(pagina), Some(deck), etapa),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(validate_material_kind_and_target("deck", None, None, etapa), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_material_kind_and_target_exige_page_id_para_page_e_book() {
        let etapa = Uuid::now_v7();
        let pagina = Uuid::now_v7();
        let deck = Uuid::now_v7();

        assert!(validate_material_kind_and_target("page", Some(pagina), None, etapa).is_ok());
        assert!(validate_material_kind_and_target("book", Some(pagina), None, etapa).is_ok());
        assert!(matches!(validate_material_kind_and_target("page", None, Some(deck), etapa), Err(Error::Invalid(_))));
        assert!(matches!(validate_material_kind_and_target("book", None, None, etapa), Err(Error::Invalid(_))));
    }

    #[test]
    fn validate_material_kind_and_target_recusa_etapa_apontando_para_si_mesma() {
        let etapa = Uuid::now_v7();
        assert!(matches!(
            validate_material_kind_and_target("page", Some(etapa), None, etapa),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn validate_material_kind_and_target_recusa_kind_desconhecido() {
        let etapa = Uuid::now_v7();
        let pagina = Uuid::now_v7();
        assert!(matches!(
            validate_material_kind_and_target("video", Some(pagina), None, etapa),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn lane_neighbours_none_e_aberto_abaixo_da_primeira() {
        let siblings = vec![("T.I.".to_string(), position::first())];
        let (before, after) = lane_neighbours(&siblings, None).unwrap();
        assert_eq!(before, None);
        assert_eq!(after, Some(siblings[0].1.as_str()));
    }

    #[test]
    fn lane_neighbours_recusa_referencia_desconhecida() {
        let siblings = vec![("T.I.".to_string(), position::first())];
        assert!(lane_neighbours(&siblings, Some("Inglês")).is_err());
    }
}
