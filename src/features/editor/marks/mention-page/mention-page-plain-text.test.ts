/**
 * FUN-037: menção de página (EDT-044) e busca global - mesmo gap relatado
 * pelo chip de data e pela equação inline: `flattenInlineText`
 * (core/serialize.ts) não sabia ler um `mentionPage` (átomo), então o título
 * mencionado não entrava no `Block.plainText`.
 *
 * Escolha entre (a) contribuir o id (inútil para busca humana) e (b) usar o
 * título: o título não está disponível aqui em tempo de render - o chip
 * resolve pelo id contra `usePageTreeStore` de propósito, para que renomear a
 * página propague (FUN-045, ver `mention-page-node-view.ts`). Mas o título
 * ESTÁ nos attrs para outro fim: `@tiptap/extension-mention` já congela
 * `attrs.label` no momento da inserção (ver `node_modules/@tiptap/extension-mention/src/mention.ts`,
 * usado como fallback por `frozenLabelOf` quando o id não resolve). Reusar
 * esse label congelado para busca é a opção (b) - o que o Notion faz na
 * prática. O que envelhece: uma página renomeada depois de mencionada segue
 * buscável pelo título ANTIGO até que o bloco que a contém seja editado de
 * novo (o que grava um `content` novo, plainText incluso) - o chip
 * renderizado não tem esse problema porque lê o store ao vivo, só a cópia de
 * busca é que congela.
 *
 * O `describe` de cima nunca importa `./register`, reproduzindo o gap tal
 * como reportado; o de baixo importa via `import()` dinâmico dentro do
 * próprio teste, provando o "depois" no mesmo arquivo.
 */
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { docToFlatBlocks } from "../../core/serialize";
import { MENTION_PAGE_NODE_NAME } from "./node-name";

function paragraphDoc(inline: JSONContent[]): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "block",
        content: [{ type: "paragraph", attrs: { id: "block-1" }, content: inline }],
      },
    ],
  };
}

const chipAlone = (): JSONContent[] => [
  { type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-1", label: "Aula de Cálculo" } },
];

const chipInMiddle = (): JSONContent[] => [
  { type: "text", text: "Ver " },
  { type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-1", label: "Aula 1" } },
  { type: "text", text: " para detalhes" },
];

describe("FUN-037 antes: sem registerInlinePlainText, o título mencionado é invisível para a busca", () => {
  it("chip sozinho no parágrafo produz plainText vazio", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("");
  });

  it("chip no meio de texto some do plainText, com um buraco no lugar do chip", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Ver  para detalhes");
  });
});

describe("FUN-037 depois: register.ts contribui o label congelado nos attrs", () => {
  it("chip sozinho no parágrafo contribui o título", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("Aula de Cálculo");
  });

  it("chip no meio de texto contribui o título no lugar certo, com o texto ao redor inteiro e na ordem certa", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Ver Aula 1 para detalhes");
  });

  it("label ausente (nunca deveria acontecer, mas não pode quebrar) não contribui nada em vez de lançar", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc([{ type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-1" } }]));
    expect(flat.plainText).toBe("");
  });
});
