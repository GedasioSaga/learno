/**
 * Drives the real keymap through actual `KeyboardEvent`s dispatched on
 * `editor.view.dom` - not by calling `handleEnter`/`handleTab`/etc.
 * directly - so these tests exercise the same path a real keystroke takes
 * (`BlockKeymap` -> ProseMirror's keymap plugin -> here), the thing the
 * task's "componente que nenhum clique alcança" warning is about.
 *
 * Every assertion goes through `contentOf`/`childrenOf` to unwrap a `Block`
 * wrapper (see `schema.ts`) rather than hardcoding numeric offsets or
 * assuming `doc.content[i]` is the text-bearing node directly.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "./extensions";

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

// `Editor.getJSON()`'s declared return type recursively narrows nested
// content to `NodeType | TextType` (no `.content` on the text branch),
// which is exactly right for that API but pointless friction in a test
// that just wants to walk the tree - `JSONContent` is the loose shape both
// `serialize.ts` and this suite already use everywhere else.
function json(): JSONContent {
  return editor.getJSON();
}

/** A `Block` wrapper's `blockContent` child - where id/type/text live. */
function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper has no blockContent child");
  return node;
}

/** A `Block` wrapper's nested children, if any - each itself a wrapper. */
function childrenOf(wrapper: JSONContent): JSONContent[] {
  const childBlocks = wrapper.content?.[1];
  return childBlocks?.type === "childBlocks" ? (childBlocks.content ?? []) : [];
}

/**
 * Position at the very start of the text of the `blockContent` node carrying
 * `blockId` - found by walking the live doc rather than hand-computing
 * offsets, so these tests don't have to know how deep the wrapper nests it.
 */
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
  if (result === null) throw new Error(`block "${blockId}" not found in the current doc`);
  return result;
}

afterEach(() => {
  editor?.destroy();
});

describe("Enter", () => {
  it("splits a paragraph at the cursor into two paragraphs (EDT-001)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 3); // end of "Olá"
    press("Enter");

    const doc = json();
    expect(doc.content).toHaveLength(2);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Olá" }] });
    const second = contentOf(doc.content![1]);
    expect(second.type).toBe("paragraph");
    expect(second.content).toBeUndefined(); // empty
    expect(editor.state.selection.$from.parent).toBe(editor.state.doc.child(1).firstChild);
  });

  it("ends a numbered list on an empty item instead of creating another one (EDT-065)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "numberedListItem", attrs: { id: "a" } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a"));
    press("Enter");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ type: "paragraph", attrs: { id: "a" } });
  });

  it("repeats the same list type when Enter splits a non-empty item (EDT-064)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "bulletedListItem", attrs: { id: "a" }, content: [{ type: "text", text: "Item 1" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 6); // end of "Item 1"
    press("Enter");

    const doc = json();
    expect(doc.content).toHaveLength(2);
    const second = contentOf(doc.content![1]);
    expect(second.type).toBe("bulletedListItem");
    expect(second.attrs?.id).not.toBe("a");
  });

  it("nests a new empty child paragraph inside an empty toggle instead of splitting it (EDT-010)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "toggle", attrs: { id: "t", collapsed: false } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("t"));
    press("Enter");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0]).attrs?.id).toBe("t");
    const children = childrenOf(doc.content![0]);
    expect(children).toHaveLength(1);
    expect(contentOf(children[0]).type).toBe("paragraph");
  });
});

