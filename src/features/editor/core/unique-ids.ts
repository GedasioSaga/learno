/**
 * Schema `default` values in ProseMirror are static - they can't call
 * `crypto.randomUUID()` per node, so `schema.ts` leaves every block's `id`
 * attribute defaulting to `null` and trusts each construction site (input
 * rules, `commands.ts`) to pass a real one. This extension is the safety net
 * for the paths that don't go through those: pasting a block (native
 * ProseMirror paste clones the source node's JSON, `id` included) or any
 * future code that forgets. Without it, two blocks could carry the same id
 * and `serialize.ts` would silently conflate them into one `Block` row.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { newBlockId } from "./ids";
import { isBlockContentType } from "./node-names";

export const UniqueBlockIds = Extension.create({
  name: "uniqueBlockIds",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const seen = new Set<string>();
          const fixes: { pos: number; id: string }[] = [];
          newState.doc.descendants((node, pos) => {
            // Every block type, core's nine and every one a builder registered
            // - a pasted image or table needs a fresh id exactly as much as a
            // pasted paragraph does. See `isBlockContentType`.
            if (!isBlockContentType(node.type)) return true;
            const id = node.attrs.id;
            if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
              seen.add(id);
            } else {
              fixes.push({ pos, id: newBlockId() });
            }
            return true;
          });

          if (fixes.length === 0) return null;
          const tr = newState.tr;
          for (const fix of fixes) {
            tr.setNodeAttribute(fix.pos, "id", fix.id);
          }
          return tr;
        },
      }),
    ];
  },
});
