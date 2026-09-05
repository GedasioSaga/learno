/**
 * EDT-040/041: prova de que aplicar cor de texto e cor de fundo sobrevive ao
 * round trip de salvar/abrir - a parte "persiste ao desfocar" do critério,
 * que uma marca comum ganha de graça (ver comentário em `register.ts`), mas
 * que vale provar em vez de assumir. `ColorMenuButton.test.tsx` cobre a
 * interação de UI; este arquivo cobre só o dado.
 */
import { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
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

function selectWord() {
  // "Olá" - posição 2 é o início do texto dentro do parágrafo (doc(1) > block(1) > paragraph(1) > texto).
  editor.commands.setTextSelection({ from: 2, to: 5 });
}

function storedBlockFor(id: string, blockType: string, content: Block["content"], plainText: string): Block {
  return {
    id,
    pageId: "page-1",
    parentBlockId: null,
    blockType,
    content,
    plainText,
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
  };
}

beforeEach(() => {
  editor = createEditor();
});

describe("EDT-040: cor de texto inline", () => {
  it("aplicar 'Vermelho' muda a cor da fonte no texto selecionado", () => {
    selectWord();
    const applied = editor.commands.setColor("#b3261e");
    expect(applied).toBe(true);

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle");
    expect(mark?.attrs.color).toBe("#b3261e");
  });

  it("persiste ao desfocar: sobrevive ao round trip doc -> Block[] -> doc", () => {
    selectWord();
    editor.commands.setColor("#b3261e");

    const [flat] = docToFlatBlocks(editor.getJSON());
    expect(flat.content).toMatchObject({
      inline: [
        { type: "text", text: "Olá", marks: [{ type: "textStyle", attrs: { color: "#b3261e" } }] },
        { type: "text", text: " mundo" },
      ],
    });

    // Reabrir: um `Block` guardado com essa marca reconstrói o doc com ela intacta.
    const reopened = blocksToDoc([storedBlockFor("p1", "paragraph", flat.content, flat.plainText)]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "textStyle", attrs: { color: "#b3261e" } });
  });

  it("'Remover cor' tira a marca de novo", () => {
    selectWord();
    editor.commands.setColor("#b3261e");
    editor.commands.unsetColor();

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle" && m.attrs.color);
    expect(mark).toBeUndefined();
  });
});

describe("EDT-041: cor de fundo (highlight) inline", () => {
  it("aplicar 'Amarelo background' é uma marca diferente de EDT-040, não a mesma renomeada", () => {
    selectWord();
    editor.commands.setHighlight({ color: "#eab30866" });

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    const highlightMark = marks.find((m) => m.type.name === "highlight");
    expect(highlightMark?.attrs.color).toBe("#eab30866");
    // A marca de cor de texto continua ausente - as duas nunca colapsam numa só.
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color)).toBe(false);
  });

  it("cor de texto e cor de fundo combinam no mesmo trecho", () => {
    selectWord();
    editor.commands.setColor("#b3261e");
    editor.commands.setHighlight({ color: "#eab30866" });

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color === "#b3261e")).toBe(true);
    expect(marks.some((m) => m.type.name === "highlight" && m.attrs.color === "#eab30866")).toBe(true);
  });

  it("persiste ao desfocar: sobrevive ao round trip doc -> Block[] -> doc", () => {
    selectWord();
    editor.commands.setHighlight({ color: "#eab30866" });

    const [flat] = docToFlatBlocks(editor.getJSON());
    const reopened = blocksToDoc([storedBlockFor("p1", "paragraph", flat.content, flat.plainText)]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "highlight", attrs: { color: "#eab30866" } });
  });

  it("'Remover destaque' tira a marca de novo", () => {
    selectWord();
    editor.commands.setHighlight({ color: "#eab30866" });
    editor.commands.unsetHighlight();

    const highlightMark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "highlight");
    expect(highlightMark).toBeUndefined();
  });
});
