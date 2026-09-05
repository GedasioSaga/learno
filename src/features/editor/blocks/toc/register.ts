/**
 * EDT-031: registers the table-of-contents block. Imported nowhere - the
 * core's `discover-extensions.ts` picks this up by its `register.ts` name.
 * See the README for why every import below goes through `core/<module>`
 * and never `../../index`.
 */
import { registerBlockSpec, registerSlashMenuItem } from "../../core/block-spec";
import { insertBlockHere } from "../../core/commands";
import { registerBlockExtension } from "../../core/registry";
import { TableOfContents, TOC_BLOCK_TYPE, TOC_NODE_NAME } from "./table-of-contents-node";

registerBlockExtension(TableOfContents);

registerBlockSpec({
  blockType: TOC_BLOCK_TYPE,
  nodeName: TOC_NODE_NAME,
  hasContent: false,
  serialization: {
    content: () => ({}),
    nodeContent: () => [],
    // O texto dos títulos já é indexado pelos próprios blocos de heading -
    // repeti-lo aqui só poluiria a busca global.
    plainText: () => "",
  },
});

registerSlashMenuItem({
  id: "blocks:table_of_contents",
  title: "Sumário",
  keywords: ["sumario", "sumário", "indice", "índice", "toc", "table of contents", "titulos", "títulos"],
  group: "Avançado",
  icon: "📑",
  order: 0,
  run: (editor) => insertBlockHere(editor, TOC_NODE_NAME),
});

// Sem `registerTurnIntoItem`: o conteúdo de um TOC é derivado, não há texto
// a preservar convertendo de/para outro tipo (ver README, seção 4).
