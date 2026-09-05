/**
 * EDT-050/EDT-051, camada 1: as primitivas de movimento contra um doc real,
 * sem passar por mouse nenhum - o mesmo estilo de `core/commands.test.ts`
 * (editor real, `getJSON()` pra inspecionar o resultado), só que chamando
 * `reorderBlock`/`nestBlockUnderSibling` diretamente em vez de simular
 * `KeyboardEvent`s.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { nestBlockUnderSibling, reorderBlock } from "./node-move";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function json(): JSONContent {
  return editor.getJSON();
}

/** Ids dos blocos de topo, na ordem em que aparecem sob `doc`. */
function topLevelIds(): (string | undefined)[] {
  return (json().content ?? []).map((wrapper) => wrapper.content?.[0]?.attrs?.id as string | undefined);
}

/** Ids dos filhos aninhados de um wrapper de topo, ou `undefined` se ele não tiver `childBlocks`. */
function childIds(topLevelIndex: number): (string | undefined)[] | undefined {
  const wrapper = json().content?.[topLevelIndex];
  const childBlocks = wrapper?.content?.[1];
  if (childBlocks?.type !== "childBlocks") return undefined;
  return (childBlocks.content ?? []).map((child) => child.content?.[0]?.attrs?.id as string | undefined);
}

function paragraph(id: string, text: string): JSONContent {
  return { type: "paragraph", attrs: { id }, content: [{ type: "text", text }] };
}

function block(...contentNode: JSONContent[]): JSONContent {
  return { type: "block", content: contentNode };
}

afterEach(() => {
  editor?.destroy();
});

describe("reorderBlock (EDT-050)", () => {
  it("EDT-050: solta C entre A e B - nova ordem A,C,B", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B")), block(paragraph("c", "C"))],
    });

    const applied = reorderBlock(editor, "c", "b", "before");

    expect(applied).toBe(true);
    expect(topLevelIds()).toEqual(["a", "c", "b"]);
  });

  it("EDT-050: arrastar um bloco com filhos leva os filhos junto", () => {
    editor = createEditor({
      type: "doc",
      content: [
        block(paragraph("a", "A")),
        block(paragraph("b", "B")),
        block(paragraph("c", "C"), { type: "childBlocks", content: [block(paragraph("c1", "C1"))] }),
      ],
    });

    reorderBlock(editor, "c", "a", "before");

    expect(topLevelIds()).toEqual(["c", "a", "b"]);
    expect(childIds(0)).toEqual(["c1"]); // C continua com C1 embaixo dela
  });

  it("recusa soltar um bloco dentro do próprio filho - viraria ciclo", () => {
    editor = createEditor({
      type: "doc",
      content: [
        block(paragraph("a", "A"), { type: "childBlocks", content: [block(paragraph("a1", "A1"))] }),
        block(paragraph("b", "B")),
      ],
    });

    const applied = reorderBlock(editor, "a", "a1", "before");

    expect(applied).toBe(false);
    // Árvore intacta: A ainda tem A1 como filho, B ainda é o segundo de topo.
    expect(topLevelIds()).toEqual(["a", "b"]);
    expect(childIds(0)).toEqual(["a1"]);
  });

  it("no-op: soltar exatamente onde o bloco já está", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B")), block(paragraph("c", "C"))],
    });

    // C já é o próximo irmão de B - pedir "depois de B" não muda nada.
    const applied = reorderBlock(editor, "c", "b", "after");

    expect(applied).toBe(false);
    expect(topLevelIds()).toEqual(["a", "b", "c"]);
  });

  it("recusa mover um bloco para o próprio lugar (mesmo id nos dois lados)", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B"))],
    });

    expect(reorderBlock(editor, "a", "a", "after")).toBe(false);
  });
});

describe("nestBlockUnderSibling (EDT-051)", () => {
  it("EDT-051: solta B na metade direita de A - B vira filho indentado de A", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A")), block(paragraph("b", "B"))],
    });

    const applied = nestBlockUnderSibling(editor, "b", "a");

    expect(applied).toBe(true);
    expect(topLevelIds()).toEqual(["a"]); // B saiu do nível de topo
    expect(childIds(0)).toEqual(["b"]);
  });

  it("acrescenta como último filho quando o alvo já tem filhos", () => {
    editor = createEditor({
      type: "doc",
      content: [
        block(paragraph("a", "A"), { type: "childBlocks", content: [block(paragraph("x", "X"))] }),
        block(paragraph("y", "Y")),
      ],
    });

    nestBlockUnderSibling(editor, "y", "a");

    expect(childIds(0)).toEqual(["x", "y"]);
  });

  it("recusa aninhar um bloco sob o próprio descendente - viraria ciclo", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A"), { type: "childBlocks", content: [block(paragraph("b", "B"))] })],
    });

    const applied = nestBlockUnderSibling(editor, "a", "b");

    expect(applied).toBe(false);
    expect(childIds(0)).toEqual(["b"]); // árvore intacta
  });

  it("no-op: o bloco já é o último filho do alvo", () => {
    editor = createEditor({
      type: "doc",
      content: [
        block(paragraph("a", "A"), {
          type: "childBlocks",
          content: [block(paragraph("x", "X")), block(paragraph("b", "B"))],
        }),
      ],
    });

    const applied = nestBlockUnderSibling(editor, "b", "a");

    expect(applied).toBe(false);
    expect(childIds(0)).toEqual(["x", "b"]);
  });
});
