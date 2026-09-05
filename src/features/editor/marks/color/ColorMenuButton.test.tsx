/**
 * A metade "menu" do critério: clicar o swatch certo aplica o comando certo
 * no `editor` real (headless, sem `Editor.tsx`/`BubbleMenu` - essa parte é
 * responsabilidade do core, não desta pasta). `register.test.ts` cobre o
 * round trip de persistência.
 */
import { Editor } from "@tiptap/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { ColorMenuButton } from "./ColorMenuButton";
import "./register";

let editor: Editor;

function createEditor(): Editor {
  return new Editor({
    extensions: buildEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá mundo" }] }],
        },
      ],
    },
  });
}

beforeEach(() => {
  editor = createEditor();
  editor.commands.setTextSelection({ from: 2, to: 5 }); // "Olá"
});

afterEach(() => {
  editor.destroy();
});

describe("EDT-040: menu de cor de texto", () => {
  it("escolher 'Vermelho' no menu aplica a cor no texto selecionado", async () => {
    const user = userEvent.setup();
    render(<ColorMenuButton editor={editor} />);

    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Vermelho" }));

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle");
    expect(mark?.attrs.color).toBe("#b3261e");
  });

  it("'Remover cor' desfaz a marca aplicada", async () => {
    const user = userEvent.setup();
    render(<ColorMenuButton editor={editor} />);

    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Vermelho" }));
    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Remover cor" }));

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle" && m.attrs.color);
    expect(mark).toBeUndefined();
  });
});

describe("EDT-041: menu de cor de fundo", () => {
  it("escolher 'Amarelo (fundo)' aplica destaque - uma marca diferente da de cor de texto", async () => {
    const user = userEvent.setup();
    render(<ColorMenuButton editor={editor} />);

    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Amarelo (fundo)" }));

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    expect(marks.some((m) => m.type.name === "highlight" && m.attrs.color === "#eab30866")).toBe(true);
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color)).toBe(false);
  });

  it("'Remover destaque' desfaz a marca de fundo sem mexer na de texto", async () => {
    const user = userEvent.setup();
    render(<ColorMenuButton editor={editor} />);

    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Vermelho" }));
    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Amarelo (fundo)" }));
    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));
    await user.click(screen.getByRole("button", { name: "Remover destaque" }));

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    expect(marks.some((m) => m.type.name === "highlight")).toBe(false);
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color === "#b3261e")).toBe(true);
  });
});

describe("acessibilidade", () => {
  it("cada swatch identifica a cor pelo nome no aria-label, não só pela cor do círculo", async () => {
    const user = userEvent.setup();
    render(<ColorMenuButton editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Cor do texto e destaque" }));

    expect(screen.getByRole("button", { name: "Azul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verde (fundo)" })).toBeInTheDocument();
  });
});
