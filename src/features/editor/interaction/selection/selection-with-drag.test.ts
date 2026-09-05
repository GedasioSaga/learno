/**
 * EDT-053/054 com DOIS builders montados no mesmo editor: esta pasta
 * (`interaction/selection`) e `interaction/drag`.
 *
 * Existe em arquivo separado de `selection.test.ts` por causa do próprio
 * defeito que ele cobre. Cada teste de builder importa só o `register.ts`
 * dele, então `buildEditorExtensions()` monta um editor com UM builder — e
 * um choque de DOM entre dois builders é invisível nesse arranjo. Em
 * produção `core/discover-extensions.ts` importa todos os `register.ts` por
 * `import.meta.glob`, e aí a alça de arrastar (`Decoration.widget` em
 * `pos + 1`, ver `drag-extension.ts`) passa a nascer como o primeiro filho
 * de `.ed-block-wrapper`, antes do conteúdo do bloco.
 *
 * Era isso que quebrava: `selection-mouse.ts` lia o id do bloco de
 * `wrapperEl.firstElementChild`, achava a alça (um `<button>` sem
 * `data-block-id`), devolvia `null` e saía do mousedown por
 * `if (!id) return false`. Resultado: com o app inteiro montado, nenhum
 * gesto de mouse selecionava bloco nenhum — EDT-053 e EDT-054 mortos —
 * enquanto os dois builders passavam nos próprios testes.
 *
 * O gesto geométrico (posição do ponteiro contra `getBoundingClientRect()`)
 * segue no e2e, onde há layout de verdade; aqui é só a leitura de DOM, que
 * jsdom cobre bem.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
// A ORDEM não importa, mas a presença dos dois importa: é a única diferença
// entre este arquivo e `selection.test.ts`.
import "./register";
import "../drag/register";
import { getSelectedBlockIds } from "./selection-state";

let editor: Editor;

afterEach(() => {
  editor?.destroy();
});

function paragraphsDoc(entries: Array<[id: string, text: string]>): JSONContent {
  return {
    type: "doc",
    content: entries.map(([id, text]) => ({
      type: "block",
      content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
    })),
  };
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function wrapperOf(blockId: string): HTMLElement {
  const content = editor.view.dom.querySelector(`[data-block-id="${blockId}"]`);
  const wrapper = content?.closest<HTMLElement>(".ed-block-wrapper");
  if (!wrapper) throw new Error(`wrapper do bloco "${blockId}" não encontrado no DOM do editor`);
  return wrapper;
}

/** Um mousedown como o navegador entrega: alvo é o conteúdo do bloco, dentro do wrapper. */
function mousedownOn(blockId: string, options: MouseEventInit = {}) {
  const content = editor.view.dom.querySelector(`[data-block-id="${blockId}"]`);
  if (!content) throw new Error(`bloco "${blockId}" não encontrado no DOM do editor`);
  content.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...options }));
}

/** Posição do início do texto do bloco — acha pelo doc em vez de calcular offset na mão. */
function startOfBlock(blockId: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.attrs.id === blockId) {
      result = pos + 1;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado no doc atual`);
  return result;
}

describe("interaction/selection + interaction/drag no mesmo editor", () => {
  it("a alça de arrastar entra ANTES do conteúdo do bloco — a condição que quebrava a leitura do id", () => {
    editor = createEditor(paragraphsDoc([["a", "Um"]]));
    const wrapper = wrapperOf("a");

    // Precondição do defeito: `firstElementChild` não é o conteúdo.
    expect(wrapper.firstElementChild?.getAttribute("data-block-id")).toBeNull();
    expect(wrapper.firstElementChild?.classList.contains("ed-drag-handle")).toBe(true);
    // E a leitura correta continua achando o bloco certo.
    expect(wrapper.querySelector(":scope > [data-block-id]")?.getAttribute("data-block-id")).toBe("a");
  });

  it("EDT-054: Shift+clique no bloco 4, cursor no bloco 1, seleciona 1, 2, 3 e 4", () => {
    editor = createEditor(
      paragraphsDoc([
        ["a", "Um"],
        ["b", "Dois"],
        ["c", "Três"],
        ["d", "Quatro"],
      ]),
    );
    // O clique simples anterior é o que deixa o cursor no bloco 1 — é dele
    // que `selection-mouse.ts` tira a âncora quando ainda não há seleção
    // múltipla nenhuma.
    editor.commands.setTextSelection(startOfBlock("a"));

    mousedownOn("d", { shiftKey: true });

    expect(getSelectedBlockIds(editor)).toEqual(["a", "b", "c", "d"]);
    // E a decoração pinta os quatro wrappers, não só o estado interno.
    for (const id of ["a", "b", "c", "d"]) {
      expect(wrapperOf(id).classList.contains("ed-block-wrapper--selected")).toBe(true);
    }
  });

  it("EDT-054: Shift+clique para trás (alvo antes da âncora) cobre o mesmo intervalo", () => {
    editor = createEditor(
      paragraphsDoc([
        ["a", "Um"],
        ["b", "Dois"],
        ["c", "Três"],
      ]),
    );
    editor.commands.setTextSelection(startOfBlock("c"));

    mousedownOn("a", { shiftKey: true });

    expect(getSelectedBlockIds(editor)).toEqual(["a", "b", "c"]);
  });
});
