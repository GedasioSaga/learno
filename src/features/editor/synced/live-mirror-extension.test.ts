/**
 * EDT-074's in-session proof (see `live-mirror-extension.ts`'s header for
 * why this is the provable slice of "sem refresh manual", and what isn't
 * provable in jsdom): two blocks on the SAME open page, both known to
 * `synced-store.ts` as the same group, stay textually identical as one is
 * edited - no debounce, no round trip, exercised through a real keystroke
 * path (`editor.commands.insertContent`, which dispatches a real
 * transaction) rather than calling the plugin's internals directly.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../core/extensions";
import { findOutOfSyncSiblings, LiveMirrorExtension } from "./live-mirror-extension";
import { markSynced, resetSyncedStoreForTests } from "./synced-store";

let editor: Editor;

function twoCopyDoc(textA: string, textB: string): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: textA }] }] },
      { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: textB }] }] },
    ],
  };
}

function startOfBlock(id: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (result !== null) return false;
    if (node.attrs.id === id) {
      result = pos + 1;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`block "${id}" not found`);
  return result;
}

// `Editor.getJSON()`'s declared return type recursively narrows nested
// content to `NodeType | TextType` (no `.content`/`.attrs` on the text
// branch) - exactly right for that API, pointless friction for a test that
// just wants to walk the tree. Same workaround `core/commands.test.ts` uses.
function json(): JSONContent {
  return editor.getJSON();
}

function textOf(id: string): string {
  const wrapper = json().content?.find((w) => w.content?.[0]?.attrs?.id === id);
  return wrapper?.content?.[0]?.content?.map((n) => n.text ?? "").join("") ?? "";
}

beforeEach(() => {
  resetSyncedStoreForTests();
});

afterEach(() => {
  editor?.destroy();
});

describe("findOutOfSyncSiblings", () => {
  it("acha o irmão do mesmo grupo cujo conteúdo diverge do bloco editado", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoCopyDoc("Olá", "Oi") });
    markSynced("a", "origin", "a");
    markSynced("b", "copy", "a");

    const $from = editor.state.doc.resolve(startOfBlock("a"));
    const targets = findOutOfSyncSiblings(editor.state.doc, $from);

    expect(targets).toHaveLength(1);
  });

  it("nada diverge quando os dois já têm o mesmo conteúdo", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoCopyDoc("Olá", "Olá") });
    markSynced("a", "origin", "a");
    markSynced("b", "copy", "a");

    const $from = editor.state.doc.resolve(startOfBlock("a"));
    expect(findOutOfSyncSiblings(editor.state.doc, $from)).toHaveLength(0);
  });

  it("bloco fora de qualquer grupo conhecido não tem irmão nenhum", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoCopyDoc("Olá", "Oi") });

    const $from = editor.state.doc.resolve(startOfBlock("a"));
    expect(findOutOfSyncSiblings(editor.state.doc, $from)).toHaveLength(0);
  });
});

describe("EDT-074: propagação ao vivo, sem refresh manual", () => {
  it("editar o bloco 'a' propaga o texto pro bloco 'b' na mesma página, na mesma transação", () => {
    editor = new Editor({
      extensions: [...buildEditorExtensions(), LiveMirrorExtension],
      content: twoCopyDoc("Olá", "Olá"),
    });
    markSynced("a", "origin", "a");
    markSynced("b", "copy", "a");

    editor.commands.setTextSelection(startOfBlock("a") + 3); // fim de "Olá"
    editor.commands.insertContent(" mundo");

    expect(textOf("a")).toBe("Olá mundo");
    expect(textOf("b")).toBe("Olá mundo");
  });

  it("blocos que não estão no mesmo grupo não são tocados", () => {
    editor = new Editor({
      extensions: [...buildEditorExtensions(), LiveMirrorExtension],
      content: twoCopyDoc("Olá", "Independente"),
    });
    // "a" nunca foi marcado como sincronizado.

    editor.commands.setTextSelection(startOfBlock("a") + 3);
    editor.commands.insertContent(" mundo");

    expect(textOf("a")).toBe("Olá mundo");
    expect(textOf("b")).toBe("Independente");
  });
});
