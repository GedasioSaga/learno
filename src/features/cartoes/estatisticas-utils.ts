import type { RevisaoDoDia } from "../../lib/ipc";

/** Quantos dias o mapa de calor cobre — 53 semanas completas, o mesmo "ano" que o Anki mostra. */
export const DIAS_DO_MAPA_DE_CALOR = 53 * 7;

/** Uma célula do mapa de calor: um dia do calendário, dentro ou fora da janela de dados que buscamos. */
export interface CelulaDeCalor {
  /** `YYYY-MM-DD` local — mesma forma de `RevisaoDoDia.dia`. */
  dia: string;
  data: Date;
  revisoes: number;
  /**
   * `false` para os dias de preenchimento que completam a semana (antes do
   * início da janela pedida ao backend, ou depois de hoje) — esses não têm
   * dado nenhum por trás, nem "zero" real, então a célula fica invisível em
   * vez de entrar na conta de intensidade ou no texto por extenso.
   */
  naJanela: boolean;
}

/** `YYYY-MM-DD` a partir dos componentes LOCAIS de `data` — nunca `toISOString()`, que é UTC. */
export function formatarDataLocal(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

/** Meia-noite local de `data` — descarta hora/minuto/segundo para comparar só o dia do calendário. */
function inicioDoDia(data: Date): Date {
  return new Date(data.getFullYear(), data.getMonth(), data.getDate());
}

/**
 * Monta o mapa de calor como colunas de semana (cada coluna, 7 células,
 * domingo a sábado) cobrindo `dias` dias terminando hoje — a mesma janela
 * que `estudoEstatisticas(deckId, dias)` buscou, então todo `porDia` cabe
 * dentro da grade.
 *
 * A grade é sempre retangular (múltiplo de 7): quando o primeiro dia da
 * janela não cai num domingo, os dias entre o domingo anterior e o início
 * real viram células com `naJanela: false`, e o mesmo vale para os dias
 * depois de hoje que completam a última semana.
 */
export function construirMapaDeCalor(porDia: readonly RevisaoDoDia[], dias: number, hoje: Date): CelulaDeCalor[][] {
  const revisoesPorDia = new Map(porDia.map((registro) => [registro.dia, registro.revisoes]));

  const fim = inicioDoDia(hoje);
  const inicio = new Date(fim);
  inicio.setDate(inicio.getDate() - (dias - 1));

  const primeiroDiaDaGrade = new Date(inicio);
  primeiroDiaDaGrade.setDate(primeiroDiaDaGrade.getDate() - primeiroDiaDaGrade.getDay());

  // Última célula: o sábado que fecha a semana de `fim`.
  const ultimoDiaDaGrade = new Date(fim);
  ultimoDiaDaGrade.setDate(ultimoDiaDaGrade.getDate() + (6 - ultimoDiaDaGrade.getDay()));

  const semanas: CelulaDeCalor[][] = [];
  let semanaAtual: CelulaDeCalor[] = [];
  const cursor = new Date(primeiroDiaDaGrade);
  while (cursor <= ultimoDiaDaGrade) {
    const chave = formatarDataLocal(cursor);
    semanaAtual.push({
      dia: chave,
      data: new Date(cursor),
      revisoes: revisoesPorDia.get(chave) ?? 0,
      naJanela: cursor >= inicio && cursor <= fim,
    });
    if (semanaAtual.length === 7) {
      semanas.push(semanaAtual);
      semanaAtual = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return semanas;
}

/** Nível de intensidade (0 a 4) de uma célula, pela fração de `revisoes` sobre o dia mais cheio da janela. */
export function nivelDeIntensidade(revisoes: number, maximoNaJanela: number): 0 | 1 | 2 | 3 | 4 {
  if (revisoes <= 0 || maximoNaJanela <= 0) return 0;
  const fracao = revisoes / maximoNaJanela;
  if (fracao <= 0.25) return 1;
  if (fracao <= 0.5) return 2;
  if (fracao <= 0.75) return 3;
  return 4;
}

/** O maior `revisoes` entre as células dentro da janela — base da intensidade relativa do mapa inteiro. */
export function maximoDeRevisoes(semanas: readonly CelulaDeCalor[][]): number {
  let maximo = 0;
  for (const semana of semanas) {
    for (const celula of semana) {
      if (celula.naJanela && celula.revisoes > maximo) maximo = celula.revisoes;
    }
  }
  return maximo;
}

/** "quinta-feira, 23 de março" — usado tanto na dica de hover quanto na coluna "Dia" da tabela por texto. */
export function dataPorExtenso(data: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(data);
}

/** "51 revisões em quinta-feira, 23 de março" — a dica por extenso do `title` do mapa de calor. */
export function descricaoDoDia(celula: Pick<CelulaDeCalor, "data" | "revisoes">): string {
  const contagem = celula.revisoes === 1 ? "1 revisão" : `${celula.revisoes} revisões`;
  return `${contagem} em ${dataPorExtenso(celula.data)}`;
}
