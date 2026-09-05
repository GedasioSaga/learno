/**
 * EDT-043: clicar no `<a>` renderizado abre a URL pelo caminho certo para
 * desktop, e nunca deixa a navegação nativa do `<a href>` acontecer -
 * exatamente o gap que a rodada de correção pediu (nenhum teste da peça
 * disparava um clique de verdade antes disso). Fora do Tauri (`isTauri()`
 * retorna falso em jsdom, ver `open-link-url.ts`), o fallback é
 * `window.open`, então é isso que os testes observam.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { LinkClickHandler } from "./LinkClickHandler";
import "./register";

let editor: Editor;

function createEditor(): Editor {
  const content: JSONContent = {
    type: "doc",
    content: [
      {
        type: "block",
        content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá mundo" }] }],
      },
    ],
  };
  const instance = new Editor({ extensions: buildEditorExtensions(), content });
  // Precisa estar conectado ao `document` - `closest`/`contains` em
  // `LinkClickHandler` dependem do `<a>` estar de fato dentro do DOM do
  // editor, não só existir como nó desconectado.
  document.body.appendChild(instance.view.dom);
  return instance;
}

function applyLinkToWord() {
  editor.commands.setTextSelection({ from: 2, to: 5 }); // "Olá"
  editor.commands.setLink({ href: "https://exemplo.com" });
}

beforeEach(() => {
  editor = createEditor();
});

afterEach(() => {
  editor.view.dom.remove();
  editor.destroy();
  vi.restoreAllMocks();
});

describe("EDT-043: clique no link abre a URL certa", () => {
  it("EDT-043: clicar no <a> renderizado abre a URL (fallback window.open fora do Tauri) e barra a navegação nativa do <a href>", () => {
    applyLinkToWord();
    render(<LinkClickHandler editor={editor} />);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const anchor = editor.view.dom.querySelector("a.ed-link");
    expect(anchor).not.toBeNull();

    const propagated = fireEvent.click(anchor as Element, { bubbles: true, button: 0 });

    // `dispatchEvent` retorna false quando algo chamou `preventDefault` - é
    // exatamente essa navegação nativa do `<a href>` que precisa ser barrada,
    // já que ela navegaria a própria WebView do app em vez de abrir o
    // navegador do SO.
    expect(propagated).toBe(false);
    expect(openSpy).toHaveBeenCalledWith("https://exemplo.com/", "_blank", "noopener,noreferrer");
  });

  it("EDT-043: clicar fora de qualquer <a> não abre nada", () => {
    applyLinkToWord();
    render(<LinkClickHandler editor={editor} />);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    // " mundo" não tem a marca - texto fora do <a>. O nó paragraph renderiza
    // como `div[data-block-type]` (`core/schema.ts`), não `<p>`.
    const paragraph = editor.view.dom.querySelector('div[data-block-type="paragraph"]');
    expect(paragraph).not.toBeNull();

    fireEvent.click(paragraph as Element, { bubbles: true, button: 0 });

    expect(openSpy).not.toHaveBeenCalled();
  });
});
