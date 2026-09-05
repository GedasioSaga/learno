/**
 * EDT-073's indicator: `buildSyncedDecorations` is tested as a pure function
 * against a real doc (built through a real `Editor`, same pattern
 * `core/commands.test.ts` uses) so it doesn't depend on a full `EditorView`
 * actually mounting in jsdom; the plugin wiring itself is exercised through
 * `refreshSyncedIndicators` against a live `Editor`, reading the plugin's
 * own state back rather than the rendered DOM (a `Decoration.widget`'s DOM
 * is opaque to `Editor.getJSON()`/`editor.state.doc`).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../core/extensions";
import { buildSyncedDecorations, syncedIndicatorPluginKey, refreshSyncedIndicators, SyncedIndicatorExtension } from "./synced-decorations";
import { markSynced, resetSyncedStoreForTests } from "./synced-store";

let editor: Editor;

function twoParagraphDoc(): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] },
      { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Oi" }] }] },
    ],
  };
}

beforeEach(() => {
  resetSyncedStoreForTests();
});

afterEach(() => {
  editor?.destroy();
});

describe("buildSyncedDecorations", () => {
  it("EDT-073: decora só o bloco cujo id está no conjunto conhecido, não o outro", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoParagraphDoc() });

    const decorations = buildSyncedDecorations(editor.state.doc, new Set(["a"]));
    const found = decorations.find();

    // Uma decoração de nó (classe) + um widget (o badge) para o bloco "a".
    expect(found.length).toBe(2);
    expect(found.every((decoration) => decoration.from <= 3)).toBe(true); // ambas dentro do primeiro wrapper (posições 0-3)
  });

  it("nenhum id conhecido -> nenhuma decoração", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoParagraphDoc() });

    expect(buildSyncedDecorations(editor.state.doc, new Set()).find()).toHaveLength(0);
  });
});

describe("o plugin de indicação, ao vivo", () => {
  it("EDT-073: refreshSyncedIndicators recalcula as decorações depois de synced-store.ts mudar por fora de uma transação", () => {
    editor = new Editor({ extensions: [...buildEditorExtensions(), SyncedIndicatorExtension], content: twoParagraphDoc() });

    expect(syncedIndicatorPluginKey.getState(editor.state)?.find()).toHaveLength(0);

    markSynced("a", "origin", "a");
    refreshSyncedIndicators(editor);

    expect(syncedIndicatorPluginKey.getState(editor.state)?.find()).toHaveLength(2);
  });
});
