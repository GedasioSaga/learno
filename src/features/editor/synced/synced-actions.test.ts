/**
 * EDT-073/076/077/078 exercised through `synced-actions.ts`'s public
 * functions - each one drives a real `Editor`/selection (never calls
 * `synced-store.ts` directly to fake state the action itself is supposed to
 * produce) and mocks only `@tauri-apps/api/core`'s `invoke`, the same
 * convention `synced-blocks-api.test.ts` and
 * `src/features/pages/PageWorkspace.test.tsx` use.
 */
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorExtensions } from "../core/extensions";
import { useDeleteSyncedOriginalDialogStore } from "./delete-confirm-store";
import {
  confirmDeleteSyncedOriginal,
  copyCurrentSyncedOriginToClipboard,
  currentBlockSyncedRole,
  isCurrentBlockSyncedOrigin,
  markCurrentBlockAsSyncedOrigin,
  pasteSyncedCopyAtCursor,
  pasteSyncedCopyFromClipboard,
  requestDeleteSyncedOriginal,
  unsyncAllCopiesOfCurrentOrigin,
  unsyncCurrentBlock,
} from "./synced-actions";
import { useSyncedClipboardStore } from "./synced-clipboard-store";
import { markSynced, resetSyncedStoreForTests, roleOf, isSynced } from "./synced-store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
let editor: Editor;

function twoBlockDoc(idA: string, textA: string, idB: string, textB: string): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "block", content: [{ type: "paragraph", attrs: { id: idA }, content: [{ type: "text", text: textA }] }] },
      { type: "block", content: [{ type: "paragraph", attrs: { id: idB }, content: [{ type: "text", text: textB }] }] },
    ],
  };
}

function startOfBlock(id: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node, pos) => {
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
// branch) - pointless friction for a test that only wants each wrapper's
// own id. Same workaround `core/commands.test.ts` uses.
function json(): JSONContent {
  return editor.getJSON();
}

function blockIds(): (string | undefined)[] {
  return json().content?.map((wrapper) => wrapper.content?.[0]?.attrs?.id) ?? [];
}

function block(overrides: Record<string, unknown> & { id: string }) {
  return {
    pageId: "page-1",
    parentBlockId: null,
    blockType: "paragraph",
    content: { inline: [{ type: "text", text: "" }] },
    plainText: "",
    syncedSourceId: null,
    position: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetSyncedStoreForTests();
  useDeleteSyncedOriginalDialogStore.getState().close();
  useSyncedClipboardStore.getState().clear();
});

afterEach(() => {
  editor?.destroy();
  invokeMock.mockReset();
});

describe("EDT-073: Turn into > Bloco sincronizado", () => {
  it("marca o bloco sob o cursor como origem e liga o indicador de isActive", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("a", "Olá", "b", "Oi") });
    editor.commands.setTextSelection(startOfBlock("a"));

    expect(isCurrentBlockSyncedOrigin(editor)).toBe(false);
    expect(markCurrentBlockAsSyncedOrigin(editor)).toBe(true);

    expect(roleOf("a")).toBe("origin");
    expect(isCurrentBlockSyncedOrigin(editor)).toBe(true);
    // O outro bloco não foi tocado.
    editor.commands.setTextSelection(startOfBlock("b"));
    expect(isCurrentBlockSyncedOrigin(editor)).toBe(false);
  });

  it("não chama o backend - origem não tem campo próprio até existir uma cópia", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("a", "Olá", "b", "Oi") });
    editor.commands.setTextSelection(startOfBlock("a"));

    markCurrentBlockAsSyncedOrigin(editor);

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("EDT-073: pasteSyncedCopyAtCursor", () => {
  it("cria a cópia via create_synced_block_copy e insere seu conteúdo logo após o bloco sob o cursor", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("anchor", "Âncora", "outro", "Depois") });
    editor.commands.setTextSelection(startOfBlock("anchor"));

    invokeMock.mockResolvedValue(
      block({
        id: "copy-x",
        content: { inline: [{ type: "text", text: "Conteúdo copiado" }] },
        plainText: "Conteúdo copiado",
        syncedSourceId: "origin-1",
      }),
    );

    const created = await pasteSyncedCopyAtCursor(editor, "origin-1", "page-1");

    expect(created).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("create_synced_block_copy", {
      sourceId: "origin-1",
      placement: { pageId: "page-1", parentBlockId: null, afterBlockId: "anchor" },
    });
    expect(blockIds()).toEqual(["anchor", "copy-x", "outro"]);
    expect(roleOf("copy-x")).toBe("copy");
    expect(isSynced("copy-x")).toBe(true);
  });
});

