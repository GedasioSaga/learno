/**
 * EDT-050/EDT-051/EDT-033, a decisão geométrica: dado um ponto e o
 * retângulo do bloco-alvo, qual das três zonas foi solta. Retângulo passado
 * à mão (não `getBoundingClientRect()` real) de propósito - jsdom nunca tem
 * layout de verdade, ver o comentário de `drop-zone.ts`.
 */
import { describe, expect, it } from "vitest";
import { COLUMN_ZONE_MAX_WIDTH_FRACTION, COLUMN_ZONE_WIDTH_PX, dropZoneFor } from "./drop-zone";

const RECT = { left: 100, top: 200, width: 400, height: 40 };

describe("dropZoneFor", () => {
  it("EDT-050: borda superior (qualquer posição horizontal) - reordenar 'antes'", () => {
    expect(dropZoneFor(RECT.left + 2, RECT.top + 2, RECT)).toEqual({ kind: "reorder", edge: "before" });
    // Perto da borda direita: a borda superior vence a faixa de colunas -
    // ver a ordem de checagem documentada em drop-zone.ts.
    expect(dropZoneFor(RECT.left + RECT.width - 2, RECT.top + 2, RECT)).toEqual({ kind: "reorder", edge: "before" });
  });

  it("EDT-050: borda inferior (qualquer posição horizontal) - reordenar 'depois'", () => {
    expect(dropZoneFor(RECT.left + 2, RECT.top + RECT.height - 2, RECT)).toEqual({ kind: "reorder", edge: "after" });
    expect(dropZoneFor(RECT.left + RECT.width - 2, RECT.top + RECT.height - 2, RECT)).toEqual({
      kind: "reorder",
      edge: "after",
    });
  });

  it("EDT-033: interior, faixa estreita perto da borda direita - zona de colunas", () => {
    const columnZoneWidth = Math.min(COLUMN_ZONE_WIDTH_PX, RECT.width * COLUMN_ZONE_MAX_WIDTH_FRACTION);
    const midHeight = RECT.top + RECT.height / 2;
    expect(dropZoneFor(RECT.left + RECT.width - columnZoneWidth, midHeight, RECT)).toEqual({ kind: "columns" });
    expect(dropZoneFor(RECT.left + RECT.width, midHeight, RECT)).toEqual({ kind: "columns" });
  });

  it("EDT-051: interior, esquerda/centro (fora da faixa de colunas) - zona de aninhar", () => {
    const midHeight = RECT.top + RECT.height / 2;
    expect(dropZoneFor(RECT.left + 2, midHeight, RECT)).toEqual({ kind: "nest" });
    expect(dropZoneFor(RECT.left + RECT.width / 2, midHeight, RECT)).toEqual({ kind: "nest" });
  });

  it("o limiar vertical é exatamente REORDER_EDGE_VERTICAL_FRACTION em cada borda", () => {
    const topBandBottom = RECT.top + RECT.height * 0.3;
    const justInsideTopBand = dropZoneFor(RECT.left + 2, topBandBottom - 1, RECT);
    const justOutsideTopBand = dropZoneFor(RECT.left + 2, topBandBottom, RECT);
    expect(justInsideTopBand).toEqual({ kind: "reorder", edge: "before" });
    expect(justOutsideTopBand.kind).not.toBe("reorder");

    const bottomBandTop = RECT.top + RECT.height * 0.7;
    const justOutsideBottomBand = dropZoneFor(RECT.left + 2, bottomBandTop, RECT);
    const justInsideBottomBand = dropZoneFor(RECT.left + 2, bottomBandTop + 1, RECT);
    expect(justOutsideBottomBand.kind).not.toBe("reorder");
    expect(justInsideBottomBand).toEqual({ kind: "reorder", edge: "after" });
  });

  it("o limiar horizontal da faixa de colunas é exatamente a borda calculada", () => {
    const columnZoneWidth = Math.min(COLUMN_ZONE_WIDTH_PX, RECT.width * COLUMN_ZONE_MAX_WIDTH_FRACTION);
    const columnZoneStart = RECT.left + RECT.width - columnZoneWidth;
    const midHeight = RECT.top + RECT.height / 2;
    expect(dropZoneFor(columnZoneStart - 1, midHeight, RECT)).toEqual({ kind: "nest" });
    expect(dropZoneFor(columnZoneStart, midHeight, RECT)).toEqual({ kind: "columns" });
  });

  it("bloco estreito: a faixa de colunas encolhe e nunca engole a zona de aninhar inteira", () => {
    // Largura bem menor que COLUMN_ZONE_WIDTH_PX (24px) - sem o teto de
    // COLUMN_ZONE_MAX_WIDTH_FRACTION, a faixa de colunas tomaria o
    // retângulo inteiro (24px > 10px de largura).
    const narrowRect = { left: 0, top: 0, width: 10, height: 40 };
    const midHeight = narrowRect.height / 2;

    // A faixa de colunas, travada pela fração, mede no máximo 30% de 10px = 3px.
    const expectedColumnZoneWidth = narrowRect.width * COLUMN_ZONE_MAX_WIDTH_FRACTION;
    expect(expectedColumnZoneWidth).toBeLessThan(COLUMN_ZONE_WIDTH_PX);

    // Um ponto claramente fora da faixa de 3px (mas ainda dentro do
    // retângulo estreito) continua caindo em "aninhar" - a zona de aninhar
    // sobrevive mesmo num bloco estreito.
    expect(dropZoneFor(narrowRect.left + 2, midHeight, narrowRect)).toEqual({ kind: "nest" });
    // Bem na borda direita, dentro da faixa de colunas encolhida.
    expect(dropZoneFor(narrowRect.left + narrowRect.width, midHeight, narrowRect)).toEqual({ kind: "columns" });
  });

  it("largura zero: nunca escolhe colunas, cai em aninhar quando fora das bordas verticais", () => {
    const zeroWidthRect = { left: 50, top: 0, width: 0, height: 40 };
    expect(dropZoneFor(50, 20, zeroWidthRect)).toEqual({ kind: "nest" });
  });
});
