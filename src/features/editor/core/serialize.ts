/**
 * The translation layer between a ProseMirror doc (what the editor edits)
 * and `Block[]` (what `contract.ts` persists) - the two other things this
 * builder is on the hook for besides the schema itself: reconstructing a
 * doc from stored blocks on open, and turning edits back into the
 * `BlockChange[]` batch `apply_block_changes` expects on save.
 *
 * It knows no block types. Every per-type fact it needs - which node a
 * stored `blockType` becomes, which attrs that type encodes, how its
 * content is shaped, how to flatten it for search - comes from the
 * `BlockSpec` registry in `block-spec.ts`, which `core-specs.ts` fills for
 * the nine structural types and every other builder fills for its own from
 * its own folder. Adding a block type therefore never edits this file.
 *
 * Pure functions throughout, no ProseMirror `Editor`/`view` involved - see
 * `serialize.test.ts`.
 */
import type { JSONContent } from "@tiptap/core";
import type { Block, BlockChange, BlockContent, BlockId, PageId } from "../contract";
import { inlinePlainTextFor, specForBlockType, specForNodeName } from "./block-spec";
// Side-effect import: registers the nine structural specs before anything
// below can look one up. Not routed through `discover-extensions.ts` on
// purpose - core's own types must be registered first, so that a builder's
// `register.ts` can deliberately replace one.
import "./core-specs";
import { newBlockId } from "./ids";
import { NODE_NAMES } from "./node-names";
import { midpointPosition } from "./position";

interface NodeShape {
  nodeName: string;
  attrs: Record<string, unknown>;
}

/**
 * The fallback for a `blockType` (or node name) no registered spec claims.
 * A document written by a build that had a block type this build doesn't
 * still has to open, so an unknown type degrades to a paragraph rather than
 * throwing or silently dropping the block.
 */
const FALLBACK_NODE_NAME: string = NODE_NAMES.paragraph;
const FALLBACK_BLOCK_TYPE = "paragraph";

/**
 * The text of a block's inline content, for global search.
 *
 * Beyond text nodes and hard breaks, an inline node contributes whatever it
 * registered through `registerInlinePlainText` - a date chip's formatted
 * date, an inline equation's LaTeX, a page mention's title. Without that,
 * anything shown by an inline atom was invisible to search no matter how
 * much text it displayed on screen.
 */
function flattenInlineText(inline: JSONContent[]): string {
  let text = "";
  for (const node of inline) {
    if (typeof node.text === "string") {
      text += node.text;
      continue;
    }
    if (node.type === "hardBreak") {
      text += "\n";
      continue;
    }
    const reader = node.type ? inlinePlainTextFor(node.type) : null;
    if (reader) {
      text += reader(node);
      continue;
    }
    // An inline node that holds inline content of its own (and registered
    // nothing) still contributes its descendants' text.
    if (Array.isArray(node.content)) text += flattenInlineText(node.content);
  }
  return text;
}

/** `Block.blockType` -> the node type name plus whatever attrs the type string itself encodes. The whole row goes through so a spec can read a column (`syncedSourceId`) and not only `content`. */
function nodeShapeFor(block: Block): NodeShape {
  const spec = specForBlockType(block.blockType);
  if (!spec) return { nodeName: FALLBACK_NODE_NAME, attrs: {} };
  return {
    nodeName: spec.nodeName,
    attrs: spec.serialization?.attrs?.(block.blockType, block.content, block) ?? {},
  };
}

/** The inverse: node type name + attrs -> the `Block.blockType` to persist. */
function blockTypeFor(nodeName: string, attrs: Record<string, unknown>): string {
  const spec = specForNodeName(nodeName);
  if (!spec) return FALLBACK_BLOCK_TYPE;
  return spec.serialization?.blockType?.(attrs) ?? spec.blockType;
}

/** The `Block.content` JSONB for a node with these attrs and this content array. */
function contentFor(nodeName: string, attrs: Record<string, unknown>, nodeContent: JSONContent[]): BlockContent {
  const spec = specForNodeName(nodeName);
  return spec?.serialization?.content?.(attrs, nodeContent) ?? { inline: nodeContent };
}

/** The `Block.plainText` for global search. */
function plainTextFor(nodeName: string, content: BlockContent, nodeContent: JSONContent[]): string {
  const spec = specForNodeName(nodeName);
  return spec?.serialization?.plainText?.(content, nodeContent) ?? flattenInlineText(nodeContent);
}

/** The node's content array, rebuilt from storage. */
function nodeContentFor(nodeName: string, content: BlockContent): JSONContent[] {
  const spec = specForNodeName(nodeName);
  if (spec?.serialization?.nodeContent) return spec.serialization.nodeContent(content);
  const inline = content.inline;
  return Array.isArray(inline) ? (inline as JSONContent[]) : [];
}

/** `false` for a node whose content expression is empty (divider, and any atom a builder adds) - writing a `content` array onto one is invalid. */
function nodeHasContent(nodeName: string): boolean {
  return specForNodeName(nodeName)?.hasContent !== false;
}

/** One page's worth of blocks, flattened depth-first, each carrying the id of the sibling right before it (or `null` for "first among its siblings") - exactly what `BlockPlacement.afterBlockId` needs. */
export interface FlatBlock {
  id: BlockId;
  parentBlockId: BlockId | null;
  afterId: BlockId | null;
  blockType: string;
  content: BlockContent;
  plainText: string;
}

