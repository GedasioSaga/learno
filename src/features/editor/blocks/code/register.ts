/**
 * Ponto de descoberta do bloco de código (EDT-018) - carregado por
 * `core/discover-extensions.ts` via `import.meta.glob`, nunca importado
 * diretamente (ver README).
 */
import type { JSONContent } from "@tiptap/core";
import { registerBlockSpec, registerSlashMenuItem, registerTurnIntoItem } from "../../core/block-spec";
import { insertBlockHere, turnCurrentBlockInto } from "../../core/commands";
import { registerBlockExtension } from "../../core/registry";
import "./code-block.css";
import { CodeBlock } from "./code-block";
import { CODE_BLOCK_NODE_NAME, DEFAULT_CODE_LANGUAGE } from "./languages";

registerBlockExtension(CodeBlock);

/**
 * O conteúdo do nó é `"text*"` (não `"inline*"`) - texto puro, sem marcas -
 * então achatar para busca é só concatenar, sem checar `hardBreak` como
 * `serialize.ts` faz para os blocos textuais: uma quebra de linha dentro de
 * um bloco de código já é o caractere "\n" literal dentro do texto, nunca um
 * nó `hardBreak` (esse tipo de nó não é sequer inserível num `"text*"`).
 */
function flattenCodeText(nodeContent: JSONContent[]): string {
  let text = "";
  for (const node of nodeContent) {
    if (typeof node.text === "string") text += node.text;
  }
  return text;
}

registerBlockSpec({
  blockType: "code",
  nodeName: CODE_BLOCK_NODE_NAME,
  serialization: {
    attrs: (_blockType, content) => ({
      language: typeof content.language === "string" ? content.language : DEFAULT_CODE_LANGUAGE,
    }),
    content: (attrs, nodeContent) => ({
      language: typeof attrs.language === "string" ? attrs.language : DEFAULT_CODE_LANGUAGE,
      code: flattenCodeText(nodeContent),
    }),
    nodeContent: (content) =>
      typeof content.code === "string" && content.code.length > 0 ? [{ type: "text", text: content.code }] : [],
    // O código em si, para a busca global achar código (pedido no enunciado
    // da peça) - não a linguagem, que já está em `content.language`.
    plainText: (content) => (typeof content.code === "string" ? content.code : ""),
  },
});

const GROUP = "Código";

registerSlashMenuItem({
  id: "blocks:code",
  title: "Código",
  keywords: ["codigo", "code", "programacao", "snippet", "syntax"],
  group: GROUP,
  icon: "</>",
  run: (editor) => insertBlockHere(editor, CODE_BLOCK_NODE_NAME, { language: DEFAULT_CODE_LANGUAGE }),
});

registerTurnIntoItem({
  id: "blocks:turn:code",
  title: "Código",
  group: GROUP,
  run: (editor) => turnCurrentBlockInto(editor, CODE_BLOCK_NODE_NAME, { language: DEFAULT_CODE_LANGUAGE }),
  isActive: (editor) => editor.state.selection.$from.parent.type.name === CODE_BLOCK_NODE_NAME,
});
