/**
 * The only two block types whose marker is *interactive* rather than pure
 * CSS: a to-do's checkbox (EDT-009 - clicking it toggles `checked`) and a
 * toggle's collapse arrow (EDT-010 - clicking it flips `collapsed`, which a
 * CSS rule in `editor.css` then uses to hide/show `.ed-children`). Every
 * other block type needs no NodeView at all (see `schema.ts`).
 *
 * Both are vanilla ProseMirror NodeViews (not `ReactNodeViewRenderer`) - the
 * marker itself has no state of its own beyond the node's own attrs, so a
 * whole React subtree per block would buy nothing here.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

class TodoItemNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private checkbox: HTMLButtonElement;
  private node: PMNode;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "ed-block ed-todo";
    this.dom.setAttribute("data-block-type", "todoItem");
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);
    this.dom.setAttribute("data-checked", String(Boolean(node.attrs.checked)));

    this.checkbox = document.createElement("button");
    this.checkbox.type = "button";
    this.checkbox.className = "ed-todo__checkbox";
    this.checkbox.setAttribute("role", "checkbox");
    this.syncCheckboxLabel();
    this.checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const current = editor.state.doc.nodeAt(pos);
      if (!current) return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "checked", !current.attrs.checked));
    });

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "ed-todo__content";

    this.dom.append(this.checkbox, this.contentDOM);
  }

  private syncCheckboxLabel() {
    const checked = Boolean(this.node.attrs.checked);
    this.checkbox.setAttribute("aria-checked", String(checked));
    this.checkbox.setAttribute("aria-label", checked ? "Marcar como não concluída" : "Marcar como concluída");
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "todoItem") return false;
    this.node = node;
    this.dom.setAttribute("data-checked", String(Boolean(node.attrs.checked)));
    this.syncCheckboxLabel();
    return true;
  }
}

class ToggleNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private arrow: HTMLButtonElement;
  private node: PMNode;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "ed-block ed-toggle";
    this.dom.setAttribute("data-block-type", "toggle");
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);
    this.dom.setAttribute("data-collapsed", String(Boolean(node.attrs.collapsed)));

    this.arrow = document.createElement("button");
    this.arrow.type = "button";
    this.arrow.className = "ed-toggle__arrow";
    this.syncArrowLabel();
    this.arrow.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const current = editor.state.doc.nodeAt(pos);
      if (!current) return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "collapsed", !current.attrs.collapsed));
    });

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "ed-toggle__content";

    this.dom.append(this.arrow, this.contentDOM);
  }

  private syncArrowLabel() {
    const collapsed = Boolean(this.node.attrs.collapsed);
    this.arrow.setAttribute("aria-expanded", String(!collapsed));
    this.arrow.setAttribute("aria-label", collapsed ? "Expandir" : "Recolher");
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "toggle") return false;
    this.node = node;
    this.dom.setAttribute("data-collapsed", String(Boolean(node.attrs.collapsed)));
    this.syncArrowLabel();
    return true;
  }
}

export function todoItemNodeView(props: NodeViewRendererProps): NodeView {
  return new TodoItemNodeView(props);
}

export function toggleNodeView(props: NodeViewRendererProps): NodeView {
  return new ToggleNodeView(props);
}
