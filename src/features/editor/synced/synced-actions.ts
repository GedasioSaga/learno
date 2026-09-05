/**
 * The operations this builder wires to UI (EDT-073/074/076/077/078): thin
 * glue between `core/commands.ts`'s primitives, `synced-blocks-api.ts`'s IPC
 * calls and `synced-store.ts`'s client-side cache, kept in one place so
 * `SyncedControls.tsx`/`register.ts` never touch either directly.
 *
 * `pasteSyncedCopyAtCursor` takes `pageId` as an explicit parameter rather
 * than discovering it itself, since it has no `editor` of its own to read a
 * page out of at the call site that matters (`pasteSyncedCopyFromClipboard`
 * below resolves it before calling in). That caller *does* have the editor
 * TipTap handed it, so it reads the page straight off the instance with
 * `pageIdOf` (`core/page-context.ts`) rather than reaching into
 * `usePageTreeStore` the way `blocks/page-link/register.ts` does for its own,
 * different need (the whole page tree, to resolve titles and reparent) -
 * `pageIdOf` is the direct channel `core` added this session for exactly
 * this "which page is *this* editor showing" question, and keeps `synced/`
 * dependent on nothing outside `core/` and `contract.ts`, same as
 * `synced-blocks-api.ts`. `pageIdOf` can return `null` (no page open, or a
 * test-built bare editor) - `pasteSyncedCopyFromClipboard` treats that the
 * same as "nothing copied yet": no call, no throw.
 */
import type { Editor } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import type { Block, BlockId, PageId } from "../contract";
import { contentDepthOf, currentBlockNode } from "../core/commands";
import { NODE_NAMES } from "../core/node-names";
import { pageIdOf } from "../core/page-context";
import { blocksToDoc } from "../core/serialize";
import { useDeleteSyncedOriginalDialogStore } from "./delete-confirm-store";
import { refreshSyncedIndicators } from "./synced-decorations";
import {
  SyncedBlockError,
  countSyncedCopies,
  createSyncedBlockCopy,
  deleteSyncedOriginal,
  unsyncAllSyncedCopies,
  unsyncBlock,
} from "./synced-blocks-api";
import { useSyncedClipboardStore } from "./synced-clipboard-store";
import { groupIdOf, markSynced, roleOf, setCachedCopyCount, unmarkGroup, unmarkSynced, type SyncedRole } from "./synced-store";

function currentBlockId(editor: Editor): BlockId | null {
  const id = currentBlockNode(editor)?.attrs.id;
  return typeof id === "string" ? id : null;
}

/**
 * EDT-073: "Turn into > Bloco sincronizado" - declares the block under the
 * cursor a synced origin. No backend call: an origin has no field of its
 * own in `contract.ts` (a `Block` only ever carries `syncedSourceId`, set
 * on a *copy* pointing back at one), so there is nothing to persist
 * server-side until the first copy actually exists - `create_synced_block_copy`
 * sets that up on its own, atomically, the moment a copy is pasted.
 */
export function markCurrentBlockAsSyncedOrigin(editor: Editor): boolean {
  const id = currentBlockId(editor);
  if (!id) return false;
  markSynced(id, "origin", id);
  refreshSyncedIndicators(editor);
  return true;
}

export function isCurrentBlockSyncedOrigin(editor: Editor): boolean {
  const id = currentBlockId(editor);
  return id !== null && roleOf(id) === "origin";
}

/** What `SyncedControls.tsx` reads to decide which buttons to show for the block under the cursor. */
export function currentBlockSyncedRole(editor: Editor): SyncedRole | null {
  const id = currentBlockId(editor);
  return id ? roleOf(id) : null;
}

/** EDT-076: detaches only the copy under the cursor, leaving its current content as its own and every other member of the group untouched. */
export async function unsyncCurrentBlock(editor: Editor): Promise<boolean> {
  const id = currentBlockId(editor);
  if (!id || roleOf(id) !== "copy") return false;
  await unsyncBlock(id);
  unmarkSynced(id);
  refreshSyncedIndicators(editor);
  return true;
}

/** EDT-077: detaches every copy of the origin under the cursor at once. */
export async function unsyncAllCopiesOfCurrentOrigin(editor: Editor): Promise<boolean> {
  const id = currentBlockId(editor);
  if (!id || roleOf(id) !== "origin") return false;
  await unsyncAllSyncedCopies(id);
  unmarkGroup(id);
  refreshSyncedIndicators(editor);
  return true;
}

/** Every `Block` id in `synced-store.ts` is a `blockContent` node's own `id` attr (`schema.ts`'s `idAttribute`) - this finds that node's `Block` wrapper (the thing actually removable as a unit) by walking the doc for it. */
function findBlockWrapper(editor: Editor, blockId: BlockId): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === NODE_NAMES.block && node.firstChild?.attrs.id === blockId) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * After `delete_synced_original` succeeds, the origin's row (and its
 * copies') is gone from Postgres - leaving its node visible in the doc
 * would show a block nothing backs any more, so this removes it from
 * whichever page is currently open (if the origin itself is the one on
 * screen; a copy that lived only on some other, unopened page is not
 * reachable from here, which is fine - it was never in this doc to begin
 * with). See this file's header and the report's `core_gaps` for why the
 * *next* autosave flush can still trip over this id having disappeared -
 * a limitation of the side-channel command, not something fixable from
 * `synced/` alone.
 */
function removeBlockWrapperFromDoc(editor: Editor, blockId: BlockId): void {
  const found = findBlockWrapper(editor, blockId);
  if (!found) return;
  const tr = editor.state.tr.delete(found.pos, found.pos + found.node.nodeSize);
  editor.view.dispatch(tr.scrollIntoView());
}

