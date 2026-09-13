import { describe, expect, it } from "vitest";
import type { Decisao, EtapaDaTrilha, FlechaDaTrilha } from "../../lib/ipc";
import {
  bloqueadorasNaoConcluidas,
  caminhosDescartadosPara,
  decisoesPendentesPara,
  descricaoParaLeitorDeTela,
  estadoVisualDaEtapa,
  rotulosDosCaminhosQueSaem,
} from "./descricoes";

function etapa(overrides: Partial<EtapaDaTrilha> & Pick<EtapaDaTrilha, "id" | "title">): EtapaDaTrilha {
  return {
    icon: null,
    laneValue: "",
    position: "a0",
    level: 0,
    inCycle: false,
    isUnlocked: true,
    situacaoNoCaminho: "ativo",
    state: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function flecha(blockedId: string, blockingId: string, pathLabel: string | null = null): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel };
}

/** `chosenLabel: null` é o padrão (decisão sem escolha ainda) — o mesmo estado de nascença descrito em `ipc.ts`. */
function decisao(stepId: string, overrides: Partial<Decisao> = {}): Decisao {
  return { stepId, chosenLabel: null, chosenAt: null, createdAt: "", updatedAt: "", ...overrides };
}

describe("estadoVisualDaEtapa", () => {
  it("concluída vence ciclo — uma etapa já terminada não precisa do aviso de ciclo", () => {
    const e = etapa({ id: "a", title: "A", state: "done", inCycle: true });
    expect(estadoVisualDaEtapa(e)).toBe("concluida");
  });

  it("ciclo vence bloqueada/disponível — isUnlocked nunca vira true sozinho num ciclo", () => {
    const e = etapa({ id: "a", title: "A", inCycle: true, isUnlocked: false });
    expect(estadoVisualDaEtapa(e)).toBe("em-ciclo");
  });

  it("em andamento", () => {
    expect(estadoVisualDaEtapa(etapa({ id: "a", title: "A", state: "in_progress" }))).toBe("em-andamento");
  });

  it("desbloqueada e sem progresso: disponível", () => {
    expect(estadoVisualDaEtapa(etapa({ id: "a", title: "A", isUnlocked: true }))).toBe("disponivel");
  });

  it("bloqueada: sem progresso e isUnlocked falso", () => {
    expect(estadoVisualDaEtapa(etapa({ id: "a", title: "A", isUnlocked: false }))).toBe("bloqueada");
  });
});

