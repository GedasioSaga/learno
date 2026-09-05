/**
 * EDT-073/074/076/077/078 exercised through the actual registries
 * `register.ts` fills - `collectSlashMenuItems`/`collectTurnIntoItems`
 * (`item.run(editor)`, the exact call `TurnIntoMenu` and
 * `SlashMenuOverlay.tsx`'s `choose()` make) and `SyncedControls`'s buttons
 * (clicked through `@testing-library/user-event`, not called as bare
 * functions).
 *
 * `synced-actions.test.ts` already proved the internal logic works against a
 * mocked `invoke`. What was missing before this round was the other half:
 * whether a real user could ever reach the state each Given clause in
 * docs/CHECKLIST.md:155-158 assumes ("dado 3 cópias", "dado original com 5
 * cópias", "dado original com 11 cópias") - `pasteSyncedCopyAtCursor` had no
 * caller anywhere in the app (`grep -rn pasteSyncedCopyAtCursor src` turned
 * up only its own test). This file builds every precondition by walking the
 * path a user actually has now: Turn into > Bloco sincronizado, click
 * "Copiar", open `/`, choose "Colar cópia sincronizada" - never `markSynced`
 * called directly to fake a state the UI itself is supposed to produce.
 */
import { invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageId } from "../contract";
import { collectEditorOverlays, collectSlashMenuItems, collectTurnIntoItems } from "../core/block-spec";
import { buildEditorExtensions } from "../core/extensions";
import { renderSyncedControls } from "./SyncedControls";
import { useSyncedClipboardStore } from "./synced-clipboard-store";
import { isSynced, resetSyncedStoreForTests, roleOf } from "./synced-store";
// Side-effect import: registers everything in this folder, the same way
// `discover-extensions.ts`'s glob would in the running app.
import "./register";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
let editor: Editor;
let copySeq = 0;

function paragraphDoc(id: string, text: string): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }] };
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

/** What `create_synced_block_copy` would hand back - a fresh id every call, same shape `synced-actions.test.ts`'s own fixture uses. */
function nextCopyBlock(sourceId: string) {
  copySeq += 1;
  const id = `copy-${copySeq}`;
  return block({ id, syncedSourceId: sourceId, content: { inline: [{ type: "text", text: `Cópia ${copySeq}` }] }, plainText: `Cópia ${copySeq}` });
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
  if (result === null) throw new Error(`block "${id}" não encontrado no doc`);
  return result;
}

function textOf(id: string): string {
  let text = "";
  editor.state.doc.descendants((node) => {
    if (node.attrs.id === id) {
      text = node.textContent;
      return false;
    }
    return true;
  });
  return text;
}

// `Editor.getJSON()`'s declared return type recursively narrows nested
// content to `NodeType | TextType` (no `.content`/`.attrs` on the text
// branch) - pointless friction for a test that only wants each wrapper's
// own id. Same workaround `synced-actions.test.ts`/`core/commands.test.ts` use.
function json(): JSONContent {
  return editor.getJSON();
}

function blockIds(): (string | undefined)[] {
  return json().content?.map((wrapper) => wrapper.content?.[0]?.attrs?.id) ?? [];
}

/** `pageId: null` mounts a bare editor with no page open - `pageIdOf` reads `null` off it, same as `page-context.ts` documents. */
function mountEditor(content: JSONContent, pageId: PageId | null = "page-1"): void {
  editor = new Editor({ extensions: buildEditorExtensions(pageId ? { pageId } : {}), content });
}

/** The real "Turn into > Bloco sincronizado" entry, called the same way `TurnIntoMenu`'s click handler would. */
function turnCurrentIntoSyncedOrigin(): void {
  const item = collectTurnIntoItems().find((entry) => entry.id === "synced:turn-into");
  if (!item) throw new Error('TurnIntoItem "synced:turn-into" não está registrado');
  item.run(editor);
}

