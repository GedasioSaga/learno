/**
 * EDT-022, camada de persistência: o `BlockSpec` de `register.ts` é o que
 * impede a equação de virar um `paragraph` mudo na primeira gravação (ver
 * `core/block-spec.test.ts`, o mesmo contrato para todo builder de bloco).
 * Testado com `blocksToDoc`/`docToFlatBlocks` puros - sem editor, sem
 * MathJax - exatamente como `serialize.test.ts` já testa os nove tipos do
 * core.
 */
import { describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { docToFlatBlocks, blocksToDoc } from "../../core/serialize";
// Efeito colateral: registra o BlockSpec de "equation" antes dos testes.
import "./register";

function storedBlock(overrides: Partial<Block>): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    parentBlockId: null,
    blockType: "paragraph",
    content: {},
    plainText: "",
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

describe("EDT-022: equação em bloco sobrevive ao round trip de persistência", () => {
  it("blockType 'equation' vira o nó 'equation' com a expressão nos attrs, sem content array (átomo)", () => {
    const stored = storedBlock({
      blockType: "equation",
      content: { expression: "\\frac{a}{b}" },
      plainText: "\\frac{a}{b}",
    });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("equation");
    expect(contentNode?.attrs).toMatchObject({ expression: "\\frac{a}{b}" });
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("equation");
    expect(flat.content).toEqual({ expression: "\\frac{a}{b}" });
    expect(flat.plainText).toBe("\\frac{a}{b}");
  });

  it("uma expressão vazia (bloco recém-criado pelo menu /) também sobrevive, sem cair para paragraph", () => {
    const doc = blocksToDoc([storedBlock({ blockType: "equation", content: { expression: "" } })]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("equation");
    expect(contentNode?.attrs?.expression).toBe("");
  });
});
