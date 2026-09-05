/**
 * Client-side registry of which block ids participate in a synced-block
 * group (EDT-073..078), and which role each plays.
 *
 * This exists because nothing in the normal load/save path
 * (`core/serialize.ts`'s `docToFlatBlocks`/`blocksToDoc`, and its
 * `FlatBlock`/`BlockPatch` shapes) ever threads `Block.syncedSourceId` into
 * a ProseMirror node attr or back out - `BlockSpec.serialization.attrs()`
 * only ever receives a block's `blockType` and its own `content` (the JSONB
 * column), never the full `Block` row, so a spec has no way to read or
 * write `syncedSourceId` even if `synced/` registered one (documented in
 * this builder's report as a `core_gaps` entry). Only the five dedicated
 * commands in `synced-blocks-api.ts` ever learn a block's synced role, so
 * this module is what remembers what they said, keyed by block id, backed
 * by `localStorage` the same way `core/blocks-api.ts`'s local stub is - so
 * the indicator (EDT-073) and each block's role survive a page reload
 * without re-querying the backend for every block on every open.
 */
import type { BlockId } from "../contract";

export type SyncedRole = "origin" | "copy";

interface SyncedEntry {
  role: SyncedRole;
  /** The canonical original's id - itself, for an origin's own entry. Groups an origin with its copies for `siblingsInGroup`. */
  groupId: BlockId;
}

const ENTRIES_KEY = "learno:editor:synced:v1:entries";
const COUNTS_KEY = "learno:editor:synced:v1:counts";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Trusted by construction, not verified at this line: `writeJson` below
    // is the only writer of these keys, and always writes exactly `T`'s
    // shape - the `catch` above already covers "not valid JSON at all"
    // (corrupt storage, a private window). The one gap this doesn't cover
    // is a value hand-edited in devtools/another extension into valid JSON
    // of the *wrong* shape; every read site (`roleOf`, `groupIdOf`, ...)
    // uses `?.` on the result so that degrades to "not known as synced"
    // rather than throwing - except `unmarkGroup`'s direct `entries[id].groupId`
    // read, which would throw on such a hand-edited entry. Given this cache
    // is single-browser, best-effort UI state (never the source of truth -
    // Postgres is), a full runtime schema check felt like more machinery
    // than the failure mode warrants; flagging it here instead of asserting
    // silent safety.
    return (parsed ?? fallback) as T;
  } catch {
    // Corrupt or inaccessible storage (private window, quota) - degrade to
    // "nothing known yet" rather than crash the editor over a cache.
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort persistence; the caller's in-memory result is still
    // correct for the rest of this session even if the write didn't stick.
  }
}

function readEntries(): Record<BlockId, SyncedEntry> {
  return readJson<Record<BlockId, SyncedEntry>>(ENTRIES_KEY, {});
}

function writeEntries(entries: Record<BlockId, SyncedEntry>): void {
  writeJson(ENTRIES_KEY, entries);
}

/** EDT-073: declares `id` part of a synced group - the origin itself (`groupId === id`) or a freshly created copy (`groupId` is the origin's id). */
export function markSynced(id: BlockId, role: SyncedRole, groupId: BlockId): void {
  const entries = readEntries();
  entries[id] = { role, groupId };
  writeEntries(entries);
}

/** EDT-076: `id` alone no longer participates in any synced group. */
export function unmarkSynced(id: BlockId): void {
  const entries = readEntries();
  if (!(id in entries)) return;
  delete entries[id];
  writeEntries(entries);
}

/** EDT-077/078: every known id sharing `groupId` (the origin's own entry included) is forgotten together. */
export function unmarkGroup(groupId: BlockId): void {
  const entries = readEntries();
  let changed = false;
  for (const id of Object.keys(entries)) {
    if (entries[id].groupId === groupId) {
      delete entries[id];
      changed = true;
    }
  }
  if (changed) writeEntries(entries);
}

export function roleOf(id: BlockId): SyncedRole | null {
  return readEntries()[id]?.role ?? null;
}

export function groupIdOf(id: BlockId): BlockId | null {
  return readEntries()[id]?.groupId ?? null;
}

export function isSynced(id: BlockId): boolean {
  return id in readEntries();
}

/** Every known id sharing `id`'s group, `id` itself excluded - who a live edit to `id` should mirror to (`live-mirror-extension.ts`). */
export function siblingsInGroup(id: BlockId): BlockId[] {
  const entries = readEntries();
  const groupId = entries[id]?.groupId;
  if (!groupId) return [];
  return Object.keys(entries).filter((other) => other !== id && entries[other].groupId === groupId);
}

/** Every id this browser knows is synced, for the decoration plugin (`synced-decorations.ts`) to check node ids against. */
export function allKnownSyncedIds(): Set<BlockId> {
  return new Set(Object.keys(readEntries()));
}

/** EDT-078: the last `count_synced_copies` result for an origin, so the delete-confirmation dialog can show a number without re-querying on every render. `null` means "never queried in this session". */
export function getCachedCopyCount(originId: BlockId): number | null {
  const counts = readJson<Record<BlockId, number>>(COUNTS_KEY, {});
  return counts[originId] ?? null;
}

export function setCachedCopyCount(originId: BlockId, count: number): void {
  const counts = readJson<Record<BlockId, number>>(COUNTS_KEY, {});
  counts[originId] = count;
  writeJson(COUNTS_KEY, counts);
}

/** Test-only: drops every cached entry so each test starts from a clean slate. Never call from production code. */
export function resetSyncedStoreForTests(): void {
  try {
    localStorage.removeItem(ENTRIES_KEY);
    localStorage.removeItem(COUNTS_KEY);
  } catch {
    // Nothing to clean up if storage itself is inaccessible.
  }
}
