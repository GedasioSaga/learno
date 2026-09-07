import type { AgendadorDeBaralho, OpcoesDeDeckJson } from "../../lib/ipc";

/**
 * A lógica pura da tela de Opções do baralho: converte o que o backend
 * devolve (`OpcoesDeDeckJson`, números em escala interna) para o que o
 * usuário digita (texto, percentuais inteiros) e de volta, validando na ida
 * de volta. Nenhum I/O aqui — é o que deixa a validação testável sem
 * renderizar nada, e mantém `OpcoesDoBaralho.tsx` só com estado e layout.
 */

/**
 * Os 21 pesos padrão do FSRS-6, espelho de `PESOS_PADRAO` em
 * `src-tauri/src/srs/fsrs.rs`. Duplicado de propósito: é o único jeito de o
 * botão "Usar padrões do FSRS-6" funcionar sem uma ida ao backend, e
 * `opcoes-de-baralho.test.ts` lê o arquivo Rust e confere número a número
 * para a cópia não envelhecer em silêncio.
 */
export const PESOS_PADRAO_FSRS6: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

export const QUANTIDADE_DE_PESOS_FSRS = 21;

/** Faixa aceita para a retenção desejada, em percentual inteiro. */
export const RETENCAO_MINIMA_PCT = 70;
export const RETENCAO_MAXIMA_PCT = 99;
/** Acima disto a carga diária cresce muito para um ganho pequeno (doc do Anki). */
export const RETENCAO_ALERTA_PCT = 97;

/** Teto do Anki para o intervalo máximo (~100 anos). */
export const INTERVALO_MAXIMO_DIAS = 36_500;
/** `u32` do Rust — os passos de aprendizagem são `Vec<u32>` em minutos. */
const MAXIMO_U32 = 4_294_967_295;
const MULTIPLICADOR_MINIMO_PCT = 100;
const MULTIPLICADOR_MAXIMO_PCT = 1_000;
const LEECH_MAXIMO = 9_999;

/**
 * O que os campos da tela guardam enquanto o usuário edita: texto cru, para
 * ele poder apagar e redigitar sem o campo "pular" para um número, e
 * percentuais inteiros onde o backend guarda fração ou escala ×100.
 */
export interface RascunhoDeOpcoes {
  agendador: AgendadorDeBaralho;
  /** "90" para `fsrs_retencao_desejada: 0.9`. */
  fsrsRetencaoPct: string;
  /** Os 21 pesos, separados por espaço. */
  fsrsPesos: string;
  /** Minutos separados por espaço: "1 10". */
  learningSteps: string;
  relearningSteps: string;
  graduatingInterval: string;
  easyInterval: string;
  easyBonusPct: string;
  hardIntervalPct: string;
  lapseNewIntervalPct: string;
  minimumInterval: string;
  maximumInterval: string;
  leechThreshold: string;
  fuzz: boolean;
}

/** Os campos de texto — os únicos que podem falhar na validação. */
export type CampoDoRascunho = Exclude<keyof RascunhoDeOpcoes, "agendador" | "fuzz">;

export type ErrosDoRascunho = Partial<Record<CampoDoRascunho, string>>;

/** Todos os campos de texto, para a validação percorrer sem `Object.entries` (que perde o tipo da chave). */
const CAMPOS_DE_TEXTO: readonly CampoDoRascunho[] = [
  "fsrsRetencaoPct",
  "fsrsPesos",
  "learningSteps",
  "relearningSteps",
  "graduatingInterval",
  "easyInterval",
  "easyBonusPct",
  "hardIntervalPct",
  "lapseNewIntervalPct",
  "minimumInterval",
  "maximumInterval",
  "leechThreshold",
];

export type ResultadoDoRascunho = { ok: true; opcoes: OpcoesDeDeckJson } | { ok: false; erros: ErrosDoRascunho };

export function formatarPesos(pesos: readonly number[]): string {
  return pesos.join(" ");
}

export function rascunhoDeOpcoes(opcoes: OpcoesDeDeckJson): RascunhoDeOpcoes {
  return {
    agendador: opcoes.agendador,
    fsrsRetencaoPct: String(Math.round(opcoes.fsrs_retencao_desejada * 100)),
    fsrsPesos: formatarPesos(opcoes.fsrs_pesos),
    learningSteps: opcoes.learning_steps_min.join(" "),
    relearningSteps: opcoes.relearning_steps_min.join(" "),
    graduatingInterval: String(opcoes.graduating_interval_dias),
    easyInterval: String(opcoes.easy_interval_dias),
    easyBonusPct: String(opcoes.easy_bonus_pct),
    hardIntervalPct: String(opcoes.hard_interval_pct),
    lapseNewIntervalPct: String(opcoes.lapse_new_interval_percent),
    minimumInterval: String(opcoes.minimum_interval_dias),
    maximumInterval: String(opcoes.maximum_interval_dias),
    leechThreshold: String(opcoes.leech_threshold),
    fuzz: opcoes.fuzz_habilitado,
  };
}

type Lido<T> = { ok: true; valor: T } | { ok: false; erro: string };

/** Espaço, vírgula ou ponto-e-vírgula separam; o decimal é sempre ponto (como o Anki mostra). */
function separar(texto: string): string[] {
  return texto.split(/[\s,;]+/).filter((pedaco) => pedaco !== "");
}

const INTEIRO = /^\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function lerInteiro(texto: string, minimo: number, maximo: number): Lido<number> {
  const limpo = texto.trim();
  if (!INTEIRO.test(limpo)) return { ok: false, erro: "Use um número inteiro." };
  const valor = Number(limpo);
  if (valor < minimo || valor > maximo) return { ok: false, erro: `Use um número entre ${minimo} e ${maximo}.` };
  return { ok: true, valor };
}

