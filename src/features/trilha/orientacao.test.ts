import { describe, expect, it } from "vitest";
import type { EtapaDaTrilha, FlechaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";
import {
  cadeiaDeDependencias,
  ehMarco,
  enquadramentoInicial,
  MARGEM_DO_ENQUADRAMENTO,
  proximaEtapaRecomendada,
  ZOOM_MINIMO_LEGIVEL,
} from "./orientacao";

function etapa(id: string, overrides: Partial<EtapaDaTrilha> = {}): EtapaDaTrilha {
  return {
    id,
    title: id,
    icon: null,
    laneValue: "",
    position: "a0",
    level: 0,
    inCycle: false,
    isUnlocked: false,
    situacaoNoCaminho: "ativo",
    state: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function flecha(blockedId: string, blockingId: string): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel: null };
}

function raia(laneValue: string, position: string): RaiaDaTrilha {
  return { viewId: "v1", laneValue, position, isCollapsed: false, createdAt: "", updatedAt: "" };
}

describe("proximaEtapaRecomendada", () => {
  it("prefere uma etapa em andamento a uma disponível, mesmo que a disponível esteja em nível menor", () => {
    const etapas = [etapa("disp", { level: 0, isUnlocked: true }), etapa("andando", { level: 3, state: "in_progress", isUnlocked: true })];
    expect(proximaEtapaRecomendada(etapas, [])?.id).toBe("andando");
  });

  it("entre duas em andamento, escolhe a de menor nível; em empate, a da raia que vem primeiro", () => {
    const raias = [raia("Teoria", "a0"), raia("Exercícios", "a1")];
    const etapas = [
      etapa("ex", { laneValue: "Exercícios", level: 1, state: "in_progress" }),
      etapa("teo", { laneValue: "Teoria", level: 1, state: "in_progress" }),
      etapa("tarde", { laneValue: "Teoria", level: 2, state: "in_progress" }),
    ];
    expect(proximaEtapaRecomendada(etapas, raias)?.id).toBe("teo");
  });

  it("nunca recomenda etapa bloqueada, concluída, em ciclo ou fora do caminho ativo", () => {
    const etapas = [
      etapa("feita", { state: "done" }),
      etapa("bloqueada", { isUnlocked: false }),
      etapa("ciclo", { inCycle: true }),
      etapa("descartada", { isUnlocked: true, situacaoNoCaminho: "descartado" }),
      etapa("suspensa", { isUnlocked: true, situacaoNoCaminho: "aguardandoEscolha" }),
    ];
    expect(proximaEtapaRecomendada(etapas, [])).toBeNull();
  });

  it("trilha vazia → null", () => {
    expect(proximaEtapaRecomendada([], [])).toBeNull();
  });
});

describe("cadeiaDeDependencias", () => {
  // a → b → c → d, e b → e (ramificação)
  const flechas = [flecha("b", "a"), flecha("c", "b"), flecha("d", "c"), flecha("e", "b")];

  it("exige é transitivo para trás; desbloqueia é transitivo para a frente", () => {
    const cadeia = cadeiaDeDependencias("c", flechas);
    expect([...cadeia.exige].sort()).toEqual(["a", "b"]);
    expect([...cadeia.desbloqueia].sort()).toEqual(["d"]);
  });

  it("a própria etapa nunca entra em nenhum dos dois conjuntos", () => {
    const cadeia = cadeiaDeDependencias("b", flechas);
    expect(cadeia.exige.has("b")).toBe(false);
    expect(cadeia.desbloqueia.has("b")).toBe(false);
    expect([...cadeia.desbloqueia].sort()).toEqual(["c", "d", "e"]);
  });

  it("não entra em loop com ciclo, e a outra ponta do laço aparece nos dois lados", () => {
    const cadeia = cadeiaDeDependencias("x", [flecha("x", "y"), flecha("y", "x"), flecha("y", "z")]);
    expect([...cadeia.exige].sort()).toEqual(["y", "z"]);
    expect([...cadeia.desbloqueia].sort()).toEqual(["y"]);
  });

  it("etapa isolada → dois conjuntos vazios", () => {
    const cadeia = cadeiaDeDependencias("sozinha", flechas);
    expect(cadeia.exige.size).toBe(0);
    expect(cadeia.desbloqueia.size).toBe(0);
  });
});

describe("ehMarco", () => {
  it("é marco quem junta dois ou mais pré-requisitos; ramificar muito não conta", () => {
    const flechas = [flecha("b", "a"), flecha("c", "a"), flecha("d", "a"), flecha("e", "b"), flecha("e", "c")];
    expect(ehMarco("a", flechas)).toBe(false);
    expect(ehMarco("e", flechas)).toBe(true);
    expect(ehMarco("b", flechas)).toBe(false);
  });
});

describe("enquadramentoInicial", () => {
  it("conteúdo pequeno: cabe inteiro, centralizado, sem passar de zoom 1", () => {
    const enquadramento = enquadramentoInicial({ largura: 600, altura: 300 }, { largura: 1400, altura: 900 });
    expect(enquadramento.zoom).toBe(1);
    expect(enquadramento.x).toBe((1400 - 600) / 2);
    expect(enquadramento.y).toBe((900 - 300) / 2);
  });

  it("conteúdo largo demais: abre no zoom mínimo legível, ancorado na raiz à esquerda e centralizado na vertical quando cabe", () => {
    const enquadramento = enquadramentoInicial({ largura: 2205, altura: 600 }, { largura: 1400, altura: 900 });
    expect(enquadramento.zoom).toBe(ZOOM_MINIMO_LEGIVEL);
    expect(enquadramento.x).toBe(MARGEM_DO_ENQUADRAMENTO);
    expect(enquadramento.y).toBe((900 - 600 * ZOOM_MINIMO_LEGIVEL) / 2);
  });

  it("conteúdo largo E alto demais: canto superior esquerdo nos dois eixos", () => {
    const enquadramento = enquadramentoInicial({ largura: 2205, altura: 1600 }, { largura: 1400, altura: 900 });
    expect(enquadramento.zoom).toBe(ZOOM_MINIMO_LEGIVEL);
    expect(enquadramento.x).toBe(MARGEM_DO_ENQUADRAMENTO);
    expect(enquadramento.y).toBe(MARGEM_DO_ENQUADRAMENTO);
  });

  it("conteúdo que cabe entre 0.8 e 1: usa o zoom exato para caber", () => {
    const enquadramento = enquadramentoInicial({ largura: 1500, altura: 400 }, { largura: 1400, altura: 900 });
    expect(enquadramento.zoom).toBeCloseTo((1400 - MARGEM_DO_ENQUADRAMENTO * 2) / 1500, 5);
    expect(enquadramento.zoom).toBeGreaterThanOrEqual(ZOOM_MINIMO_LEGIVEL);
  });

  it("tela de tamanho zero (medida antes do layout) não divide por zero nem devolve NaN", () => {
    const enquadramento = enquadramentoInicial({ largura: 0, altura: 0 }, { largura: 0, altura: 0 });
    expect(Number.isFinite(enquadramento.zoom)).toBe(true);
    expect(Number.isFinite(enquadramento.x)).toBe(true);
  });
});
