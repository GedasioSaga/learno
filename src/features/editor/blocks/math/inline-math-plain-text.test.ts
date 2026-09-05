/**
 * FUN-037: equação inline (EDT-023) e busca global. `Block.plainText` é
 * achatado por `flattenInlineText` (core/serialize.ts), que só entendia nó de
 * texto e quebra de linha - um `inlineMath` (átomo, sem `content` próprio)
 * contribuía nada, por mais LaTeX que mostrasse renderizado. `register.ts`
 * fecha esse buraco com `registerInlinePlainText`.
 *
 * Cada `describe` abaixo prova um lado do comportamento no mesmo arquivo: o
 * de cima nunca importa `./register`, então a leitura do nó inline nunca foi
 * ensinada ao achatador - reproduz o bug tal como os três construtores
 * (EDT-023/044/045) o reportaram. O de baixo importa `./register` via
 * `import()` dinâmico dentro do próprio teste, depois do bug já provado, para
 * que a ordem "antes sem, depois com" fique explícita na leitura do arquivo.
 */
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { docToFlatBlocks } from "../../core/serialize";
import { INLINE_MATH_NODE_NAME } from "./node-names";

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

const chipAlone = (): JSONContent[] => [{ type: INLINE_MATH_NODE_NAME, attrs: { expression: "\\frac{a}{b}" } }];

const chipInMiddle = (): JSONContent[] => [
  { type: "text", text: "Resolva " },
  { type: INLINE_MATH_NODE_NAME, attrs: { expression: "x^2+1" } },
  { type: "text", text: " agora" },
];

describe("FUN-037 antes: sem registerInlinePlainText, o LaTeX do chip é invisível para a busca", () => {
  it("chip sozinho no parágrafo produz plainText vazio", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("");
  });

  it("chip no meio de texto some do plainText, mas o texto ao redor sobrevive (com um buraco no lugar do chip)", () => {
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Resolva  agora");
  });
});

describe("FUN-037 depois: register.ts ensina o achatador a ler expression", () => {
  it("chip sozinho no parágrafo contribui o LaTeX cru", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipAlone()));
    expect(flat.plainText).toBe("\\frac{a}{b}");
  });

  it("chip no meio de texto contribui o LaTeX no lugar certo, com o texto ao redor inteiro e na ordem certa", async () => {
    await import("./register");
    const [flat] = docToFlatBlocks(paragraphDoc(chipInMiddle()));
    expect(flat.plainText).toBe("Resolva x^2+1 agora");
  });
});
