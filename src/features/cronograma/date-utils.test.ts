import { describe, expect, it } from "vitest";
import {
  abreviacaoDoDia,
  formatarDataLocal,
  hojeLocal,
  inicioDaSemanaLocal,
  rotuloCurtoDoDia,
  somarDiasLocal,
} from "./date-utils";

describe("formatarDataLocal", () => {
  it("faz zero-padding de mês e dia", () => {
    expect(formatarDataLocal(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("hojeLocal — a virada do dia é LOCAL, nunca UTC", () => {
  it("uma data fixa às 23h continua caindo no dia certo (não no seguinte, como toISOString() faria perto da meia-noite)", () => {
    const vinteETresHoras = new Date(2026, 8, 5, 23, 30);
    expect(hojeLocal(vinteETresHoras)).toBe("2026-09-05");
  });

  it("uma data fixa logo após a meia-noite continua no dia certo", () => {
    const meiaNoiteEPouco = new Date(2026, 8, 5, 0, 1);
    expect(hojeLocal(meiaNoiteEPouco)).toBe("2026-09-05");
  });
});

describe("somarDiasLocal", () => {
  it("soma dias dentro do mesmo mês", () => {
    expect(somarDiasLocal("2026-09-01", 3)).toBe("2026-09-04");
  });

  it("soma cruzando o fim do mês", () => {
    expect(somarDiasLocal("2026-09-29", 3)).toBe("2026-10-02");
  });

  it("subtrai (dias negativo) cruzando o início do mês", () => {
    expect(somarDiasLocal("2026-09-01", -3)).toBe("2026-08-29");
  });

  it("uma semana inteira (7 dias) sempre cai no mesmo dia da semana", () => {
    expect(abreviacaoDoDia(somarDiasLocal("2026-09-01", 7))).toBe(abreviacaoDoDia("2026-09-01"));
  });
});

/** `YYYY-MM-DD` -> `Date` à meia-noite local, só para montar os `Date` de entrada dos testes abaixo. */
function dataDeIso(dataIso: string): Date {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

describe("inicioDaSemanaLocal", () => {
  it("é idempotente sobre segunda-feira: a segunda da semana da própria segunda é ela mesma", () => {
    const segunda = inicioDaSemanaLocal(new Date(2026, 8, 7));
    expect(inicioDaSemanaLocal(dataDeIso(segunda))).toBe(segunda);
  });

  it("os sete dias de uma semana (a segunda e os seis dias seguintes) têm todos o mesmo início de semana", () => {
    const segundaDaSemanaBase = inicioDaSemanaLocal(new Date(2026, 8, 1));
    for (let deslocamento = 0; deslocamento < 7; deslocamento += 1) {
      const dataIso = somarDiasLocal(segundaDaSemanaBase, deslocamento);
      expect(inicioDaSemanaLocal(dataDeIso(dataIso))).toBe(segundaDaSemanaBase);
    }
  });

  it("a semana seguinte começa exatamente 7 dias depois", () => {
    const segunda = inicioDaSemanaLocal(new Date(2026, 8, 1));
    const semanaSeguinte = somarDiasLocal(segunda, 7);
    expect(inicioDaSemanaLocal(dataDeIso(semanaSeguinte))).toBe(semanaSeguinte);
  });

  it("o início de semana calculado é sempre uma segunda-feira (abreviação 'seg')", () => {
    expect(abreviacaoDoDia(inicioDaSemanaLocal(new Date(2026, 8, 1)))).toBe("seg");
    expect(abreviacaoDoDia(inicioDaSemanaLocal(new Date(2026, 8, 6)))).toBe("seg"); // um domingo qualquer
  });
});

describe("abreviacaoDoDia", () => {
  it("os sete dias a partir de uma segunda seguem a ordem seg…dom", () => {
    const segunda = inicioDaSemanaLocal(new Date(2026, 8, 1));
    const esperado = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
    const obtido = esperado.map((_, indice) => abreviacaoDoDia(somarDiasLocal(segunda, indice)));
    expect(obtido).toEqual(esperado);
  });
});

describe("rotuloCurtoDoDia", () => {
  it("formata dia e mês abreviado em pt-BR", () => {
    // O texto exato do mês abreviado depende do ICU embutido no Node/Vitest;
    // checamos a forma (número + texto), não o literal, para não acoplar o
    // teste a uma versão específica de dados de locale.
    expect(rotuloCurtoDoDia("2026-09-05")).toMatch(/^5 de \p{L}+\.?$/u);
  });
});
