/**
 * The registries every builder outside `core/` writes to, so that adding a
 * block type, a slash-menu entry, a formatting-menu button or a floating
 * panel never means editing a file `core/` owns.
 *
 * `registry.ts` already covered "add a TipTap extension". That was enough
 * for a mark, and not enough for anything else: a new *block* type also has
 * to teach `serialize.ts` how its node turns into a `Block` row and back
 * (without an entry there it silently persists as a paragraph - the trap the
 * README used to just warn about), and any block worth inserting also needs
 * to appear in the `/` menu (EDT-047) and usually in "Turn into" (EDT-049).
 * Those three facts about one block type belong in one declaration, made in
 * the builder's own folder. That declaration is `BlockSpec`.
 *
 * Everything here is a plain module-level registry filled at import time by
 * `register.ts` files that `discover-extensions.ts` loads eagerly - same
 * mechanism, same timing, no import graph between builders.
 */
import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import type { ReactNode } from "react";
import type { Block, BlockContent } from "../contract";

/**
 * How one block type crosses between the ProseMirror doc and the `Block`
 * row that `contract.ts` persists. Every field is optional: the defaults
 * describe the ordinary textual block (`content: "inline*"`, persisted as
 * `{ inline: [...] }`), which is what most types are.
 */
export interface BlockSpecSerialization {
  /**
   * Node attrs to put on the node when rebuilding it from storage. Gets the
   * persisted `blockType` string too, because a type family encodes an attr
   * in the string itself (`heading_2` -> `{ level: 2 }`), and the whole
   * `Block` row as a third argument for the fields that are *columns* rather
   * than part of `content` - `syncedSourceId` above all, which a synced
   * block's node view needs in order to show its indicator (EDT-073) and
   * which no amount of reading `content` can reach.
   *
   * Read-only in that direction: `content()` cannot write `syncedSourceId`
   * back, because it is not part of the JSONB. The dedicated commands
   * (`create_synced_block_copy`, `unsync_block`) own that column.
   */
  attrs?(blockType: string, content: BlockContent, block?: Block): Record<string, unknown>;
  /**
   * The persisted `blockType` for a node carrying these attrs. Defaults to
   * `spec.blockType`; only a family (heading) needs to override it.
   */
  blockType?(attrs: Record<string, unknown>): string;
  /** The persisted `content` for a node with these attrs and this content array. */
  content?(attrs: Record<string, unknown>, nodeContent: JSONContent[]): BlockContent;
  /** The node's content array, rebuilt from persisted content. Return `[]` for an atom. */
  nodeContent?(content: BlockContent): JSONContent[];
  /**
   * The flattened text that feeds global search. Defaults to the inline
   * text; a structured block (a table's cells, a bookmark's title) has to
   * say how to flatten itself, because nothing else can know.
   */
  plainText?(content: BlockContent, nodeContent: JSONContent[]): string;
}

export interface BlockSpec {
  /** The persisted vocabulary (`Block.blockType`): "paragraph", "heading_1", "image", … */
  blockType: string;
  /** The ProseMirror node type name this block renders as. */
  nodeName: string;
  /**
   * Whether a stored `blockType` belongs to this spec. Defaults to string
   * equality with `blockType`; heading overrides it to claim the whole
   * `heading_*` family with one spec.
   */
  matches?(blockType: string): boolean;
  /**
   * `false` when the node holds nothing (a divider, an image): `nodeContent`
   * is then never written onto the rebuilt node, which matters because
   * ProseMirror rejects a content array on a node whose content expression
   * is empty.
   */
  hasContent?: boolean;
  serialization?: BlockSpecSerialization;
}

/** One entry in the `/` menu (EDT-047). */
export interface SlashMenuItem {
  /** Unique across all builders - used as the React key and in tests. */
  id: string;
  title: string;
  /** Extra terms the filter should match besides `title` (accent-free, lowercase). */
  keywords?: string[];
  /** Section heading in the menu. Free-form; the menu groups by it in first-seen order. */
  group?: string;
  /** Short glyph or emoji shown before the title. */
  icon?: string;
  /** Lower sorts first inside a group. Defaults to 0. */
  order?: number;
  /** Perform the insertion at the current selection. Return false when it could not run. */
  run(editor: TiptapEditor): boolean;
}

/** One entry in the "Turn into" list (EDT-049) - converting an existing block, not inserting a new one. */
export interface TurnIntoItem {
  id: string;
  title: string;
  group?: string;
  icon?: string;
  order?: number;
  /** Convert the block holding the selection. Return false when it could not run. */
  run(editor: TiptapEditor): boolean;
  /** Whether the block holding the selection already is this type - the list marks it. */
  isActive?(editor: TiptapEditor): boolean;
}

/**
 * One button (or group of buttons) in the single selection toolbar core
 * renders. A registry rather than "each builder renders its own bubble
 * menu", because N builders each mounting their own floating bar is N
 * floating bars fighting over the same selection.
 */
export interface FormattingMenuItem {
  id: string;
  /** Lower sorts first. Defaults to 0. */
  order?: number;
  render(editor: TiptapEditor): ReactNode;
}

/**
 * A free-form panel mounted alongside the editor content, for UI that is
 * neither a toolbar button nor part of the document: the `/` menu popup, a
 * link editor, an image caption dialog.
 */
export interface EditorOverlay {
  id: string;
  /** Lower renders first. Defaults to 0. */
  order?: number;
  render(editor: TiptapEditor): ReactNode;
}

