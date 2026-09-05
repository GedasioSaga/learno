/**
 * EDT-033: os dois tipos de nó estruturais de "colunas". Ambos no grupo
 * `"blockContent"` (nunca `"block"` - ver README) e com `content: ""`: nem
 * `columnList` nem `column` guardam texto ou uma árvore própria dentro de si
 * mesmos, exatamente como `divider` em `core/schema.ts` - o que cada um
 * "contém" de verdade é o `childBlocks` do `Block` wrapper que os envolve
 * (ver `node-names.ts` para a árvore completa e por quê).
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { columnNodeView } from "./column-node-view";
import { COLUMN_LIST_NODE_NAME, COLUMN_NODE_NAME, DEFAULT_COLUMN_WIDTH } from "./node-names";

/** Mesmo padrão do `idAttribute` de `core/schema.ts` (não é exportado de lá - ver `math/equation-block.ts` para o mesmo comentário de outro builder). */
const idAttribute = {
  id: {
    default: null as string | null, // alarga o tipo do literal `null` p/ `string | null` - nunca esconde erro, `id` só chega de verdade via input rule/comando (ver `core/schema.ts`'s idêntico idAttribute)
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const ColumnList = Node.create({
  name: COLUMN_LIST_NODE_NAME,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${COLUMN_LIST_NODE_NAME}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    // Puramente estrutural - a própria div não mostra nada; é a irmã dela
    // (`.ed-children`, o `childBlocks` com as colunas) que `columns.css`
    // transforma numa linha flex via seletor de irmão adjacente.
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": COLUMN_LIST_NODE_NAME,
        class: "ed-block ed-column-list",
        contenteditable: "false",
        "aria-hidden": "true",
      }),
    ];
  },
});

export const Column = Node.create({
  name: COLUMN_NODE_NAME,
  group: "blockContent",
  content: "",
  addAttributes() {
    return { ...idAttribute, width: { default: DEFAULT_COLUMN_WIDTH } };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${COLUMN_NODE_NAME}"]` }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": COLUMN_NODE_NAME,
        "data-width": String(node.attrs.width),
        class: "ed-block ed-column",
        contenteditable: "false",
      }),
    ];
  },
  // A alça de redimensionar (EDT-033: arraste E teclado) e a própria largura
  // da coluna (uma propriedade CSS no `Block` wrapper que este nó nem
  // controla via `renderHTML` - ver `column-node-view.ts` para o porquê)
  // exigem DOM imperativo; não dá pra fazer só com `renderHTML`.
  addNodeView() {
    return columnNodeView;
  },
});

export const columnStructuralNodes = [ColumnList, Column];
