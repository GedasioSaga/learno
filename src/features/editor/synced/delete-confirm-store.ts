/**
 * EDT-078's confirmation dialog state - same bridge role
 * `interaction/slash-menu/slash-menu-store.ts` plays between a
 * non-React plugin/action and the React overlay that renders it:
 * `synced-actions.ts`'s `requestDeleteSyncedOriginal` writes here after the
 * backend refuses an unconfirmed delete, `DeleteSyncedOriginalDialog.tsx`
 * only reads it and calls back into `confirmDeleteSyncedOriginal`.
 */
import { create } from "zustand";
import type { BlockId } from "../contract";

interface DeleteSyncedOriginalDialogState {
  open: boolean;
  blockId: BlockId | null;
  /** From an authoritative `countSyncedCopies` call, never parsed out of the backend's rejection message (EDT-078's own requirement). */
  copyCount: number | null;
  pending: boolean;
  errorMessage: string | null;
  requestConfirmation(blockId: BlockId, copyCount: number): void;
  setPending(pending: boolean): void;
  setError(message: string | null): void;
  close(): void;
}

export const useDeleteSyncedOriginalDialogStore = create<DeleteSyncedOriginalDialogState>((set) => ({
  open: false,
  blockId: null,
  copyCount: null,
  pending: false,
  errorMessage: null,
  requestConfirmation: (blockId, copyCount) => set({ open: true, blockId, copyCount, pending: false, errorMessage: null }),
  setPending: (pending) => set({ pending }),
  setError: (errorMessage) => set({ errorMessage }),
  close: () => set({ open: false, blockId: null, copyCount: null, pending: false, errorMessage: null }),
}));
