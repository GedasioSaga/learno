import { describe, expect, it } from "vitest";
import {
  deslocarMes,
  ehMesValido,
  formatarDataLocal,
  formatarReais,
  lerReais,
  mesDe,
  primeiroDiaDoMes,
  rotuloDoMes,
} from "./dinheiro";

// Intl separa "R$" do número com espaço inseparável (U+00A0).
function semEspacoInseparavel(texto: string): string {
  return texto.replace(/ /g, " ");
}

describe("formatarReais", () => {
  it("formata centavos no padrão brasileiro", () => {
    expect(semEspacoInseparavel(formatarReais(412345))).toBe("R$ 4.123,45");
  });

  it("zero e centavos soltos", () => {
    expect(semEspacoInseparavel(formatarReais(0))).toBe("R$ 0,00");
    expect(semEspacoInseparavel(formatarReais(7))).toBe("R$ 0,07");
  });
});

describe("lerReais", () => {
  it.each([
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["R$ 4.100", 410000],
    ["4100", 410000],
    ["0,29", 29],
    ["0,5", 50],
    ["1234.5", 123450],
    ["1.234", 123400],
    ["  90 ", 9000],
    ["1.000.000,00", 100000000],
  ])("%s vira %i centavos", (texto, esperado) => {
    expect(lerReais(texto)).toBe(esperado);
  });

  it.each([[""], ["   "], ["-50"], ["abc"], ["1,2,3"], ["1,234"], ["12.34.56"], ["1.23,00"], ["R$"], ["1e5"]])(
    "%s é recusado",
    (texto) => {
      expect(lerReais(texto)).toBeNull();
    },
  );

  it("recusa valor acima do teto defensivo", () => {
    expect(lerReais("100.000.000.001")).toBeNull();
  });
});

describe("mês", () => {
  it("valida YYYY-MM com mês de 01 a 12", () => {
    expect(ehMesValido("2026-09")).toBe(true);
    expect(ehMesValido("2026-13")).toBe(false);
    expect(ehMesValido("2026-00")).toBe(false);
    expect(ehMesValido("2026-9")).toBe(false);
  });

  it("desloca atravessando a virada de ano nos dois sentidos", () => {
    expect(deslocarMes("2026-12", 1)).toBe("2027-01");
    expect(deslocarMes("2027-01", -1)).toBe("2026-12");
    expect(deslocarMes("2026-09", 16)).toBe("2028-01");
    expect(deslocarMes("2026-09", 0)).toBe("2026-09");
  });

  it("mesDe usa o relógio local, não UTC", () => {
    expect(mesDe(new Date(2026, 8, 30, 23, 59))).toBe("2026-09");
  });

  it("rótulo e primeiro dia", () => {
    expect(rotuloDoMes("2026-09")).toBe("setembro de 2026");
    expect(primeiroDiaDoMes("2026-09")).toBe("2026-09-01");
    expect(formatarDataLocal("2026-09-30")).toBe("30/09/2026");
  });

  it("lança erro com mês inválido em vez de calcular lixo", () => {
    expect(() => deslocarMes("2026-13", 1)).toThrow();
  });
});
