import { describe, expect, it } from "vitest";
import { formatarIntervalo, preverIntervaloDias, rotuloDeResposta } from "./previsao";

describe("formatarIntervalo", () => {
  it("formata minutos, horas, dias, meses e anos", () => {
    expect(formatarIntervalo(1 / 1440)).toBe("1 min");
    expect(formatarIntervalo(10 / 1440)).toBe("10 min");
    expect(formatarIntervalo(2 / 24)).toBe("2 h");
    expect(formatarIntervalo(1)).toBe("1 dia");
    expect(formatarIntervalo(3)).toBe("3 dias");
    expect(formatarIntervalo(60)).toBe("2 meses");
    expect(formatarIntervalo(400)).toBe("1 ano");
  });

  it("nunca mostra 0 min — arredonda para baixo de 1 minuto vira 1 min, não 0", () => {
    expect(formatarIntervalo(0.0001)).toBe("1 min");
  });
});

describe("preverIntervaloDias", () => {
  it("cartão novo/aprendendo usa passos fixos, com 'Fácil' graduando para 4 dias", () => {
    const cartaoNovo = { state: "new" as const, intervalDays: 0, easeFactor: 0 };
    expect(preverIntervaloDias(cartaoNovo, "again")).toBeCloseTo(1 / 1440);
    expect(preverIntervaloDias(cartaoNovo, "hard")).toBeCloseTo(6 / 1440);
    expect(preverIntervaloDias(cartaoNovo, "good")).toBeCloseTo(10 / 1440);
    expect(preverIntervaloDias(cartaoNovo, "easy")).toBe(4);
  });

  it("cartão em revisão usa o intervalo atual × fator de facilidade (SM-2)", () => {
    const cartaoEmRevisao = { state: "review" as const, intervalDays: 10, easeFactor: 2500 };
    expect(preverIntervaloDias(cartaoEmRevisao, "again")).toBeCloseTo(1 / 1440);
    expect(preverIntervaloDias(cartaoEmRevisao, "hard")).toBeCloseTo(12);
    expect(preverIntervaloDias(cartaoEmRevisao, "good")).toBeCloseTo(25);
    expect(preverIntervaloDias(cartaoEmRevisao, "easy")).toBeCloseTo(32.5);
  });

  it("fator de facilidade zerado (cartão nunca respondido) cai no padrão SM-2 de 2.5", () => {
    const cartaoSemFator = { state: "review" as const, intervalDays: 4, easeFactor: 0 };
    expect(preverIntervaloDias(cartaoSemFator, "good")).toBeCloseTo(4 * 2.5);
  });

  it("rotuloDeResposta encadeia previsão e formatação", () => {
    const cartaoNovo = { state: "new" as const, intervalDays: 0, easeFactor: 0 };
    expect(rotuloDeResposta(cartaoNovo, "good")).toBe("10 min");
    expect(rotuloDeResposta(cartaoNovo, "easy")).toBe("4 dias");
  });
});
