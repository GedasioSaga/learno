/**
 * ProseMirror node-type names for every structural block this builder owns,
 * plus the "childBlocks" wrapper that makes arbitrary nesting possible.
 *
 * These are ProseMirror schema names, distinct from `Block.blockType` in
 * `contract.ts` (the editor's own persisted vocabulary, e.g. "heading_2").
 * `serialize.ts` is the only place that translates between the two - every
 * other module should import these constants instead of typing the strings
 * again, so a rename never has to hunt down string literals.
 */
export const NODE_NAMES = {
  doc: "doc",
  /**
   * Generic wrapper: `content: "blockContent childBlocks?"`. Exists because
   * ProseMirror schemas flatly refuse to mix inline and block content in
   * one node ("Mixing inline and block content" - confirmed by
   * `commands.test.ts` failing loudly the moment this wasn't here), so a
   * block's own text and its nested children can never live in the same
   * node. Every one of the nine types below only ever appears as this
   * wrapper's first child; `Block.id`/`blockType` live on *that* child, not
   * on the wrapper - see `serialize.ts`.
   */
  block: "block",
  paragraph: "paragraph",
  heading: "heading",
  bulletedListItem: "bulletedListItem",
  numberedListItem: "numberedListItem",
  todoItem: "todoItem",
  toggle: "toggle",
  quote: "quote",
  callout: "callout",
  divider: "divider",
  /**
   * Structural-only wrapper: holds a block's nested children. Never a `Block`
   * row itself (see `serialize.ts`) and never appears in the "block" group,
   * so it can only occur where a node type's own content model explicitly
   * allows it (as the trailing member of `"inline* childBlocks?"`) - never
   * as a top-level sibling under `doc`.
   */
  childBlocks: "childBlocks",
} as const;

export type BlockNodeName = Exclude<
  (typeof NODE_NAMES)[keyof typeof NODE_NAMES],
  typeof NODE_NAMES.doc | typeof NODE_NAMES.block | typeof NODE_NAMES.childBlocks
>;

/** Every node type that is a genuine block (has its own `Block` row). */
export const BLOCK_NODE_NAMES: readonly BlockNodeName[] = [
  NODE_NAMES.paragraph,
  NODE_NAMES.heading,
  NODE_NAMES.bulletedListItem,
  NODE_NAMES.numberedListItem,
  NODE_NAMES.todoItem,
  NODE_NAMES.toggle,
  NODE_NAMES.quote,
  NODE_NAMES.callout,
  NODE_NAMES.divider,
];

/** List-like types: Enter repeats the same type; Enter on an empty one ends the list (EDT-064/065). */
export const LIST_ITEM_NODE_NAMES: readonly BlockNodeName[] = [
  NODE_NAMES.bulletedListItem,
  NODE_NAMES.numberedListItem,
  NODE_NAMES.todoItem,
];

/**
 * Node types a lone empty Backspace demotes to a paragraph before it can be
 * deleted (EDT-070). Paragraph itself is excluded on purpose - it's already
 * the demotion target, so a second Backspace on an empty paragraph falls
 * through to the merge-with-previous path instead.
 */
export const DEMOTABLE_NODE_NAMES: readonly BlockNodeName[] = [
  NODE_NAMES.heading,
  NODE_NAMES.bulletedListItem,
  NODE_NAMES.numberedListItem,
  NODE_NAMES.todoItem,
  NODE_NAMES.toggle,
  NODE_NAMES.quote,
  NODE_NAMES.callout,
];

/** The ProseMirror group every genuine block type declares - core's nine and every one a builder adds. */
export const BLOCK_CONTENT_GROUP = "blockContent";

/**
 * Whether a node type is a genuine block, asked of the *schema* rather than
 * of `BLOCK_NODE_NAMES`.
 *
 * `BLOCK_NODE_NAMES` is a fixed list of core's nine, so anything keyed off it
 * quietly excludes every block type registered from outside `core/` - an
 * image, a table, an equation. Two things were keyed off it and should not
 * have been: unique-id repair (a pasted table kept the source's id, so
 * `serialize.ts` conflated two blocks into one row) and the structural
 * keymap (Tab/Enter/Backspace did nothing inside a new block type, contrary
 * to what the README promises). Both ask this instead.
 *
 * `BLOCK_NODE_NAMES` stays for what it is genuinely about: the list of types
 * whose *behaviour* core hardcodes (which ones repeat on Enter, which demote
 * on Backspace).
 */
export function isBlockContentType(type: { spec: { group?: string | null } }): boolean {
  return (type.spec.group ?? "").split(" ").includes(BLOCK_CONTENT_GROUP);
}
