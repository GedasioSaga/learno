import { afterEach, describe, expect, it } from "vitest";
import { ATRIBUTO_INICIO, intervaloSelecionadoEm } from "./selecao-no-texto";

/** Monta a mesma estrutura que a prévia de `CriarLacunaDeOrigem` renderiza. */
function montar(pedacos: Array<{ inicio: number; texto: string; lacuna?: boolean }>): HTMLElement {
  const container = document.createElement("p");
  for (const pedaco of pedacos) {
    const span = document.createElement("span");
    span.setAttribute(ATRIBUTO_INICIO, String(pedaco.inicio));
    span.textContent = pedaco.texto;
    if (pedaco.lacuna) {
      const chip = document.createElement("span");
      const selo = document.createElement("sup");
      selo.textContent = "1"; // não é texto do bloco: fica FORA do pedaço
      chip.append(span, selo);
      container.append(chip);
    } else {
      container.append(span);
    }
  }
  document.body.append(container);
  return container;
}

function selecionar(inicioNo: Node, inicioOffset: number, fimNo: Node, fimOffset: number): Selection {
  const range = document.createRange();
  range.setStart(inicioNo, inicioOffset);
  range.setEnd(fimNo, fimOffset);
  const selecao = document.getSelection();
  if (!selecao) throw new Error("jsdom sem Selection");
  selecao.removeAllRanges();
  selecao.addRange(range);
  return selecao;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("intervaloSelecionadoEm", () => {
  it("dentro de um pedaço só: soma o offset ao data-inicio", () => {
    const container = montar([{ inicio: 0, texto: "A mitocôndria produz" }]);
    const no = container.firstChild?.firstChild;
    if (!no) throw new Error("sem nó de texto");
    const selecao = selecionar(no, 2, no, 13);
    expect(intervaloSelecionadoEm(container, selecao)).toEqual({ inicio: 2, fim: 13 });
  });

  it("atravessando pedaços (literal → lacuna): cada ponta resolve pelo seu próprio pedaço", () => {
    const container = montar([
      { inicio: 0, texto: "A " },
      { inicio: 2, texto: "mitocôndria", lacuna: true },
      { inicio: 13, texto: " produz" },
    ]);
    const pedacos = container.querySelectorAll(`[${ATRIBUTO_INICIO}]`);
    const primeiro = pedacos[0]?.firstChild;
    const ultimo = pedacos[2]?.firstChild;
    if (!primeiro || !ultimo) throw new Error("sem nós de texto");
    const selecao = selecionar(primeiro, 0, ultimo, 4);
    expect(intervaloSelecionadoEm(container, selecao)).toEqual({ inicio: 0, fim: 17 });
  });

  it("seleção colapsada ou ausente: null", () => {
    const container = montar([{ inicio: 0, texto: "abc" }]);
    const no = container.firstChild?.firstChild;
    if (!no) throw new Error("sem nó de texto");
    expect(intervaloSelecionadoEm(container, selecionar(no, 1, no, 1))).toBeNull();
    expect(intervaloSelecionadoEm(container, null)).toBeNull();
  });

  it("ponta no selo da lacuna (fora do texto do bloco): null, nunca um índice inventado", () => {
    const container = montar([{ inicio: 0, texto: "abc", lacuna: true }]);
    const texto = container.querySelector(`[${ATRIBUTO_INICIO}]`)?.firstChild;
    const selo = container.querySelector("sup")?.firstChild;
    if (!texto || !selo) throw new Error("estrutura inesperada");
    expect(intervaloSelecionadoEm(container, selecionar(texto, 0, selo, 1))).toBeNull();
  });

  it("seleção fora do container: null", () => {
    const container = montar([{ inicio: 0, texto: "abc" }]);
    const fora = document.createElement("p");
    fora.textContent = "outro";
    document.body.append(fora);
    const no = fora.firstChild;
    if (!no) throw new Error("sem nó");
    expect(intervaloSelecionadoEm(container, selecionar(no, 0, no, 3))).toBeNull();
  });
});
