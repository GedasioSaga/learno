/**
 * `register.ts`'s own contract: importing it (the same way
 * `core/discover-extensions.ts`'s glob would) puts every EDT-073..078 entry
 * point on the shared registries `block-spec.ts` exposes, and the "Turn
 * into" item actually flips the block under the cursor's synced role - not
 * just that a function of the right shape got handed to `registerTurnIntoItem`.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectEditorOverlays, collectFormattingMenuItems, collectSlashMenuItems, collectTurnIntoItems } from "../core/block-spec";
import { buildEditorExtensions } from "../core/extensions";
import { resetSyncedStoreForTests, roleOf } from "./synced-store";
// Side-effect import: registers everything in this folder, the same way
// `discover-extensions.ts`'s glob would in the running app.
import "./register";

let editor: Editor;

function paragraphDoc(id: string, text: string): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }] };
}

beforeEach(() => {
  resetSyncedStoreForTests();
});

afterEach(() => {
  editor?.destroy();
});

describe("EDT-073: registro do 'Turn into > Bloco sincronizado'", () => {
  it("aparece na lista de Turn Into e converte o bloco sob o cursor", () => {
    expect(collectTurnIntoItems().some((item) => item.id === "synced:turn-into")).toBe(true);

    editor = new Editor({ extensions: buildEditorExtensions(), content: paragraphDoc("a", "Olá") });
    editor.commands.setTextSelection(2);

    const item = collectTurnIntoItems().find((entry) => entry.id === "synced:turn-into");
    expect(item?.run(editor)).toBe(true);
    expect(roleOf("a")).toBe("origin");
    expect(item?.isActive?.(editor)).toBe(true);
  });
});

describe("EDT-076/077/078: registro dos controles e do diálogo", () => {
  it("os controles e o diálogo de confirmação estão registrados", () => {
    expect(collectFormattingMenuItems().some((item) => item.id === "synced:controls")).toBe(true);
    expect(collectEditorOverlays().some((overlay) => overlay.id === "synced:delete-confirm-dialog")).toBe(true);
  });
});

describe("EDT-073/074: registro do '/' \"Colar cópia sincronizada\"", () => {
  it("aparece na lista de itens do menu '/'", () => {
    const item = collectSlashMenuItems().find((entry) => entry.id === "synced:paste-copy");
    expect(item?.title).toBe("Colar cópia sincronizada");
    expect(item?.group).toBe("Sincronizado");
  });
});
