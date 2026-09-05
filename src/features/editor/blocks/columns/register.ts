/**
 * Ponto de descoberta automática desta peça (EDT-033: colunas / layout
 * multi-coluna) - ver `discover-extensions.ts`'s `import.meta.glob`. Importa
 * sempre de `../../core/<módulo>`, nunca de `../../index` (README).
 */
import { registerBlockSpec, registerSlashMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { coerceWidth, wrapCurrentBlockInColumns } from "./column-commands";
import { ColumnKeymap } from "./column-keymap";
import { Column, ColumnList } from "./column-nodes";
import "./columns.css";
import { COLUMN_BLOCK_TYPE, COLUMN_LIST_BLOCK_TYPE, COLUMN_LIST_NODE_NAME, COLUMN_NODE_NAME } from "./node-names";

registerBlockExtension([ColumnList, Column, ColumnKeymap]);

registerBlockSpec([
  {
    blockType: COLUMN_LIST_BLOCK_TYPE,
    nodeName: COLUMN_LIST_NODE_NAME,
    hasContent: false,
    serialization: {
      // Nada para guardar além do id (que `serialize.ts` já trata à parte) -
      // as colunas de verdade são filhas via `childBlocks`, cada uma com sua
      // própria linha em `blocks` (ver `node-names.ts`).
      content: () => ({}),
      nodeContent: () => [],
      plainText: () => "",
    },
  },
  {
    blockType: COLUMN_BLOCK_TYPE,
    nodeName: COLUMN_NODE_NAME,
    hasContent: false,
    serialization: {
      attrs: (_blockType, content) => ({ width: coerceWidth(content.width) }),
      content: (attrs) => ({ width: coerceWidth(attrs.width) }),
      nodeContent: () => [],
      // O texto de uma coluna já é buscável através dos blocos que ela
      // contém (cada um com seu próprio `plainText`) - a coluna em si não
      // duplica esse texto.
      plainText: () => "",
    },
  },
]);

registerSlashMenuItem({
  id: "blocks:columns:two",
  title: "Duas colunas",
  keywords: ["colunas", "columns", "layout", "lado a lado", "grade"],
  group: "Layout",
  icon: "▥",
  order: 0,
  run: (editor) => wrapCurrentBlockInColumns(editor),
});
