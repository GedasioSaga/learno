/**
 * The toolbar buttons' own contract (EDT-076/077/078), separate from
 * `synced-actions.test.ts`'s direct calls: exercised through a real click on
 * a real `<button>`, the same pattern `marks/basic/formatting-buttons.test.tsx`
 * uses for its own toolbar buttons.
 */
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorExtensions } from "../core/extensions";
import { renderSyncedControls } from "./SyncedControls";
import { useSyncedClipboardStore } from "./synced-clipboard-store";
import { markSynced, resetSyncedStoreForTests } from "./synced-store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
let editor: Editor;

function paragraphDoc(id: string, text: string): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }] };
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

beforeEach(() => {
  resetSyncedStoreForTests();
  useSyncedClipboardStore.getState().clear();
});

afterEach(() => {
  editor?.destroy();
  invokeMock.mockReset();
});

describe("bloco sem papel sincronizado", () => {
  it("não renderiza controle nenhum", () => {
    editor = createEditor(paragraphDoc("a", "Solto"));
    editor.commands.setTextSelection(2);

    const { container } = render(<>{renderSyncedControls(editor)}</>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("EDT-076: bloco copy", () => {
  it('mostra "Desvincular esta cópia" e clicar chama unsync_block', async () => {
    const user = userEvent.setup();
    editor = createEditor(paragraphDoc("c", "Cópia"));
    markSynced("o", "origin", "o");
    markSynced("c", "copy", "o");
    editor.commands.setTextSelection(2);
    invokeMock.mockResolvedValue({ id: "c", syncedSourceId: null });

    render(
      <>
        <EditorContent editor={editor} />
        {renderSyncedControls(editor)}
      </>,
    );

    const button = screen.getByRole("button", { name: "Desvincular esta cópia" });
    await user.click(button);

    expect(invokeMock).toHaveBeenCalledWith("unsync_block", { id: "c" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Desvincular esta cópia" })).not.toBeInTheDocument());
  });
});

describe("EDT-077/078: bloco origin", () => {
  it('mostra "Desvincular todas" e "Apagar", cada um chamando o comando certo', async () => {
    const user = userEvent.setup();
    editor = createEditor(paragraphDoc("o", "Original"));
    markSynced("o", "origin", "o");
    editor.commands.setTextSelection(2);
    invokeMock.mockResolvedValue(undefined);

    render(
      <>
        <EditorContent editor={editor} />
        {renderSyncedControls(editor)}
      </>,
    );

    expect(screen.getByRole("button", { name: "Desvincular todas as cópias" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Apagar bloco sincronizado" }));

    expect(invokeMock).toHaveBeenCalledWith("delete_synced_original", { id: "o", confirmed: false });
  });

  it('EDT-073: "Copiar" grava o id do bloco no clipboard sem chamar o backend', async () => {
    const user = userEvent.setup();
    editor = createEditor(paragraphDoc("o", "Original"));
    markSynced("o", "origin", "o");
    editor.commands.setTextSelection(2);

    render(
      <>
        <EditorContent editor={editor} />
        {renderSyncedControls(editor)}
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Copiar bloco sincronizado" }));

    expect(useSyncedClipboardStore.getState().sourceId).toBe("o");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
