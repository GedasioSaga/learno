/**
 * EDT-049: "Turn into" - the block handle listing `collectTurnIntoItems()`.
 * Drives the real keymap/DOM the same way `core/commands.test.ts` does (real
 * `KeyboardEvent`s and real `click()`s through `editor.view.dom`, not the
 * plugin's internals called directly), so these tests exercise the same
 * path a user does.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor, Mark } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCoreSpecsRegistered } from "../../core/core-specs";
import { buildEditorExtensions } from "../../core/extensions";
import { TURN_INTO_HANDLE_ATTRIBUTE, TURN_INTO_HANDLE_TESTID, TurnIntoBlockHandle } from "./turn-into-handle";

// Populates `collectTurnIntoItems()` with the nine core entries - see this
// module's own doc comment for why importing it is what registers them.
ensureCoreSpecsRegistered();

// A minimal inline mark, local to this test file only - proving marks
// survive the conversion doesn't require depending on whichever real mark
// another builder's `marks/` folder happens to have registered by the time
// this runs (they're being built in parallel - see the task's own warning).
const TestBold = Mark.create({
  name: "testBold",
  parseHTML: () => [{ tag: "strong" }],
  renderHTML: () => ["strong", 0],
});

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function pressTurnIntoShortcut() {
  // TURN_INTO_SHORTCUT is "Mod-Alt-t"; jsdom reports no Mac platform, so
  // prosemirror-keymap resolves "Mod" to Ctrl here, same as a real Linux/
  // Windows keyboard.
  press("t", { ctrlKey: true, altKey: true });
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: [...buildEditorExtensions(), TurnIntoBlockHandle, TestBold], content });
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
  if (result === null) throw new Error(`block "${blockId}" not found in the current doc`);
  return result;
}

/** The handle's own root - present only for the block currently holding the selection (see `turn-into-handle.ts`'s `blockGutterAnchor`). */
function handleRoot(): HTMLElement | null {
  return editor.view.dom.querySelector<HTMLElement>(`[${TURN_INTO_HANDLE_ATTRIBUTE}]`);
}

function openMenuByClick(): HTMLElement {
  const trigger = editor.view.dom.querySelector<HTMLButtonElement>(`[data-testid="${TURN_INTO_HANDLE_TESTID}"]`);
  if (!trigger) throw new Error("handle trigger not found - selection isn't inside a block");
  trigger.click();
  const menu = handleRoot()?.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("menu did not open");
  return menu;
}

function menuItemByTitle(menu: HTMLElement, title: string): HTMLButtonElement {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  const match = items.find((el) => el.textContent?.includes(title));
  if (!match) throw new Error(`no "Turn into" item titled "${title}"`);
  return match;
}

function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper has no blockContent child");
  return node;
}

function childrenOf(wrapper: JSONContent): JSONContent[] {
  const childBlocks = wrapper.content?.[1];
  return childBlocks?.type === "childBlocks" ? (childBlocks.content ?? []) : [];
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-049: converter bloco em outro tipo", () => {
  it("EDT-049: clicar em Título 1 vira o parágrafo em H1 preservando texto e id, sem duplicar o bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Título da seção" }] }],
        },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("p1"));

    const menu = openMenuByClick();
    menuItemByTitle(menu, "Título 1").click();

    const doc = editor.getJSON();
    expect(doc.content).toHaveLength(1); // não duplicou: ainda um bloco só
    const converted = contentOf(doc.content![0]);
    expect(converted.type).toBe("heading");
    expect(converted.attrs).toMatchObject({ id: "p1", level: 1 });
    expect(converted.content).toEqual([{ type: "text", text: "Título da seção" }]);
  });

  it("EDT-049: preserva marcas inline (negrito) do texto convertido", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            {
              type: "paragraph",
              attrs: { id: "p1" },
              content: [{ type: "text", text: "Nome", marks: [{ type: "testBold" }] }],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("p1"));

    const menu = openMenuByClick();
    menuItemByTitle(menu, "Título 2").click();

    const converted = contentOf(editor.getJSON().content![0]);
    expect(converted.type).toBe("heading");
    expect(converted.content?.[0]).toMatchObject({ text: "Nome", marks: [{ type: "testBold" }] });
  });

  it("EDT-049: preserva os filhos aninhados do bloco convertido", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "paragraph", attrs: { id: "pai" }, content: [{ type: "text", text: "Pai" }] },
            {
              type: "childBlocks",
              content: [
                {
                  type: "block",
                  content: [{ type: "paragraph", attrs: { id: "filho" }, content: [{ type: "text", text: "Filho" }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("pai"));

    const menu = openMenuByClick();
    menuItemByTitle(menu, "Citação").click();

    const doc = editor.getJSON();
    expect(doc.content).toHaveLength(1);
    const converted = contentOf(doc.content![0]);
    expect(converted.type).toBe("quote");
    expect(converted.attrs?.id).toBe("pai");
    const children = childrenOf(doc.content![0]);
    expect(children).toHaveLength(1);
    expect(contentOf(children[0])).toMatchObject({ attrs: { id: "filho" }, content: [{ text: "Filho" }] });
  });

  it("EDT-049: marca o item ativo do menu (isActive) para o tipo atual do bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "heading", attrs: { id: "h", level: 2 }, content: [{ type: "text", text: "X" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("h"));

    const menu = openMenuByClick();
    expect(menuItemByTitle(menu, "Título 2").getAttribute("aria-checked")).toBe("true");
    expect(menuItemByTitle(menu, "Título 1").getAttribute("aria-checked")).toBe("false");
    expect(menuItemByTitle(menu, "Texto").getAttribute("aria-checked")).toBe("false");
  });

  it("EDT-049: o atalho de teclado (Mod-Alt-t) abre o menu sem precisar de mouse", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1"));

    expect(handleRoot()?.querySelector('[role="menu"]')).toHaveProperty("hidden", true);
    pressTurnIntoShortcut();

    const menu = handleRoot()?.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu).toHaveProperty("hidden", false);

    // A seleção via teclado continua funcional a partir daqui: ativar o
    // item focado é o mesmo `click()` que Espaço/Enter disparam num botão.
    menuItemByTitle(menu as HTMLElement, "Lista com marcador").click();
    expect(contentOf(editor.getJSON().content![0]).type).toBe("bulletedListItem");
  });

  it("EDT-049: a alça expõe o data-attribute e o test id estáveis para o handle de arraste conviver ao lado", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1"));

    const root = handleRoot();
    expect(root?.getAttribute(TURN_INTO_HANDLE_ATTRIBUTE)).toBe("turn-into");
    expect(root?.querySelector(`[data-testid="${TURN_INTO_HANDLE_TESTID}"]`)).not.toBeNull();
  });

  it("EDT-049: a alça só aparece para o bloco que contém a seleção atual", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Primeiro" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Segundo" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a"));
    expect(handleRoot()).not.toBeNull();

    editor.commands.setTextSelection(startOfBlock("b"));
    // Reaberto para "b" - não sobrou uma segunda alça presa em "a".
    expect(editor.view.dom.querySelectorAll(`[${TURN_INTO_HANDLE_ATTRIBUTE}]`)).toHaveLength(1);
  });
});
