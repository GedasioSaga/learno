/**
 * EDT-050 por teclado: mesma primitiva de movimento, origem/destino vindos
 * do cursor em vez de um id solto por um evento de drop.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { moveBlockAmongSiblings } from "./keyboard-move";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

// `getJSON()`'s declared return type recursively narrows nested content to
// `NodeType | TextType` (sem `.content`/`.attrs` no ramo de texto) - exatamente
// o motivo que o comentário de `core/commands.test.ts`'s `json()` documenta.
// `JSONContent` é a forma solta que este arquivo só quer pra andar na árvore.
function json(): JSONContent {
  return editor.getJSON();
}

function topLevelIds(): (string | undefined)[] {
  return (json().content ?? []).map((wrapper) => wrapper.content?.[0]?.attrs?.id as string | undefined);
}

/** Posição do início do texto do bloco `blockId` - igual ao helper de `core/commands.test.ts`, achado no doc em vez de calculado à mão. */
function startOfBlock(blockId: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (result !== null) return false;
    if (node.attrs.id === blockId) {
      result = pos + 1;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado`);
  return result;
}

function paragraph(id: string, text: string): JSONContent {
  return { type: "paragraph", attrs: { id }, content: [{ type: "text", text }] };
}

function block(contentNode: JSONContent): JSONContent {
  return { type: "block", content: [contentNode] };
}

afterEach(() => {
  editor?.destroy();
});

describe("moveBlockAmongSiblings", () => {
  it("EDT-050: Ctrl+Shift+Baixo troca o bloco com o irmão seguinte", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B")), block(paragraph("c", "C"))],
    });
    editor.commands.setTextSelection(startOfBlock("a"));

    const applied = moveBlockAmongSiblings(editor, "down");

    expect(applied).toBe(true);
    expect(topLevelIds()).toEqual(["b", "a", "c"]);
  });

  it("EDT-050: Ctrl+Shift+Cima troca o bloco com o irmão anterior", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B")), block(paragraph("c", "C"))],
    });
    editor.commands.setTextSelection(startOfBlock("c"));

    const applied = moveBlockAmongSiblings(editor, "up");

    expect(applied).toBe(true);
    expect(topLevelIds()).toEqual(["a", "c", "b"]);
  });

  it("no-op: mover pra cima o primeiro bloco não tem irmão anterior", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B"))],
    });
    editor.commands.setTextSelection(startOfBlock("a"));

    expect(moveBlockAmongSiblings(editor, "up")).toBe(false);
    expect(topLevelIds()).toEqual(["a", "b"]);
  });

  it("no-op: mover pra baixo o último bloco não tem irmão seguinte", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B"))],
    });
    editor.commands.setTextSelection(startOfBlock("b"));

    expect(moveBlockAmongSiblings(editor, "down")).toBe(false);
    expect(topLevelIds()).toEqual(["a", "b"]);
  });
});
