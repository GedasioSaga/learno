import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  buildMonthGrid,
  dateCandidatesFor,
  formatDatePtBR,
  monthLabelPtBR,
  parseIsoDateString,
  toIsoDateString,
} from "./date-parsing";

// Quinta-feira, 3 de setembro de 2026 - fixado com `vi.setSystemTime` (nunca
// o dia real de execução) para que "amanhã"/"ontem"/"próxima segunda"
// tenham uma resposta determinística.
const FIXED_NOW = new Date(2026, 8, 3, 10, 30, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EDT-045: termos relativos em português", () => {
  it("EDT-045: 'hoje' resolve para o dia fixado como agora", () => {
    const [candidate] = dateCandidatesFor("hoje", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-03");
  });

  it("EDT-045: 'amanha' resolve para o dia seguinte ao agora fixado", () => {
    const [candidate] = dateCandidatesFor("amanha", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-04");
  });

  it("EDT-045: 'amanhã' (com acento) resolve igual a 'amanha'", () => {
    const [candidate] = dateCandidatesFor("amanhã", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-04");
  });

  it("EDT-045: 'ontem' resolve para o dia anterior ao agora fixado", () => {
    const [candidate] = dateCandidatesFor("ontem", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-02");
  });

  it("EDT-045: casamento é por prefixo - 'ama' já sugere 'amanhã' sozinho", () => {
    const candidates = dateCandidatesFor("ama", FIXED_NOW);
    expect(candidates.map((c) => c.id)).toEqual(["relative:amanha"]);
  });
});

describe("EDT-045: 'próxima <dia da semana>'", () => {
  it("EDT-045: 'proxima segunda' pula para a segunda-feira da semana seguinte, não a de hoje", () => {
    // FIXED_NOW é uma quinta-feira - a segunda mais próxima é daqui a 4 dias.
    const [candidate] = dateCandidatesFor("proxima segunda", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-07");
  });

  it("EDT-045: 'próxima quinta' (mesmo dia da semana de hoje) pula uma semana inteira, não fica em 'hoje'", () => {
    const [candidate] = dateCandidatesFor("proxima quinta", FIXED_NOW);
    expect(candidate.iso).toBe("2026-09-10");
  });

  it("EDT-045: um prefixo curto do dia ainda casa ('proxima seg')", () => {
    const [candidate] = dateCandidatesFor("proxima seg", FIXED_NOW);
    expect(candidate.id).toBe("weekday:segunda");
  });

  it("EDT-045: fica em silêncio enquanto o dia da semana ainda não tem letras suficientes", () => {
    expect(dateCandidatesFor("proxima s", FIXED_NOW)).toEqual([]);
  });
});

describe("EDT-045: formato de data absoluto", () => {
  it("EDT-045: 'dd/mm' usa o ano corrente", () => {
    const [candidate] = dateCandidatesFor("25/12", FIXED_NOW);
    expect(candidate.iso).toBe("2026-12-25");
  });

  it("EDT-045: 'dd/mm/aaaa' usa o ano informado", () => {
    const [candidate] = dateCandidatesFor("25/12/2027", FIXED_NOW);
    expect(candidate.iso).toBe("2027-12-25");
  });

  it("EDT-045: ano com 2 dígitos assume o século 2000", () => {
    const [candidate] = dateCandidatesFor("25/12/27", FIXED_NOW);
    expect(candidate.iso).toBe("2027-12-25");
  });

  it("EDT-045: rejeita um dia que não existe (31/02) em vez de rolar para março", () => {
    expect(dateCandidatesFor("31/02", FIXED_NOW)).toEqual([]);
  });
});

describe("EDT-045: silêncio quando o texto não é termo nem formato de data", () => {
  it("EDT-045: uma consulta vazia não sugere nada", () => {
    expect(dateCandidatesFor("", FIXED_NOW)).toEqual([]);
  });

  it("EDT-045: um nome comum (menção de página) não casa com nenhum termo de data", () => {
    expect(dateCandidatesFor("joao", FIXED_NOW)).toEqual([]);
    expect(dateCandidatesFor("maria silva", FIXED_NOW)).toEqual([]);
  });
});

describe("EDT-045: a data é sempre gravada como ISO, nunca como o texto digitado", () => {
  it("toIsoDateString/parseIsoDateString fazem o caminho de ida e volta sem deslocar o dia", () => {
    const date = new Date(2026, 0, 15);
    const iso = toIsoDateString(date);
    expect(iso).toBe("2026-01-15");
    expect(parseIsoDateString(iso)?.getDate()).toBe(15);
  });

  it("formatDatePtBR devolve dd/mm/aaaa a partir do ISO, não o termo relativo original", () => {
    expect(formatDatePtBR("2026-09-04")).toBe("04/09/2026");
  });

  it("EDT-045: formatDatePtBR(null) devolve string vazia em vez de lançar", () => {
    expect(formatDatePtBR(null)).toBe("");
  });

  it("EDT-045: formatDatePtBR(undefined) devolve string vazia em vez de lançar", () => {
    expect(formatDatePtBR(undefined)).toBe("");
  });

  it("uma consulta de data absoluta inválida (formato solto) não produz nenhum candidato", () => {
    expect(dateCandidatesFor("13/13/2026", FIXED_NOW)).toEqual([]);
  });
});

describe("EDT-045: mini-calendário - navegação por teclado opera sobre datas, não texto", () => {
  it("addDays soma/subtrai dias de calendário corretamente através de virada de mês", () => {
    expect(toIsoDateString(addDays(new Date(2026, 8, 30), 1))).toBe("2026-10-01");
    expect(toIsoDateString(addDays(new Date(2026, 8, 1), -1))).toBe("2026-08-31");
  });

  it("buildMonthGrid cobre o mês inteiro com 6 semanas e marca dias fora do mês", () => {
    const weeks = buildMonthGrid(new Date(2026, 8, 3));
    expect(weeks).toHaveLength(6);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    const allDays = weeks.flat();
    expect(allDays.some((day) => day.iso === "2026-09-01" && day.inCurrentMonth)).toBe(true);
    // 1º de setembro de 2026 cai numa terça - o domingo/segunda antes pertencem a agosto.
    expect(allDays.some((day) => day.iso === "2026-08-31" && !day.inCurrentMonth)).toBe(true);
  });

  it("monthLabelPtBR nomeia o mês em português sem depender de dados de locale do Intl", () => {
    expect(monthLabelPtBR(new Date(2026, 8, 3))).toBe("Setembro de 2026");
  });
});
