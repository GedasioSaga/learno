/**
 * FUN-037: chip de data (EDT-045) e busca global - mesmo gap que o chip de
 * equação e o de menção de página relataram: `flattenInlineText`
 * (core/serialize.ts) só entendia texto e quebra de linha, então o
 * `mentionDate` (átomo) não contribuía nada ao `Block.plainText`.
 *
 * Escolha: contribuir as DUAS formas - "04/09/2026" (o que o usuário vê no
 * chip e o mais provável de ele digitar na busca) e "2026-09-04" (o ISO
 * guardado em `attrs.date`, útil para quem lembra a data por trás de
 * filtro/relatório) - separadas por espaço, único jeito de as duas buscas
 * acharem o mesmo bloco.
 *
 * O `describe` de cima nunca importa `./register`, reproduzindo o gap tal
 * como reportado; o de baixo importa via `import()` dinâmico dentro do
 * próprio teste, provando o "depois" no mesmo arquivo.
 */
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { docToFlatBlocks } from "../../core/serialize";
import { MENTION_DATE_NODE_NAME } from "./date-mention-node";

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

const chipAlone = (): JSONContent[] => [{ type: MENTION_DATE_NODE_NAME, attrs: { date: "2026-09-04" } }];

const chipInMiddle = (): JSONContent[] => [
  { type: "text", text: "Reunião em " },
  { type: MENTION_DATE_NODE_NAME, attrs: { date: "2026-12-25" } },
  { type: "text", text: " às 10h" },
];

describe("FUN-037 antes: sem registerInlinePlainText, o chip de data é invisível para a busca", () => {
  it("chip sozinho no parágrafo produz plainText vazio", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("");
  });

  it("chip no meio de texto some do plainText, com um buraco no lugar do chip", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Reunião em  às 10h");
  });
});

describe("FUN-037 depois: register.ts contribui a data formatada e o ISO, separados por espaço", () => {
  it("chip sozinho no parágrafo contribui '04/09/2026 2026-09-04'", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("04/09/2026 2026-09-04");
  });

  it("chip no meio de texto contribui as duas formas no lugar certo, com o texto ao redor inteiro e na ordem certa", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Reunião em 25/12/2026 2026-12-25 às 10h");
  });

  it("attrs.date ausente (chip sem valor) não quebra e não contribui nada", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc([{ type: MENTION_DATE_NODE_NAME, attrs: { date: null } }]));
    expect(flat.plainText).toBe("");
  });
});