describe("descricaoParaLeitorDeTela", () => {
  it("etapa bloqueada é anunciada como bloqueada, com o nome de quem falta concluir", () => {
    const azure = etapa({ id: "azure", title: "Azure", isUnlocked: false });
    const databricks = etapa({ id: "databricks", title: "Databricks", state: null });
    const flechas = [flecha("azure", "databricks")];

    const texto = descricaoParaLeitorDeTela(azure, [azure, databricks], flechas);

    expect(texto).toContain("Azure");
    expect(texto).toContain("bloqueada");
    expect(texto).toContain("Databricks");
  });

  it("bloqueadora já concluída some da lista do que falta", () => {
    const azure = etapa({ id: "azure", title: "Azure", isUnlocked: true });
    const databricks = etapa({ id: "databricks", title: "Databricks", state: "done" });
    const flechas = [flecha("azure", "databricks")];

    expect(bloqueadorasNaoConcluidas(azure, [azure, databricks], flechas)).toEqual([]);
  });

  it("etapa em ciclo avisa que nunca desbloqueia sozinha e nomeia a outra ponta", () => {
    const a = etapa({ id: "a", title: "A", inCycle: true, isUnlocked: false });
    const b = etapa({ id: "b", title: "B", inCycle: true, isUnlocked: false });
    const flechas = [flecha("a", "b"), flecha("b", "a")];

    const texto = descricaoParaLeitorDeTela(a, [a, b], flechas);
    expect(texto).toContain("ciclo");
    expect(texto).toContain("B");
    expect(texto).toContain("Nunca desbloqueia sozinha");
  });

  it("etapa concluída e etapa disponível", () => {
    const concluida = etapa({ id: "c", title: "Concluída", state: "done" });
    const disponivel = etapa({ id: "d", title: "Disponível", isUnlocked: true });
    expect(descricaoParaLeitorDeTela(concluida, [concluida], [])).toContain("concluída");
    expect(descricaoParaLeitorDeTela(disponivel, [disponivel], [])).toContain("disponível");
  });

  it("etapa que é uma decisão anuncia isso, mesmo sem `decisoes` a lista é vazia por padrão e não quebra", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    expect(descricaoParaLeitorDeTela(raiz, [raiz], [])).not.toContain("decisão");

    expect(descricaoParaLeitorDeTela(raiz, [raiz], [], [decisao("raiz")])).toContain("decisão");
  });

  it("etapa aguardando escolha nomeia a decisão de quem falta escolher", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    const azure = etapa({ id: "azure", title: "Azure", situacaoNoCaminho: "aguardandoEscolha" });
    const flechas = [flecha("azure", "raiz", "nuvem")];

    const texto = descricaoParaLeitorDeTela(azure, [raiz, azure], flechas, [decisao("raiz")]);
    expect(texto).toContain("suspenso");
    expect(texto).toContain("Raiz");
  });

  it("etapa descartada diz quem escolheu o quê, e que o progresso continua salvo quando há progresso", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    const azure = etapa({ id: "azure", title: "Azure", situacaoNoCaminho: "descartado", state: "done" });
    const flechas = [flecha("azure", "raiz", "nuvem")];
    const decisoes = [decisao("raiz", { chosenLabel: "local" })];

    const texto = descricaoParaLeitorDeTela(azure, [raiz, azure], flechas, decisoes);
    expect(texto).toContain("descartado");
    expect(texto).toContain('Raiz escolheu "local"');
    expect(texto).toContain("progresso desta etapa continua salvo");
  });

  it("etapa descartada SEM progresso não afirma que algo foi salvo", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    const azure = etapa({ id: "azure", title: "Azure", situacaoNoCaminho: "descartado", state: null });
    const flechas = [flecha("azure", "raiz", "nuvem")];
    const decisoes = [decisao("raiz", { chosenLabel: "local" })];

    const texto = descricaoParaLeitorDeTela(azure, [raiz, azure], flechas, decisoes);
    expect(texto).not.toContain("progresso desta etapa continua salvo");
  });
});

describe("decisoesPendentesPara", () => {
  it("só lista decisões cuja escolha ainda não foi feita", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    const outraDecisao = etapa({ id: "outra", title: "Outra" });
    const azure = etapa({ id: "azure", title: "Azure" });
    const flechas = [flecha("azure", "raiz", "nuvem"), flecha("azure", "outra", "x")];
    const decisoes = [decisao("raiz"), decisao("outra", { chosenLabel: "x" })];

    const pendentes = decisoesPendentesPara(azure, [raiz, outraDecisao, azure], flechas, decisoes);

    expect(pendentes.map((e) => e.id)).toEqual(["raiz"]);
  });
});

describe("caminhosDescartadosPara", () => {
  it("só lista caminhos cuja decisão já escolheu outro rótulo", () => {
    const raiz = etapa({ id: "raiz", title: "Raiz" });
    const azure = etapa({ id: "azure", title: "Azure" });
    const flechas = [flecha("azure", "raiz", "nuvem")];

    expect(caminhosDescartadosPara(azure, [raiz, azure], flechas, [decisao("raiz", { chosenLabel: null })])).toEqual([]);
    expect(caminhosDescartadosPara(azure, [raiz, azure], flechas, [decisao("raiz", { chosenLabel: "nuvem" })])).toEqual([]);

    const descartados = caminhosDescartadosPara(azure, [raiz, azure], flechas, [decisao("raiz", { chosenLabel: "local" })]);
    expect(descartados).toEqual([{ decisao: raiz, pathLabel: "nuvem", escolhido: "local" }]);
  });
});

describe("rotulosDosCaminhosQueSaem", () => {
  it("devolve os rótulos únicos, na ordem em que as flechas aparecem, ignorando flechas sem rótulo e de outra decisão", () => {
    const flechas = [flecha("a", "raiz", "nuvem"), flecha("b", "outra", "y"), flecha("c", "raiz", "local"), flecha("d", "raiz", "nuvem"), flecha("e", "raiz")];

    expect(rotulosDosCaminhosQueSaem("raiz", flechas)).toEqual(["nuvem", "local"]);
  });
});
