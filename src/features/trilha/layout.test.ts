import { describe, expect, it } from "vitest";
import type { EtapaDaTrilha, FlechaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";
import { calcularLayoutDaTrilha, type FaixaDaRaia, type PosicaoDaEtapa } from "./layout";

/**
 * `Map.get`/`Array.find` devolvem `T | undefined` — em vez de `!` (proibido
 * sem justificar por linha, regra do projeto), estes dois falham o teste com
 * uma mensagem clara quando a chave não vier, em vez de silenciar o tipo.
 */
function pegarPosicao(resultado: ReturnType<typeof calcularLayoutDaTrilha>, id: string): PosicaoDaEtapa {
  const posicao = resultado.posicoes.get(id);
  if (!posicao) throw new Error(`esperava posição para a etapa "${id}", e não veio`);
  return posicao;
}

function pegarFaixa(faixas: FaixaDaRaia[], laneValue: string): FaixaDaRaia {
  const faixa = faixas.find((f) => f.laneValue === laneValue);
  if (!faixa) throw new Error(`esperava a faixa "${laneValue}", e não veio`);
  return faixa;
}

function etapa(overrides: Partial<EtapaDaTrilha> & Pick<EtapaDaTrilha, "id" | "level" | "laneValue">): EtapaDaTrilha {
  return {
    title: overrides.id,
    icon: null,
    // Default estável (nunca usado para desempate de verdade nos testes que
    // já passam `position` explícito): mesmo valor para todas as etapas que
    // não se importam com ordem, então `id` decide o desempate como antes.
    position: "a0",
    inCycle: false,
    isUnlocked: true,
    situacaoNoCaminho: "ativo",
    state: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function raia(laneValue: string, position: string, isCollapsed = false): RaiaDaTrilha {
  return { viewId: "v1", laneValue, position, isCollapsed, createdAt: "", updatedAt: "" };
}

/** `pathLabel` sempre `null` aqui: o layout (coluna/linha) não depende de caminho nenhum — quem testa isso é `ligacao.test.ts`. */
function flecha(blockedId: string, blockingId: string): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel: null };
}

/** Verdadeiro se dois retângulos {x,y,width,height} se sobrepõem (bordas encostando não conta como sobreposição). */
function seSobrepoe(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function todasAsPosicoesVisiveis(resultado: ReturnType<typeof calcularLayoutDaTrilha>) {
  return [...resultado.posicoes.values()].filter((posicao) => posicao.visivel);
}

function semNenhumaSobreposicao(resultado: ReturnType<typeof calcularLayoutDaTrilha>) {
  const posicoes = todasAsPosicoesVisiveis(resultado);
  for (let i = 0; i < posicoes.length; i++) {
    for (let j = i + 1; j < posicoes.length; j++) {
      expect(seSobrepoe(posicoes[i], posicoes[j])).toBe(false);
    }
  }
}

describe("calcularLayoutDaTrilha", () => {
  it("cadeia simples: cada etapa na coluna do próprio nível, sem sobreposição", () => {
    const etapas = [
      etapa({ id: "a", level: 0, laneValue: "" }),
      etapa({ id: "b", level: 1, laneValue: "" }),
      etapa({ id: "c", level: 2, laneValue: "" }),
    ];
    const flechas = [flecha("b", "a"), flecha("c", "b")];
    const raias = [raia("", "a0")];

    const resultado = calcularLayoutDaTrilha(etapas, flechas, raias);

    for (const e of etapas) {
      const posicao = pegarPosicao(resultado, e.id);
      // coluna == level: x cresce em passos fixos de PASSO_COLUNA (315px), então
      // o índice do nível é recuperável dividindo pela mesma régua do layout.
      expect(Math.round((posicao.x - 45) / 315)).toBe(e.level);
    }
    semNenhumaSobreposicao(resultado);
    expect(resultado.totalNiveis).toBe(3);
  });

  it("árvore que se junta: duas raízes bloqueando a mesma etapa não colidem", () => {
    const etapas = [
      etapa({ id: "a", level: 0, laneValue: "" }),
      etapa({ id: "b", level: 0, laneValue: "" }),
      etapa({ id: "c", level: 1, laneValue: "" }),
    ];
    const flechas = [flecha("c", "a"), flecha("c", "b")];
    const raias = [raia("", "a0")];

    const resultado = calcularLayoutDaTrilha(etapas, flechas, raias);

    expect(pegarPosicao(resultado, "a").x).toBe(pegarPosicao(resultado, "b").x);
    semNenhumaSobreposicao(resultado);
  });

  it("etapa solta (sem flecha nenhuma) fica na coluna 0, sozinha", () => {
    const etapas = [etapa({ id: "solta", level: 0, laneValue: "" })];
    const resultado = calcularLayoutDaTrilha(etapas, [], [raia("", "a0")]);

    const posicao = pegarPosicao(resultado, "solta");
    expect(posicao.visivel).toBe(true);
    expect(Math.round((posicao.x - 45) / 315)).toBe(0);
    semNenhumaSobreposicao(resultado);
  });

  it("ciclo (A bloqueia B, B bloqueia A) não trava e não sobrepõe", () => {
    // As duas marcadas `inCycle: true`, como o backend devolveria — o layout
    // não recalcula isso, só usa `level` (aqui, de propósito, o mesmo para
    // as duas: é o caso realista de um ciclo detectado sem ordem clara).
    const etapas = [
      etapa({ id: "a", level: 0, laneValue: "", inCycle: true }),
      etapa({ id: "b", level: 0, laneValue: "", inCycle: true }),
    ];
    const flechas = [flecha("b", "a"), flecha("a", "b")];
    const raias = [raia("", "a0")];

    const resultado = calcularLayoutDaTrilha(etapas, flechas, raias);

    semNenhumaSobreposicao(resultado);
    // mesmo nível (0) para as duas: precisam de linhas diferentes.
    expect(pegarPosicao(resultado, "a").y).not.toBe(pegarPosicao(resultado, "b").y);
  });

  it("etapas de raias diferentes ficam em faixas verticais disjuntas, mesmo nível igual", () => {
    const etapas = [
      etapa({ id: "x", level: 0, laneValue: "estudos" }),
      etapa({ id: "y", level: 0, laneValue: "trabalho" }),
    ];
    const raias = [raia("estudos", "a0"), raia("trabalho", "a1")];

    const resultado = calcularLayoutDaTrilha(etapas, [], raias);

    const faixaEstudos = pegarFaixa(resultado.faixas, "estudos");
    const faixaTrabalho = pegarFaixa(resultado.faixas, "trabalho");
    const posX = pegarPosicao(resultado, "x");
    const posY = pegarPosicao(resultado, "y");

    // cada etapa cai dentro da faixa vertical da própria raia.
    expect(posX.y).toBeGreaterThanOrEqual(faixaEstudos.y);
    expect(posX.y + posX.height).toBeLessThanOrEqual(faixaEstudos.y + faixaEstudos.height);
    expect(posY.y).toBeGreaterThanOrEqual(faixaTrabalho.y);
    expect(posY.y + posY.height).toBeLessThanOrEqual(faixaTrabalho.y + faixaTrabalho.height);

    // as duas faixas não se sobrepõem entre si.
    expect(faixaEstudos.y + faixaEstudos.height).toBeLessThanOrEqual(faixaTrabalho.y);
    semNenhumaSobreposicao(resultado);
  });

  it("raia recolhida: etapas saem invisíveis, e a faixa encolhe ao cabeçalho", () => {
    const etapas = [etapa({ id: "a", level: 0, laneValue: "dobrada" }), etapa({ id: "b", level: 1, laneValue: "dobrada" })];
    const raias = [raia("dobrada", "a0", true)];

    const resultado = calcularLayoutDaTrilha(etapas, [], raias);

    expect(pegarPosicao(resultado, "a").visivel).toBe(false);
    expect(pegarPosicao(resultado, "b").visivel).toBe(false);
    expect(resultado.faixas[0].isCollapsed).toBe(true);
    expect(resultado.faixas[0].height).toBeLessThan(60);
  });

  it("sem raia nenhuma no contrato (defensivo): agrupa pelo laneValue da própria etapa, sem perder nenhuma", () => {
    const etapas = [etapa({ id: "a", level: 0, laneValue: "" }), etapa({ id: "b", level: 0, laneValue: "outra" })];

    const resultado = calcularLayoutDaTrilha(etapas, [], []);

    expect(resultado.posicoes.size).toBe(2);
    expect(resultado.faixas.map((f) => f.laneValue).sort()).toEqual(["", "outra"]);
    semNenhumaSobreposicao(resultado);
  });

  it("BUG REAL (usuário): etapa cujo laneValue não casa com nenhuma raia existente ainda aparece, numa faixa 'Sem raia' — antes do conserto ela sumia do layout inteiro", () => {
    // Reproduz o banco do usuário: 1 raia nomeada "Estudos", 4 etapas com
    // `laneValue` vazio (o NULL do SQLite vira "" antes de chegar aqui).
    // `etapas.filter((etapa) => etapa.laneValue === raia.laneValue)` original
    // nunca casava "" com "Estudos" — as 4 ficavam fora de toda faixa.
    const etapas = [
      etapa({ id: "prog", level: 0, laneValue: "" }),
      etapa({ id: "mat", level: 0, laneValue: "" }),
      etapa({ id: "ing1", level: 0, laneValue: "" }),
      etapa({ id: "ing2", level: 0, laneValue: "" }),
    ];
    const raias = [raia("Estudos", "a0")];

    const resultado = calcularLayoutDaTrilha(etapas, [], raias);

    expect(resultado.posicoes.size).toBe(4);
    for (const e of etapas) {
      const posicao = pegarPosicao(resultado, e.id);
      expect(posicao.visivel).toBe(true);
    }
    // A faixa órfã existe e aparece — sem ela o cartão não teria onde nascer.
    const faixaOrfa = pegarFaixa(resultado.faixas, "");
    expect(faixaOrfa).toBeDefined();
    semNenhumaSobreposicao(resultado);
  });

  it("invariante de contagem: toda etapa recebida sai posicionada, mesmo com mistura de laneValue que casa e que não casa com raia nenhuma", () => {
    const etapas = [
      etapa({ id: "casa", level: 0, laneValue: "Estudos" }),
      etapa({ id: "orfa-vazia", level: 0, laneValue: "" }),
      etapa({ id: "orfa-antiga", level: 1, laneValue: "Raia que não existe mais" }),
    ];
    const raias = [raia("Estudos", "a0")];

    const resultado = calcularLayoutDaTrilha(etapas, [], raias);

    expect(resultado.posicoes.size).toBe(etapas.length);
    semNenhumaSobreposicao(resultado);
  });

  it("sem etapa nenhuma: uma coluna (raiz) e nenhuma posição", () => {
    const resultado = calcularLayoutDaTrilha([], [], [raia("", "a0")]);
    expect(resultado.totalNiveis).toBe(1);
    expect(resultado.posicoes.size).toBe(0);
  });

  it("cartão com situação de caminho (mais alto que o mínimo) empurra a linha de baixo em vez de ficar por cima dela", () => {
    // Mesma forma do cenário com decisão da vitrine: duas etapas no MESMO
    // nível da MESMA raia, a de cima descartada (ganha selo + frase, cresce).
    const etapas = [
      etapa({ id: "ielts", level: 4, laneValue: "Certificação", situacaoNoCaminho: "descartado" }),
      etapa({ id: "toefl", level: 4, laneValue: "Certificação" }),
    ];
    const resultado = calcularLayoutDaTrilha(etapas, [], [raia("Certificação", "a0")]);
    const deCima = pegarPosicao(resultado, "ielts");
    const deBaixo = pegarPosicao(resultado, "toefl");
    expect(deCima.height).toBeGreaterThan(deBaixo.height);
    expect(deBaixo.y).toBeGreaterThanOrEqual(deCima.y + deCima.height);
    semNenhumaSobreposicao(resultado);
    // A faixa da raia cresceu junto: o cartão mais alto continua dentro dela.
    const faixa = pegarFaixa(resultado.faixas, "Certificação");
    expect(deBaixo.y + deBaixo.height).toBeLessThanOrEqual(faixa.y + faixa.height);
  });

  it("ordena por `position`, NUNCA por título: 'Data Engineer' com position maior fica ABAIXO de 'Data Science', mesmo E vindo antes de S no alfabeto", () => {
    // O problema real do usuário: as duas etapas no mesmo nível da mesma
    // raia, e ele queria "Data Science" antes de "Data Engineer" sem
    // renomear nada — só arrastando (move_page reescreve `position`).
    const etapas = [
      etapa({ id: "eng", level: 0, laneValue: "Dados", title: "Data Engineer", position: "a1" }),
      etapa({ id: "sci", level: 0, laneValue: "Dados", title: "Data Science", position: "a0" }),
    ];
    const resultado = calcularLayoutDaTrilha(etapas, [], [raia("Dados", "a0")]);

    const posEng = pegarPosicao(resultado, "eng");
    const posSci = pegarPosicao(resultado, "sci");
    // position "a0" < "a1": Data Science (a0) vem ANTES, ou seja, mais acima.
    expect(posSci.y).toBeLessThan(posEng.y);
    semNenhumaSobreposicao(resultado);
  });
});