/**
 * Depth-first flatten of a ProseMirror doc into `FlatBlock[]`, ready to diff
 * against the last-saved snapshot (`diffToChanges`) or to hand a
 * freshly-created page's worth of blocks straight to `create_block`.
 *
 * `nodes` here is always a list of `Block` wrappers (`doc.content`, or a
 * `childBlocks` node's own `content`) - each one unwrapped into its
 * `blockContent` first child (where `id`/type/text live) and optional
 * `childBlocks` second child (see `schema.ts` on why the wrapper exists).
 */
export function docToFlatBlocks(doc: JSONContent): FlatBlock[] {
  const result: FlatBlock[] = [];

  function walk(wrappers: JSONContent[], parentBlockId: BlockId | null) {
    let afterId: BlockId | null = null;
    for (const wrapper of wrappers) {
      const contentNode = wrapper.content?.[0];
      const id = contentNode?.attrs?.id;
      if (!contentNode || typeof id !== "string") continue;

      const childBlocksNode = wrapper.content?.[1];
      const children = childBlocksNode?.type === NODE_NAMES.childBlocks ? (childBlocksNode.content ?? []) : [];
      const nodeContent = contentNode.content ?? [];
      const nodeName = contentNode.type ?? FALLBACK_NODE_NAME;
      const attrs = contentNode.attrs ?? {};
      const content = contentFor(nodeName, attrs, nodeContent);

      result.push({
        id,
        parentBlockId,
        afterId,
        blockType: blockTypeFor(nodeName, attrs),
        content,
        plainText: plainTextFor(nodeName, content, nodeContent),
      });
      afterId = id;
      if (children.length > 0) walk(children, id);
    }
  }

  walk(doc.content ?? [], null);
  return result;
}

/** The inverse of `docToFlatBlocks`, from what the backend (or the local stub) actually stores: a page's `Block[]` (contract.ts), each already carrying its own `position` for ordering among siblings. */
export function blocksToDoc(blocks: Block[]): JSONContent {
  const childrenByParent = new Map<BlockId | null, Block[]>();
  for (const block of blocks) {
    const siblings = childrenByParent.get(block.parentBlockId);
    if (siblings) siblings.push(block);
    else childrenByParent.set(block.parentBlockId, [block]);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }

  function buildContentNode(block: Block): JSONContent {
    const { nodeName, attrs } = nodeShapeFor(block);
    const node: JSONContent = { type: nodeName, attrs: { ...attrs, id: block.id } };
    if (nodeHasContent(nodeName)) {
      const content = nodeContentFor(nodeName, block.content);
      if (content.length > 0) node.content = content;
    }
    return node;
  }

  /** One `Block` wrapper: its `blockContent` node, plus a `childBlocks` second child when it has any (see `schema.ts`). */
  function buildWrapper(block: Block): JSONContent {
    const contentNode = buildContentNode(block);
    const children = childrenByParent.get(block.id) ?? [];
    const wrapperContent: JSONContent[] = [contentNode];
    if (children.length > 0) {
      wrapperContent.push({ type: NODE_NAMES.childBlocks, content: children.map(buildWrapper) });
    }
    return { type: NODE_NAMES.block, content: wrapperContent };
  }

  const roots = childrenByParent.get(null) ?? [];
  if (roots.length === 0) {
    return {
      type: NODE_NAMES.doc,
      content: [
        { type: NODE_NAMES.block, content: [{ type: NODE_NAMES.paragraph, attrs: { id: newBlockId() } }] },
      ],
    };
  }
  return { type: NODE_NAMES.doc, content: roots.map(buildWrapper) };
}

function contentEquals(a: BlockContent, b: BlockContent): boolean {
  // Both sides are always built by the same spec's `content()` with the same
  // key order, so a plain string comparison is safe here and cheaper than a
  // structural deep-equal for content this small.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What changed between the last snapshot this editor knows was saved and
 * the doc's current flattened state - the batch `apply_block_changes`
 * (contract.ts) exists for. A block's own patch and a move it also
 * underwent are reported as two separate changes, matching `BlockChange`'s
 * shape (a patch never carries a placement).
 */
export function diffToChanges(pageId: PageId, previous: FlatBlock[], current: FlatBlock[]): BlockChange[] {
  const previousById = new Map(previous.map((block) => [block.id, block] as const));
  const currentIds = new Set(current.map((block) => block.id));
  const changes: BlockChange[] = [];

  for (const id of previousById.keys()) {
    if (!currentIds.has(id)) changes.push({ kind: "delete", id });
  }

  for (const block of current) {
    const before = previousById.get(block.id);
    if (!before) {
      changes.push({
        kind: "create",
        block: {
          // The id the node already carries in the doc - see `NewBlock.id`.
          id: block.id,
          blockType: block.blockType,
          content: block.content,
          plainText: block.plainText,
          placement: { pageId, parentBlockId: block.parentBlockId, afterBlockId: block.afterId },
        },
      });
      continue;
    }

    const patch: { blockType?: string; content?: BlockContent; plainText?: string } = {};
    if (before.blockType !== block.blockType) patch.blockType = block.blockType;
    if (!contentEquals(before.content, block.content)) patch.content = block.content;
    if (before.plainText !== block.plainText) patch.plainText = block.plainText;
    if (Object.keys(patch).length > 0) changes.push({ kind: "update", id: block.id, patch });

    if (before.parentBlockId !== block.parentBlockId || before.afterId !== block.afterId) {
      changes.push({
        kind: "move",
        id: block.id,
        placement: { pageId, parentBlockId: block.parentBlockId, afterBlockId: block.afterId },
      });
    }
  }

  return changes;
}

/** Exposed for `blocks-api.ts`'s local stub, which has to assign its own `position`/`createdAt`/`updatedAt` the way a real backend would. */
export { midpointPosition };
