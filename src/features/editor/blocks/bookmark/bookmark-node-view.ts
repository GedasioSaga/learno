/**
 * Vanilla ProseMirror NodeView, same choice `core/node-views.ts` makes for
 * the todo checkbox and toggle arrow: the card has no state beyond the
 * node's own attrs, so a React subtree per bookmark would buy nothing. The
 * actual DOM building is `renderBookmarkCard` (`bookmark-card.ts`) - this
 * class is only the ProseMirror wiring around it.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { renderBookmarkCard } from "./bookmark-card";
import { BOOKMARK_NODE_NAME } from "./constants";
import { openBookmarkUrl } from "./open-url";

function contentOf(node: PMNode) {
  return {
    url: typeof node.attrs.url === "string" ? node.attrs.url : "",
    title: typeof node.attrs.title === "string" ? node.attrs.title : "",
    description: typeof node.attrs.description === "string" ? node.attrs.description : "",
    favicon: typeof node.attrs.favicon === "string" ? node.attrs.favicon : null,
  };
}

class BookmarkNodeView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;

  constructor({ node }: NodeViewRendererProps) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "ed-block ed-bookmark";
    this.dom.setAttribute("data-block-type", BOOKMARK_NODE_NAME);
    this.dom.setAttribute("contenteditable", "false");
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);
    this.render();
  }

  private render(): void {
    const content = contentOf(this.node);
    renderBookmarkCard(this.dom, content, () => {
      void openBookmarkUrl(content.url);
    });
  }

  update(node: PMNode): boolean {
    if (node.type.name !== BOOKMARK_NODE_NAME) return false;
    this.node = node;
    this.render();
    return true;
  }
}

export function bookmarkNodeView(props: NodeViewRendererProps): NodeView {
  return new BookmarkNodeView(props);
}
