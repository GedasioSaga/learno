import type { BlocoPlanejado, SemanaDeEstudo } from "../../lib/ipc";

/**
 * O modelo puro por trás da visão de Grade (`GradeSemanal.tsx`): dado uma
 * `SemanaDeEstudo`, decide em que LINHA (faixa de horário) e LANE (coluna
 * lado a lado, dentro do dia) cada bloco com horário cai — sem tocar em DOM.
 * `GradeSemanal.tsx` só percorre o resultado e desenha `<table>`.
 *
 * Quatro decisões desta rodada, documentadas aqui porque é aqui que elas
 * viram código (o relatório de entrega repete o resumo):
 *
 * 1) FAIXA DE HORÁRIO DA GRADE — nunca fixa (7h–23h desperdiçaria a tela
 *    inteira pra quem estuda de madrugada ou só de noite). `calcularFaixaDaGrade`
 *    deriva do menor início e do maior fim entre os blocos COM horário da
 *    semana, arredondado pra hora cheia (floor no início, ceil no fim), com
 *    um mínimo de `SPAN_MINIMO_MINUTOS` pra um único bloco curto não virar
 *    uma grade de uma linha só. Semana sem NENHUM bloco com horário não gera
 *    faixa nenhuma — `temBlocoComHorario: false`, e `GradeSemanal.tsx` mostra
 *    um estado vazio de verdade em vez de uma grade em branco.
 *
 * 2) GRANULARIDADE DA LINHA — 30 minutos (`GRANULARIDADE_MINUTOS`), o mesmo
 *    passo que qualquer agenda visual usa. Um bloco de 25 minutos (o
 *    tamanho de um Pomodoro, que vai ser comum aqui) quase nunca alinha
 *    exatamente com uma linha de 30 minutos — a linha em que ele começa é a
 *    que CONTÉM o minuto de início (`linhaDoMinuto` usa `Math.floor`), e ele
 *    ocupa pelo menos 1 linha (`linhaSpan` nunca é 0). O horário exato
 *    (`horaInicio`–`horaFim`) e a duração (`formatarDuracao`, já existente)
 *    aparecem por escrito dentro da célula — a granularidade da LINHA é
 *    visual, a informação de horário nunca é arredondada.
 *
 * 3) BLOCO QUE ATRAVESSA VÁRIAS LINHAS — `linhaSpan` > 1 vira `rowSpan` na
 *    `<td>` (`GradeSemanal.tsx`); o título não se repete porque só existe
 *    UMA célula pro bloco inteiro, não uma por linha.
 *
 * 4) DOIS BLOCOS NO MESMO HORÁRIO DO MESMO DIA — `atribuirLanes` faz
 *    particionamento de intervalos guloso (o mesmo algoritmo de qualquer
 *    agenda visual): cada bloco entra na primeira lane livre naquele
 *    horário; sem lane livre, abre uma nova. Nunca dois blocos na mesma
 *    lane com horário sobreposto — `GradeSemanal.tsx` desenha lanes como
 *    colunas lado a lado dentro do dia, nunca uma célula por cima da outra.
 *    As lanes são contadas POR GRUPO DE CONFLITO (`agruparConflitos`), não
 *    por dia: só quem está de fato no conflito divide a largura.
 *
 * Bloco SEM horário (`startLocalTime === null`) não entra na grade — não há
 * onde posicioná-lo num eixo de tempo. Ele não soma: `separarPorHorario` o
 * devolve em `ColunaDaGrade.semHorario`, e `GradeSemanal.tsx` desenha uma
 * seção própria "Sem horário definido" abaixo da grade, reaproveitando
 * `BlocoCard` (mesmo componente da visão de Colunas) — ele nunca
 * desaparece, só não fica na grade de horários.
 */

export const GRANULARIDADE_MINUTOS = 30;
const SPAN_MINIMO_MINUTOS = 180;
const MINUTOS_POR_DIA = 24 * 60;

function pad2(valor: number): string {
  return String(valor).padStart(2, "0");
}

/** "09:30" a partir de 570 minutos desde 00:00. */
export function minutosParaRotulo(minutos: number): string {
  return `${pad2(Math.floor(minutos / 60))}:${pad2(minutos % 60)}`;
}

