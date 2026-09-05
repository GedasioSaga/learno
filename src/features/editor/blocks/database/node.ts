/**
 * DBS-001: o nó ProseMirror do bloco "database inline" — um átomo que
 * carrega só o id da database embutida (a database em si é uma linha de
 * `databases`, arquitetura §11 desta peça — S2). Igual a `LinkToPage`
 * (`../page-link/node.ts`), o conteúdo mostrado (nome, propriedades,
 * bloqueio) nunca é congelado num attr — vem de quem resolve o `databaseId`
 * (ver `DatabaseBlockView.tsx` e a divergência S2 registrada no relatório
 * desta peça: ainda não existe, nesta rodada, um comando Rust que leia o
 * esquema de uma database por id).
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { DatabaseBlockView } from "./DatabaseBlockView";

/** Nome do nó ProseMirror. */
export const NODE_NAME = "databaseInline";
/** Vocabulário persistido em `Block.blockType` (ver `register.ts`). */
export const BLOCK_TYPE = "database";

/**
 * Espelha o `idAttribute` privado de `core/schema.ts` — mesma cópia que
 * `../page-link/node.ts` mantém, pela mesma razão descrita lá: não é
 * exportado de `core/`, então todo construtor fora de `core/` guarda a sua.
 */
const idAttribute = {
  id: {
    // `as string | null`: sem isto TipTap infere o tipo do attr como
    // `null` (o literal), não `string | null` — o mesmo padrão de
    // `../page-link/node.ts`.
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const DatabaseInline = Node.create({
  name: NODE_NAME,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      ...idAttribute,
      databaseId: {
        // `as string | null`: sem isto TipTap infere o tipo do attr como
    // `null` (o literal), não `string | null` — o mesmo padrão de
    // `../page-link/node.ts`.
    default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-database-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.databaseId ? { "data-database-id": attributes.databaseId } : {},
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
        class: "ed-block ed-database-inline",
        contenteditable: "false",
      }),
    ];
  },
  // O contêiner (`DatabaseContainer`) é estado React puro vindo de
  // `src/features/databases/container` — não um attr do nó — por isso
  // NodeView React, igual a `LinkToPage`.
  addNodeView() {
    return ReactNodeViewRenderer<HTMLDivElement>(DatabaseBlockView);
  },
});
