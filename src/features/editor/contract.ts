/**
 * The boundary between the pieces of the editor, written down before any of
 * them exists so they can be built in parallel without guessing at each other.
 *
 * This file is deliberately types-only. It says what a block *is* and what the
 * backend can be asked to do with one; it says nothing about how the editor
 * stores, renders or edits them. Those are the builders' decisions.
 *
 * The shape mirrors the `blocks` table (`src-tauri/migrations/0006_blocks.sql`).
 * When the two disagree, the migration wins and this file is wrong.
 */

/** Server-generated UUID. Aliased so a block id is never mistaken for a page id. */
export type BlockId = string;
export type PageId = string;

/**
 * `content` is JSONB on the Postgres side, so its shape is the editor's to
 * define per block type. It travels opaquely through the data layer, which
 * never parses it.
 */
export type BlockContent = Record<string, unknown>;

export interface Block {
  id: BlockId;
  pageId: PageId;
  /** null for a top-level block on the page. */
  parentBlockId: BlockId | null;
  /** The editor's own vocabulary: "paragraph", "heading_1", "to_do", … */
  blockType: string;
  content: BlockContent;
  /**
   * Flattened text of `content`, for global search. The editor writes it,
   * because only the editor knows how to flatten its own block types - the
   * data layer would have to know all of them to do it.
   */
  plainText: string;
  /** Set on a synced copy, pointing at the original it mirrors. */
  syncedSourceId: BlockId | null;
  /** Fractional index among siblings sharing (pageId, parentBlockId). */
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a block goes, expressed relative to blocks that already exist rather
 * than as a numeric index - the position is fractional, so "between these two"
 * is the question the backend can answer cheaply and "at index 4" is not.
 */
export interface BlockPlacement {
  pageId: PageId;
  parentBlockId: BlockId | null;
  /** null means "first among its siblings". */
  afterBlockId: BlockId | null;
}

export interface NewBlock {
  blockType: string;
  content: BlockContent;
  plainText: string;
  placement: BlockPlacement;
}

/** Every field optional: a patch touches only what changed. */
export interface BlockPatch {
  blockType?: string;
  content?: BlockContent;
  plainText?: string;
}

/**
 * The commands the editor may invoke. Names match the `#[tauri::command]`
 * functions on the Rust side exactly; the TypeScript wrappers live in
 * `src/lib/ipc.ts` alongside the Phase 1 ones.
 *
 * Bulk shapes exist because typing produces many small changes per second, and
 * one round trip per keystroke is a different program than one per batch.
 */
export interface BlockCommands {
  /** Whole block tree of a page, in document order, nesting included. */
  list_page_blocks(pageId: PageId): Promise<Block[]>;
  create_block(block: NewBlock): Promise<Block>;
  update_block(id: BlockId, patch: BlockPatch): Promise<Block>;
  /** Soft delete, so the page's trash and version history keep working. */
  delete_blocks(ids: BlockId[]): Promise<void>;
  move_block(id: BlockId, placement: BlockPlacement): Promise<Block>;
  /** Applies many patches atomically - the editor's autosave batches into this. */
  apply_block_changes(changes: BlockChange[]): Promise<Block[]>;
}

export type BlockChange =
  | { kind: "create"; block: NewBlock }
  | { kind: "update"; id: BlockId; patch: BlockPatch }
  | { kind: "delete"; id: BlockId }
  | { kind: "move"; id: BlockId; placement: BlockPlacement };
