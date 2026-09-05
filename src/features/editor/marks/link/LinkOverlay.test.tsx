/**
 * EDT-043: a interação do Ctrl/Cmd+K - abrir, validar, aplicar, fechar sem
 * aplicar, e o limite explícito com a busca global (FUN-037) que o pedido
 * avisa ser "o caso que quebra na mão do usuário". `register.test.ts` cobre
 * a marca em si (o dado); este arquivo cobre só a UI.
 *
 * O editor é headless (`new Editor`, sem `Editor.tsx`/`useEditor`), mas
 * `editor.view.dom` precisa estar de verdade dentro do `document` para os
 * testes de "sobe até a busca global" - sem isso o evento não tem para onde
 * borbulhar (um nó desconectado não tem ancestral nenhum).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { LinkOverlay } from "./LinkOverlay";
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
  // Precisa estar conectado ao `document` para o keydown poder borbulhar até
  // `window` nos testes abaixo - ver comentário do arquivo.
  document.body.appendChild(instance.view.dom);
  return instance;
}

/** "Olá" - posição 2 é o início do texto (doc > block > parágrafo). */
function selectWord() {
  editor.commands.setTextSelection({ from: 2, to: 5 });
}

function pressCtrlK() {
  return fireEvent.keyDown(editor.view.dom, { key: "k", ctrlKey: true, bubbles: true });
}

beforeEach(() => {
  editor = createEditor();
});

afterEach(() => {
  editor.view.dom.remove();
  editor.destroy();
});

describe("EDT-043: abrir o popup do link", () => {
  it("EDT-043: Ctrl+K com texto selecionado abre o popup, foca o campo e não deixa o evento subir para a busca global", () => {
    render(<LinkOverlay editor={editor} />);
    selectWord();
    const onWindowKeyDown = vi.fn();
    window.addEventListener("keydown", onWindowKeyDown);

    const propagated = pressCtrlK();

    expect(propagated).toBe(false); // `dispatchEvent` retorna false quando algo chamou preventDefault
    expect(onWindowKeyDown).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Adicionar link" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "URL do link" })).toHaveFocus();

    window.removeEventListener("keydown", onWindowKeyDown);
  });

  it("EDT-043: Ctrl+K sem seleção não abre o popup - o mesmo atalho continua caindo na busca global (FUN-037)", () => {
    render(<LinkOverlay editor={editor} />);
    editor.commands.setTextSelection({ from: 2, to: 2 }); // seleção vazia, cursor só

    const onWindowKeyDown = vi.fn();
    window.addEventListener("keydown", onWindowKeyDown);

    const propagated = pressCtrlK();

    expect(propagated).toBe(true); // nada chamou preventDefault - livre para a busca global tratar
    expect(onWindowKeyDown).toHaveBeenCalledTimes(1); // e de fato chegou lá
    expect(screen.queryByRole("dialog", { name: "Adicionar link" })).not.toBeInTheDocument();

    window.removeEventListener("keydown", onWindowKeyDown);
  });
});

describe("EDT-043: aplicar e cancelar", () => {
  it("EDT-043: Enter com URL válida aplica o link no trecho selecionado e fecha o popup", async () => {
    const user = userEvent.setup();
    render(<LinkOverlay editor={editor} />);
    selectWord();
    pressCtrlK();

    await user.type(screen.getByRole("textbox", { name: "URL do link" }), "https://exemplo.com{Enter}");

    expect(screen.queryByRole("dialog", { name: "Adicionar link" })).not.toBeInTheDocument();
    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark?.attrs.href).toBe("https://exemplo.com/");
  });

  it("EDT-043: Esc fecha o popup sem aplicar nada", async () => {
    const user = userEvent.setup();
    render(<LinkOverlay editor={editor} />);
    selectWord();
    pressCtrlK();

    await user.type(screen.getByRole("textbox", { name: "URL do link" }), "https://exemplo.com");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Adicionar link" })).not.toBeInTheDocument();
    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark).toBeUndefined();
  });

  it("EDT-043: URL vazia não aplica e mostra o erro sem fechar o popup", async () => {
    const user = userEvent.setup();
    render(<LinkOverlay editor={editor} />);
    selectWord();
    pressCtrlK();

    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Adicionar link" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/URL inválida/);
    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark).toBeUndefined();
  });

  it("EDT-043: URL sem esquema reconhecido (javascript:) não aplica e mostra o erro", async () => {
    const user = userEvent.setup();
    render(<LinkOverlay editor={editor} />);
    selectWord();
    pressCtrlK();

    await user.type(screen.getByRole("textbox", { name: "URL do link" }), "javascript:alert(1){Enter}");

    expect(screen.getByRole("alert")).toHaveTextContent(/URL inválida/);
    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark).toBeUndefined();
  });
});
