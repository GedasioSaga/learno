import { describe, expect, it } from "vitest";
import { escolherMaisUrgente, formatarDataDoPrazo, nivelDeUrgencia, rotuloDeContagem } from "./format";
import type { PrazoComContagem, PrazosListados } from "./ipc";

function prazo(overrides: Partial<PrazoComContagem> = {}): PrazoComContagem {
  return {
    id: "p1",
    title: "Prova de Biologia",
    dueLocalDate: "2026-09-20",
    deckId: null,
    pageId: null,
    status: "ativo",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    diasRestantes: 5,
    ...overrides,
  };
}

function listagem(overrides: Partial<PrazosListados> = {}): PrazosListados {
  return { hoje: "2026-09-05", vencidos: [], futuros: [], ...overrides };
}

describe("rotuloDeContagem", () => {
  it("zero dias é 'Vence hoje', nunca confundido com vencido", () => {
    expect(rotuloDeContagem(0)).toBe("Vence hoje");
  });

  it("positivo é 'Falta(m) N dia(s)', com plural certo", () => {
    expect(rotuloDeContagem(1)).toBe("Falta 1 dia");
    expect(rotuloDeContagem(12)).toBe("Faltam 12 dias");
  });

  it("negativo é 'Venceu há N dia(s)', com plural certo e sem sinal", () => {
    expect(rotuloDeContagem(-1)).toBe("Venceu há 1 dia");
    expect(rotuloDeContagem(-3)).toBe("Venceu há 3 dias");
  });
});

describe("nivelDeUrgencia", () => {
  it("negativo é 'vencido'", () => {
    expect(nivelDeUrgencia(-1)).toBe("vencido");
    expect(nivelDeUrgencia(-100)).toBe("vencido");
  });

  it("zero é 'hoje', nunca 'vencido' (o dia ainda não acabou)", () => {
    expect(nivelDeUrgencia(0)).toBe("hoje");
  });

  it("1 a 3 dias é 'proximo'", () => {
    expect(nivelDeUrgencia(1)).toBe("proximo");
    expect(nivelDeUrgencia(3)).toBe("proximo");
  });

  it("4+ dias é 'distante'", () => {
    expect(nivelDeUrgencia(4)).toBe("distante");
    expect(nivelDeUrgencia(30)).toBe("distante");
  });
});

describe("formatarDataDoPrazo", () => {
  it("formata 'YYYY-MM-DD' em pt-BR por extenso, sem deslocar de fuso", () => {
    // Ponto do teste: dias limítrofes do mês não podem "vazar" para o dia
    // anterior por causa de um parse que passe por UTC.
    expect(formatarDataDoPrazo("2026-09-01")).toBe("1 de set. de 2026");
    expect(formatarDataDoPrazo("2026-01-31")).toBe("31 de jan. de 2026");
  });
});

describe("escolherMaisUrgente", () => {
  it("sem nenhum prazo ativo, devolve null — nunca inventa um", () => {
    expect(escolherMaisUrgente(listagem())).toBeNull();
  });

  it("só futuros: devolve o mais próximo (primeiro do array)", () => {
    const maisProximo = prazo({ id: "f1", diasRestantes: 2 });
    const distante = prazo({ id: "f2", diasRestantes: 10 });
    expect(escolherMaisUrgente(listagem({ futuros: [maisProximo, distante] }))).toBe(maisProximo);
  });

  it("um vencido ativo vence sobre qualquer futuro, mesmo o mais próximo", () => {
    const vencido = prazo({ id: "v1", diasRestantes: -1 });
    const futuroProximo = prazo({ id: "f1", diasRestantes: 0 });
    expect(escolherMaisUrgente(listagem({ vencidos: [vencido], futuros: [futuroProximo] }))).toBe(vencido);
  });
});
