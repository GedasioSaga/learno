/**
 * EDT-043: a marca em si - aplicar `setLink` no trecho selecionado e
 * sobreviver ao round trip de salvar/abrir. A interação de Ctrl/Cmd+K (abrir
 * o popup, validar, aplicar, o limite com a busca global) está em
 * `LinkOverlay.test.tsx`; este arquivo cobre só o dado, como
 * `marks/color/register.test.ts` faz para cor.
 */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** "Olá" - posição 2 é o início do texto dentro do parágrafo (doc(1) > block(1) > paragraph(1) > texto). */
function selectWord() {
  editor.commands.setTextSelection({ from: 2, to: 5 });
}

function storedBlockFor(id: string, content: Block["content"], plainText: string): Block {
  return {
    id,
    pageId: "page-1",
    parentBlockId: null,
    blockType: "paragraph",
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

afterEach(() => {
  editor.destroy();
});

describe("EDT-043: link inline", () => {
  it("EDT-043: setLink no texto selecionado vira um link clicável com o href certo", () => {
    selectWord();
    const applied = editor.commands.setLink({ href: "https://exemplo.com" });
    expect(applied).toBe(true);

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark?.attrs.href).toBe("https://exemplo.com");
  });

  it("EDT-043: o preview ao passar o mouse é o title com a URL de destino", () => {
    selectWord();
    editor.commands.setLink({ href: "https://exemplo.com", title: "https://exemplo.com" });

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark?.attrs.title).toBe("https://exemplo.com");
  });

  it("EDT-043: javascript: é rejeitado mesmo chamando o comando direto - defesa também na extensão, não só no popup", () => {
    selectWord();
    const applied = editor.commands.setLink({ href: "javascript:alert(1)" });
    expect(applied).toBe(false);

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark).toBeUndefined();
  });

  it("EDT-043: persiste ao desfocar - sobrevive ao round trip doc -> Block[] -> doc", () => {
    selectWord();
    editor.commands.setLink({ href: "https://exemplo.com", title: "https://exemplo.com" });

    const [flat] = docToFlatBlocks(editor.getJSON());
    expect(flat.content).toMatchObject({
      inline: [
        {
          type: "text",
          text: "Olá",
          marks: [{ type: "link", attrs: expect.objectContaining({ href: "https://exemplo.com" }) }],
        },
        { type: "text", text: " mundo" },
      ],
    });

    const reopened = blocksToDoc([storedBlockFor("p1", flat.content, flat.plainText)]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks?.[0]).toMatchObject({ type: "link", attrs: { href: "https://exemplo.com" } });
  });

  it("EDT-043: unsetLink tira a marca de novo", () => {
    selectWord();
    editor.commands.setLink({ href: "https://exemplo.com" });
    editor.commands.unsetLink();

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "link");
    expect(mark).toBeUndefined();
  });
});
