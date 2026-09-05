/**
 * EDT-044's chip: an inline atom NodeView, vanilla ProseMirror (same choice
 * `core/node-views.ts` makes for todoItem/toggle) - the chip's own text has
 * no state beyond which page it points at, so a React subtree per mention
 * would buy nothing.
 *
 * The one thing this NodeView cannot get from `node.attrs` alone is the
 * page's *current* title: `attrs.label` is whatever the title was the
 * instant the mention was inserted, and FUN-045 (renomear propaga, another
 * builder's item) depends on this chip re-reading the title by `id` instead
 * of trusting that frozen copy. `usePageTreeStore.subscribe` is what makes
 * that live - a rename anywhere in the app updates `pagesById`, this
 * subscription fires, and `renderLabel` re-reads the current title.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { usePageTreeStore } from "../../../pages/store";
import { displayTitle } from "../../../pages/tree-utils";
import { MENTION_PAGE_NODE_NAME } from "./node-name";

/** Same fallback glyph `PageTreeItem`/`Breadcrumb` use for a `PageRow` with `icon: null` - the chip's icon follows the same convention as the rest of the app instead of inventing its own. */
const DEFAULT_PAGE_ICON = "📄";
/** Shown instead of a blank chip when the store has no page for this id - deleted page, or the tree hasn't loaded yet. */
const UNKNOWN_PAGE_LABEL = "página";

function pageIdOf(node: PMNode): string | null {
  return typeof node.attrs.id === "string" ? node.attrs.id : null;
}

/** The label frozen onto the node at insertion time - the *only* correct place to read it: after a real page lookup misses. */
function frozenLabelOf(node: PMNode): string {
  return typeof node.attrs.label === "string" && node.attrs.label.trim() !== "" ? node.attrs.label : UNKNOWN_PAGE_LABEL;
}

class MentionPageNodeView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private readonly unsubscribe: () => void;

  constructor({ node }: NodeViewRendererProps) {
    this.node = node;

    // Um <a> real em vez de <span role="link"> - HTML semântico primeiro
    // (regra 16/README): navegação por teclado, foco e o papel de link já
    // vêm de graça do próprio elemento, sem ARIA nenhuma.
    const anchor = document.createElement("a");
    anchor.href = "#";
    anchor.className = "ed-mention-page";
    anchor.contentEditable = "false";
    anchor.addEventListener("click", (event) => {
      // Sempre interceptado: dentro do app não existe "abrir link" de
      // verdade, só a troca de página que `navigate()` faz.
      event.preventDefault();
      this.navigate();
    });
    this.dom = anchor;

    this.renderLabel();
    this.unsubscribe = usePageTreeStore.subscribe(() => this.renderLabel());
  }

  private navigate(): void {
    const pageId = pageIdOf(this.node);
    if (!pageId) return;
    // EDT-044: só troca qual página está aberta - nunca `move`/`rename`, daí
    // a mention nunca alterar hierarquia nenhuma ao ser clicada.
    usePageTreeStore.getState().selectPage(pageId);
  }

  private renderLabel(): void {
    const pageId = pageIdOf(this.node);
    const page = pageId ? usePageTreeStore.getState().pagesById.get(pageId) : undefined;
    // O ícone segue a mesma regra do resto do app (`page.icon ?? "📄"`) tanto
    // achada quanto não achada a página - um chip sem nenhum ícone era o gap
    // que o critic apontou (EDT-044 pede "chip com ícone/título").
    const icon = page?.icon ?? DEFAULT_PAGE_ICON;
    const title = page ? displayTitle(page) : frozenLabelOf(this.node);
    this.dom.textContent = `${icon} ${title}`;
    this.dom.setAttribute("aria-label", `Ir para a página ${title}`);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== MENTION_PAGE_NODE_NAME) return false;
    this.node = node;
    this.renderLabel();
    return true;
  }

  destroy(): void {
    this.unsubscribe();
  }
}

export function mentionPageNodeView(props: NodeViewRendererProps): NodeView {
  return new MentionPageNodeView(props);
}
