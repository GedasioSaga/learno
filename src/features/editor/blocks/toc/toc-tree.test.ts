import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { buildTocTree, collectHeadings } from "./toc-tree";
import "./register";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function heading(id: string, level: number, text: string): JSONContent {
  return { type: "block", content: [{ type: "heading", attrs: { id, level }, content: [{ type: "text", text }] }] };
}

function paragraph(id: string, text = ""): JSONContent {
  return {
    type: "block",
    content: [{ type: "paragraph", attrs: { id }, content: text ? [{ type: "text", text }] : undefined }],
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-031: extração de títulos e montagem da árvore", () => {
  it("EDT-031: coleta H1/H2/H3 em ordem de documento, ignorando parágrafos", () => {
    editor = createEditor({
      type: "doc",
      content: [heading("h1", 1, "Introdução"), paragraph("p1", "texto"), heading("h2", 2, "Detalhes")],
    });

    const headings = collectHeadings(editor.state.doc);

    expect(headings).toEqual([
      { id: "h1", level: 1, text: "Introdução" },
      { id: "h2", level: 2, text: "Detalhes" },
    ]);
  });

  it("EDT-031: aninha H2 sob o H1 anterior e H3 sob esse H2 - indentação semântica por nível", () => {
    editor = createEditor({
      type: "doc",
      content: [
        heading("h1", 1, "Capítulo 1"),
        heading("h2a", 2, "Seção 1.1"),
        heading("h3", 3, "Subseção 1.1.1"),
        heading("h2b", 2, "Seção 1.2"),
        heading("h1b", 1, "Capítulo 2"),
      ],
    });

    const tree = buildTocTree(collectHeadings(editor.state.doc));

    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe("h1");
    expect(tree[0].children.map((c) => c.id)).toEqual(["h2a", "h2b"]);
    expect(tree[0].children[0].children.map((c) => c.id)).toEqual(["h3"]);
    expect(tree[1].id).toBe("h1b");
    expect(tree[1].children).toHaveLength(0);
  });

  it("EDT-031: um salto de nível (H1 direto para H3) aninha sob o ancestral aberto mais próximo em vez de quebrar", () => {
    editor = createEditor({
      type: "doc",
      content: [heading("h1", 1, "Título"), heading("h3", 3, "Detalhe fundo")],
    });

    const tree = buildTocTree(collectHeadings(editor.state.doc));

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.id)).toEqual(["h3"]);
  });

  it("EDT-031: sem heading nenhum, a árvore fica vazia (alimenta o estado vazio do bloco)", () => {
    editor = createEditor({ type: "doc", content: [paragraph("p1", "só texto")] });

    expect(buildTocTree(collectHeadings(editor.state.doc))).toEqual([]);
  });

  it("EDT-031: um heading sem id (doc malformado) é ignorado em vez de quebrar a navegação", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Sem id" }] }] }],
    });

    expect(collectHeadings(editor.state.doc)).toEqual([]);
  });
});
