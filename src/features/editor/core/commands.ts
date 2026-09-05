/**
 * Enter, Shift+Tab, Tab and Backspace at block boundaries (EDT-064 through
 * EDT-070). Shift+Enter (soft break) and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z
 * (EDT-062/063) need nothing here - StarterKit's `hardBreak` and `undoRedo`
 * extensions already bind those (see `extensions.ts`).
 *
 * Every function below takes the live `Editor` and returns whether it
 * handled the key - the same shape `addKeyboardShortcuts` expects, so
 * `keymap.ts` is a thin one-line-per-key wire-up and all the tree surgery
 * lives here, exercised end-to-end (real `KeyboardEvent`s through the real
 * keymap, not these functions called directly) in `commands.test.ts`.
 *
 * Depth vocabulary used throughout (see `schema.ts` for why the extra
 * level exists): `contentDepth` is where `$from.parent` lives - the
 * `blockContent` node (paragraph/heading/...) holding the cursor's own
 * text. `wrapperDepth = contentDepth - 1` is its `Block` wrapper - the
 * thing that actually has siblings, a previous/next block, and an optional
 * `childBlocks` second child. Every "move this block" operation works at
 * `wrapperDepth`; only text-emptiness/offset checks work at `contentDepth`.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { newBlockId } from "./ids";
import { DEMOTABLE_NODE_NAMES, LIST_ITEM_NODE_NAMES, NODE_NAMES, isBlockContentType } from "./node-names";

/**
 * Asks the schema, not a fixed list: a block type registered from `blocks/`
 * or `synced/` is as much a block as core's nine, and the README promises
 * Enter/Tab/Shift-Tab/Backspace work inside it. Keying this off
 * `BLOCK_NODE_NAMES` made that promise false for every type a builder added.
 */
function isBlockContentNode(node: PMNode): boolean {
  return isBlockContentType(node.type);
}

/** A `Block` wrapper's own nested-children container, if it has one. */
function childBlocksOf(wrapper: PMNode): PMNode | null {
  return wrapper.childCount === 2 ? wrapper.lastChild : null;
}

function fragmentToArray(fragment: PMNode["content"]): PMNode[] {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => nodes.push(node));
  return nodes;
}

/**
 * EDT-049-adjacent primitive (also used by demotion/list-ending below):
 * changes a `blockContent` node's type in place, keeping its id and text -
 * "turning into" a different type is never a new block, it's the same one
 * relabeled. Never touches the wrapper.
 */