/**
 * How one *inline* node type contributes to its block's `plainText`.
 *
 * `plainText` is what global search (FUN-037) indexes, and the default
 * flattener only understands text nodes and hard breaks - so an inline atom
 * (a date chip, an inline equation, a page mention) contributed nothing and
 * was invisible to search, no matter how much text it displayed. An inline
 * node that carries meaning registers how to read it here.
 */
export interface InlinePlainText {
  /** The ProseMirror node name of the inline node. */
  nodeName: string;
  /** The text this node contributes. Gets the node's own JSON (attrs included). */
  text(node: JSONContent): string;
}

const blockSpecs = new Map<string, BlockSpec>();
const inlinePlainText = new Map<string, InlinePlainText>();
const slashMenuItems = new Map<string, SlashMenuItem>();
const turnIntoItems = new Map<string, TurnIntoItem>();
const formattingMenuItems = new Map<string, FormattingMenuItem>();
const editorOverlays = new Map<string, EditorOverlay>();

function upsert<T extends { id: string }>(store: Map<string, T>, entry: T | T[], what: string): void {
  for (const one of Array.isArray(entry) ? entry : [entry]) {
    if (!one.id) throw new Error(`${what} sem id: todo registro precisa de um id único.`);
    store.set(one.id, one);
  }
}

/**
 * Declare a block type. Call from your own `register.ts`, next to the
 * `registerBlockExtension` call that adds the node itself.
 *
 * Re-registering the same `blockType` replaces the previous spec (so a hot
 * reload re-running the module is harmless) unless the `nodeName` differs,
 * which can only mean two builders picked the same persisted `blockType` by
 * accident - a collision that would corrupt stored documents, so it throws
 * instead of picking a winner.
 */
export function registerBlockSpec(spec: BlockSpec | BlockSpec[]): void {
  for (const one of Array.isArray(spec) ? spec : [spec]) {
    const existing = blockSpecs.get(one.blockType);
    if (existing && existing.nodeName !== one.nodeName) {
      throw new Error(
        `blockType "${one.blockType}" já está registrado pelo nó "${existing.nodeName}" e foi registrado de novo por "${one.nodeName}". ` +
          `Dois tipos de bloco não podem compartilhar o mesmo blockType persistido — escolha outro nome.`,
      );
    }
    blockSpecs.set(one.blockType, one);
  }
}

/** Teach the `plainText` flattener how to read an inline node your builder adds. See `InlinePlainText`. */
export function registerInlinePlainText(entry: InlinePlainText | InlinePlainText[]): void {
  for (const one of Array.isArray(entry) ? entry : [entry]) {
    inlinePlainText.set(one.nodeName, one);
  }
}

/** The registered reader for an inline node name, or `null`. Used by `serialize.ts`. */
export function inlinePlainTextFor(nodeName: string): ((node: JSONContent) => string) | null {
  return inlinePlainText.get(nodeName)?.text ?? null;
}

export function registerSlashMenuItem(item: SlashMenuItem | SlashMenuItem[]): void {
  upsert(slashMenuItems, item, "SlashMenuItem");
}

export function registerTurnIntoItem(item: TurnIntoItem | TurnIntoItem[]): void {
  upsert(turnIntoItems, item, "TurnIntoItem");
}

export function registerFormattingMenuItem(item: FormattingMenuItem | FormattingMenuItem[]): void {
  upsert(formattingMenuItems, item, "FormattingMenuItem");
}

export function registerEditorOverlay(overlay: EditorOverlay | EditorOverlay[]): void {
  upsert(editorOverlays, overlay, "EditorOverlay");
}

function byOrder<T extends { order?: number }>(a: T, b: T): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

export function collectSlashMenuItems(): SlashMenuItem[] {
  return [...slashMenuItems.values()].sort(byOrder);
}

export function collectTurnIntoItems(): TurnIntoItem[] {
  return [...turnIntoItems.values()].sort(byOrder);
}

export function collectFormattingMenuItems(): FormattingMenuItem[] {
  return [...formattingMenuItems.values()].sort(byOrder);
}

export function collectEditorOverlays(): EditorOverlay[] {
  return [...editorOverlays.values()].sort(byOrder);
}

/** Every registered spec, in registration order. Exposed for tests and for the `/` menu's "all block types" listing. */
export function collectBlockSpecs(): BlockSpec[] {
  return [...blockSpecs.values()];
}

/**
 * The spec that owns a stored `blockType`, or `null` when nothing claims it.
 * `serialize.ts` falls back to paragraph in that case rather than throwing,
 * because a document stored by a newer build (a block type this build does
 * not have) must still open.
 */
export function specForBlockType(blockType: string): BlockSpec | null {
  const exact = blockSpecs.get(blockType);
  if (exact) return exact;
  for (const spec of blockSpecs.values()) {
    if (spec.matches?.(blockType)) return spec;
  }
  return null;
}

/** The spec that owns a ProseMirror node name, or `null`. */
export function specForNodeName(nodeName: string): BlockSpec | null {
  for (const spec of blockSpecs.values()) {
    if (spec.nodeName === nodeName) return spec;
  }
  return null;
}

/** Test-only: drops every registration. Never call from production code. */
export function resetBlockRegistriesForTests(): void {
  blockSpecs.clear();
  inlinePlainText.clear();
  slashMenuItems.clear();
  turnIntoItems.clear();
  formattingMenuItems.clear();
  editorOverlays.clear();
}
