/**
 * EDT-044: discovered automatically by `core/discover-extensions.ts`'s
 * `import.meta.glob` - nobody imports this file directly (see README).
 *
 * No `registerBlockSpec` here on purpose: `mentionPage` is an *inline* atom
 * (`group: "inline"`, inherited from `@tiptap/extension-mention`'s base
 * config), never a `Block` row of its own. It travels inside whatever
 * `blockContent` node its containing block already is, as plain JSON in
 * that block's `content.inline` array - `serialize.ts`'s default
 * `nodeContent`/`content` (no spec override needed) round-trip any inline
 * node's `type`/`attrs` as-is, which is exactly right for `{id, label}`.
 */
import { registerInlinePlainText } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { MentionPage } from "./mention-page";
import { MENTION_PAGE_NODE_NAME } from "./node-name";

registerBlockExtension(MentionPage);

// FUN-037: o título da página mencionada não está disponível aqui - o chip
// resolve pelo id em tempo de render, de propósito, para renomear propagar
// (FUN-045, `mention-page-node-view.ts`'s `renderLabel`). A opção (b): usar
// `attrs.label`, o label que `@tiptap/extension-mention` já congela no nó no
// momento da inserção (o mesmo `frozenLabelOf` usa como fallback quando o id
// não resolve) - é o que o Notion faz na prática. Custo aceito: essa cópia
// para busca envelhece a cada rename até a próxima edição do bloco que a
// contém (o que grava um `content` novo), igual a qualquer índice
// denormalizado - diferente do chip renderizado, que sempre mostra o título
// atual porque lê o store, não este attr.
registerInlinePlainText({
  nodeName: MENTION_PAGE_NODE_NAME,
  text: (node) => (typeof node.attrs?.label === "string" ? node.attrs.label : ""),
});
