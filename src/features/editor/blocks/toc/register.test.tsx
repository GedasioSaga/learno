/**
 * EDT-031: registro do bloco (round trip de persistência + item do menu "/")
 * e o painel React em si (reatividade a mudanças no doc, clique navega,
 * estado vazio) - ver `toc-tree.test.ts` para a extração/aninhamento puros.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { collectSlashMenuItems } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { TocPanel } from "./TocView";
import "./register";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function heading(id: string, level: number, text: string): JSONContent {
  return { type: "block", content: [{ type: "heading", attrs: { id, level }, content: [{ type: "text", text }] }] };
}

/** Posição do início do texto do heading `id`, achada andando pelo doc ao vivo. */
function headingPos(id: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (result !== null) return false;
    if (node.type.name === "heading" && node.attrs.id === id) {
      result = pos;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`heading "${id}" não encontrado`);
  return result;
}

function storedBlock(overrides: Partial<Block>): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    parentBlockId: null,
    blockType: "paragraph",
    content: { inline: [] },
    plainText: "",
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-031: persistência (BlockSpec)", () => {
  it("EDT-031: o bloco é um átomo - nada além da sua existência é persistido, e reabre sem conteúdo", () => {
    const stored = storedBlock({ blockType: "table_of_contents", content: {}, plainText: "" });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("tableOfContents");
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("table_of_contents");
    expect(flat.content).toEqual({});
  });

  it("EDT-031: plainText fica vazio - o texto dos títulos já é buscável nos próprios headings", () => {
    editor = createEditor({
      type: "doc",
      content: [heading("h1", 1, "Título único"), { type: "block", content: [{ type: "tableOfContents", attrs: { id: "toc" } }] }],
    });

    const [, tocFlat] = docToFlatBlocks(editor.getJSON());
    expect(tocFlat.blockType).toBe("table_of_contents");
    expect(tocFlat.plainText).toBe("");
  });

  it("EDT-031: aparece no menu \"/\" no grupo Avançado", () => {
    const item = collectSlashMenuItems().find((entry) => entry.id === "blocks:table_of_contents");
    expect(item).toBeDefined();
    expect(item?.group).toBe("Avançado");
    expect(item?.title).toBe("Sumário");
  });

  it("EDT-031: escolher o item do menu \"/\" insere de fato o bloco tableOfContents", () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    editor.commands.setTextSelection(2);
    const item = collectSlashMenuItems().find((entry) => entry.id === "blocks:table_of_contents");

    const ran = item?.run(editor);

    expect(ran).toBe(true);
    expect(editor.getJSON().content?.[0]?.content?.[0]?.type).toBe("tableOfContents");
  });
});

describe("EDT-031: painel - lista, navegação por clique e estado vazio", () => {
  it("EDT-031: mostra os títulos existentes ao montar", async () => {
    editor = createEditor({
      type: "doc",
      content: [heading("h1", 1, "Introdução"), heading("h2", 2, "Detalhes")],
    });

    render(<TocPanel editor={editor} />);

    expect(await screen.findByRole("button", { name: "Introdução" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Detalhes" })).toBeInTheDocument();
  });

  it("EDT-031: sem heading nenhum, o bloco explica em vez de mostrar uma lista vazia", () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });

    render(<TocPanel editor={editor} />);

    expect(screen.getByText(/ainda não tem títulos/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("EDT-031: adicionar um heading em qualquer lugar do doc atualiza a lista sem recarregar o bloco", async () => {
    editor = createEditor({ type: "doc", content: [heading("h1", 1, "Único título")] });
    render(<TocPanel editor={editor} />);
    expect(await screen.findByRole("button", { name: "Único título" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Novo título" })).not.toBeInTheDocument();

    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, heading("h2", 2, "Novo título"));
    });

    expect(await screen.findByRole("button", { name: "Novo título" })).toBeInTheDocument();
  });

  it("EDT-031: remover o único heading da página troca a lista pelo estado vazio", async () => {
    editor = createEditor({ type: "doc", content: [heading("h1", 1, "Vai sumir"), { type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    render(<TocPanel editor={editor} />);
    expect(await screen.findByRole("button", { name: "Vai sumir" })).toBeInTheDocument();

    act(() => {
      // Apaga o wrapper inteiro do heading (2 posições: entra no wrapper, entra no conteúdo).
      const from = 0;
      const to = editor.state.doc.child(0).nodeSize;
      editor.commands.deleteRange({ from, to });
    });

    expect(await screen.findByText(/ainda não tem títulos/)).toBeInTheDocument();
  });

  it("EDT-031: clicar num item move a seleção para o heading correspondente pelo id, não pelo texto", async () => {
    const user = userEvent.setup();
    editor = createEditor({
      type: "doc",
      // Dois headings com o mesmo texto - só o id distingue qual é qual.
      content: [heading("h1", 1, "Repetido"), heading("h2", 1, "Repetido")],
    });
    render(<TocPanel editor={editor} />);
    const buttons = await screen.findAllByRole("button", { name: "Repetido" });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[1]);

    const secondPos = headingPos("h2");
    expect(editor.state.selection.from).toBe(secondPos + 1);
    expect(editor.state.selection.$from.parent.attrs.id).toBe("h2");
  });

  it("EDT-031: aninha visualmente H2 sob H1 numa lista de verdade (<ul> dentro de <li>), navegável por teclado", async () => {
    editor = createEditor({
      type: "doc",
      content: [heading("h1", 1, "Capítulo"), heading("h2", 2, "Seção")],
    });
    render(<TocPanel editor={editor} />);

    const topLevelButton = await screen.findByRole("button", { name: "Capítulo" });
    const nestedButton = screen.getByRole("button", { name: "Seção" });
    // "Seção" está dentro do <li> de "Capítulo" - aninhamento real do DOM,
    // não uma margem calculada a partir de um número de nível.
    const topLevelItem = topLevelButton.closest("li");
    expect(topLevelItem).not.toBeNull();
    expect(topLevelItem?.contains(nestedButton)).toBe(true);
    // <button> nativo: focável e acionável por teclado sem ARIA extra.
    expect(nestedButton.tagName).toBe("BUTTON");
  });
});
