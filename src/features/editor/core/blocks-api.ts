/**
 * The thin layer the task asked for: everything above this file (the editor,
 * `use-blocks-document.ts`) only ever calls `blocksApi`, typed exactly as
 * `BlockCommands` from `contract.ts`. Swapping the stub for the real backend
 * once the Rust side lands the six commands is the one line at the bottom of
 * this file - nothing else in the editor changes.
 *
 * `createLocalStubBlocksApi` exists because that Rust side is being written
 * in parallel and doesn't exist yet today - it plays the backend's role
 * against `localStorage` (per page, namespaced so it never collides across
 * pages) well enough to prove "open loads blocks, edit saves, reopen shows
 * it" end-to-end right now, with the exact same contract the real commands
 * will satisfy later.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Block,
  BlockChange,
  BlockCommands,
  BlockId,
  BlockPatch,
  BlockPlacement,
  NewBlock,
  PageId,
} from "../contract";
import { newBlockId } from "./ids";
import { midpointPosition } from "./position";

/**
 * Toda escrita de bloco já disparada, encadeada — a barreira que
 * `whenBlockWritesSettle` espera.
 *
 * Existe por causa de uma corrida real, encontrada por e2e: sair de uma
 * página dispara o autosave dela pelo `useEffect` de limpeza
 * (`use-blocks-document.ts`), e limpeza de efeito no React não pode ser
 * `async` — o `flush()` sai como `void flush()`, sem ninguém esperando. A
 * gravação acontece, só que depois. Quem abre a próxima página e lê algo que
 * dependa daquela gravação (o rodapé de backlinks lê `list_backlinks`, que
 * depende do `block_page_links` que o gatilho do Postgres preenche a partir
 * do bloco recém-salvo) pode ler o banco antes de a escrita chegar lá, e
 * mostrar um backlink de menos. Na mão do usuário isso é "mencionei a página
 * e o backlink não apareceu".
 *
 * `catch` engolindo a falha é deliberado: esta cadeia serve para ORDENAR, não
 * para propagar erro. Quem disparou a escrita continua recebendo a rejeição
 * dela pela promise que `trackWrite` devolve intacta; a barreira não pode
 * ficar rejeitada para sempre por causa de uma escrita que falhou uma vez.
 */
let pendingWrites: Promise<unknown> = Promise.resolve();

function trackWrite<T>(work: Promise<T>): Promise<T> {
  pendingWrites = pendingWrites.then(
    () => work.catch(() => undefined),
    () => work.catch(() => undefined),
  );
  return work;
}

/**
 * Resolve quando toda escrita de bloco já disparada terminou. Chame antes de
 * ler algo derivado de bloco (backlinks, busca global) logo depois de uma
 * edição — ver o comentário de `pendingWrites`.
 */
export function whenBlockWritesSettle(): Promise<void> {
  return pendingWrites.then(
    () => undefined,
    () => undefined,
  );
}

function byPosition(a: Block, b: Block): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

function siblingsOf(blocks: Block[], pageId: PageId, parentBlockId: BlockId | null): Block[] {
  return blocks.filter((b) => b.pageId === pageId && b.parentBlockId === parentBlockId).sort(byPosition);
}

function computePosition(blocks: Block[], pageId: PageId, parentBlockId: BlockId | null, afterBlockId: BlockId | null): string {
  const siblings = siblingsOf(blocks, pageId, parentBlockId);
  if (afterBlockId === null) {
    return midpointPosition(null, siblings[0]?.position ?? null);
  }
  const afterIndex = siblings.findIndex((b) => b.id === afterBlockId);
  if (afterIndex === -1) {
    // Stale `afterBlockId` (e.g. it moved elsewhere in the same batch,
    // already processed) - append at the end rather than fail the whole
    // autosave batch over an ordering hint that's since gone stale.
    return midpointPosition(siblings[siblings.length - 1]?.position ?? null, null);
  }
  const before = siblings[afterIndex];
  const after = siblings[afterIndex + 1];
  return midpointPosition(before.position, after?.position ?? null);
}

function descendantIds(blocks: Block[], rootIds: Set<BlockId>): Set<BlockId> {
  const result = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const block of blocks) {
      if (block.parentBlockId !== null && result.has(block.parentBlockId) && !result.has(block.id)) {
        result.add(block.id);
        grew = true;
      }
    }
  }
  return result;
}

const STORAGE_PREFIX = "learno:editor:blocks:v1:";

function loadStoredBlocks(pageId: PageId): Block[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + pageId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    // Corrupt or inaccessible storage (private window, quota) - treat the
    // page as having no saved blocks yet rather than crash the editor.
    return [];
  }
}

function saveStoredBlocks(pageId: PageId, blocks: Block[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + pageId, JSON.stringify(blocks));
  } catch {
    // Best-effort persistence; the caller's in-memory result is still
    // correct for the rest of this session even if the write didn't stick.
  }
}

/**
 * Stands in for the Rust commands `contract.ts` declares, until they exist.
 * Each page's blocks live under their own `localStorage` key, mutated
 * synchronously and written back whole after every call - correct for the
 * data sizes a single page of study notes has, not meant to survive being
 * the real backend once one exists.
 */
async function stubListPageBlocks(pageId: PageId): Promise<Block[]> {
  return loadStoredBlocks(pageId);
}

