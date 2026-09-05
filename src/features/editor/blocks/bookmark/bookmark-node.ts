/**
 * The `bookmark` node itself: an atom (no editable content - `hasContent:
 * false` on its `BlockSpec` in `bookmark-spec.ts` matches this exactly), so
 * its four data attrs (`url`/`title`/`description`/`favicon`) are the whole
 * block, the same shape `schema.ts`'s nine core types use for their own
 * `id` attribute (reflected to `data-block-id`, not stored as ProseMirror
 * text).
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { bookmarkNodeView } from "./bookmark-node-view";
import { BOOKMARK_NODE_NAME } from "./constants";

export const BookmarkNode = Node.create({
  name: BOOKMARK_NODE_NAME,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: {
        // Widens the inferred `null` literal to the attr's real type - the
        // id is only ever `null` before `unique-ids.ts`'s safety net (or an
        // input-rule/command) fills it in; same pattern `schema.ts` uses for
        // every other block's `id` attribute.
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.id ? { "data-block-id": attributes.id } : {},
      },
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      // Same widening as `id` above - `null` is the honest "no favicon yet"
      // default (fetchBookmarkMetadata's fallback never fabricates one).
      favicon: { default: null as string | null },
    };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${BOOKMARK_NODE_NAME}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": BOOKMARK_NODE_NAME,
        class: "ed-block ed-bookmark",
        contenteditable: "false",
      }),
    ];
  },
  addNodeView() {
    return bookmarkNodeView;
  },
});
