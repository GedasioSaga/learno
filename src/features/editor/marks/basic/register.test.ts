/**
 * EDT-035/036/038/039: negrito, itálico, riscado, código inline. Drives the
 * real keymap and the real input-rules plugin - not `toggleBold()` etc.
 * called directly - the same way `core/commands.test.ts` drives Enter/Tab
 * through actual `KeyboardEvent`s, so a shortcut this test is happy with is
 * a shortcut a real keystroke also triggers.
 *
 * `handleTextInput` is prosemirror-view's own hook for simulated typed text
 * (used by prosemirror-inputrules' own test suite the same way): calling it
 * directly is how a markdown input rule is exercised without a real IME.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
// Side-effect import: registers the marks and their toolbar buttons, the
// same way `discover-extensions.ts`'s glob would in the running app.
import "./register";

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

/** Simulates one typed character reaching the input-rules plugin, the way a real keystroke would. */
function typeChar(char: string): void {
  const { from, to } = editor.state.selection;
  editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, char, () => editor.state.tr));
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper has no blockContent child");
  return node;
}

function paragraphDoc(text: string, id = "a"): JSONContent {
  return {
    type: "doc",
    content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }],
  };
}

// A genuinely empty paragraph - no `content` key at all, not a text node
// holding `""` (ProseMirror's own `fromJSON` rejects an empty text node:
// "Empty text nodes are not allowed").
function emptyParagraphDoc(id = "a"): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id } }] }] };
}

function startOfFirstBlock(): number {
  // The doc is always `doc > block > paragraph` in this file's fixtures -
  // start of the wrapper (+1) then start of the paragraph's own text (+1).
  return 2;
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-035: negrito", () => {
  it("Ctrl/Cmd+B em texto selecionado aplica negrito; repetir remove", () => {
    editor = createEditor(paragraphDoc("abc def"));
    const from = startOfFirstBlock();
    editor.commands.setTextSelection({ from, to: from + 3 }); // "abc"

    press("b", { ctrlKey: true });
    expect(editor.isActive("bold")).toBe(true);

    press("b", { ctrlKey: true });
    expect(editor.isActive("bold")).toBe(false);
  });

  it("**texto** vira negrito ao digitar o delimitador final", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfFirstBlock());
    editor.commands.insertContent("**bold*");
    typeChar("*");

    const contentNode = contentOf(editor.getJSON().content![0]);
    expect(contentNode.content?.[0].text).toBe("bold");
    expect(contentNode.content?.[0].marks?.[0].type).toBe("bold");
  });
});

describe("EDT-036: itálico", () => {
  it("Ctrl/Cmd+I em texto selecionado aplica itálico", () => {
    editor = createEditor(paragraphDoc("abc def"));
    const from = startOfFirstBlock();
    editor.commands.setTextSelection({ from, to: from + 3 });

    press("i", { ctrlKey: true });
    expect(editor.isActive("italic")).toBe(true);
  });
});

describe("EDT-038: riscado", () => {
  it("Ctrl/Cmd+Shift+S em texto selecionado risca o texto", () => {
    editor = createEditor(paragraphDoc("abc def"));
    const from = startOfFirstBlock();
    editor.commands.setTextSelection({ from, to: from + 3 });

    press("s", { ctrlKey: true, shiftKey: true });
    expect(editor.isActive("strike")).toBe(true);
  });

  it("~texto~ (um til de cada lado) vira riscado ao digitar o til final", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfFirstBlock());
    editor.commands.insertContent("~riscado");
    typeChar("~");

    const contentNode = contentOf(editor.getJSON().content![0]);
    expect(contentNode.content?.[0].text).toBe("riscado");
    expect(contentNode.content?.[0].marks?.[0].type).toBe("strike");
  });
});

describe("EDT-039: código inline", () => {
  it("Ctrl/Cmd+E em texto selecionado aplica a marca de código", () => {
    editor = createEditor(paragraphDoc("abc def"));
    const from = startOfFirstBlock();
    editor.commands.setTextSelection({ from, to: from + 3 });

    press("e", { ctrlKey: true });
    expect(editor.isActive("code")).toBe(true);
  });
});
