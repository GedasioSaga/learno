/**
 * Thin `invoke` wrappers for the five synced-block commands
 * (`src-tauri/src/ipc/block_commands.rs`) that are additive to
 * `BlockCommands` (`contract.ts`) rather than part of it - `blocksApi`
 * (`core/blocks-api.ts`) only covers the six generic CRUD commands, so
 * these are called directly, the same convention `createIpcBlocksApi` uses:
 * argument keys are camelCase, Tauri v2 converts them to the Rust side's
 * snake_case for us.
 *
 * There is no local-storage stub here the way `blocksApi` has one for the
 * generic six - the propagation these commands do (update_block patching
 * every copy, EDT-074) lives entirely in Postgres, so a jsdom/vitest run
 * has nothing meaningful to stand in for it. Tests mock `invoke` itself
 * instead (see `synced-blocks-api.test.ts`).
 */
import { invoke } from "@tauri-apps/api/core";
import type { Block, BlockId, BlockPlacement } from "../contract";

interface TauriErrorPayload {
  kind: string;
  message: string;
}

function isTauriErrorPayload(value: unknown): value is TauriErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  // Safe widening, not a lie about the shape: the object/null check above is
  // what actually gates it, this just lets `kind`/`message` be probed.
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/**
 * What every function below rejects with - `src-tauri/src/error.rs`'s
 * `ErrorPayload`, wrapped so a caller branches on `.kind` (EDT-078 checks
 * for `"invalid"`) instead of re-deriving the payload shape at each call
 * site. Mirrors `src/lib/ipc.ts`'s `AppError` but is defined locally so
 * `synced/` depends on nothing outside `core/` and `contract.ts`.
 */
export class SyncedBlockError extends Error {
  readonly kind: string;

  constructor(payload: TauriErrorPayload) {
    super(payload.message);
    this.name = "SyncedBlockError";
    this.kind = payload.kind;
  }
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (isTauriErrorPayload(error)) throw new SyncedBlockError(error);
    throw error;
  }
}

/** EDT-073: pastes a synced copy of `sourceId` at `placement`, returning the new copy row (already carrying `syncedSourceId`). */
export function createSyncedBlockCopy(sourceId: BlockId, placement: BlockPlacement): Promise<Block> {
  return call<Block>("create_synced_block_copy", { sourceId, placement });
}

/** How many live copies point at `id`'s group (resolved to the canonical original first, so asking about a copy answers about the whole group) - what EDT-073's indicator and EDT-078's confirmation both read instead of guessing. */
export function countSyncedCopies(id: BlockId): Promise<number> {
  return call<number>("count_synced_copies", { id });
}

/** EDT-076: detaches only this one copy, preserving its current content. */
export function unsyncBlock(id: BlockId): Promise<Block> {
  return call<Block>("unsync_block", { id });
}

/** EDT-077: detaches every copy of the original `id`. */
export function unsyncAllSyncedCopies(id: BlockId): Promise<Block[]> {
  return call<Block[]>("unsync_all_synced_copies", { id });
}

/**
 * EDT-078: deletes the original `id` and, with it, every one of its
 * copies. Past the backend's warning threshold, calling this with
 * `confirmed: false` rejects with a `SyncedBlockError` (`kind: "invalid"`)
 * describing the copy count in `.message` - the caller is expected to show
 * that as a warning (backed by an authoritative `countSyncedCopies(id)`
 * call, not by parsing the count out of `.message`) and retry with
 * `confirmed: true` once the user agrees.
 */
export function deleteSyncedOriginal(id: BlockId, confirmed: boolean): Promise<void> {
  return call<void>("delete_synced_original", { id, confirmed });
}