/** The real "Colar cópia sincronizada" `/` entry - `SlashMenuOverlay.tsx`'s `choose()` makes this exact call after clearing the query text. */
async function pasteViaSlashMenu(): Promise<void> {
  const before = invokeMock.mock.calls.length;
  const item = collectSlashMenuItems().find((entry) => entry.id === "synced:paste-copy");
  if (!item) throw new Error('SlashMenuItem "synced:paste-copy" não está registrado');
  item.run(editor);
  await waitFor(() => expect(invokeMock.mock.calls.length).toBeGreaterThan(before));
}

/** Mounts the real toolbar, clicks one of its buttons by accessible name, then unmounts - fresh each call so an earlier interaction's DOM never lingers to make a later `getByRole` ambiguous. */
async function clickSyncedControl(name: string): Promise<void> {
  const view = render(<>{renderSyncedControls(editor)}</>);
  const user = userEvent.setup();
  await user.click(view.getByRole("button", { name }));
  view.unmount();
}

/** EDT-078's two-step flow needs both buttons in the SAME mounted tree - "Apagar" opens the dialog the second click then lives inside. */
async function deleteOriginalWithConfirmation(): Promise<void> {
  const overlay = collectEditorOverlays().find((entry) => entry.id === "synced:delete-confirm-dialog");
  if (!overlay) throw new Error('EditorOverlay "synced:delete-confirm-dialog" não está registrado');
  const view = render(
    <>
      {renderSyncedControls(editor)}
      {overlay.render(editor)}
    </>,
  );
  const user = userEvent.setup();
  await user.click(view.getByRole("button", { name: "Apagar bloco sincronizado" }));
  const confirmButton = await view.findByRole("button", { name: "Apagar mesmo assim" });
  await user.click(confirmButton);
  view.unmount();
}

beforeEach(() => {
  resetSyncedStoreForTests();
  useSyncedClipboardStore.getState().clear();
  copySeq = 0;
});

afterEach(() => {
  editor?.destroy();
  invokeMock.mockReset();
});

