/**
 * Remembers which synced origin "Copiar" last marked as ready to paste - the
 * missing half of EDT-073/074/076/077/078's live path. Neither TipTap's own
 * clipboard nor `synced-store.ts`'s per-block role cache carries this: "what
 * the user meant to paste next" isn't a block's role, it's a pending action
 * that has to survive the trip from one page to another (copy on page A,
 * open page B, then paste). Same bridge-store shape as
 * `delete-confirm-store.ts` - a non-React action (`SyncedControls`'s click
 * handler) writes here, another (the `/` menu's `run`) reads it later.
 */
import { create } from "zustand";
import type { BlockId } from "../contract";

interface SyncedClipboardState {
  sourceId: BlockId | null;
  copy(sourceId: BlockId): void;
  clear(): void;
}

export const useSyncedClipboardStore = create<SyncedClipboardState>((set) => ({
  sourceId: null,
  copy: (sourceId) => set({ sourceId }),
  clear: () => set({ sourceId: null }),
}));

/** Test-only: drops whatever a previous test left copied. Never call from production code. */
export function resetSyncedClipboardForTests(): void {
  useSyncedClipboardStore.getState().clear();
}
