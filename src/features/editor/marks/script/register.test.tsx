/**
 * EDT-082: sobrescrito e subscrito, e a exclusão mútua entre eles - o único
 * ponto não trivial do item (ver comentário em `register.ts`).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { SubscriptButton, SuperscriptButton } from "./FormattingButtons";
import "./register";

let editor: Editor;

function createEditor(): Editor {
  const content: JSONContent = {
    type: "doc",
    content: [
      {
        type: "block",
        content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá mundo" }] }],
      },
    ],
  };
  return new Editor({ extensions: buildEditorExtensions(), content });
}

/** Seleciona "Olá" - posição 2 é o início do texto (doc > block > parágrafo). */
function selectFirstWord(): void {
  editor.commands.setTextSelection({ from: 2, to: 5 });
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-082: subscrito e sobrescrito", () => {
  it("EDT-082: Sobrescrito aplicado via menu de formatação marca o trecho como superscript", () => {
    editor = createEditor();
    selectFirstWord();

    editor.commands.toggleSuperscript();

    expect(editor.isActive("superscript")).toBe(true);
  });

  it("EDT-082: Subscrito aplicado via menu de formatação marca o trecho como subscript", () => {
    editor = createEditor();
    selectFirstWord();

    editor.commands.toggleSubscript();

    expect(editor.isActive("subscript")).toBe(true);
  });

  it("EDT-082: aplicar Subscrito sobre um trecho já Sobrescrito remove o Sobrescrito - mutuamente exclusivos", () => {
    editor = createEditor();
    selectFirstWord();

    editor.commands.toggleSuperscript();
    expect(editor.isActive("superscript")).toBe(true);

    editor.commands.toggleSubscript();

    expect(editor.isActive("subscript")).toBe(true);
    expect(editor.isActive("superscript")).toBe(false);
  });

  it("EDT-082: aplicar Sobrescrito sobre um trecho já Subscrito remove o Subscrito - mesma exclusão na direção oposta", () => {
    editor = createEditor();
    selectFirstWord();

    editor.commands.toggleSubscript();
    expect(editor.isActive("subscript")).toBe(true);

    editor.commands.toggleSuperscript();

    expect(editor.isActive("superscript")).toBe(true);
    expect(editor.isActive("subscript")).toBe(false);
  });

  it("EDT-082: aria-pressed dos dois botões reflete o estado da marca, nunca só a cor", () => {
    editor = createEditor();
    selectFirstWord();

    const superscript = render(<SuperscriptButton editor={editor} />);
    const subscript = render(<SubscriptButton editor={editor} />);
    expect(screen.getByRole("button", { name: "Sobrescrito" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Subscrito" })).toHaveAttribute("aria-pressed", "false");

    editor.commands.toggleSuperscript();
    superscript.rerender(<SuperscriptButton editor={editor} />);
    subscript.rerender(<SubscriptButton editor={editor} />);

    expect(screen.getByRole("button", { name: "Sobrescrito" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Subscrito" })).toHaveAttribute("aria-pressed", "false");
  });

  it("EDT-082: um clique real no botão (não uma chamada direta de comando) aplica a marca no editor", async () => {
    editor = createEditor();
    selectFirstWord();
    const user = userEvent.setup();

    const { rerender } = render(<SuperscriptButton editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Sobrescrito" }));
    rerender(<SuperscriptButton editor={editor} />);

    expect(editor.isActive("superscript")).toBe(true);
    expect(screen.getByRole("button", { name: "Sobrescrito" })).toHaveAttribute("aria-pressed", "true");
  });
});