describe("EDT-073: caminho completo de UI - origem, Copiar, colar", () => {
  it('Turn into > Bloco sincronizado + "Copiar" + "/Colar cópia sincronizada" criam uma cópia de verdade via create_synced_block_copy', async () => {
    mountEditor(paragraphDoc("origin", "Nota reutilizável"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    expect(roleOf("origin")).toBe("origin");

    await clickSyncedControl("Copiar bloco sincronizado");
    expect(useSyncedClipboardStore.getState().sourceId).toBe("origin");

    invokeMock.mockResolvedValueOnce(nextCopyBlock("origin"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    await pasteViaSlashMenu();

    expect(invokeMock).toHaveBeenCalledWith("create_synced_block_copy", {
      sourceId: "origin",
      placement: { pageId: "page-1", parentBlockId: null, afterBlockId: "origin" },
    });
    expect(blockIds()).toEqual(["origin", "copy-1"]);
    expect(roleOf("copy-1")).toBe("copy");
  });

  it('sem nada copiado ainda, "/Colar cópia sincronizada" não chama o backend', async () => {
    mountEditor(paragraphDoc("solto", "Parágrafo comum"));
    editor.commands.setTextSelection(startOfBlock("solto"));

    const item = collectSlashMenuItems().find((entry) => entry.id === "synced:paste-copy");
    item?.run(editor);
    // Dá tempo pro fire-and-forget de `register.ts` resolver antes de checar
    // "nada aconteceu" - do contrário uma falha só apareceria por acaso.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(blockIds()).toEqual(["solto"]);
  });
});

describe("EDT-073: a segunda metade do critério - copiar para OUTRA página", () => {
  it('copiar na página A e colar na página B (outro editor) usa o pageId de B, não o de A, e a cópia nasce com syncedSourceId apontando pro original', async () => {
    // Página A: declara a origem e "Copiar" - o clipboard (`synced-clipboard-store.ts`)
    // é estado de sessão do app, não o clipboard do sistema nem algo preso a
    // este editor, então sobrevive à troca de página abaixo.
    mountEditor(paragraphDoc("origin", "Nota reutilizável"), "page-a");
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");
    expect(useSyncedClipboardStore.getState().sourceId).toBe("origin");
    const editorA = editor;

    // "Abre outra página": uma segunda instância de `<Editor>`, com seu
    // próprio `pageIdOf` (`page-b`), o mesmo jeito que `PageWorkspace`
    // remonta o editor ao trocar de página.
    mountEditor(paragraphDoc("destino", "Página B"), "page-b");
    editor.commands.setTextSelection(startOfBlock("destino"));

    invokeMock.mockResolvedValueOnce(
      block({
        id: "copy-1",
        pageId: "page-b",
        syncedSourceId: "origin",
        content: { inline: [{ type: "text", text: "Nota reutilizável" }] },
        plainText: "Nota reutilizável",
      }),
    );
    await pasteViaSlashMenu();

    // (b) o pageId mandado é o da página de DESTINO (B), não o de onde a
    // origem mora (A) - o ponto que quebraria se `run` reusasse um pageId
    // congelado no momento do "Copiar".
    expect(invokeMock).toHaveBeenCalledWith("create_synced_block_copy", {
      sourceId: "origin",
      placement: { pageId: "page-b", parentBlockId: null, afterBlockId: "destino" },
    });
    expect(blockIds()).toEqual(["destino", "copy-1"]);

    // (a) a referência ao original ficou guardada - `roleOf`/`groupIdOf` são
    // o que `live-mirror-extension.ts` usa pra saber quem espelha quem.
    expect(roleOf("copy-1")).toBe("copy");

    // (d) o indicador aparece nos dois lados: a origem continua marcada em
    // A, e a cópia nova está marcada em B.
    expect(roleOf("origin")).toBe("origin");
    expect(isSynced("copy-1")).toBe(true);

    editorA.destroy();
  });

  it("com pageIdOf(editor) devolvendo null (editor sem página aberta), colar não chama o backend e não quebra", async () => {
    mountEditor(paragraphDoc("origin", "Nota reutilizável"), "page-a");
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");
    const editorA = editor;

    mountEditor(paragraphDoc("solto", "Parágrafo comum"), null);
    editor.commands.setTextSelection(startOfBlock("solto"));

    const item = collectSlashMenuItems().find((entry) => entry.id === "synced:paste-copy");
    item?.run(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(blockIds()).toEqual(["solto"]);

    editorA.destroy();
  });
});

describe("EDT-074: editar uma cópia colada pelo caminho real propaga sem refresh manual", () => {
  it("dado 3 cópias coladas via /, editar uma delas atualiza a origem e as outras 2 no mesmo doc", async () => {
    mountEditor(paragraphDoc("origin", "Nota"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");

    for (let i = 0; i < 3; i += 1) {
      invokeMock.mockResolvedValueOnce(nextCopyBlock("origin"));
      editor.commands.setTextSelection(startOfBlock("origin"));
      await pasteViaSlashMenu();
    }
    expect(blockIds()).toEqual(["origin", "copy-3", "copy-2", "copy-1"]);
    expect(["copy-1", "copy-2", "copy-3"].every((id) => isSynced(id))).toBe(true);

    // Edita "copy-2" (o mirror é client-side, `live-mirror-extension.ts`,
    // registrado por este mesmo `register.ts` - nenhuma chamada de rede
    // nova aqui, é isso que "sem refresh manual" quer dizer).
    editor.commands.setTextSelection(startOfBlock("copy-2"));
    editor.commands.insertContent("EDITADO ");

    const edited = textOf("copy-2");
    expect(edited).toContain("EDITADO");
    expect(textOf("origin")).toBe(edited);
    expect(textOf("copy-1")).toBe(edited);
    expect(textOf("copy-3")).toBe(edited);
  });
});

describe("EDT-076: unsync de uma cópia individual, colada pelo caminho real", () => {
  it("dado 3 cópias, desvincular uma na toolbar a torna independente e as outras 2 continuam sincronizadas", async () => {
    mountEditor(paragraphDoc("origin", "Nota"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");

    for (let i = 0; i < 3; i += 1) {
      invokeMock.mockResolvedValueOnce(nextCopyBlock("origin"));
      editor.commands.setTextSelection(startOfBlock("origin"));
      await pasteViaSlashMenu();
    }

    invokeMock.mockResolvedValueOnce(block({ id: "copy-2", syncedSourceId: null }));
    editor.commands.setTextSelection(startOfBlock("copy-2"));
    await clickSyncedControl("Desvincular esta cópia");

    expect(invokeMock).toHaveBeenCalledWith("unsync_block", { id: "copy-2" });
    expect(isSynced("copy-2")).toBe(false);
    expect(isSynced("copy-1")).toBe(true);
    expect(isSynced("copy-3")).toBe(true);
    expect(isSynced("origin")).toBe(true);
  });
});

describe("EDT-077: unsync all a partir do original, cujas cópias vieram do caminho real", () => {
  it("dado original com 5 cópias, 'Desvincular todas' no original desliga o grupo inteiro", async () => {
    mountEditor(paragraphDoc("origin", "Nota"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");

    const copyIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const copy = nextCopyBlock("origin");
      copyIds.push(copy.id);
      invokeMock.mockResolvedValueOnce(copy);
      editor.commands.setTextSelection(startOfBlock("origin"));
      await pasteViaSlashMenu();
    }
    expect(copyIds).toHaveLength(5);
    expect(copyIds.every((id) => isSynced(id))).toBe(true);

    invokeMock.mockResolvedValueOnce(copyIds.map((id) => block({ id, syncedSourceId: null })));
    editor.commands.setTextSelection(startOfBlock("origin"));
    await clickSyncedControl("Desvincular todas as cópias");

    expect(invokeMock).toHaveBeenCalledWith("unsync_all_synced_copies", { id: "origin" });
    expect(isSynced("origin")).toBe(false);
    expect(copyIds.every((id) => !isSynced(id))).toBe(true);
  });
});

describe("EDT-078: apagar o original com aviso, cujas cópias vieram do caminho real", () => {
  it("dado original com 11 cópias, apagar avisa a contagem real e só apaga após confirmar", async () => {
    mountEditor(paragraphDoc("origin", "Nota"));
    editor.commands.setTextSelection(startOfBlock("origin"));
    turnCurrentIntoSyncedOrigin();
    await clickSyncedControl("Copiar bloco sincronizado");

    for (let i = 0; i < 11; i += 1) {
      invokeMock.mockResolvedValueOnce(nextCopyBlock("origin"));
      editor.commands.setTextSelection(startOfBlock("origin"));
      await pasteViaSlashMenu();
    }
    expect(Array.from({ length: 11 }, (_, i) => `copy-${i + 1}`).every((id) => isSynced(id))).toBe(true);

    editor.commands.setTextSelection(startOfBlock("origin"));
    invokeMock
      .mockRejectedValueOnce({ kind: "invalid", message: "o bloco original tem 11 cópias vinculadas; confirme a exclusão" })
      .mockResolvedValueOnce(11) // count_synced_copies
      .mockResolvedValueOnce(undefined); // delete_synced_original confirmado
    // As 11 chamadas de `create_synced_block_copy` já feitas acima contam no
    // mock - os três passos do próprio apagar começam depois delas, não em 1.
    const callsBeforeDelete = invokeMock.mock.calls.length;

    await deleteOriginalWithConfirmation();

    expect(invokeMock).toHaveBeenNthCalledWith(callsBeforeDelete + 1, "delete_synced_original", { id: "origin", confirmed: false });
    expect(invokeMock).toHaveBeenNthCalledWith(callsBeforeDelete + 2, "count_synced_copies", { id: "origin" });
    expect(invokeMock).toHaveBeenNthCalledWith(callsBeforeDelete + 3, "delete_synced_original", { id: "origin", confirmed: true });
    expect(isSynced("origin")).toBe(false);
    expect(blockIds()).not.toContain("origin");
  });
});
