import { describe, expect, it } from "vitest";
import type { Decisao, FlechaDaTrilha } from "../../lib/ipc";
import {
  argumentosDeCriarFlecha,
  estadoDaFlecha,
  etapaEhDecisao,
  paresDaFlechaPorConexao,
  proximoRotuloDeCaminho,
  rotuloDeExibicao,
} from "./ligacao";

function decisao(overrides: Partial<Decisao> & Pick<Decisao, "stepId">): Decisao {
  return { chosenLabel: null, chosenAt: null, createdAt: "", updatedAt: "", ...overrides };
}

function flecha(blockedId: string, blockingId: string, pathLabel: string | null = null): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel };
}

describe("paresDaFlechaPorConexao", () => {
  it("source vira blockingId, target vira blockedId — nunca o contrário", () => {
    const par = paresDaFlechaPorConexao({ source: "databricks", target: "azure" });
    expect(par).toEqual({ blockedId: "azure", blockingId: "databricks" });
  });

  it("sem source ou sem target (conexão incompleta), não forma par", () => {
    expect(paresDaFlechaPorConexao({ source: null, target: "azure" })).toBeNull();
    expect(paresDaFlechaPorConexao({ source: "databricks", target: null })).toBeNull();
    expect(paresDaFlechaPorConexao({ source: null, target: null })).toBeNull();
  });
});

describe("etapaEhDecisao", () => {
  it("true quando existe uma Decisao com este stepId", () => {
    expect(etapaEhDecisao("escolher-stack", [decisao({ stepId: "escolher-stack" })])).toBe(true);
  });

  it("false para uma etapa comum (sem entrada em decisoes)", () => {
    expect(etapaEhDecisao("estudar-sql", [decisao({ stepId: "escolher-stack" })])).toBe(false);
    expect(etapaEhDecisao("estudar-sql", [])).toBe(false);
  });
});

describe("proximoRotuloDeCaminho", () => {
  it("sem nenhum caminho existente, sugere 'Caminho 1'", () => {
    expect(proximoRotuloDeCaminho("escolher-stack", [])).toBe("Caminho 1");
  });

  it("pula os números já usados por OUTRAS flechas da MESMA decisão", () => {
    const flechas = [flecha("azure", "escolher-stack", "Caminho 1"), flecha("aws", "escolher-stack", "Caminho 2")];
    expect(proximoRotuloDeCaminho("escolher-stack", flechas)).toBe("Caminho 3");
  });

  it("ignora flechas de OUTRA decisão — a numeração é por origem", () => {
    const flechas = [flecha("azure", "escolher-stack", "Caminho 1"), flecha("react", "escolher-frontend", "Caminho 1")];
    expect(proximoRotuloDeCaminho("escolher-frontend", flechas)).toBe("Caminho 2");
  });
});

describe("argumentosDeCriarFlecha", () => {
  it("arrastar de uma decisão passa o pathLabel a criarFlecha (afirme o ARGUMENTO)", () => {
    const decisoes = [decisao({ stepId: "escolher-stack" })];
    const argumentos = argumentosDeCriarFlecha({ source: "escolher-stack", target: "azure" }, decisoes, []);
    expect(argumentos).toEqual({ blockedId: "azure", blockingId: "escolher-stack", pathLabel: "Caminho 1" });
  });

  it("arrastar de uma etapa comum passa null", () => {
    const argumentos = argumentosDeCriarFlecha({ source: "estudar-sql", target: "estudar-python" }, [], []);
    expect(argumentos).toEqual({ blockedId: "estudar-python", blockingId: "estudar-sql", pathLabel: null });
  });

  it("conexão incompleta continua null, mesmo com decisões no meio", () => {
    expect(argumentosDeCriarFlecha({ source: null, target: "azure" }, [decisao({ stepId: "escolher-stack" })], [])).toBeNull();
  });
});

describe("estadoDaFlecha", () => {
  it("viva: pré-requisito incondicional (pathLabel null) sempre bloqueia", () => {
    expect(estadoDaFlecha(flecha("azure", "estudar-sql", null), [])).toBe("viva");
  });

  it("viva: rótulo é exatamente o caminho escolhido pela decisão", () => {
    const decisoes = [decisao({ stepId: "escolher-stack", chosenLabel: "Caminho 1" })];
    expect(estadoDaFlecha(flecha("azure", "escolher-stack", "Caminho 1"), decisoes)).toBe("viva");
  });

  it("morta: a decisão já escolheu, e é OUTRO rótulo — este ramo não bloqueia", () => {
    const decisoes = [decisao({ stepId: "escolher-stack", chosenLabel: "Caminho 1" })];
    expect(estadoDaFlecha(flecha("aws", "escolher-stack", "Caminho 2"), decisoes)).toBe("morta");
  });

  it("esperando: tem rótulo, mas a decisão ainda não escolheu nenhum caminho", () => {
    const decisoes = [decisao({ stepId: "escolher-stack", chosenLabel: null })];
    expect(estadoDaFlecha(flecha("azure", "escolher-stack", "Caminho 1"), decisoes)).toBe("esperando");
  });

  it("esperando (defensivo): tem rótulo mas a decisão nem aparece em decisoes", () => {
    expect(estadoDaFlecha(flecha("azure", "escolher-stack", "Caminho 1"), [])).toBe("esperando");
  });
});

describe("rotuloDeExibicao", () => {
  it("null vira undefined — a flecha fica sem rótulo nenhum no canvas", () => {
    expect(rotuloDeExibicao(null)).toBeUndefined();
  });

  it("rótulo curto passa direto, sem cortar", () => {
    expect(rotuloDeExibicao("Caminho 1")).toBe("Caminho 1");
  });

  it("rótulo comprido é cortado com reticências — não vira sopa no canvas", () => {
    const comprido = "Um nome de caminho bem mais comprido do que cabe";
    const exibido = rotuloDeExibicao(comprido);
    expect(exibido?.endsWith("…")).toBe(true);
    expect(exibido?.length).toBe(20);
  });
});
