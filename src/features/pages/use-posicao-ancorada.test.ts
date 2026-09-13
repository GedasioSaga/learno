import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { usePosicaoAncorada } from "./use-posicao-ancorada";

/**
 * O teste que faltava quando os menus abriam fora da tela.
 *
 * Os três menus deste projeto usavam `absolute top-full` dentro de um
 * `popover`, e na top layer isso posiciona a partir da JANELA, não do
 * gatilho — o painel abria uma altura de tela inteira abaixo do visível. Como
 * o jsdom não faz layout, todo teste existente continuou verde: `getByRole`
 * acha o painel esteja ele onde estiver, e o usuário via um botão que não
 * fazia nada.
 *
 * Aqui o layout é forjado de propósito (`getBoundingClientRect` e as medidas
 * da janela são fixadas à mão), que é o único jeito de afirmar POSIÇÃO num
 * ambiente sem layout. Sem isto, a correção seria indistinguível do defeito
 * para a suíte.
 */

const LARGURA_DA_JANELA = 800;
const ALTURA_DA_JANELA = 600;

interface Medidas {
  top: number;
  left: number;
  width: number;
  height: number;
}

function elementoMedindo({ top, left, width, height }: Medidas): HTMLElement {
  const elemento = document.createElement("div");
  document.body.appendChild(elemento);
  elemento.getBoundingClientRect = () =>
    ({
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  return elemento;
}

function ref(elemento: HTMLElement): RefObject<HTMLElement | null> {
  return { current: elemento };
}

function fixarJanela() {
  Object.defineProperty(window, "innerWidth", { value: LARGURA_DA_JANELA, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: ALTURA_DA_JANELA, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("usePosicaoAncorada", () => {
  it("crava position fixed e ancora o painel logo abaixo do gatilho", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 100, left: 200, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true));

    // `fixed`, e não `absolute`, é o ponto inteiro da correção: dentro da top
    // layer, `absolute` resolve contra a janela e a conta sai errada.
    expect(painel.style.position).toBe("fixed");
    expect(painel.style.top).toBe("136px"); // 100 + 32 (altura do gatilho) + 4 (espaçamento)
    expect(painel.style.left).toBe("200px");
  });

  it("alinha a borda direita do painel à direita do gatilho quando pedido", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 100, left: 600, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true, { alinhamento: "fim" }));

    expect(painel.style.left).toBe("376px"); // 632 (direita do gatilho) - 256
  });

  it("vira para cima quando não cabe embaixo", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 528, left: 200, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true));

    expect(painel.style.top).toBe("224px"); // 528 - 4 - 300
  });

  it("nunca deixa o painel sair pela direita da janela", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 100, left: 700, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true));

    // 700 jogaria 156px do painel para fora; encosta na margem em vez disso.
    expect(painel.style.left).toBe("536px"); // 800 - 256 - 8
  });

  it("encosta no topo quando o painel é mais alto que a janela inteira", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 300, left: 200, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 900 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true));

    // Não cabe em lugar nenhum: mostra o começo do menu, que é o que a pessoa
    // precisa ler primeiro.
    expect(painel.style.top).toBe("8px");
  });

  it("não toca no painel enquanto ele está fechado", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 100, left: 200, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), false));

    expect(painel.style.position).toBe("");
    expect(painel.style.top).toBe("");
  });

  it("reposiciona quando a janela muda de tamanho com o painel aberto", () => {
    fixarJanela();
    const gatilho = elementoMedindo({ top: 100, left: 700, width: 32, height: 32 });
    const painel = elementoMedindo({ top: 0, left: 0, width: 256, height: 300 });

    renderHook(() => usePosicaoAncorada(ref(gatilho), ref(painel), true));
    expect(painel.style.left).toBe("536px");

    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // Com janela larga o painel cabe onde deveria estar desde o começo.
    expect(painel.style.left).toBe("700px");
  });
});
