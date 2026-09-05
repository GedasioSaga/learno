/**
 * blocks-table (EDT-079/080): grade de texto plano dentro do wrapper
 * `Block` deste editor. `table-schema.ts` explica a troca de `group` e de
 * `content` das células; `table-content.ts` explica como "linhas de
 * células" vira o `content.rows` estruturado que `contract.ts` persiste.
 *
 * `.ts`, não `.tsx`, de propósito: `core/discover-extensions.ts` só
 * descobre arquivos chamados exatamente `register.ts` (README, "Como
 * registrar"); `createElement` monta o `EditorOverlay` sem precisar de
 * JSX aqui.
 */
import { createElement } from "react";
import { registerBlockExtension } from "../../core/registry";
import { registerBlockSpec, registerEditorOverlay, registerSlashMenuItem } from "../../core/block-spec";
import { insertBlockHere } from "../../core/commands";
import { TableControls } from "./TableControls";
import { buildEmptyTableRows, nodeContentFromTableContent, tableContentFromNodeContent, tableContentToPlainText } from "./table-content";
import { BlockTable, BlockTableCell, BlockTableHeader, BlockTableRow } from "./table-schema";
import { TABLE_BLOCK_TYPE, TABLE_NODE_NAME } from "./constants";
import "./table.css";

/** Grade inicial do menu `/` (EDT-079: "recebe texto em duas células"). */
const DEFAULT_TABLE_ROWS = 2;
const DEFAULT_TABLE_COLS = 2;

registerBlockExtension([
  BlockTable.configure({
    resizable: true, // EDT-080: larguras de coluna redimensionáveis, persistidas via `colwidth` (ver table-content.ts)
    HTMLAttributes: { class: "ed-block ed-table", "data-block-type": TABLE_NODE_NAME },
  }),
  BlockTableRow,
  BlockTableCell,
  BlockTableHeader,
]);

registerBlockSpec({
  blockType: TABLE_BLOCK_TYPE,
  nodeName: TABLE_NODE_NAME,
  serialization: {
    content: (_attrs, nodeContent) => tableContentFromNodeContent(nodeContent),
    nodeContent: (content) => nodeContentFromTableContent(content),
    plainText: (content) => tableContentToPlainText(content),
  },
});

registerSlashMenuItem({
  id: "blocks:table",
  title: "Tabela",
  keywords: ["tabela", "table", "grade", "planilha"],
  group: "Mídia",
  icon: "▦",
  // Tabela não tem "conteúdo de texto" que valha preservar ao converter -
  // `insertBlockHere` decide sozinho (bloco vazio converte, com texto insere
  // como irmão abaixo), o mesmo primitivo que todo item do core usa.
  run: (editor) => {
    const rows = buildEmptyTableRows(editor.state.schema, DEFAULT_TABLE_ROWS, DEFAULT_TABLE_COLS);
    return insertBlockHere(editor, TABLE_NODE_NAME, {}, rows);
  },
});

registerEditorOverlay({
  id: "blocks:table:controls",
  render: (editor) => createElement(TableControls, { editor }),
});