function convertBlockType(
  editor: Editor,
  contentDepth: number,
  newTypeName: string,
  extraAttrs: Record<string, unknown>,
): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const contentNode = $from.node(contentDepth);
  const newType = state.schema.nodes[newTypeName];
  if (!newType) return false;
  const pos = $from.before(contentDepth);
  const tr = state.tr.setNodeMarkup(pos, newType, { ...extraAttrs, id: contentNode.attrs.id });
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** EDT-010: Enter while the cursor is still in a toggle's own header text creates a nested empty paragraph, as the toggle's first child. */
function insertChildParagraph(editor: Editor, contentDepth: number): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const wrapperDepth = contentDepth - 1;
  const wrapper = $from.node(wrapperDepth);
  const existingChildren = childBlocksOf(wrapper);
  // Right after the `blockContent` node closes, still inside the wrapper -
  // exactly where `childBlocks` belongs (whether or not it exists yet).
  const insertAt = $from.after(contentDepth);

  const paragraphType = state.schema.nodes[NODE_NAMES.paragraph];
  const wrapperType = state.schema.nodes[NODE_NAMES.block];
  const paragraph = paragraphType.createAndFill({ id: newBlockId() });
  if (!paragraph) return false;
  const newWrapper = wrapperType.create(null, paragraph);

  const tr = state.tr;
  if (existingChildren) {
    tr.insert(insertAt + 1, newWrapper);
  } else {
    const childBlocksWrapper = state.schema.nodes[NODE_NAMES.childBlocks].create(null, newWrapper);
    tr.insert(insertAt, childBlocksWrapper);
  }
  // Enter `newWrapper` (+1), then its own `blockContent` node (+1). Both
  // branches insert `newWrapper` starting one position further in than the
  // other (`insertAt + 1` vs `insertAt`), so both land on `insertAt + 3`.
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 3), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Splits the current block's own text at the cursor into two sibling
 * `Block` wrappers. `nextTypeName`/`nextAttrs` describe the *second* half -
 * same type for list items (EDT-064), paragraph for everything else
 * (EDT-001). Splitting 2 levels up (`blockContent`, then its `Block`
 * wrapper) in one `Transform.split` is what turns one wrapper into two -
 * see `Transform.split`'s own doc comment on `typesAfter`, outermost first.
 *
 * Relies on `split`'s default selection mapping (the same thing
 * `prosemirror-commands`' own `splitBlock` does) to land the cursor at the
 * start of the new block, so no manual selection juggling here.
 *
 * Known boundary: if the original block already had nested children
 * (`childBlocks`, as the wrapper's second child), `split` hands them to the
 * *second* half, since they sit after the cursor in document order. Not
 * exercised by any Fase 2 criterion (EDT-010 handles toggle - the one type
 * this is meant to nest under - separately, above) - flagged here rather
 * than silently accepted.
 */
function splitBlock(editor: Editor, nextTypeName: string, nextAttrs: Record<string, unknown>): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const nextType = state.schema.nodes[nextTypeName];
  const wrapperType = state.schema.nodes[NODE_NAMES.block];
  if (!nextType || !wrapperType) return false;
  const tr = state.tr.split($from.pos, 2, [{ type: wrapperType }, { type: nextType, attrs: { ...nextAttrs, id: newBlockId() } }]);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function handleEnter(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const contentDepth = $from.depth;
  if (contentDepth < 2) return false; // must have at least doc > Block > blockContent
  const contentNode = $from.node(contentDepth);
  if (!isBlockContentNode(contentNode)) return false;
  if (contentNode.type.name === NODE_NAMES.divider) return false;

  if (contentNode.type.name === NODE_NAMES.toggle) {
    return insertChildParagraph(editor, contentDepth);
  }

  const isListItem = (LIST_ITEM_NODE_NAMES as readonly string[]).includes(contentNode.type.name);
  const isEmpty = contentNode.content.size === 0;

  if (isListItem && isEmpty) {
    // EDT-065: Enter on an empty list item ends the list right there.
    return convertBlockType(editor, contentDepth, NODE_NAMES.paragraph, {});
  }

  const nextTypeName = isListItem ? contentNode.type.name : NODE_NAMES.paragraph;
  const nextAttrs = isListItem && contentNode.type.name === NODE_NAMES.todoItem ? { checked: false } : {};
  return splitBlock(editor, nextTypeName, nextAttrs);
}

/** EDT-067: Tab at the start of a block nests its whole wrapper (own children included) as the last child of the previous sibling. No-op for the first block among its siblings - there's nothing to indent under. */
export function handleTab(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const contentDepth = $from.depth;
  if (contentDepth < 2) return false;
  const contentNode = $from.node(contentDepth);
  if (!isBlockContentNode(contentNode)) return false;

  const wrapperDepth = contentDepth - 1;
  const wrapperBefore = $from.before(wrapperDepth);
  if (wrapperBefore === 0) return false;
  const prevWrapper = state.doc.resolve(wrapperBefore).nodeBefore;
  if (!prevWrapper || prevWrapper.type.name !== NODE_NAMES.block) return false;

  const wrapperEnd = $from.after(wrapperDepth);
  const movedWrapper = $from.node(wrapperDepth);
  const tr = state.tr.delete(wrapperBefore, wrapperEnd);

  // Where the moved wrapper's own content starts once inserted - the two
  // branches land at different depths, and conflating them was a real bug
  // (see `commands.test.ts`, "Tab sob um irmão que já tem filhos").
  let insertAt: number;
  if (childBlocksOf(prevWrapper) !== null) {
    // `prevWrapper` already has a `childBlocks`, and it is its last child, so
    // that node *ends* at `wrapperBefore - 1` and its own content ends one
    // token further in, at `wrapperBefore - 2`. Appending there makes
    // `movedWrapper` the existing container's new last child. Inserting at
    // `wrapperBefore - 1` instead - which is what this used to do - aims at
    // `prevWrapper`'s content *after* the `childBlocks`, where a second
    // `childBlocks` is not legal ("blockContent childBlocks?"), and
    // ProseMirror resolves the impossible insertion by leaving the block at
    // top level: Tab silently did nothing.
    insertAt = wrapperBefore - 2;
    tr.insert(insertAt, movedWrapper);
  } else {
    // No container yet: one is created around `movedWrapper` and inserted at
    // the end of `prevWrapper`'s content, one token further out.
    insertAt = wrapperBefore - 1;
    tr.insert(insertAt, state.schema.nodes[NODE_NAMES.childBlocks].create(null, movedWrapper));
    // The extra `childBlocks` opening token this branch adds sits between
    // `insertAt` and the moved wrapper.
    insertAt += 1;
  }
  // Enter `movedWrapper` (+1), then its own `blockContent` node (+1).
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 2), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** EDT-068: Shift+Tab at the start of a nested block promotes its whole wrapper back to a sibling of its old container, right after it. No-op when the block isn't nested. */
export function handleShiftTab(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const contentDepth = $from.depth;
  if (contentDepth < 4) return false; // doc > containerBlock > childBlocks > ownBlock > blockContent
  const contentNode = $from.node(contentDepth);
  if (!isBlockContentNode(contentNode)) return false;

  const ownWrapperDepth = contentDepth - 1;
  const childBlocksDepth = ownWrapperDepth - 1;
  const childBlocksNode = $from.node(childBlocksDepth);
  if (childBlocksNode.type.name !== NODE_NAMES.childBlocks) return false;
  const containerWrapperDepth = childBlocksDepth - 1;

  const wrapperBefore = $from.before(ownWrapperDepth);
  const wrapperEnd = $from.after(ownWrapperDepth);
  const movedWrapper = $from.node(ownWrapperDepth);
  const containerAfter = $from.after(containerWrapperDepth);

  // `childBlocks` requires at least one child ("block+"). Deleting just
  // `movedWrapper`'s own range when it's the *only* child would leave that
  // requirement briefly unmet mid-transaction - `Transform.delete` doesn't
  // tolerate that, it silently auto-fills a blank paragraph to keep the doc
  // valid (confirmed by `zzz-debug.test.ts` while chasing this exact bug),
  // which is never what Shift-Tab should produce. Deleting the whole
  // now-redundant `childBlocks` node in that case, in the same step,
  // sidesteps the auto-fill entirely instead of cleaning up after it.
  const removingLastChild = childBlocksNode.childCount === 1;
  const deleteFrom = removingLastChild ? $from.before(childBlocksDepth) : wrapperBefore;
  const deleteTo = removingLastChild ? deleteFrom + childBlocksNode.nodeSize : wrapperEnd;
  const tr = state.tr.delete(deleteFrom, deleteTo);

  const insertAt = tr.mapping.map(containerAfter);
  tr.insert(insertAt, movedWrapper);
  // Enter `movedWrapper` (+1), then its own `blockContent` node (+1).
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 2), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * EDT-069/EDT-070: Backspace at the start of a block's own text.
 *
 * - Empty `blockContent` of a "special" type (heading/list item/toggle/
 *   quote/callout): first press demotes to paragraph (EDT-070's first
 *   half) - never touches the wrapper.
 * - Otherwise: merge the current block's text into the end of the previous
 *   sibling's text, splicing plain inline content across the two wrappers
 *   (never `Transform.join` - the two `blockContent` nodes are cousins, not
 *   siblings, so ProseMirror can't join them directly). Whatever children
 *   the removed wrapper had are re-homed onto the end of the previous
 *   wrapper's own children, creating a `childBlocks` there if it didn't
 *   have one. A second Backspace on the paragraph EDT-070 just demoted to
 *   falls through here as an empty paragraph merging into its predecessor,
 *   which *is* "the block disappears" (EDT-070's second half) - no separate
 *   delete path needed.
 */
export function handleBackspace(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const contentDepth = $from.depth;
  if (contentDepth < 2) return false;
  const contentNode = $from.node(contentDepth);
  if (!isBlockContentNode(contentNode)) return false;

  const isEmpty = contentNode.content.size === 0;
  if (isEmpty && (DEMOTABLE_NODE_NAMES as readonly string[]).includes(contentNode.type.name)) {
    return convertBlockType(editor, contentDepth, NODE_NAMES.paragraph, {});
  }

  const wrapperDepth = contentDepth - 1;
  const wrapperBefore = $from.before(wrapperDepth);
  if (wrapperBefore === 0) return false;
  const prevWrapper = state.doc.resolve(wrapperBefore).nodeBefore;
  if (!prevWrapper || prevWrapper.type.name !== NODE_NAMES.block) return false;

  const prevContentNode = prevWrapper.firstChild;
  if (!prevContentNode) return false;
  // Enter `prevWrapper` (+1), then its own `blockContent` node (+1), to
  // reach the start of its text; its end is `size` further in.
  const prevContentStart = wrapperBefore - prevWrapper.nodeSize + 2;
  const mergeAt = prevContentStart + prevContentNode.content.size;

  const wrapperEnd = $from.after(wrapperDepth);
  const currentWrapper = $from.node(wrapperDepth);
  const currentInline = contentNode.content;
  const currentChildren = childBlocksOf(currentWrapper);

  const tr = state.tr;
  tr.insert(mergeAt, currentInline);
  const insertedSize = currentInline.size;
  tr.delete(wrapperBefore + insertedSize, wrapperEnd + insertedSize);

  if (currentChildren && currentChildren.childCount > 0) {
    const movedChildren = fragmentToArray(currentChildren.content);
    const prevChildBlocks = childBlocksOf(prevWrapper);
    // Right before `prevWrapper`'s own closing tag in the now-merged doc -
    // the correct append point whether or not it already had `childBlocks`
    // (when it does, that container is `prevWrapper`'s last child, so its
    // own end coincides with `prevWrapper`'s end; nothing sits between them).
    const appendAt = tr.mapping.map(wrapperBefore) - 1;
    if (prevChildBlocks) {
      tr.insert(appendAt, movedChildren);
    } else {
      tr.insert(appendAt, state.schema.nodes[NODE_NAMES.childBlocks].create(null, movedChildren));
    }
  }

  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(mergeAt)), -1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------
// Public primitives for builders outside `core/`
//
// A `/` menu entry (EDT-047) and a "Turn into" entry (EDT-049) both need to
// do exactly one of two things to the block holding the cursor: relabel it,
// or put a new block next to it. Both need the `contentDepth` bookkeeping
// this file already does for the keymap, so they live here rather than
// being re-derived - badly - in each builder's folder.
// ---------------------------------------------------------------------------

/**
 * The depth at which the `blockContent` node holding the selection lives, or
 * `null` when the selection isn't inside one (an empty doc mid-transaction,
 * a NodeSelection on a wrapper). See this file's header for the depth
 * vocabulary.
 */
export function contentDepthOf(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    if (isBlockContentNode($from.node(depth))) return depth;
  }
  return null;
}

/** The `blockContent` node holding the selection, or `null`. */
export function currentBlockNode(editor: Editor): PMNode | null {
  const depth = contentDepthOf(editor);
  return depth === null ? null : editor.state.selection.$from.node(depth);
}

/**
 * EDT-049: relabel the block holding the selection, keeping its id and its
 * text. The same primitive the keymap's demotion path uses, exposed so a
 * "Turn into" entry registered from `blocks/` needs no tree surgery of its
 * own.
 */
export function turnCurrentBlockInto(
  editor: Editor,
  nodeName: string,
  attrs: Record<string, unknown> = {},
): boolean {
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  return convertBlockType(editor, depth, nodeName, attrs);
}

/**
 * What a `/` menu entry does on confirm: an empty block is *converted* (the
 * `/` and the filter text the user typed are that block's whole content, so
 * leaving it behind as an empty paragraph above the new block is wrong),
 * and a block with text keeps its text and gets the new block as its next
 * sibling.
 *
 * `content` is the new node's content array, for a type that needs one
 * seeded (a table's rows, a code block's text). Omit it for a textual block
 * or an atom.
 */
export function insertBlockHere(
  editor: Editor,
  nodeName: string,
  attrs: Record<string, unknown> = {},
  content?: PMNode[],
): boolean {
  const { state } = editor;
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  const type = state.schema.nodes[nodeName];
  const wrapperType = state.schema.nodes[NODE_NAMES.block];
  if (!type || !wrapperType) return false;

  const contentNode = state.selection.$from.node(depth);
  const seeded = content && content.length > 0 ? content : undefined;
  if (contentNode.content.size === 0 && !seeded) {
    return convertBlockType(editor, depth, nodeName, attrs);
  }

  // An `id` in `attrs` wins: a builder that has to reference the block it
  // just inserted (to write a link row, to paste a synced copy) generates
  // the id itself with `newBlockId()` and passes it in, instead of having to
  // hunt the doc afterwards for a block it cannot identify.
  const id = typeof attrs.id === "string" && attrs.id.length > 0 ? attrs.id : newBlockId();
  const newNode = type.create({ ...attrs, id }, seeded);
  const wrapper = wrapperType.create(null, newNode);
  const wrapperDepth = depth - 1;
  const insertAt = state.selection.$from.after(wrapperDepth);
  const tr = state.tr.insert(insertAt, wrapper);
  // `insertAt + 2` enters the new wrapper and then its content node; for an
  // atom with no text position inside it, `TextSelection.near` walks
  // forward to the nearest valid one instead of throwing.
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(insertAt + 2, tr.doc.content.size)), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Replaces the `/` trigger text before the cursor - the `/` itself plus
 * whatever was typed to filter - so the block the menu acts on doesn't keep
 * the query as leftover text. Returns the transaction-applied editor state's
 * success, and is a no-op when there is no such text (the menu was opened
 * some other way).
 */
export function clearSlashQuery(editor: Editor, queryLength: number): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty) return false;
  // +1 for the "/" itself.
  const from = $from.pos - queryLength - 1;
  if (from < $from.start()) return false;
  editor.view.dispatch(state.tr.delete(from, $from.pos));
  return true;
}