describe("Tab / Shift-Tab", () => {
  function twoParagraphs(): JSONContent {
    return {
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Primeiro" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Segundo" }] }] },
      ],
    };
  }

  beforeEach(() => {
    editor = createEditor(twoParagraphs());
  });

  it("nests a block under its previous sibling (EDT-067)", () => {
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Tab");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    const first = doc.content![0];
    expect(contentOf(first).attrs?.id).toBe("a");
    const children = childrenOf(first);
    expect(children).toHaveLength(1);
    expect(contentOf(children[0]).attrs?.id).toBe("b");
  });

  it("is a no-op on the first block among its siblings", () => {
    editor.commands.setTextSelection(startOfBlock("a")); // no previous sibling
    press("Tab");
    expect(json().content).toHaveLength(2);
  });

  it("promotes a nested block back to a sibling of its old container (EDT-068)", () => {
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Tab"); // nest b under a first
    editor.commands.setTextSelection(startOfBlock("b")); // now nested - re-locate it
    press("Tab", { shiftKey: true });

    const doc = json();
    expect(doc.content?.map((wrapper) => contentOf(wrapper).attrs?.id)).toEqual(["a", "b"]);
    expect(childrenOf(doc.content![0])).toHaveLength(0); // no leftover empty childBlocks
  });

  it("is a no-op on a top-level block (nothing to outdent from)", () => {
    editor.commands.setTextSelection(startOfBlock("a"));
    press("Tab", { shiftKey: true });
    expect(json().content).toHaveLength(2);
  });
});

describe("Backspace", () => {
  it("merges two consecutive same-type blocks into one (EDT-069)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Mundo" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("b"));
    press("Backspace");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "OláMundo" }] });
  });

  it("demotes an empty special block to a paragraph before deleting it (EDT-070)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Antes" }] }] },
        { type: "block", content: [{ type: "heading", attrs: { id: "h", level: 2 } }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("h"));
    press("Backspace");
    expect(contentOf(json().content![1])).toMatchObject({ type: "paragraph", attrs: { id: "h" } });

    editor.commands.setTextSelection(startOfBlock("h")); // now an empty paragraph
    press("Backspace"); // second press: merges away
    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Antes" }] });
  });

  it("does nothing at the very start of the document", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Só isto" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a"));
    press("Backspace");
    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ content: [{ text: "Só isto" }] });
  });
});

/**
 * O ramo do `handleTab` que nenhum teste alcançava: indentar um bloco sob um
 * irmão que JÁ TEM filhos. Achado pelo construtor de arrasto (EDT-050/051),
 * que bateu no mesmo cálculo de posição ao mover blocos e viu o teste dele
 * falhar; aqui o mesmo erro estava escondido porque `blockContent
 * childBlocks?` aceita no máximo um `childBlocks`, então inserir no nível
 * errado não deformava o documento de um jeito visível.
 */
describe("Tab sob um irmão que já tem filhos", () => {
  it("aninha dentro do childBlocks existente, como último filho, sem criar um segundo childBlocks (EDT-067)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "A" }] },
            {
              type: "childBlocks",
              content: [
                { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "B" }] }] },
              ],
            },
          ],
        },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "c" }, content: [{ type: "text", text: "C" }] }] },
      ],
    });

    editor.commands.setTextSelection(startOfBlock("c"));
    press("Tab");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    const a = doc.content![0];
    expect(contentOf(a)).toMatchObject({ attrs: { id: "a" } });
    // Um único childBlocks, com B e C dentro, nessa ordem.
    expect(a.content).toHaveLength(2);
    expect(a.content![1].type).toBe("childBlocks");
    const filhos = childrenOf(a);
    expect(filhos).toHaveLength(2);
    expect(contentOf(filhos[0])).toMatchObject({ attrs: { id: "b" }, content: [{ text: "B" }] });
    expect(contentOf(filhos[1])).toMatchObject({ attrs: { id: "c" }, content: [{ text: "C" }] });
  });

  it("deixa o cursor dentro do bloco que acabou de ser aninhado", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "A" }] },
            {
              type: "childBlocks",
              content: [
                { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "B" }] }] },
              ],
            },
          ],
        },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "c" }, content: [{ type: "text", text: "C" }] }] },
      ],
    });

    editor.commands.setTextSelection(startOfBlock("c"));
    press("Tab");

    expect(editor.state.selection.$from.parent.attrs.id).toBe("c");
  });
});
