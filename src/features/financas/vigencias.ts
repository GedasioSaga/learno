import { formatarReais, rotuloCurtoDoMes } from "./dinheiro";
import type { VigenciaRow } from "./ipc";

/**
 * A vigência que cobre `mes`, ou `null`. Só uma consulta para a tela de
 * Renda e fixos dizer "valor em setembro": nenhuma soma sai daqui — previsto
 * e sobra vêm prontos do backend (`resumoFinanceiroDoMes`).
 *
 * Comparação de texto funciona porque `YYYY-MM` tem largura fixa: ordem
 * lexicográfica é ordem cronológica (mesmo motivo do schema).
 */
export function vigenciaNoMes(vigencias: readonly VigenciaRow[], mes: string): VigenciaRow | null {
  return vigencias.find((v) => v.inicioMes <= mes && (v.fimMes === null || mes <= v.fimMes)) ?? null;
}

/** A última vigência em ordem de início — a que diz se o item ainda está ativo. */
export function ultimaVigencia(vigencias: readonly VigenciaRow[]): VigenciaRow | null {
  return vigencias.length === 0 ? null : vigencias[vigencias.length - 1];
}

/** `"R$ 4.100,00 · set. de 26 → dez. de 26"`, ou `"… · set. de 26 em diante"` quando não tem fim. */
export function descreverVigencia(vigencia: VigenciaRow): string {
  const inicio = rotuloCurtoDoMes(vigencia.inicioMes);
  const periodo = vigencia.fimMes ? `${inicio} → ${rotuloCurtoDoMes(vigencia.fimMes)}` : `${inicio} em diante`;
  return `${formatarReais(vigencia.valorCentavos)} · ${periodo}`;
}
