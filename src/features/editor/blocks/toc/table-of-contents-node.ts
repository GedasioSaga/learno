/**
 * EDT-031: the table-of-contents block itself. An atom like `Divider` in
 * `core/schema.ts` (`content: ""`) - there is nothing to type or persist
 * beyond the block's own existence, because its list is derived from the
 * page's headings on every render (`TocView.tsx`), not stored.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TocNodeView } from "./TocView";

/** ProseMirror node type name - distinct from the persisted `Block.blockType` below (see `contract.ts`/README on why the two vocabularies differ). */
export const TOC_NODE_NAME = "tableOfContents";
/** `Block.blockType` this node persists as. */
export const TOC_BLOCK_TYPE = "table_of_contents";

/** Same shape as `core/schema.ts`'s own (private) `idAttribute` - every `blockContent` node reflects its id to `data-block-id` so the DOM node stays addressable by it. */
const idAttribute = {
  id: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const TableOfContents = Node.create({
  name: TOC_NODE_NAME,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${TOC_NODE_NAME}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": TOC_NODE_NAME,
        class: "ed-block ed-toc-block",
        contenteditable: "false",
      }),
    ];
  },
  // A NodeView (not plain `renderHTML`) because the list is derived and has
  // to re-render on every doc change, not just when this node's own attrs
  // change - see `TocView.tsx`.
  addNodeView() {
    return ReactNodeViewRenderer(TocNodeView);
  },
});
