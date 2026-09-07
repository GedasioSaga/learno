/**
 * DBS-001: registra o bloco "database inline" nos pontos de
 * `core/block-spec.ts` — ver o README do editor para o porquê de cada um.
 * Este arquivo nunca é importado por ninguém: `core/discover-extensions.ts`
 * o descobre via `import.meta.glob`.
 *
 * O item "/database" cria a database E a primeira view antes de inserir o
 * bloco (`actions.ts`) — um bloco sem `databaseId` válido fabricaria um
 * estado que a FK de `database_views` rejeitaria no primeiro uso real.
 */
import { createElement } from "react";
import { registerBlockSpec, registerEditorOverlay, registerSlashMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { usePageTreeStore } from "../../../pages/store";
import { createDatabaseAndInsert } from "./actions";
import { DatabaseInsertError } from "./DatabaseInsertError";
import { BLOCK_TYPE, DatabaseInline, NODE_NAME } from "./node";
import "./database-inline.css";

registerBlockExtension(DatabaseInline);

registerBlockSpec({
  blockType: BLOCK_TYPE,
  nodeName: NODE_NAME,
  hasContent: false,
  serialization: {
    attrs: (_blockType, content) => ({
      databaseId: typeof content.databaseId === "string" ? content.databaseId : null,
    }),
    content: (attrs) => ({
      databaseId: typeof attrs.databaseId === "string" ? attrs.databaseId : null,
    }),
    // Sem nome de database resolvido nesta rodada (ver a divergência acima)
    // — o texto buscável fica vazio em vez de inventar um rótulo que a
    // busca global (FUN-037) mostraria errado assim que a database ganhar
    // nome de verdade.
    plainText: () => "",
  },
});

registerSlashMenuItem({
  id: "blocks:database",
  title: "Database",
  keywords: ["database", "tabela", "table", "banco", "base de dados", "planilha"],
  group: "Páginas",
  icon: "▦",
  run: (editor) => {
    if (!usePageTreeStore.getState().selectedPageId) return false;
    // Async por natureza (cria a database antes de saber o `databaseId` do
    // bloco) — `run` só diz que a ação começou. Toda falha já foi levada à
    // tela por `actions.ts` (store + overlay abaixo); nada é engolido aqui.
    void createDatabaseAndInsert(editor);
    return true;
  },
});

registerEditorOverlay({
  id: "blocks:database-insert-error",
  render: () => createElement(DatabaseInsertError),
});