/** "09:30" -> 570. Espelha o formato `HH:MM` de `BlocoPlanejado.startLocalTime`. Exportada porque `GradeSemanal.tsx` deriva o estado passado/agora/futuro do bloco com a mesma leitura. */
export function minutosDoHorario(horario: string): number {
  const [horas, minutos] = horario.split(":").map(Number);
  return horas * 60 + minutos;
}

/**
 * Fim (minutos desde 00:00) de um bloco, clipado em 24:00 — nunca negativo
 * nem "voltando" pro início do dia. Só existe como CAMINHO DEFENSIVO: o
 * normal é ler `bloco.endLocalTime` direto (ver `separarPorHorario`), que o
 * backend já deriva com a mesma regra (`fim_local`, Fase 1 do Cronograma) e
 * já resolve o caso de atravessar a meia-noite via `crossesMidnight`. Esta
 * função só entra em jogo se `endLocalTime` vier `null` com `startLocalTime`
 * preenchido — um estado que a documentação do próprio campo diz que não
 * deveria acontecer, mas não custa não confiar cegamente nisso (regra de
 * nunca assumir o que um campo opcional teria "garantido").
 */
function fimEmMinutosSemDado(inicioMinutos: number, plannedMinutes: number): number {
  return Math.min(inicioMinutos + plannedMinutes, MINUTOS_POR_DIA);
}

export interface FaixaHoraria {
  /** Minutos desde 00:00 em que a linha começa. */
  minutoInicio: number;
  /** "09:30" — o que aparece no cabeçalho da linha. */
  rotulo: string;
}

export interface BlocoNaCelula {
  bloco: BlocoPlanejado;
  /** Índice em `GradeSemana.faixas` onde a célula do bloco começa. */
  linhaInicio: number;
  /** Quantas linhas a célula ocupa — vira `rowSpan` na `<td>`. Nunca 0. */
  linhaSpan: number;
  /** Coluna lado a lado dentro do dia (0-based) — ver item 4 do comentário de topo. */
  lane: number;
  /**
   * Quantas lanes o GRUPO de conflito deste bloco tem (ver `GrupoDeConflito`)
   * — não o dia inteiro. Um bloco sozinho às 14:00 tem `totalLanes: 1` mesmo
   * que às 09:00 do mesmo dia haja três blocos brigando: a largura dele não
   * paga pelo conflito dos outros.
   */
  totalLanes: number;
  /** Índice em `ColunaDaGrade.grupos` do grupo de conflito a que o bloco pertence. */
  grupo: number;
  /** `startLocalTime`, já sabido não-nulo (só blocos com horário viram `BlocoNaCelula`) — evita um `!`/`as` no componente. */
  horaInicio: string;
  /** Horário de término — normalmente o `endLocalTime` já derivado pelo backend (Fase 1 do Cronograma); ver `separarPorHorario`. */
  horaFim: string;
}

/**
 * Um GRUPO DE CONFLITO: o conjunto de blocos do dia ligados por sobreposição
 * (A cruza B, B cruza C → A, B e C são um grupo, mesmo que A e C não se
 * toquem). É a unidade que a tela divide em lanes — `GradeSemanal.tsx`
 * decide quantas lanes do grupo cabem na largura da coluna e esconde o
 * excedente atrás de um "+N", por grupo, nunca pela coluna inteira.
 */
export interface GrupoDeConflito {
  /** Minutos desde 00:00 em que o primeiro bloco do grupo começa. */
  inicio: number;
  /** Minutos desde 00:00 em que o último bloco do grupo termina (clipado em 24:00). */
  fim: number;
  /** Lanes que o grupo precisa — 1 quando é um bloco sozinho. */
  totalLanes: number;
  /** Os blocos do grupo, ordenados por início e lane — os MESMOS objetos de `blocosPosicionados`. */
  blocos: BlocoNaCelula[];
}

export interface ColunaDaGrade {
  data: string;
  /** Sempre ≥ 1, mesmo num dia sem bloco algum: o maior `totalLanes` entre os grupos do dia. */
  totalLanes: number;
  blocosPosicionados: BlocoNaCelula[];
  /** Grupos de conflito do dia, por ordem de início; a soma dos `blocos` é `blocosPosicionados`. */
  grupos: GrupoDeConflito[];
  /** Blocos deste dia sem `startLocalTime` — nunca somem, só não entram na grade de horários. */
  semHorario: BlocoPlanejado[];
}

