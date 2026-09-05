/**
 * EDT-062/063/066 - desfazer, refazer e quebra de linha suave. O core
 * (`extensions.ts`) diz que essas três vêm de graça do `StarterKit`
 * (`undoRedo` e `hardBreak`, nenhum dos dois desligado em `.configure()`),
 * mas ninguém tinha provado isso ainda. Este arquivo prova - e, se algo
 * tivesse falhado, seria onde um `registerBlockExtension` corretivo desta
 * pasta entraria.
 *
 * Mesmo formato de `core/commands.test.ts`: `KeyboardEvent` real disparado em
 * `editor.view.dom`, atravessando o keymap de verdade (`BlockKeymap` +
 * extensões do `StarterKit`), nunca a função de comando chamada direto -
 * senão o teste prova o comando, não o atalho de teclado.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { turnCurrentBlockInto } from "../../core/commands";
import { buildEditorExtensions } from "../../core/extensions";

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function json(): JSONContent {
  return editor.getJSON();
}

/** O filho `blockContent` de um wrapper `Block` - onde id/tipo/texto vivem. */
function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper sem filho blockContent");
  return node;
}

/** Os filhos aninhados de um wrapper `Block`, se houver. */
function childrenOf(wrapper: JSONContent): JSONContent[] {
  const childBlocks = wrapper.content?.[1];
  return childBlocks?.type === "childBlocks" ? (childBlocks.content ?? []) : [];
}

/** Posição no início do texto do nó `blockContent` que carrega `blockId`, achada andando pelo doc ao vivo - igual `commands.test.ts`. */
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

function threeParagraphs(): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Primeiro" }] }] },
      { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Segundo" }] }] },
      { type: "block", content: [{ type: "paragraph", attrs: { id: "c" }, content: [{ type: "text", text: "Terceiro" }] }] },
    ],
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-062: desfazer (Ctrl/Cmd+Z)", () => {
  it("bloco apagado por Backspace reaparece na mesma posição, com o mesmo conteúdo", () => {
    editor = createEditor(threeParagraphs());
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Backspace"); // funde "b" em "a" (EDT-069) - "b" some do doc
    expect(json().content).toHaveLength(2);

    press("z", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(3);
    // mesma posição: continua entre "a" e "c", não anexado no fim nem duplicado
    expect(doc.content!.map((wrapper) => contentOf(wrapper).attrs?.id)).toEqual(["a", "b", "c"]);
    expect(contentOf(doc.content![1])).toMatchObject({ attrs: { id: "b" }, content: [{ text: "Segundo" }] });
    // "a" também voltou ao seu próprio texto, sem sobra do que tinha sido fundido nele
    expect(contentOf(doc.content![0]).content).toEqual([{ type: "text", text: "Primeiro" }]);
  });

  it("depois de uma conversão de tipo (turnCurrentBlockInto), desfazer devolve o tipo antigo", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Título" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a"));
    turnCurrentBlockInto(editor, "heading", { level: 2 });
    expect(contentOf(json().content![0]).type).toBe("heading");

    press("z", { ctrlKey: true });

    const restored = contentOf(json().content![0]);
    expect(restored.type).toBe("paragraph");
    expect(restored.attrs?.id).toBe("a"); // mesmo id - "desfazer" não é "criar outro bloco"
    expect(restored.content).toEqual([{ type: "text", text: "Título" }]);
  });

  it("depois de Tab, desfazer desindenta o bloco de volta ao nível anterior", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Primeiro" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Segundo" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Tab"); // aninha "b" sob "a" (EDT-067)
    expect(childrenOf(json().content![0])).toHaveLength(1);

    press("z", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(2);
    expect(doc.content!.map((wrapper) => contentOf(wrapper).attrs?.id)).toEqual(["a", "b"]);
    expect(childrenOf(doc.content![0])).toHaveLength(0); // nenhum childBlocks vazio deixado para trás
  });
});

describe("EDT-063: refazer (Ctrl/Cmd+Shift+Z)", () => {
  it("depois de desfazer uma exclusão, refazer remove o bloco de novo", () => {
    editor = createEditor(threeParagraphs());
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Backspace");
    press("z", { ctrlKey: true }); // desfaz - "b" volta
    expect(json().content).toHaveLength(3);

    press("z", { ctrlKey: true, shiftKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(2);
    expect(doc.content!.map((wrapper) => contentOf(wrapper).attrs?.id)).toEqual(["a", "c"]);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "PrimeiroSegundo" }] });
  });
});

describe("EDT-066: Shift+Enter é quebra de linha suave, não split de bloco", () => {
  it("cursor no meio de um parágrafo, Shift+Enter insere uma quebra sem criar bloco novo", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "AntesDepois" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 5); // entre "Antes" e "Depois"
    press("Enter", { shiftKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(1); // ainda um bloco só - o teste que separa soft break de split
    const content = contentOf(doc.content![0]);
    expect(content.attrs?.id).toBe("a"); // sem novo id
    expect(content.content?.map((node) => node.type)).toEqual(["text", "hardBreak", "text"]);
    expect(content.content?.[0]).toMatchObject({ text: "Antes" });
    expect(content.content?.[2]).toMatchObject({ text: "Depois" });
  });

  it("Ctrl/Cmd+Enter também produz a mesma quebra suave (atalho alternativo do hardBreak)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Um" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 2); // fim de "Um"
    press("Enter", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0]).content?.map((node) => node.type)).toEqual(["text", "hardBreak"]);
  });
});