describe("EDT-073: copyCurrentSyncedOriginToClipboard / pasteSyncedCopyFromClipboard", () => {
  it("Copiar num bloco origem grava o id no clipboard; num bloco comum ou numa cópia, não faz nada", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "solto", "Livre") });
    markSynced("o", "origin", "o");

    editor.commands.setTextSelection(startOfBlock("solto"));
    expect(copyCurrentSyncedOriginToClipboard(editor)).toBe(false);
    expect(useSyncedClipboardStore.getState().sourceId).toBeNull();

    editor.commands.setTextSelection(startOfBlock("o"));
    expect(copyCurrentSyncedOriginToClipboard(editor)).toBe(true);
    expect(useSyncedClipboardStore.getState().sourceId).toBe("o");
  });

  it("sem nada copiado ainda, mesmo com uma página aberta (pageIdOf não-null), não chama o backend", async () => {
    editor = new Editor({ extensions: buildEditorExtensions({ pageId: "page-1" }), content: twoBlockDoc("anchor", "Âncora", "outro", "Depois") });
    editor.commands.setTextSelection(startOfBlock("anchor"));

    expect(await pasteSyncedCopyFromClipboard(editor)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("com algo copiado mas pageIdOf(editor) retornando null (nenhuma página aberta), não chama o backend e não quebra", async () => {
    // `buildEditorExtensions()` sem `pageId` é o mesmo editor "sem página
    // aberta" que `page-context.ts` documenta - `PageContext` nasce com
    // `pageId: null` e `pageIdOf` devolve `null`.
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("anchor", "Âncora", "outro", "Depois") });
    editor.commands.setTextSelection(startOfBlock("anchor"));
    useSyncedClipboardStore.getState().copy("origin-1");

    expect(await pasteSyncedCopyFromClipboard(editor)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("com um id copiado e uma página aberta, resolve pageId de pageIdOf(editor) e cola via pasteSyncedCopyAtCursor", async () => {
    editor = new Editor({ extensions: buildEditorExtensions({ pageId: "page-42" }), content: twoBlockDoc("anchor", "Âncora", "outro", "Depois") });
    editor.commands.setTextSelection(startOfBlock("anchor"));
    useSyncedClipboardStore.getState().copy("origin-1");
    invokeMock.mockResolvedValue(
      block({
        id: "copy-x",
        content: { inline: [{ type: "text", text: "Conteúdo copiado" }] },
        plainText: "Conteúdo copiado",
        syncedSourceId: "origin-1",
      }),
    );

    const result = await pasteSyncedCopyFromClipboard(editor);

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("create_synced_block_copy", {
      sourceId: "origin-1",
      placement: { pageId: "page-42", parentBlockId: null, afterBlockId: "anchor" },
    });
    expect(roleOf("copy-x")).toBe("copy");
  });
});

describe("EDT-076: unsyncCurrentBlock", () => {
  it("desvincula a cópia sob o cursor via unsync_block e some do cache local", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "c", "Cópia") });
    markSynced("o", "origin", "o");
    markSynced("c", "copy", "o");
    editor.commands.setTextSelection(startOfBlock("c"));
    invokeMock.mockResolvedValue(block({ id: "c", syncedSourceId: null }));

    const result = await unsyncCurrentBlock(editor);

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("unsync_block", { id: "c" });
    expect(isSynced("c")).toBe(false);
    expect(isSynced("o")).toBe(true); // o original e outras cópias não são afetados
  });

  it("não faz nada num bloco que não é uma cópia conhecida", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "c", "Cópia") });
    markSynced("o", "origin", "o");
    editor.commands.setTextSelection(startOfBlock("o")); // é a origem, não uma cópia

    const result = await unsyncCurrentBlock(editor);

    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("EDT-077: unsyncAllCopiesOfCurrentOrigin", () => {
  it("desvincula todas as cópias do grupo via unsync_all_synced_copies", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "c1", "Cópia 1") });
    markSynced("o", "origin", "o");
    markSynced("c1", "copy", "o");
    markSynced("c2", "copy", "o"); // cópia noutra página, nem precisa estar neste doc
    editor.commands.setTextSelection(startOfBlock("o"));
    invokeMock.mockResolvedValue([block({ id: "c1", syncedSourceId: null }), block({ id: "c2", syncedSourceId: null })]);

    const result = await unsyncAllCopiesOfCurrentOrigin(editor);

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("unsync_all_synced_copies", { id: "o" });
    expect(isSynced("o")).toBe(false);
    expect(isSynced("c1")).toBe(false);
    expect(isSynced("c2")).toBe(false);
  });
});

