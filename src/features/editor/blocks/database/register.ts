/**
 * DBS-001: registra o bloco "database inline" nos pontos de
 * `core/block-spec.ts` — ver o README do editor para o porquê de cada um.
 * Este arquivo nunca é importado por ninguém: `core/discover-extensions.ts`
 * o descobre via `import.meta.glob`.
 *
 * Sem item de menu "/" nesta rodada, de propósito: inserir um bloco novo
 * exigiria uma database recém-criada, e não existe comando Rust que crie
 * uma linha em `databases` ainda (ver a divergência S2 no relatório desta
 * peça — criar esse comando é trabalho de Rust, fora do papel deste
 * construtor). Um item de menu que inserisse um bloco sem `databaseId`
 * válido fabricaria um estado que a FK de `database_properties`/
 * `database_views` rejeitaria no primeiro uso real — pior que não oferecer
 * a entrada. O nó e o `BlockSpec` abaixo já estão prontos para um
 * `databaseId` de verdade assim que esse comando existir.
 */
import { registerBlockSpec } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
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
