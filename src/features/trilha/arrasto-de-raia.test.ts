import { describe, expect, it } from "vitest";
import type { FaixaDaRaia } from "./layout";
import { alvoDeReordenacaoNaRaia, laneParaMover, posicaoComXTravado, raiaAlvoNoY, yDaLinhaDeInsercao, type CartaoIrmaoParaReordenar } from "./arrasto-de-raia";

function faixa(overrides: Partial<FaixaDaRaia> & Pick<FaixaDaRaia, "laneValue" | "y" | "height">): FaixaDaRaia {
  return { isCollapsed: false, ...overrides };
}

describe("raiaAlvoNoY", () => {
  const faixas = [
    faixa({ laneValue: "Backend", y: 0, height: 100 }),
    faixa({ laneValue: "Frontend", y: 100, height: 100, isCollapsed: true }),
    faixa({ laneValue: "", y: 200, height: 100 }), // "Sem raia"
  ];

  it("acha a raia certa quando o ponto cai dentro dela", () => {
    expect(raiaAlvoNoY(50, faixas)).toBe("Backend");
    expect(raiaAlvoNoY(250, faixas)).toBe("");
  });

  it("a borda de baixo de uma faixa pertence à faixa, a de cima já é a próxima (nunca as duas ao mesmo tempo)", () => {
    expect(raiaAlvoNoY(0, faixas)).toBe("Backend");
    expect(raiaAlvoNoY(99.9, faixas)).toBe("Backend");
    expect(raiaAlvoNoY(100, faixas)).toBe(null); // já é "Frontend", mas ela está recolhida — ver teste abaixo
  });

  it("raia recolhida recusa o drop: nunca devolve o laneValue dela, mesmo com o ponto bem no meio", () => {
    expect(raiaAlvoNoY(150, faixas)).toBe(null);
  });

  it("fora de qualquer faixa (acima da primeira, ou abaixo da última) devolve null", () => {
    expect(raiaAlvoNoY(-10, faixas)).toBe(null);
    expect(raiaAlvoNoY(1000, faixas)).toBe(null);
  });

  it("sem raia nenhuma na trilha (TRL-014, `faixas` vazio), tudo é fora", () => {
    expect(raiaAlvoNoY(50, [])).toBe(null);
  });
});

describe("laneParaMover", () => {
  it("alvo diferente da atual: manda mover para o alvo", () => {
    expect(laneParaMover("Backend", "Frontend")).toBe("Frontend");
  });

  it("alvo null (soltou fora de qualquer raia): não faz nada", () => {
    expect(laneParaMover("Backend", null)).toBe(null);
  });

  it("alvo igual à atual (soltou na mesma raia): não faz nada", () => {
    expect(laneParaMover("Backend", "Backend")).toBe(null);
  });

  it("etapa sem raia (laneAtual === \"\") solta de novo em \"Sem raia\": também não faz nada", () => {
    expect(laneParaMover("", "")).toBe(null);
  });
});

describe("posicaoComXTravado", () => {
  it("devolve sempre o x original, custe o y que for — inclusive um arrasto na diagonal não muda o x", () => {
    expect(posicaoComXTravado(340, 12)).toEqual({ x: 340, y: 12 });
    expect(posicaoComXTravado(340, 999)).toEqual({ x: 340, y: 999 });
  });
});

/** Um irmão a 100px de distância vertical do anterior — mesma régua de layout.ts (linha ~60px + gap ~22px), só não precisa ser exata para estes testes. */
function irmao(id: string, position: string, y: number): CartaoIrmaoParaReordenar {
  return { id, position, y };
}

describe("alvoDeReordenacaoNaRaia", () => {
  // Três irmãos empilhados na ordem de `position`: eng (a0, y=100), sci
  // (a1, y=200), red (a2, y=300) — o mesmo cenário do problema real do
  // usuário ("Data Engineer" acima de "Data Science" só porque entrou
  // primeiro), agora vendo o que acontece ao arrastar um deles.
  const eng = irmao("eng", "a0", 100);
  const sci = irmao("sci", "a1", 200);
  const red = irmao("red", "a2", 300);

  it("soltar mais ACIMA de todo mundo manda para o início (`start`)", () => {
    // Arrastando "red" (hoje por último) para bem acima de "eng".
    expect(alvoDeReordenacaoNaRaia(10, "a2", [eng, sci])).toEqual({ type: "start" });
  });

  it("soltar entre dois irmãos manda `after` o de cima — o alvo certo, não um índice numérico", () => {
    // Arrastando "red" (a2) para entre "eng" (y=100) e "sci" (y=200): o
    // centro do cartão arrastado cai em 150, entre os dois.
    expect(alvoDeReordenacaoNaRaia(150, "a2", [eng, sci])).toEqual({ type: "after", value: "eng" });
  });

  it("soltar mais ABAIXO de todo mundo manda `after` o último", () => {
    // Arrastando "eng" (a0) para abaixo de "sci" e "red".
    expect(alvoDeReordenacaoNaRaia(350, "a0", [sci, red])).toEqual({ type: "after", value: "red" });
  });

  it("soltar de volta exatamente onde já estava (por `position`) não gera alvo nenhum — nenhuma chamada de IPC deve sair daqui", () => {
    // "sci" já está entre "eng" e "red" por `position` (a0 < a1 < a2). Soltar
    // o centro dele em qualquer Y que ainda o deixe entre os dois (aqui,
    // bem perto de onde ele já estava, y=200) tem que reconhecer que o
    // antecessor não mudou (`eng`, tanto antes quanto depois).
    expect(alvoDeReordenacaoNaRaia(210, "a1", [eng, red])).toBe(null);
  });

  it("etapa já é a primeira por `position` e continua caindo antes de tudo: também não muda nada", () => {
    expect(alvoDeReordenacaoNaRaia(50, "a0", [sci, red])).toBe(null);
  });

  it("sozinha no nível/raia (sem irmão nenhum): não há contra o que reordenar", () => {
    expect(alvoDeReordenacaoNaRaia(500, "a0", [])).toBe(null);
  });
});

describe("yDaLinhaDeInsercao", () => {
  const eng = irmao("eng", "a0", 100);
  const sci = irmao("sci", "a1", 200);

  it("entre dois irmãos: a meio caminho exato dos dois centros", () => {
    expect(yDaLinhaDeInsercao(150, [eng, sci], 60, 20)).toBe(150);
  });

  it("acima do primeiro: colada acima dele, respeitando altura do cartão + gap", () => {
    expect(yDaLinhaDeInsercao(10, [eng, sci], 60, 20)).toBe(100 - 60 / 2 - 20 / 2);
  });

  it("abaixo do último: colada abaixo dele, mesma régua", () => {
    expect(yDaLinhaDeInsercao(500, [eng, sci], 60, 20)).toBe(200 + 60 / 2 + 20 / 2);
  });

  it("sem irmão nenhum: cai no próprio centro do cartão arrastado (nada para comparar)", () => {
    expect(yDaLinhaDeInsercao(77, [], 60, 20)).toBe(77);
  });
});
