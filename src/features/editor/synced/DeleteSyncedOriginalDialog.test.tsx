/**
 * EDT-078's confirmation dialog: hidden until `synced-actions.ts` opens it,
 * shows the real `count_synced_copies` number (never a guess), and
 * "Apagar mesmo assim" retries with `confirmed: true`.
 */
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorExtensions } from "../core/extensions";
import { DeleteSyncedOriginalDialog } from "./DeleteSyncedOriginalDialog";
import { useDeleteSyncedOriginalDialogStore } from "./delete-confirm-store";
import { markSynced, resetSyncedStoreForTests, isSynced } from "./synced-store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
let editor: Editor;

function paragraphDoc(id: string, text: string): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }] };
}

beforeEach(() => {
  resetSyncedStoreForTests();
  useDeleteSyncedOriginalDialogStore.getState().close();
});

afterEach(() => {
  editor?.destroy();
  invokeMock.mockReset();
});

describe("fechado", () => {
  it("não renderiza nada antes de requestConfirmation", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: paragraphDoc("o", "Original") });

    const { container } = render(<DeleteSyncedOriginalDialog editor={editor} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("EDT-078: aberto com a contagem real", () => {
  it("mostra o número de cópias vindo do estado, e confirmar chama delete_synced_original com confirmed:true", async () => {
    const user = userEvent.setup();
    editor = new Editor({ extensions: buildEditorExtensions(), content: paragraphDoc("o", "Original") });
    markSynced("o", "origin", "o");
    useDeleteSyncedOriginalDialogStore.getState().requestConfirmation("o", 11);
    invokeMock.mockResolvedValue(undefined);

    render(<DeleteSyncedOriginalDialog editor={editor} />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/11 cópias vinculadas/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Apagar mesmo assim" }));

    expect(invokeMock).toHaveBeenCalledWith("delete_synced_original", { id: "o", confirmed: true });
    expect(isSynced("o")).toBe(false);
  });

  it('"Cancelar" fecha sem chamar o backend', async () => {
    const user = userEvent.setup();
    editor = new Editor({ extensions: buildEditorExtensions(), content: paragraphDoc("o", "Original") });
    useDeleteSyncedOriginalDialogStore.getState().requestConfirmation("o", 3);

    render(<DeleteSyncedOriginalDialog editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useDeleteSyncedOriginalDialogStore.getState().open).toBe(false);
  });
});