/**
 * EDT-078 step 1: tries the delete outright. Past the backend's warning
 * threshold this rejects with `SyncedBlockError("invalid")`; the real copy
 * count for the confirmation dialog is then read from `countSyncedCopies`
 * (never parsed out of the rejection's own message) and the dialog opens.
 */
export async function requestDeleteSyncedOriginal(editor: Editor): Promise<void> {
  const id = currentBlockId(editor);
  if (!id || roleOf(id) !== "origin") return;

  try {
    await deleteSyncedOriginal(id, false);
    unmarkGroup(id);
    removeBlockWrapperFromDoc(editor, id);
    refreshSyncedIndicators(editor);
  } catch (error) {
    if (!(error instanceof SyncedBlockError) || error.kind !== "invalid") throw error;
    const copyCount = await countSyncedCopies(id);
    setCachedCopyCount(id, copyCount);
    useDeleteSyncedOriginalDialogStore.getState().requestConfirmation(id, copyCount);
  }
}

/** EDT-078 step 2: the confirmation dialog's "Apagar mesmo assim", retried with `confirmed: true`. */
export async function confirmDeleteSyncedOriginal(editor: Editor): Promise<void> {
  const dialog = useDeleteSyncedOriginalDialogStore.getState();
  const id = dialog.blockId;
  if (!id) return;
  dialog.setPending(true);
  try {
    await deleteSyncedOriginal(id, true);
    unmarkGroup(id);
    removeBlockWrapperFromDoc(editor, id);
    refreshSyncedIndicators(editor);
    dialog.close();
  } catch (error) {
    dialog.setPending(false);
    dialog.setError(error instanceof Error ? error.message : "Não foi possível apagar o bloco sincronizado.");
  }
}

/** The `parentBlockId` a fresh sibling of the block under the cursor would have - `null` at the page's top level, or the id of whichever block's `childBlocks` the cursor sits inside (same depth arithmetic `core/commands.ts`'s `handleShiftTab` uses). */
function parentBlockIdAtCursor(editor: Editor, wrapperDepth: number): BlockId | null {
  if (wrapperDepth < 2) return null;
  const containerWrapper = editor.state.selection.$from.node(wrapperDepth - 2);
  const id = containerWrapper.firstChild?.attrs.id;
  return typeof id === "string" ? id : null;
}

/**
 * EDT-073's other half: pastes a synced copy of `sourceId` right after the
 * block under the cursor, on `pageId` (see this file's header for why the
 * caller has to supply it). Creates the row server-side first
 * (`create_synced_block_copy`, so it already carries `syncedSourceId`), then
 * builds its ProseMirror node via `core/serialize.ts`'s `blocksToDoc` (the
 * one place that already knows how every registered block type's
 * `content`/`attrs` round-trip - reusing it here means a copy of a table or
 * an image block would serialize exactly as correctly as a copy of a
 * paragraph, with no per-type logic of its own).
 */
export async function pasteSyncedCopyAtCursor(editor: Editor, sourceId: BlockId, pageId: PageId): Promise<boolean> {
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  const anchorId = currentBlockId(editor);
  if (!anchorId) return false;

  const wrapperDepth = depth - 1;
  const copy: Block = await createSyncedBlockCopy(sourceId, {
    pageId,
    parentBlockId: parentBlockIdAtCursor(editor, wrapperDepth),
    afterBlockId: anchorId,
  });

  const wrapperJson = blocksToDoc([copy]).content?.[0];
  if (!wrapperJson) return false;
  const wrapperNode = PMNode.fromJSON(editor.state.schema, wrapperJson);

  const insertAt = editor.state.selection.$from.after(wrapperDepth);
  const tr = editor.state.tr.insert(insertAt, wrapperNode);
  editor.view.dispatch(tr.scrollIntoView());

  markSynced(copy.id, "copy", copy.syncedSourceId ?? groupIdOf(sourceId) ?? sourceId);
  refreshSyncedIndicators(editor);
  return true;
}

/**
 * EDT-073's "Copiar": marks the origin under the cursor as the paste source
 * for the next "Colar cópia sincronizada" (`register.ts`'s `/` menu entry) -
 * mirrors a real clipboard's "copy now, paste later, maybe on another page"
 * shape rather than pasting immediately, since the target block is usually
 * somewhere the origin isn't even visible from yet.
 */
export function copyCurrentSyncedOriginToClipboard(editor: Editor): boolean {
  const id = currentBlockId(editor);
  if (!id || roleOf(id) !== "origin") return false;
  useSyncedClipboardStore.getState().copy(id);
  return true;
}

/**
 * The `/` menu entry's `run`: pastes whatever "Copiar" last set, on whichever
 * page `editor` itself is showing right now (`pageIdOf(editor)` - see this
 * file's header). Reading it off the instance instead of a global "selected
 * page" store is what makes this correct across pages at all: copy on page
 * A, open page B (a fresh `<Editor pageId="B">`), paste - the `editor` this
 * `run` receives is *that* instance, so `pageIdOf` names B, never A. Returns
 * `false` (not a thrown error) for "nothing copied yet" and "no page open",
 * same as every other guard clause in this file - `register.ts`'s item
 * still reports itself as having run, matching `createSubPageAndInsert`'s
 * own async-`run` convention in `blocks/page-link/register.ts`.
 */
export async function pasteSyncedCopyFromClipboard(editor: Editor): Promise<boolean> {
  const sourceId = useSyncedClipboardStore.getState().sourceId;
  const pageId = pageIdOf(editor);
  if (!sourceId || !pageId) return false;
  return pasteSyncedCopyAtCursor(editor, sourceId, pageId);
}
