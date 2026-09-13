import type { EtapaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";
import { ordenarRaiasParaExibicao } from "./layout";

/**
 * As cinco famílias de cor por raia, na "ordem de ciclo recomendada" de
 * `docs/DESIGN-TRILHA.md` §8: vizinhas mais distantes em matiz primeiro
 * (azul/roxo e roxo/magenta são os pares mais parecidos; esta ordem os
 * separa o máximo possível quando há mais de cinco raias e o ciclo repete).
 */
const ORDEM_DE_CICLO_DE_COR = ["azul", "magenta", "oliva", "ciano", "roxo"] as const;

export type CorDeRaia = (typeof ORDEM_DE_CICLO_DE_COR)[number];

/**
 * Uma raia não tem coluna de cor no banco (`RaiaDaTrilha` não guarda uma) —
 * a cor é só de apresentação, atribuída pelo ÍNDICE da raia na mesma ordem
 * que `calcularLayoutDaTrilha` usa (`ordenarRaiasParaExibicao`), para a
 * mesma raia sair sempre com a mesma cor entre uma releitura e outra
 * enquanto a ordem das raias não mudar.
 */
export function mapaDeCoresDasRaias(etapas: EtapaDaTrilha[], raias: RaiaDaTrilha[]): Map<string, CorDeRaia> {
  const mapa = new Map<string, CorDeRaia>();
  ordenarRaiasParaExibicao(etapas, raias).forEach((raia, indice) => {
    mapa.set(raia.laneValue, ORDEM_DE_CICLO_DE_COR[indice % ORDEM_DE_CICLO_DE_COR.length]);
  });
  return mapa;
}