export interface GradeSemana {
  /** Vazio quando `temBlocoComHorario` é `false` — não há eixo de tempo pra desenhar. */
  faixas: FaixaHoraria[];
  colunas: ColunaDaGrade[];
  /** `false` = nenhum bloco da semana tem horário; é o sinal pro estado vazio honesto (ver item 1 do comentário de topo). */
  temBlocoComHorario: boolean;
}

interface BlocoComHorario {
  bloco: BlocoPlanejado;
  inicio: number;
  fim: number;
  horaInicio: string;
}

function separarPorHorario(blocos: readonly BlocoPlanejado[]): {
  comHorario: BlocoComHorario[];
  semHorario: BlocoPlanejado[];
} {
  const comHorario: BlocoComHorario[] = [];
  const semHorario: BlocoPlanejado[] = [];
  for (const bloco of blocos) {
    if (bloco.startLocalTime === null) {
      semHorario.push(bloco);
      continue;
    }
    const inicio = minutosDoHorario(bloco.startLocalTime);
    // `crossesMidnight`: o bloco continuaria no dia seguinte — clipa em
    // 24:00 NESTA coluna (desenhar a continuação no dia seguinte é
    // calendário multi-dia, fora desta rodada, ver relatório de entrega).
    // Sem `crossesMidnight`, usa `endLocalTime` (derivado no backend) e só
    // recorre ao cálculo local se ele vier `null` por algum motivo.
    const fim = bloco.crossesMidnight
      ? MINUTOS_POR_DIA
      : bloco.endLocalTime !== null
        ? minutosDoHorario(bloco.endLocalTime)
        : fimEmMinutosSemDado(inicio, bloco.plannedMinutes);
    comHorario.push({ bloco, inicio, fim, horaInicio: bloco.startLocalTime });
  }
  return { comHorario, semHorario };
}

/**
 * Faixa [início, fim) que a grade inteira cobre, em minutos desde 00:00 —
 * só chamada quando já existe pelo menos um bloco com horário na semana
 * (ver item 1 do comentário de topo do arquivo).
 */
function calcularFaixaDaGrade(blocos: readonly BlocoComHorario[]): { inicio: number; fim: number } {
  const menorInicio = Math.min(...blocos.map((b) => b.inicio));
  const maiorFim = Math.max(...blocos.map((b) => b.fim));
  let inicio = Math.floor(menorInicio / 60) * 60;
  let fim = Math.min(Math.ceil(maiorFim / 60) * 60, MINUTOS_POR_DIA);
  if (fim - inicio < SPAN_MINIMO_MINUTOS) {
    fim = Math.min(inicio + SPAN_MINIMO_MINUTOS, MINUTOS_POR_DIA);
  }
  // Se o mínimo estourou a meia-noite (semana com bloco só depois das 21h30,
  // por exemplo) e ainda assim não bateu o mínimo, recua o INÍCIO em vez de
  // ultrapassar 24:00 — nunca desenha uma linha de horário inexistente.
  if (fim - inicio < SPAN_MINIMO_MINUTOS) {
    inicio = Math.max(0, fim - SPAN_MINIMO_MINUTOS);
  }
  return { inicio, fim };
}

/** Índice de linha (em `faixas`) que contém o minuto dado, sempre dentro de `[0, totalLinhas - 1]`. */
function linhaDoMinuto(minuto: number, inicioDaGrade: number, totalLinhas: number): number {
  const linha = Math.floor((minuto - inicioDaGrade) / GRANULARIDADE_MINUTOS);
  return Math.min(Math.max(linha, 0), totalLinhas - 1);
}

/**
 * Particionamento de intervalos guloso: cada bloco (já ordenado por início)
 * entra na primeira lane cujo último bloco já terminou (`<=`, não `<` — dois
 * blocos que só se tocam, um termina exatamente quando o outro começa, não
 * são conflito); sem lane livre, abre uma nova.
 */
function atribuirLanes(blocos: readonly BlocoComHorario[]): { item: BlocoComHorario; lane: number }[] {
  const ordenados = [...blocos].sort(
    (a, b) => a.inicio - b.inicio || (b.fim - b.inicio) - (a.fim - a.inicio),
  );
  const fimPorLane: number[] = [];
  const resultado: { item: BlocoComHorario; lane: number }[] = [];
  for (const item of ordenados) {
    const laneEncontrada = fimPorLane.findIndex((fim) => fim <= item.inicio);
    const lane = laneEncontrada === -1 ? fimPorLane.length : laneEncontrada;
    fimPorLane[lane] = item.fim;
    resultado.push({ item, lane });
  }
  return resultado;
}

