/**
 * EDT-050/EDT-051/EDT-033: que gesto um ponto de soltura representa, dado o
 * retângulo do bloco-alvo. Função pura sobre números - nada de DOM aqui -
 * porque em jsdom todo `getBoundingClientRect()` volta zerado (não existe
 * layout de verdade; ver o comentário equivalente em `PageTree.tsx`/
 * `page-tree-drag-and-drop.e2e.mjs`), então só uma função que recebe o
 * retângulo já calculado é testável em unidade; `drag-extension.ts` é quem
 * passa o retângulo real.
 *
 * Três faixas, não duas - EDT-033 (colunas) e EDT-051 (aninhar) descrevem o
 * MESMO gesto de mouse ("soltar na metade direita do bloco-alvo") com
 * resultados diferentes; sem uma terceira zona os dois critérios não
 * coexistem. Resolvido do jeito que o Notion resolve, checado nesta ordem:
 *
 *   1. Borda superior/inferior (faixa fina, QUALQUER posição horizontal) ->
 *      reordenar (EDT-050). Checada primeiro porque "solte perto da borda
 *      pra inserir antes/depois" precisa valer mesmo perto do canto direito
 *      - senão o canto vira ambíguo com a faixa de colunas do item 3.
 *   2. Fora da borda vertical, faixa estreita perto da borda DIREITA ->
 *      colunas lado a lado (EDT-033).
 *   3. Todo o resto do interior (esquerda/centro) -> aninhar (EDT-051).
 *
 * A faixa de colunas é medida em pixels absolutos (`COLUMN_ZONE_WIDTH_PX`),
 * não em fração da largura - uma faixa de "agarrar a borda" larga demais
 * num bloco bem largo atrapalharia o aninhar; estreita demais num bloco
 * estreito desapareceria. `COLUMN_ZONE_MAX_WIDTH_FRACTION` trava o outro
 * lado desse mesmo problema: um bloco ESTREITO (largura menor que uns
 * poucos `COLUMN_ZONE_WIDTH_PX`) não pode ter a faixa de colunas comendo a
 * faixa de aninhar inteira - a zona de colunas encolhe proporcionalmente
 * nesse caso, nunca passando da fração configurada da largura total.
 */
import type { ReorderEdge } from "./node-move";

/** Fração da altura do bloco, medida a partir de cada borda (topo e base), que conta como "borda" para reordenar (EDT-050). Fora dessas duas faixas é interior (aninhar ou colunas). */
export const REORDER_EDGE_VERTICAL_FRACTION = 0.3;

/** Largura absoluta (px) da faixa de colunas (EDT-033) medida a partir da borda direita do bloco-alvo, quando o bloco é largo o bastante para não disparar o limite de `COLUMN_ZONE_MAX_WIDTH_FRACTION`. */
export const COLUMN_ZONE_WIDTH_PX = 24;

/** Teto: a faixa de colunas nunca consome mais que esta fração da largura total do bloco-alvo - sem isto um bloco mais estreito que `COLUMN_ZONE_WIDTH_PX` teria a faixa de colunas engolindo toda (ou quase toda) a zona de aninhar, o que violaria EDT-051. */
export const COLUMN_ZONE_MAX_WIDTH_FRACTION = 0.3;

export type DropZone = { kind: "nest" } | { kind: "reorder"; edge: ReorderEdge } | { kind: "columns" };

/** Só os quatro campos de um `DOMRect` que a decisão usa - deixa o teste construir um objeto simples em vez de precisar de um `DOMRect` de verdade. */
export interface DropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function dropZoneFor(pointerX: number, pointerY: number, targetRect: DropRect): DropZone {
  // Retângulo de altura zero (degenerado - só ocorre num ambiente sem
  // layout de verdade, como jsdom sem stub) sempre cai na borda superior:
  // mesmo default seguro que a versão anterior desta função usava.
  const verticalFraction = targetRect.height === 0 ? 0 : (pointerY - targetRect.top) / targetRect.height;
  if (verticalFraction < REORDER_EDGE_VERTICAL_FRACTION) return { kind: "reorder", edge: "before" };
  if (verticalFraction > 1 - REORDER_EDGE_VERTICAL_FRACTION) return { kind: "reorder", edge: "after" };

  // Largura zero: sem forma de decidir "perto da borda direita" com
  // sentido nenhum - cai em aninhar (o comportamento pré-existente de
  // EDT-051), nunca em colunas.
  if (targetRect.width > 0) {
    const columnZoneWidth = Math.min(COLUMN_ZONE_WIDTH_PX, targetRect.width * COLUMN_ZONE_MAX_WIDTH_FRACTION);
    const columnZoneStart = targetRect.left + targetRect.width - columnZoneWidth;
    if (pointerX >= columnZoneStart) return { kind: "columns" };
  }

  return { kind: "nest" };
}
