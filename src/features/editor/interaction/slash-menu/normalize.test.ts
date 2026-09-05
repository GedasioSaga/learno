import { describe, expect, it } from "vitest";
import { normalizeForSearch } from "./normalize";

describe("normalizeForSearch", () => {
  it('EDT-047: "titulo" (sem acento) e "Título" normalizam pro mesmo valor', () => {
    expect(normalizeForSearch("titulo")).toBe(normalizeForSearch("Título"));
  });

  it('EDT-047: "codigo" e "Código" normalizam pro mesmo valor', () => {
    expect(normalizeForSearch("codigo")).toBe(normalizeForSearch("Código"));
  });

  it("EDT-047: ignora maiúscula/minúscula além de acento", () => {
    expect(normalizeForSearch("CITAÇÃO")).toBe("citacao");
  });

  it("EDT-047: string sem diacrítico só baixa a caixa", () => {
    expect(normalizeForSearch("Divisor")).toBe("divisor");
  });
});
