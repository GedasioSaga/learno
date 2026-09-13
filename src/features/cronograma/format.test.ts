import { describe, expect, it } from "vitest";
import { formatarDuracao, minutosParaHorasTexto, rotuloDoBloco, ROTULO_DA_ATIVIDADE } from "./format";

describe("minutosParaHorasTexto", () => {
  it("390 minutos vira '6,5' (vírgula decimal, pt-BR)", () => {
    expect(minutosParaHorasTexto(390)).toBe("6,5");
  });

  it("minutos exatos em hora não mostram casa decimal", () => {
    expect(minutosParaHorasTexto(480)).toBe("8");
  });

  it("zero minutos vira '0'", () => {
    expect(minutosParaHorasTexto(0)).toBe("0");
  });
});

describe("formatarDuracao", () => {
  it("pomodoro com ciclos conhecidos mostra 'ciclos×minutos min' (o '2x25' da maquete)", () => {
    expect(formatarDuracao({ activity: "pomodoro", plannedMinutes: 50, pomodoroCycles: 2 })).toBe("2×25 min");
  });

  it("pomodoro SEM ciclos preenchidos (caso comum na criação, que não recebe esse campo) cai na duração simples", () => {
    expect(formatarDuracao({ activity: "pomodoro", plannedMinutes: 50, pomodoroCycles: null })).toBe("50 min");
  });

  it("qualquer outra atividade mostra só a duração", () => {
    expect(formatarDuracao({ activity: "review", plannedMinutes: 30, pomodoroCycles: null })).toBe("30 min");
    expect(formatarDuracao({ activity: "mindmap", plannedMinutes: 45, pomodoroCycles: null })).toBe("45 min");
  });
});

describe("rotuloDoBloco", () => {
  it("usa o título quando ele existe", () => {
    expect(rotuloDoBloco({ title: "Verbos irregulares", activity: "review" })).toBe("Verbos irregulares");
  });

  it("título só com espaço conta como ausente e cai no rótulo da atividade", () => {
    expect(rotuloDoBloco({ title: "   ", activity: "mindmap" })).toBe("Mapa mental");
  });

  it("sem título, usa o rótulo em português da atividade", () => {
    expect(rotuloDoBloco({ title: null, activity: "pomodoro" })).toBe("Pomodoro");
  });
});

describe("ROTULO_DA_ATIVIDADE", () => {
  it("tem um rótulo em português para toda atividade do tipo", () => {
    expect(ROTULO_DA_ATIVIDADE.pomodoro).toBe("Pomodoro");
    expect(ROTULO_DA_ATIVIDADE.review).toBe("Revisão");
    expect(ROTULO_DA_ATIVIDADE.mindmap).toBe("Mapa mental");
    expect(ROTULO_DA_ATIVIDADE.reading).toBe("Leitura");
    expect(ROTULO_DA_ATIVIDADE.other).toBe("Outro");
  });
});
