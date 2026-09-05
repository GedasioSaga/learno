/**
 * EDT-074's provable slice of "sem refresh manual": within ONE open page,
 * editing a synced block's text mirrors instantly into every other block in
 * the SAME doc sharing its group (`synced-store.ts`'s `siblingsInGroup`) -
 * no round trip, no debounce wait, no reload.
 *
 * The cross-page half of EDT-074 - a copy on page B edited while page A is
 * "open" elsewhere - is `update_block`'s own job server-side
 * (`src-tauri/src/db/blocks.rs`'s `apply_patch_to_copies` propagates to
 * every copy in the same transaction that patches whichever one was
 * edited), plus this app's own navigation: `Editor` reloads a page's blocks
 * straight from Postgres on every mount (`core/use-blocks-document.ts`), so
 * re-opening A after editing B always shows the latest content with no
 * manual "refresh" action - there is no second `Editor` instance mounted at
 * the same time as B's to prove that half inside one jsdom test either
 * (`PageWorkspace.tsx` mounts exactly one `Editor` at a time, keyed by
 * page - see its own comment on why). Documented in the report's mechanism
 * explanation rather than faked with a test that doesn't exercise it.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { BLOCK_NODE_NAMES } from "../core/node-names";
import { siblingsInGroup } from "./synced-store";

function isBlockContentNode(node: PMNode): boolean {
  // Widened the same way `core/commands.ts`'s own `isBlockContentNode` is:
  // `BLOCK_NODE_NAMES` is typed as a fixed literal-string union array, and
  // `.includes` needs `string` to accept `node.type.name`'s wider runtime type.
  return (BLOCK_NODE_NAMES as readonly string[]).includes(node.type.name);
}

/** The `blockContent` node holding `$from`, or `null` - same depth-walk `core/commands.ts`'s `contentDepthOf` does, reimplemented here since that one takes an `Editor`, not a bare `ResolvedPos`, and this plugin only ever sees `EditorState`. */
function blockContentNodeAt($from: ResolvedPos): PMNode | null {
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const node = $from.node(depth);
    if (isBlockContentNode(node)) return node;
  }
  return null;
}

/**
 * Pure so `live-mirror-extension.test.ts` can drive it without a real
 * `EditorView`: given the doc a transaction just produced and the selection
 * it left behind, returns the `(pos, nodeSize)` of every sibling block whose
 * content has fallen out of sync with the block the selection sits in - the
 * one the user was just typing into.
 */
export function findOutOfSyncSiblings(doc: PMNode, selectionFrom: ResolvedPos): { pos: number; nodeSize: number }[] {
  const editedNode = blockContentNodeAt(selectionFrom);
  if (!editedNode) return [];
  const editedId = editedNode.attrs.id;
  if (typeof editedId !== "string") return [];

  const siblingIds = siblingsInGroup(editedId);
  if (siblingIds.length === 0) return [];

  const targets: { pos: number; nodeSize: number }[] = [];
  doc.descendants((node, pos) => {
    if (!isBlockContentNode(node)) return true;
    const id = node.attrs.id;
    if (typeof id !== "string" || !siblingIds.includes(id)) return true;
    if (!node.content.eq(editedNode.content)) targets.push({ pos, nodeSize: node.nodeSize });
    return true;
  });
  return targets;
}

export const LiveMirrorExtension = Extension.create({
  name: "syncedLiveMirror",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const editedNode = blockContentNodeAt(newState.selection.$from);
          if (!editedNode) return null;

          const targets = findOutOfSyncSiblings(newState.doc, newState.selection.$from);
          if (targets.length === 0) return null;

          let tr = newState.tr;
          for (const target of targets) {
            // +1/-1: `replaceWith`'s range is the node's own *content*, not
            // its opening/closing tag - the same convention `commands.ts`'s
            // merge/indent helpers use throughout.
            const from = tr.mapping.map(target.pos) + 1;
            const to = tr.mapping.map(target.pos + target.nodeSize) - 1;
            tr = tr.replaceWith(from, to, editedNode.content);
          }
          // Never steals focus/selection from whichever block the user is
          // actually typing in - only the sibling ranges moved.
          return tr;
        },
      }),
    ];
  },
});
