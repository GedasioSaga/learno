/**
 * Renderização do popup - `slash-menu-extension.test.ts` já prova a
 * interceptação de teclado de ponta a ponta; este arquivo prova o que fica
 * na tela: grupos, papéis de acessibilidade, mensagem de "nada casou" e o
 * clique do mouse como segunda forma de escolher (a primeira, Enter, já
 * está no outro arquivo).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { registerSlashMenuItem, resetBlockRegistriesForTests } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import "./register";
import { SlashMenuOverlay } from "./SlashMenuOverlay";
import { useSlashMenuStore } from "./slash-menu-store";

let editor: Editor;

function docWithText(id: string, text: string): JSONContent {
  // ProseMirror recusa nó de texto vazio - um parágrafo vazio não tem `content` nenhum.
  const inline = text ? [{ type: "text", text }] : [];
  return {
    type: "doc",
    content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: inline }] }],
  };
}

beforeEach(() => {
  resetBlockRegistriesForTests();
  useSlashMenuStore.getState().close();
});

afterEach(() => {
  editor?.destroy();
});

describe("EDT-047: popup do menu de barra", () => {
  it("EDT-047: nada renderiza enquanto o menu está fechado", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: docWithText("a", "") });
    const { container } = render(<SlashMenuOverlay editor={editor} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("EDT-047: aberto, lista em role=listbox os itens agrupados e anuncia o realçado", () => {
    registerSlashMenuItem({ id: "test:heading_1", title: "Título 1", group: "Básico", order: 0, run: () => true });
    registerSlashMenuItem({ id: "test:quote", title: "Citação", group: "Básico", order: 1, run: () => true });

    editor = new Editor({ extensions: buildEditorExtensions(), content: docWithText("a", "") });
    useSlashMenuStore.getState().open("", document.body.getBoundingClientRect());

    render(<SlashMenuOverlay editor={editor} />);

    const listbox = screen.getByRole("listbox", { name: "Inserir bloco" });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Título 1", "Citação"]);
    // Nada foi navegado por seta ainda: o primeiro item visível é o realçado por padrão.
    expect(listbox).toHaveAttribute("aria-activedescendant", "ed-slash-menu-item-test:heading_1");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("EDT-047: quando nada casa, mostra a mensagem em vez de sumir", () => {
    registerSlashMenuItem({ id: "test:heading_1", title: "Título 1", group: "Básico", run: () => true });

    editor = new Editor({ extensions: buildEditorExtensions(), content: docWithText("a", "") });
    useSlashMenuStore.getState().open("xyz-nao-existe", document.body.getBoundingClientRect());

    render(<SlashMenuOverlay editor={editor} />);

    expect(screen.getByText("Nenhum bloco encontrado")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("EDT-047: clicar num item roda o run() dele e apaga o \"/\" e o filtro do texto", async () => {
    let ran = false;
    registerSlashMenuItem({
      id: "test:heading_1",
      title: "Título 1",
      keywords: ["head", "heading"],
      group: "Básico",
      run: (ed) => {
        ed.commands.insertContent("BLOCO-INSERIDO");
        ran = true;
        return true;
      },
    });

    editor = new Editor({ extensions: buildEditorExtensions(), content: docWithText("a", "/head") });
    // Posiciona a seleção no fim de "/head", como o gatilho real deixaria.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    useSlashMenuStore.getState().open("head", document.body.getBoundingClientRect());

    render(<SlashMenuOverlay editor={editor} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("option", { name: "Título 1" }));

    expect(ran).toBe(true);
    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
    expect(text).toBe("BLOCO-INSERIDO");
    expect(text).not.toContain("/head");
    expect(useSlashMenuStore.getState().active).toBe(false);
  });

  it("EDT-047: clicar fora do popup fecha o menu", async () => {
    registerSlashMenuItem({ id: "test:heading_1", title: "Título 1", group: "Básico", run: () => true });

    editor = new Editor({ extensions: buildEditorExtensions(), content: docWithText("a", "/head") });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    useSlashMenuStore.getState().open("head", document.body.getBoundingClientRect());

    render(<SlashMenuOverlay editor={editor} />);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    const outsideTarget = document.createElement("div");
    document.body.appendChild(outsideTarget);
    const user = userEvent.setup();
    await user.click(outsideTarget);

    expect(useSlashMenuStore.getState().active).toBe(false);
    document.body.removeChild(outsideTarget);
  });
});