interface GrupoBruto {
  inicio: number;
  fim: number;
  totalLanes: number;
}

/**
 * Corta a lista (já ordenada por início, saída de `atribuirLanes`) em grupos
 * de conflito: um bloco que começa DEPOIS de tudo que veio antes ter
 * terminado (`>=`, coerente com o `<=` de `atribuirLanes`) abre um grupo
 * novo — e, como toda lane já está livre nesse instante, o guloso lhe deu a
 * lane 0, então cada grupo conta as suas lanes do zero.
 */
function agruparConflitos(
  comLane: readonly { item: BlocoComHorario; lane: number }[],
): { grupos: GrupoBruto[]; grupoDe: number[] } {
  const grupos: GrupoBruto[] = [];
  const grupoDe: number[] = [];
  for (const { item, lane } of comLane) {
    const atual = grupos[grupos.length - 1];
    if (atual && item.inicio < atual.fim) {
      atual.fim = Math.max(atual.fim, item.fim);
      atual.totalLanes = Math.max(atual.totalLanes, lane + 1);
    } else {
      grupos.push({ inicio: item.inicio, fim: item.fim, totalLanes: lane + 1 });
    }
    grupoDe.push(grupos.length - 1);
  }
  return { grupos, grupoDe };
}

/** Monta o modelo da grade a partir da semana já carregada — pura, sem efeito colateral. */
export function construirGrade(semana: SemanaDeEstudo): GradeSemana {
  const porDia = semana.dias.map((dia) => ({ data: dia.data, ...separarPorHorario(dia.blocos) }));
  const todosComHorario = porDia.flatMap((d) => d.comHorario);

  if (todosComHorario.length === 0) {
    return {
      faixas: [],
      colunas: porDia.map((d) => ({ data: d.data, totalLanes: 1, blocosPosicionados: [], grupos: [], semHorario: d.semHorario })),
      temBlocoComHorario: false,
    };
  }

  const { inicio, fim } = calcularFaixaDaGrade(todosComHorario);
  const faixas: FaixaHoraria[] = [];
  for (let minuto = inicio; minuto < fim; minuto += GRANULARIDADE_MINUTOS) {
    faixas.push({ minutoInicio: minuto, rotulo: minutosParaRotulo(minuto) });
  }
  const totalLinhas = faixas.length;

  const colunas: ColunaDaGrade[] = porDia.map((dia) => {
    const comLane = atribuirLanes(dia.comHorario);
    const { grupos, grupoDe } = agruparConflitos(comLane);
    const totalLanes = Math.max(1, ...grupos.map((g) => g.totalLanes));
    const blocosPosicionados: BlocoNaCelula[] = comLane
      .map(({ item, lane }, indice) => {
        const grupo = grupoDe[indice];
        const linhaInicio = linhaDoMinuto(item.inicio, inicio, totalLinhas);
        const linhaFim = linhaDoMinuto(Math.max(item.fim - 1, item.inicio), inicio, totalLinhas);
        return {
          bloco: item.bloco,
          linhaInicio,
          linhaSpan: Math.max(1, linhaFim - linhaInicio + 1),
          lane,
          totalLanes: grupos[grupo].totalLanes,
          grupo,
          horaInicio: item.horaInicio,
          // Prefere o texto REAL de `endLocalTime` (que já mostra "00:15" num
          // bloco que atravessa a meia-noite) — `minutosParaRotulo(item.fim)`
          // só entra se ele não vier (o caso defensivo de `separarPorHorario`),
          // porque `item.fim` foi clipado em 24:00 e mostraria "24:00", que
          // não é um horário que existe.
          horaFim: item.bloco.endLocalTime ?? minutosParaRotulo(item.fim),
        };
      })
      .sort((a, b) => a.linhaInicio - b.linhaInicio || a.lane - b.lane);
    const gruposDeConflito: GrupoDeConflito[] = grupos.map((g, indice) => ({
      inicio: g.inicio,
      fim: g.fim,
      totalLanes: g.totalLanes,
      blocos: blocosPosicionados.filter((posicao) => posicao.grupo === indice),
    }));
    return { data: dia.data, totalLanes, blocosPosicionados, grupos: gruposDeConflito, semHorario: dia.semHorario };
  });

  return { faixas, colunas, temBlocoComHorario: true };
}