async function stubCreateBlock(newBlock: NewBlock): Promise<Block> {
  const { pageId, parentBlockId, afterBlockId } = newBlock.placement;
  const blocks = loadStoredBlocks(pageId);
  const now = new Date().toISOString();
  const block: Block = {
    // Honours `NewBlock.id` exactly as the real backend does - a stub that
    // invented its own id would hide the bug that field exists to prevent.
    id: newBlock.id ?? newBlockId(),
    pageId,
    parentBlockId,
    blockType: newBlock.blockType,
    content: newBlock.content,
    plainText: newBlock.plainText,
    syncedSourceId: null,
    position: computePosition(blocks, pageId, parentBlockId, afterBlockId),
    createdAt: now,
    updatedAt: now,
  };
  blocks.push(block);
  saveStoredBlocks(pageId, blocks);
  return block;
}

async function stubUpdateBlock(id: BlockId, patch: BlockPatch): Promise<Block> {
  // The stub only ever sees one page's key at a time (see `blocksApi`'s
  // callers), but this command's signature - like the real one's - is
  // page-agnostic, so it has to search every page this session touched.
  for (const key of allStoredPageIds()) {
    const blocks = loadStoredBlocks(key);
    const index = blocks.findIndex((b) => b.id === id);
    if (index === -1) continue;
    const updated: Block = { ...blocks[index], ...patch, updatedAt: new Date().toISOString() };
    blocks[index] = updated;
    saveStoredBlocks(key, blocks);
    return updated;
  }
  throw new Error(`update_block: bloco ${id} não encontrado`);
}

async function stubDeleteBlocks(ids: BlockId[]): Promise<void> {
  for (const key of allStoredPageIds()) {
    const blocks = loadStoredBlocks(key);
    const toDelete = descendantIds(blocks, new Set(ids));
    const remaining = blocks.filter((b) => !toDelete.has(b.id));
    if (remaining.length !== blocks.length) saveStoredBlocks(key, remaining);
  }
}

async function stubMoveBlock(id: BlockId, placement: BlockPlacement): Promise<Block> {
  const blocks = loadStoredBlocks(placement.pageId);
  const index = blocks.findIndex((b) => b.id === id);
  if (index === -1) throw new Error(`move_block: bloco ${id} não encontrado em ${placement.pageId}`);
  const updated: Block = {
    ...blocks[index],
    parentBlockId: placement.parentBlockId,
    position: computePosition(blocks, placement.pageId, placement.parentBlockId, placement.afterBlockId),
    updatedAt: new Date().toISOString(),
  };
  blocks[index] = updated;
  saveStoredBlocks(placement.pageId, blocks);
  return updated;
}

async function stubApplyBlockChanges(changes: BlockChange[]): Promise<Block[]> {
  const results: Block[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "create":
        results.push(await stubCreateBlock(change.block));
        break;
      case "update":
        results.push(await stubUpdateBlock(change.id, change.patch));
        break;
      case "move":
        results.push(await stubMoveBlock(change.id, change.placement));
        break;
      case "delete":
        await stubDeleteBlocks([change.id]);
        break;
    }
  }
  return results;
}

export function createLocalStubBlocksApi(): BlockCommands {
  return {
    list_page_blocks: stubListPageBlocks,
    // As escritas passam pela mesma barreira do backend real: um teste que
    // roda contra o stub tem que enxergar a mesma ordenação que o app.
    create_block: (block) => trackWrite(stubCreateBlock(block)),
    update_block: (id, patch) => trackWrite(stubUpdateBlock(id, patch)),
    delete_blocks: (ids) => trackWrite(stubDeleteBlocks(ids)),
    move_block: (id, placement) => trackWrite(stubMoveBlock(id, placement)),
    apply_block_changes: (changes) => trackWrite(stubApplyBlockChanges(changes)),
  };
}

function allStoredPageIds(): PageId[] {
  const ids: PageId[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) ids.push(key.slice(STORAGE_PREFIX.length));
  }
  return ids;
}

/**
 * The real implementation, calling the `#[tauri::command]` functions
 * `contract.ts` names - ready for the day the Rust side (being written in
 * parallel right now) lands them. Argument keys are camelCase, matching the
 * convention every other wrapper in `src/lib/ipc.ts` already uses.
 */
export function createIpcBlocksApi(): BlockCommands {
  return {
    list_page_blocks: (pageId) => invoke<Block[]>("list_page_blocks", { pageId }),
    create_block: (block) => trackWrite(invoke<Block>("create_block", { block })),
    update_block: (id, patch) => trackWrite(invoke<Block>("update_block", { id, patch })),
    delete_blocks: (ids) => trackWrite(invoke<void>("delete_blocks", { ids })),
    move_block: (id, placement) => trackWrite(invoke<Block>("move_block", { id, placement })),
    apply_block_changes: (changes) => trackWrite(invoke<Block[]>("apply_block_changes", { changes })),
  };
}

/**
 * The real backend when there is one, the local stub when there isn't.
 *
 * `src-tauri` now exposes all six commands (`ipc/block_commands.rs`), so
 * inside the desktop app every block goes to Postgres. Outside it - a plain
 * `vite dev` in a browser, and every `vitest` run - `invoke` has no host to
 * call and would reject on the first keystroke, so the localStorage stub
 * stays as the fallback rather than the app failing to load a page at all.
 * `isTauri()` is Tauri's own check (`window.__TAURI_INTERNALS__`), not a
 * guess at one.
 */
export const blocksApi: BlockCommands = isTauri() ? createIpcBlocksApi() : createLocalStubBlocksApi();