function lerPassos(texto: string): Lido<number[]> {
  const pedacos = separar(texto);
  const passos: number[] = [];
  for (const pedaco of pedacos) {
    if (!INTEIRO.test(pedaco)) {
      return { ok: false, erro: "Cada passo é um número inteiro de minutos; separe-os por espaço." };
    }
    const minutos = Number(pedaco);
    if (minutos > MAXIMO_U32) return { ok: false, erro: `Nenhum passo pode passar de ${MAXIMO_U32} minutos.` };
    passos.push(minutos);
  }
  return { ok: true, valor: passos };
}

function lerPesos(texto: string): Lido<number[]> {
  const pedacos = separar(texto);
  if (pedacos.length !== QUANTIDADE_DE_PESOS_FSRS) {
    return {
      ok: false,
      erro: `São ${pedacos.length} números; o FSRS-6 usa exatamente ${QUANTIDADE_DE_PESOS_FSRS}.`,
    };
  }
  const pesos: number[] = [];
  for (const pedaco of pedacos) {
    if (!DECIMAL.test(pedaco)) {
      return { ok: false, erro: "Cada parâmetro é um número com ponto decimal (por exemplo 0.212)." };
    }
    pesos.push(Number(pedaco));
  }
  return { ok: true, valor: pesos };
}

/**
 * Valida o rascunho inteiro de uma vez e devolve OU as opções no shape do
 * Rust, OU um erro por campo — nunca uma mistura: assim a tela mostra todos
 * os problemas numa rodada em vez de um por clique em Salvar.
 */
export function opcoesDoRascunho(rascunho: RascunhoDeOpcoes): ResultadoDoRascunho {
  const erros: ErrosDoRascunho = {};

  const learningSteps = lerPassos(rascunho.learningSteps);
  const relearningSteps = lerPassos(rascunho.relearningSteps);
  const graduatingInterval = lerInteiro(rascunho.graduatingInterval, 1, INTERVALO_MAXIMO_DIAS);
  const easyInterval = lerInteiro(rascunho.easyInterval, 1, INTERVALO_MAXIMO_DIAS);
  const easyBonusPct = lerInteiro(rascunho.easyBonusPct, MULTIPLICADOR_MINIMO_PCT, MULTIPLICADOR_MAXIMO_PCT);
  const hardIntervalPct = lerInteiro(rascunho.hardIntervalPct, MULTIPLICADOR_MINIMO_PCT, MULTIPLICADOR_MAXIMO_PCT);
  const lapseNewIntervalPct = lerInteiro(rascunho.lapseNewIntervalPct, 0, 100);
  const minimumInterval = lerInteiro(rascunho.minimumInterval, 1, INTERVALO_MAXIMO_DIAS);
  const maximumInterval = lerInteiro(rascunho.maximumInterval, 1, INTERVALO_MAXIMO_DIAS);
  const leechThreshold = lerInteiro(rascunho.leechThreshold, 0, LEECH_MAXIMO);
  const fsrsRetencaoPct = lerInteiro(rascunho.fsrsRetencaoPct, RETENCAO_MINIMA_PCT, RETENCAO_MAXIMA_PCT);
  const fsrsPesos = lerPesos(rascunho.fsrsPesos);

  const lidos = {
    learningSteps,
    relearningSteps,
    graduatingInterval,
    easyInterval,
    easyBonusPct,
    hardIntervalPct,
    lapseNewIntervalPct,
    minimumInterval,
    maximumInterval,
    leechThreshold,
    fsrsRetencaoPct,
    fsrsPesos,
  } satisfies Record<CampoDoRascunho, Lido<unknown>>;

  for (const campo of CAMPOS_DE_TEXTO) {
    const lido = lidos[campo];
    if (!lido.ok) erros[campo] = lido.erro;
  }

  if (minimumInterval.ok && maximumInterval.ok && minimumInterval.valor > maximumInterval.valor) {
    erros.minimumInterval = "Não pode passar do intervalo máximo.";
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  // Todos `ok` aqui: o laço acima já teria devolvido erro em qualquer outro caso.
  if (
    !learningSteps.ok ||
    !relearningSteps.ok ||
    !graduatingInterval.ok ||
    !easyInterval.ok ||
    !easyBonusPct.ok ||
    !hardIntervalPct.ok ||
    !lapseNewIntervalPct.ok ||
    !minimumInterval.ok ||
    !maximumInterval.ok ||
    !leechThreshold.ok ||
    !fsrsRetencaoPct.ok ||
    !fsrsPesos.ok
  ) {
    return { ok: false, erros };
  }

  return {
    ok: true,
    opcoes: {
      learning_steps_min: learningSteps.valor,
      relearning_steps_min: relearningSteps.valor,
      graduating_interval_dias: graduatingInterval.valor,
      easy_interval_dias: easyInterval.valor,
      easy_bonus_pct: easyBonusPct.valor,
      hard_interval_pct: hardIntervalPct.valor,
      lapse_new_interval_percent: lapseNewIntervalPct.valor,
      minimum_interval_dias: minimumInterval.valor,
      maximum_interval_dias: maximumInterval.valor,
      leech_threshold: leechThreshold.valor,
      fuzz_habilitado: rascunho.fuzz,
      agendador: rascunho.agendador,
      fsrs_retencao_desejada: fsrsRetencaoPct.valor / 100,
      fsrs_pesos: fsrsPesos.valor,
    },
  };
}
