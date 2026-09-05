/**
 * Comportamento do `MathNodeView`, exercitado com um editor Tiptap real
 * (mesmo padrão de `core/commands.test.ts` e `marks/basic/register.test.ts`:
 * `KeyboardEvent`/`handleTextInput` de verdade, não os métodos privados
 * chamados direto) - mas com `createEquationExtension`/`createInlineMathExtension`
 * recebendo um `renderLatex` de mentira, nunca `./register.ts` nem
 * `render-latex.ts`: MathJax não termina de carregar a tempo sob jsdom (ver
 * cabeçalho do arquivo da tarefa), então o próprio código já isola a chamada
 * atrás de um parâmetro para este teste substituir.
 *
 * O que cada teste prova, por checklist:
 * - EDT-022: a expressão digitada é guardada e o render é pedido com ela
 *   exata ao sair da edição (Esc); clicar no resultado renderizado volta a
 *   mostrar o LaTeX cru.
 * - EDT-023: `$..$` fecha e renderiza inline sem sobrar o delimitador no
 *   texto; Ctrl/Cmd+Shift+E embrulha a seleção.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { createEquationExtension } from "./equation-block";
import { createInlineMathExtension } from "./inline-math";
import type { RenderLatex } from "./math-node-view";

let editor: Editor;

afterEach(() => {
  editor?.destroy();
});

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

/** Mesma técnica de `marks/basic/register.test.ts`: simula texto digitado chegando ao plugin de input rules. */
function typeChar(char: string): void {
  const { from, to } = editor.state.selection;
  editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, char, () => editor.state.tr));
}

/**
 * `Editor.getJSON()`'s declared return type recursively narrows nested
 * content para `NodeType | TextType` (o ramo de texto não tem `.attrs`) -
 * exatamente certo pra essa API, mas atrapalha um teste que só quer andar na
 * árvore. `JSONContent` é a forma solta que `serialize.ts` já usa em todo
 * lugar - mesmo ajuste que `core/commands.test.ts` faz pelo mesmo motivo.
 */
