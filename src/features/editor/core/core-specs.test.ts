/**
 * EDT-049/EDT-047 estendidos: Título 4. `core-specs.ts` já tinha
 * heading_1..3 com um `blockSpec` de família só (ver `block-spec.test.ts`);
 * este arquivo prova que o nível 4 entra pelos mesmos dois pontos que os
 * outros três - o menu `/` e "Transformar em" - e que a conversão de
 * verdade (não só a existência do item) funciona nos dois sentidos, mesmo
 * padrão de `interaction/keys/keys.test.ts` (`turnCurrentBlockInto` contra
 * um `Editor` real, nunca `tsc`/registro sozinho).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { collectSlashMenuItems, collectTurnIntoItems } from "./block-spec";
import { turnCurrentBlockInto } from "./commands";
// Efeito colateral: registra os BlockSpecs/itens de menu do core (nove tipos
// + Título 4) antes dos testes - `serialize.ts` é o único importado "de
// verdade" em produção (ver o cabeçalho de `core-specs.ts`), mas nada aqui
// passa por ele, então o import precisa ser explícito.
import "./core-specs";
import { buildEditorExtensions } from "./extensions";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function json(): JSONContent {
  return editor.getJSON();
}

/** O filho `blockContent` de um wrapper `Block` - mesmo helper de `keys.test.ts`. */
function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper sem filho blockContent");
  return node;
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
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado no doc atual`);
  return result;
}

afterEach(() => {
  editor?.destroy();
});

describe("Título 4", () => {
  it("existe no menu \"/\" e em \"Transformar em\", ao lado dos níveis 1 a 3", () => {
    expect(collectSlashMenuItems().find((item) => item.id === "core:heading_4")).toMatchObject({ title: "Título 4" });
    expect(collectTurnIntoItems().find((item) => item.id === "core:turn:heading_4")).toMatchObject({
      title: "Título 4",
    });
  });

  it("transforma um parágrafo em heading nível 4 - o documento resultante tem o nó certo", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a"));

    expect(turnCurrentBlockInto(editor, "heading", { level: 4 })).toBe(true);

    const node = contentOf(json().content![0]);
    expect(node.type).toBe("heading");
    expect(node.attrs?.level).toBe(4);
  });

  it("transforma de volta para texto sem perder o id do bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "heading", attrs: { id: "a", level: 4 }, content: [{ type: "text", text: "Nível 4" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    expect(turnCurrentBlockInto(editor, "paragraph")).toBe(true);

    const node = contentOf(json().content![0]);
    expect(node.type).toBe("paragraph");
    expect(node.attrs?.id).toBe("a");
    expect(node.content).toEqual([{ type: "text", text: "Nível 4" }]);
  });

  it("transforma um bloco que já tem conteúdo - o texto sobrevive dentro do heading novo", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Já tinha texto" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    expect(turnCurrentBlockInto(editor, "heading", { level: 4 })).toBe(true);

    const node = contentOf(json().content![0]);
    expect(node.type).toBe("heading");
    expect(node.attrs?.level).toBe(4);
    expect(node.content).toEqual([{ type: "text", text: "Já tinha texto" }]);
  });
});
