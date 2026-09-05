import { describe, expect, it } from "vitest";
import { formatDateValuePtBr } from "./date-format-pt-br";

describe("DBS-010 — Data simples", () => {
  it('15/03/2026 mostra "15 de março de 2026", o literal do critério', () => {
    expect(formatDateValuePtBr({ start: "2026-03-15" })).toBe("15 de março de 2026");
  });
});

describe("DBS-011 — Data com intervalo (end date)", () => {
  it('início 01/03 e fim 05/03 mostram "1 → 5 de março", o literal do critério', () => {
    expect(formatDateValuePtBr({ start: "2026-03-01", end: "2026-03-05" })).toBe("1 → 5 de março");
  });

  it("meses diferentes no mesmo ano: cada lado por extenso — sem forma compacta inventada sem critério que a comprove", () => {
    expect(formatDateValuePtBr({ start: "2026-03-28", end: "2026-04-02" })).toBe(
      "28 de março de 2026 → 2 de abril de 2026",
    );
  });

  it("anos diferentes: idem, cada lado carrega o próprio ano", () => {
    expect(formatDateValuePtBr({ start: "2026-12-30", end: "2027-01-02" })).toBe(
      "30 de dezembro de 2026 → 2 de janeiro de 2027",
    );
  });
});

describe("DBS-012 — Include time", () => {
  it("15/03/2026 14:30 mostra a hora", () => {
    expect(formatDateValuePtBr({ start: "2026-03-15T14:30" })).toBe("15 de março de 2026 às 14:30");
  });

  it("intervalo com hora não usa a forma compacta de dia (perderia a hora)", () => {
    expect(formatDateValuePtBr({ start: "2026-03-01T09:00", end: "2026-03-05T17:00" })).toBe(
      "1 de março de 2026 às 09:00 → 5 de março de 2026 às 17:00",
    );
  });
});

describe("degradação TOTAL — um lado corrompido nunca esconde a linha inteira", () => {
  it("start válido, end fora da forma: degrada para mostrar só o início", () => {
    expect(formatDateValuePtBr({ start: "2026-03-15", end: "lixo" })).toBe("15 de março de 2026");
  });

  it("start corrompido: devolve vazio em vez de lançar", () => {
    expect(formatDateValuePtBr({ start: "lixo" })).toBe("");
  });
});
