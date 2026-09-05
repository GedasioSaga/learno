/**
 * EDT-017: o nó ProseMirror do bloco "link para página" - um átomo que
 * carrega só o id da página apontada. Não tem texto próprio (`content: ""`,
 * como `Divider` em `core/schema.ts`); título e ícone exibidos vêm ao vivo
 * de `usePageTreeStore` dentro de `LinkToPageView`, nunca congelados aqui,
 * para que renomear a página (FUN-045) propague sem tocar neste bloco.
 *
 * A reparentagem que separa este bloco da @menção (EDT-044, outro
 * construtor) não é responsabilidade deste arquivo - só a forma do nó mora
 * aqui. Ver `actions.ts` para onde a chamada de reparent de fato acontece.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { LinkToPageView } from "./LinkToPageView";

/** Nome do nó ProseMirror. */
export const NODE_NAME = "linkToPage";
/** Vocabulário persistido em `Block.blockType` (ver `register.ts`). */
export const BLOCK_TYPE = "link_to_page";

/**
 * Espelha o `idAttribute` privado de `core/schema.ts` - não é exportado de
 * lá, então todo construtor fora de `core/` que precisa do mesmo reflexo
 * `data-block-id` mantém sua própria cópia (é por isso que este arquivo
 * nunca importa de `core/schema.ts`, só de `core/node-names`/`core/commands`
 * quando precisa, ambas folhas do grafo de módulos).
 */
const idAttribute = {
  id: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const LinkToPage = Node.create({
  name: NODE_NAME,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      ...idAttribute,
      pageId: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-page-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.pageId ? { "data-page-id": attributes.pageId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAME}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAME,
        class: "ed-block ed-link-to-page",
        contenteditable: "false",
      }),
    ];
  },
  // A marcação interativa (ícone+título ao vivo, clique navega) precisa de
  // estado externo ao nó (o título mora em `usePageTreeStore`, não em
  // `attrs`) - por isso React aqui, diferente dos NodeViews vanilla de
  // `core/node-views.ts`, onde tudo que muda já é um attr do próprio nó.
  addNodeView() {
    return ReactNodeViewRenderer<HTMLDivElement>(LinkToPageView);
  },
});