function json(): JSONContent {
  return editor.getJSON();
}

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
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado`);
  return result;
}

/** Um `renderLatex` de mentira que grava cada chamada e devolve um nó DOM identificável, em vez de comparar SVG de verdade - exatamente o que a tarefa pede. */
function makeStubRenderLatex(): { renderLatex: RenderLatex; calls: { expression: string; display: boolean }[] } {
  const calls: { expression: string; display: boolean }[] = [];
  const renderLatex: RenderLatex = async (expression, display) => {
    calls.push({ expression, display });
    const stub = document.createElement("span");
    stub.setAttribute("data-stub-render", "true");
    stub.textContent = `MATH(${display ? "block" : "inline"}):${expression}`;
    return stub;
  };
  return { renderLatex, calls };
}

/** Simula MathJax rejeitando (LaTeX inválido, erro de parse) - o caminho `catch` de `renderMath` em `math-node-view.ts`. */
function makeFailingRenderLatex(): RenderLatex {
  return async () => {
    throw new Error("LaTeX inválido");
  };
}

function createEditor(content: JSONContent, renderLatex: RenderLatex): Editor {
  return new Editor({
    extensions: [...buildEditorExtensions(), createEquationExtension(renderLatex), createInlineMathExtension(renderLatex)],
    content,
  });
}

/** `renderMath` é assíncrono (mesmo com o stub, por ser uma função `async`) - um giro de macrotask garante que o microtask de resolução já rodou. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("EDT-022: equação em bloco", () => {
  it("começa em modo de edição quando criada vazia (menu /), e nada é renderizado ainda", () => {
    const { renderLatex, calls } = makeStubRenderLatex();
    editor = createEditor(
      { type: "doc", content: [{ type: "block", content: [{ type: "equation", attrs: { id: "eq1", expression: "" } }] }] },
      renderLatex,
    );
    const dom = editor.view.dom.querySelector('[data-block-type="equation"]');
    expect(dom?.getAttribute("data-latex-editing")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("renderiza a fração formatada e centralizada ao sair do modo de edição (Esc)", async () => {
    const { renderLatex, calls } = makeStubRenderLatex();
    editor = createEditor(
      { type: "doc", content: [{ type: "block", content: [{ type: "equation", attrs: { id: "eq1", expression: "" } }] }] },
      renderLatex,
    );
    const dom = editor.view.dom.querySelector('[data-block-type="equation"]');
    if (!dom) throw new Error("nó da equação não montou");
    const input = dom.querySelector(".ed-equation__input");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("textarea de edição não encontrada");

    input.value = "\\frac{a}{b}";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // "centralizada" é responsabilidade do CSS de `.ed-equation` (flex
    // centralizado em math.css) - o que este teste prova é o contrato
    // observável: saiu da edição e pediu o render com a expressão exata.
    expect(dom.getAttribute("data-latex-editing")).toBe("false");
    expect(calls).toEqual([{ expression: "\\frac{a}{b}", display: true }]);
    const rendered = dom.querySelector(".ed-equation__render [data-stub-render]");
    expect(rendered?.textContent).toBe("MATH(block):\\frac{a}{b}");

    // E a expressão realmente foi gravada no nó, não só mostrada uma vez.
    expect(json().content?.[0]?.content?.[0]?.attrs?.expression).toBe("\\frac{a}{b}");
  });

  it("clicar na equação renderizada volta ao modo de edição mostrando o LaTeX cru", async () => {
    const { renderLatex } = makeStubRenderLatex();
    editor = createEditor(
      {
        type: "doc",
        content: [{ type: "block", content: [{ type: "equation", attrs: { id: "eq1", expression: "x^2" } }] }],
      },
      renderLatex,
    );
    await flushMicrotasks();
    const dom = editor.view.dom.querySelector('[data-block-type="equation"]');
    if (!dom) throw new Error("nó da equação não montou");
    expect(dom.getAttribute("data-latex-editing")).toBe("false");

    const renderContainer = dom.querySelector(".ed-equation__render");
    renderContainer?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(dom.getAttribute("data-latex-editing")).toBe("true");
    const input = dom.querySelector(".ed-equation__input");
    expect(input instanceof HTMLTextAreaElement && input.value).toBe("x^2");
  });

  it("EDT-022: quando o render rejeita (LaTeX inválido), mostra mensagem de erro em vez de travar", async () => {
    editor = createEditor(
      { type: "doc", content: [{ type: "block", content: [{ type: "equation", attrs: { id: "eq1", expression: "" } }] }] },
      makeFailingRenderLatex(),
    );
    const dom = editor.view.dom.querySelector('[data-block-type="equation"]');
    if (!dom) throw new Error("nó da equação não montou");
    const input = dom.querySelector(".ed-equation__input");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("textarea de edição não encontrada");

    input.value = "\\frac{";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushMicrotasks();

    // Saiu do modo de edição normalmente - a falha de render não deixa o bloco preso editando.
    expect(dom.getAttribute("data-latex-editing")).toBe("false");
    const renderContainer = dom.querySelector(".ed-equation__render");
    expect(renderContainer?.textContent).toBe("Não foi possível renderizar esta equação");
    // A expressão inválida ainda foi gravada - reabrir a edição mostra o que a pessoa digitou, não perde o trabalho.
    expect(json().content?.[0]?.content?.[0]?.attrs?.expression).toBe("\\frac{");
  });
});

describe("EDT-023: equação inline", () => {
  it("uma expressão entre $..$ renderiza inline assim que o delimitador fecha", async () => {
    const { renderLatex, calls } = makeStubRenderLatex();
    editor = createEditor(
      { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] },
      renderLatex,
    );
    editor.commands.setTextSelection(startOfBlock("p1"));
    // Só o último caractere (o `$` que fecha) precisa passar pelo plugin de
    // input rules de verdade - o resto entra direto, mesmo padrão de
    // `marks/basic/register.test.ts` para o `**bold*` + `typeChar("*")`.
    editor.commands.insertContent("$a+b");
    typeChar("$");
    await flushMicrotasks();

    const dom = editor.view.dom.querySelector('[data-inline-type="inlineMath"]');
    expect(dom).not.toBeNull();
    expect(dom?.getAttribute("data-latex-editing")).toBe("false");
    expect(calls).toEqual([{ expression: "a+b", display: false }]);
    // O "$a+b$" digitado não sobra como texto ao lado - o input rule substituiu o intervalo casado.
    expect(editor.view.dom.textContent).not.toContain("$a+b$");
  });

  it("Ctrl/Cmd+Shift+E embrulha a seleção atual numa equação inline", async () => {
    const { renderLatex, calls } = makeStubRenderLatex();
    editor = createEditor(
      {
        type: "doc",
        content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "x^2" }] }] }],
      },
      renderLatex,
    );
    const start = startOfBlock("p1");
    editor.commands.setTextSelection({ from: start, to: start + 3 }); // seleciona "x^2"

    press("e", { ctrlKey: true, shiftKey: true });
    await flushMicrotasks();

    expect(calls).toEqual([{ expression: "x^2", display: false }]);
    const dom = editor.view.dom.querySelector('[data-inline-type="inlineMath"]');
    expect(dom?.getAttribute("data-latex-editing")).toBe("false");
  });

  it("Ctrl/Cmd+Shift+E sem seleção abre uma equação inline vazia em modo de edição", () => {
    const { renderLatex, calls } = makeStubRenderLatex();
    editor = createEditor(
      { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] },
      renderLatex,
    );
    editor.commands.setTextSelection(startOfBlock("p1"));

    press("e", { ctrlKey: true, shiftKey: true });

    const dom = editor.view.dom.querySelector('[data-inline-type="inlineMath"]');
    expect(dom?.getAttribute("data-latex-editing")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("EDT-023: quando o render rejeita, a equação inline também mostra mensagem de erro em vez de travar", async () => {
    editor = createEditor(
      {
        type: "doc",
        content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "x^" }] }] }],
      },
      makeFailingRenderLatex(),
    );
    const start = startOfBlock("p1");
    editor.commands.setTextSelection({ from: start, to: start + 2 }); // seleciona "x^"

    press("e", { ctrlKey: true, shiftKey: true });
    await flushMicrotasks();

    const dom = editor.view.dom.querySelector('[data-inline-type="inlineMath"]');
    if (!dom) throw new Error("nó da equação inline não montou");
    expect(dom.getAttribute("data-latex-editing")).toBe("false");
    const renderContainer = dom.querySelector(".ed-inline-math__render");
    expect(renderContainer?.textContent).toBe("Não foi possível renderizar esta equação");
  });
});
