/**
 * The toolbar button's own contract, separate from the mark/shortcut tests
 * in `register.test.ts`: `aria-pressed` has to track `editor.isActive(...)`
 * (the task's own wording), and clicking has to actually toggle the mark -
 * exercised through a real click on a real `<button>`, not by calling the
 * `onToggle` prop directly.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorContent } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { renderBoldButton } from "./formatting-buttons";
import "./register";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function paragraphDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text }] }] }],
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-035: botão de negrito na barra de formatação", () => {
  it("aria-pressed segue editor.isActive('bold') e clicar alterna a marca", async () => {
    const user = userEvent.setup();
    editor = createEditor(paragraphDoc("abc"));
    editor.commands.setTextSelection({ from: 2, to: 5 }); // "abc"

    render(
      <>
        <EditorContent editor={editor} />
        {renderBoldButton(editor)}
      </>,
    );

    const button = screen.getByRole("button", { name: "Negrito" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(editor.isActive("bold")).toBe(true);

    await user.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(editor.isActive("bold")).toBe(false);
  });
});

describe("EDT-039: código inline (estilo visual)", () => {
  it("o texto marcado como código fica monoespaçado com fundo diferenciado do texto normal", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            {
              type: "paragraph",
              attrs: { id: "a" },
              content: [
                { type: "text", text: "normal " },
                { type: "text", text: "code", marks: [{ type: "code" }] },
              ],
            },
          ],
        },
      ],
    });

    // `.ed-root` é a classe que `core/Editor.tsx` põe na raiz do editor em
    // produção; `basic-marks.css`'s `.ed-root code` depende dela como
    // ancestral, então o wrapper reproduz isso sem tocar em core/.
    const { container } = render(
      <div className="ed-root">
        <EditorContent editor={editor} />
      </div>,
    );

    const codeEl = container.querySelector("code");
    if (!codeEl) throw new Error("marca de código não renderizou um elemento <code>");
    // Paragraph renderiza como `<div data-block-type="paragraph">`, não `<p>` (schema.ts).
    const paragraphEl = container.querySelector('[data-block-type="paragraph"]');
    if (!paragraphEl) throw new Error("parágrafo não renderizado");

    const codeStyle = getComputedStyle(codeEl);
    const paragraphStyle = getComputedStyle(paragraphEl);

    // Monoespaçado: a pilha inteira declarada em basic-marks.css, não só "algo com mono".
    expect(codeStyle.fontFamily).toBe('ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace');
    expect(codeStyle.fontFamily).not.toBe(paragraphStyle.fontFamily);

    // Fundo diferenciado: jsdom não resolve `var()` para a cor final em
    // propriedades longhand (getComputedStyle().backgroundColor sempre
    // volta transparente - https://github.com/jsdom/jsdom/issues/1895,
    // ainda aberto na v29 usada aqui, confirmado por leitura direta do
    // jsdom nesta máquina). A propriedade shorthand `background`, porém,
    // preserva o `var(...)` não resolvido no valor computado - então isto
    // ainda prova que a regra `.ed-root code { background: var(--surface-sunken) }`
    // resolveu especificamente para este `<code>` renderizado (e não para o
    // parágrafo ao lado), que é o fato que EDT-039 pede.
    expect(codeStyle.background).toContain("var(--surface-sunken)");
    expect(paragraphStyle.background).not.toContain("var(--surface-sunken)");
  });
});