describe("EDT-078: apagar o original com aviso", () => {
  it("apaga direto quando o backend aceita sem confirmação, removendo o nó do doc aberto", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "outro", "Fica") });
    markSynced("o", "origin", "o");
    editor.commands.setTextSelection(startOfBlock("o"));
    invokeMock.mockResolvedValue(undefined);

    await requestDeleteSyncedOriginal(editor);

    expect(invokeMock).toHaveBeenCalledWith("delete_synced_original", { id: "o", confirmed: false });
    expect(isSynced("o")).toBe(false);
    expect(blockIds()).toEqual(["outro"]);
    expect(useDeleteSyncedOriginalDialogStore.getState().open).toBe(false);
  });

  it("acima do limiar, abre o diálogo com a contagem real (não a extraída da mensagem de erro)", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "outro", "Fica") });
    markSynced("o", "origin", "o");
    editor.commands.setTextSelection(startOfBlock("o"));
    invokeMock
      .mockRejectedValueOnce({ kind: "invalid", message: "o bloco original tem 11 cópias vinculadas; confirme a exclusão" })
      .mockResolvedValueOnce(11); // count_synced_copies

    await requestDeleteSyncedOriginal(editor);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "delete_synced_original", { id: "o", confirmed: false });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "count_synced_copies", { id: "o" });
    const dialog = useDeleteSyncedOriginalDialogStore.getState();
    expect(dialog.open).toBe(true);
    expect(dialog.blockId).toBe("o");
    expect(dialog.copyCount).toBe(11);
    // Nada foi apagado do doc ainda - só o aviso está de pé.
    expect(blockIds()).toEqual(["o", "outro"]);
  });

  it("confirmDeleteSyncedOriginal reenvia com confirmed:true e fecha o diálogo ao suceder", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "outro", "Fica") });
    markSynced("o", "origin", "o");
    useDeleteSyncedOriginalDialogStore.getState().requestConfirmation("o", 11);
    invokeMock.mockResolvedValue(undefined);

    await confirmDeleteSyncedOriginal(editor);

    expect(invokeMock).toHaveBeenCalledWith("delete_synced_original", { id: "o", confirmed: true });
    expect(isSynced("o")).toBe(false);
    expect(blockIds()).toEqual(["outro"]);
    expect(useDeleteSyncedOriginalDialogStore.getState().open).toBe(false);
  });

  it("um segundo erro na confirmação fica visível no diálogo em vez de fechar silenciosamente", async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "outro", "Fica") });
    useDeleteSyncedOriginalDialogStore.getState().requestConfirmation("o", 11);
    invokeMock.mockRejectedValue({ kind: "database", message: "conexão perdida" });

    await confirmDeleteSyncedOriginal(editor);

    const dialog = useDeleteSyncedOriginalDialogStore.getState();
    expect(dialog.open).toBe(true);
    expect(dialog.pending).toBe(false);
    expect(dialog.errorMessage).toContain("conexão perdida");
  });
});

describe("currentBlockSyncedRole", () => {
  it("reflete origin/copy/null conforme o cache local", () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: twoBlockDoc("o", "Original", "solto", "Livre") });
    markSynced("o", "origin", "o");

    editor.commands.setTextSelection(startOfBlock("o"));
    expect(currentBlockSyncedRole(editor)).toBe("origin");

    editor.commands.setTextSelection(startOfBlock("solto"));
    expect(currentBlockSyncedRole(editor)).toBeNull();
  });
});
