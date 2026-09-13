/**
 * EDT-022, camada de persistência: o `BlockSpec` de `register.ts` é o que
 * impede a equação de virar um `paragraph` mudo na primeira gravação (ver
 * `core/block-spec.test.ts`, o mesmo contrato para todo builder de bloco).
 * Testado com `blocksToDoc`/`docToFlatBlocks` puros - sem editor, sem
 * MathJax - exatamente como `serialize.test.ts` já testa os nove tipos do
 * core.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { collectTurnIntoItems } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
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

describe('"Transformar em" > Equação em bloco - camada de Editor', () => {
  let editor: Editor;

  function createEditor(content: JSONContent): Editor {
    return new Editor({ extensions: buildEditorExtensions(), content });
  }

  function startOfBlock(blockId: string): number {
    let result: number | null = null;
    editor.state.doc.descendants((node: PMNode, pos: number) => {
      if (result !== null) return false;
      if (node.attrs.id === blockId) {
        result = pos + 1;
        return false;
      }
      return true;
    });
    if (result === null) throw new Error(`bloco "${blockId}" não encontrado`);
    return result;
  }

  function firstNodeOfType(typeName: string): PMNode | null {
    let found: PMNode | null = null;
    editor.state.doc.descendants((node: PMNode) => {
      if (found) return false;
      if (node.type.name === typeName) {
        found = node;
        return false;
      }
      return true;
    });
    return found;
  }

  afterEach(() => {
    editor?.destroy();
  });

  it("num bloco vazio, converte no lugar - o documento resultante tem o nó equation", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1"));
    const item = collectTurnIntoItems().find((entry) => entry.id === "math:turn:equation");
    if (!item) throw new Error('item "math:turn:equation" não registrado');

    expect(item.run(editor)).toBe(true);

    expect(firstNodeOfType("equation")).not.toBeNull();
    expect(editor.getJSON().content).toHaveLength(1);
  });

  it("num bloco com texto, o texto sobrevive (a equação entra como próximo irmão)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "x = 1" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1") + 1);
    const item = collectTurnIntoItems().find((entry) => entry.id === "math:turn:equation");
    if (!item) throw new Error('item "math:turn:equation" não registrado');

    expect(item.run(editor)).toBe(true);

    const doc = editor.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[0]?.content?.[0]).toMatchObject({ type: "paragraph", content: [{ text: "x = 1" }] });
    expect(firstNodeOfType("equation")).not.toBeNull();
  });
});
