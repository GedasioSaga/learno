/**
 * `bookmarkPasteDecision` is tested against a real `EditorState` (built from
 * a real `Editor`, same helper pattern `core/commands.test.ts` uses) but a
 * fake clipboard-text source, not a DOM `ClipboardEvent` - jsdom (this
 * project's vitest environment) implements no `ClipboardEvent` at all, so
 * one can't be constructed to drive `handlePaste` through the actual DOM
 * paste path. The one line in `paste-plugin.ts` that touches the real event
 * (`event.clipboardData`) is a direct, untestable-by-jsdom pass-through to
 * this function - documented as a gap in the report, not silently skipped.
 */
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { BookmarkNode } from "./bookmark-node";
import {
  bookmarkPasteDecision,
  bookmarkPasteKey,
  BookmarkPastePlugin,
  confirmBookmarkCard,
  confirmInlineLink,
  confirmPlainTextPaste,
  type ClipboardTextSource,
} from "./paste-plugin";

let editor: Editor;

function fakeClipboard(text: string): ClipboardTextSource {
  return { getData: (format) => (format === "text/plain" ? text : "") };
}

function createEditor(content: JSONContent, extraExtensions: AnyExtension[] = []) {
  return new Editor({ extensions: [...buildEditorExtensions(), BookmarkNode, BookmarkPastePlugin, ...extraExtensions], content });
}

function emptyParagraphDoc(): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] }] };
}

function press(key: string) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/**
 * The empty paragraph's own text-start position - found by walking the live
 * doc (same approach `core/commands.test.ts`'s `startOfBlock` uses) rather
 * than hand-counting wrapper/node open-tag offsets, which drift the moment
 * the doc shape changes.
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

// `Editor.getJSON()`'s declared return type recursively narrows nested
// content to `NodeType | TextType` (no `.content`/`.attrs` on the text
// branch) - exactly right for that API, pointless friction for a test that
// just wants to walk the tree. Same workaround `core/commands.test.ts` uses.
function json(): JSONContent {
  return editor.getJSON();
}

afterEach(() => {
  editor?.destroy();
});

describe("bookmarkPasteDecision", () => {
  it("EDT-030: URL colada, sozinha, em bloco vazio -> pendente com a URL e a posição do cursor", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a")); // dentro do parágrafo vazio "a"

    const decision = bookmarkPasteDecision(editor.state, fakeClipboard("https://exemplo.test/pagina"));
    expect(decision).toEqual({ url: "https://exemplo.test/pagina", pos: startOfBlock("a") });
  });

  it("não oferece o menu quando o bloco já tem texto", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] }],
    });
    editor.commands.setTextSelection(4); // fim de "Olá"

    expect(bookmarkPasteDecision(editor.state, fakeClipboard("https://exemplo.test"))).toBeNull();
  });

  it("não oferece o menu quando o texto colado não é uma URL isolada", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));

    expect(bookmarkPasteDecision(editor.state, fakeClipboard("dá uma olhada: https://exemplo.test"))).toBeNull();
    expect(bookmarkPasteDecision(editor.state, fakeClipboard("texto qualquer"))).toBeNull();
  });

  it("recusa esquema hostil (javascript:/data:) mesmo colado sozinho num bloco vazio", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));

    expect(bookmarkPasteDecision(editor.state, fakeClipboard("javascript:alert(1)"))).toBeNull();
    expect(bookmarkPasteDecision(editor.state, fakeClipboard("data:text/html,x"))).toBeNull();
  });
});

describe("dispatch do estado pendente (o que handlePaste faz ao aceitar uma decisão)", () => {
  it("EDT-030: gravar a decisão via setMeta deixa o menu (estado do plugin) visível e não insere nada no documento", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));

    const decision = bookmarkPasteDecision(editor.state, fakeClipboard("https://exemplo.test"));
    if (!decision) throw new Error("esperava uma decisão pendente para uma URL isolada em bloco vazio");
    editor.view.dispatch(editor.state.tr.setMeta(bookmarkPasteKey, decision));

    // `bookmarkPasteDecision` normaliza a URL via `URL#toString()` - por
    // isso a barra final, que "https://exemplo.test" não tinha.
    expect(bookmarkPasteKey.getState(editor.state)).toEqual({ url: "https://exemplo.test/", pos: startOfBlock("a") });
    // Nada foi inserido no documento - o bloco continua vazio, esperando a escolha.
    expect(json().content?.[0]?.content?.[0]?.content).toBeUndefined();
  });
});

describe("confirmBookmarkCard", () => {
  it('EDT-028/030: "Criar bookmark" converte o bloco vazio no cartão, com os metadados passados', () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));

    const created = confirmBookmarkCard(
      editor,
      { url: "https://exemplo.test/pagina", pos: startOfBlock("a") },
      { title: "Exemplo", description: "Uma descrição", favicon: "https://exemplo.test/favicon.ico" },
    );

    expect(created).toBe(true);
    const doc = json();
    const wrapper = doc.content?.[0];
    const contentNode = wrapper?.content?.[0];
    expect(contentNode?.type).toBe("bookmark");
    expect(contentNode?.attrs).toMatchObject({
      url: "https://exemplo.test/pagina",
      title: "Exemplo",
      description: "Uma descrição",
      favicon: "https://exemplo.test/favicon.ico",
    });
    // Mesmo bloco (mesmo id), só o tipo mudou - igual a `turnCurrentBlockInto`.
    expect(contentNode?.attrs?.id).toBe("a");
  });
});

describe("confirmInlineLink", () => {
  it('EDT-030: "Criar link/menção" insere a URL como texto inline no mesmo bloco, não um cartão', () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));

    const created = confirmInlineLink(editor, { url: "https://exemplo.test", pos: startOfBlock("a") });

    expect(created).toBe(true);
    const doc = json();
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("paragraph"); // continua parágrafo, não virou bookmark
    expect(contentNode?.content?.[0]?.text).toBe("https://exemplo.test");
  });

  it("com a marca link registrada, o texto inserido carrega o mark link com o href certo", () => {
    editor = createEditor(emptyParagraphDoc(), [Link.configure({ openOnClick: false })]);
    editor.commands.setTextSelection(startOfBlock("a"));

    confirmInlineLink(editor, { url: "https://exemplo.test", pos: startOfBlock("a") });

    const textNode = json().content?.[0]?.content?.[0]?.content?.[0];
    expect(textNode?.text).toBe("https://exemplo.test");
    expect(textNode?.marks).toEqual([{ type: "link", attrs: expect.objectContaining({ href: "https://exemplo.test" }) }]);
  });
});

describe("Escape / Cancelar", () => {
  it("Escape com o menu pendente cola o texto simples e limpa o estado pendente", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.view.dispatch(editor.state.tr.setMeta(bookmarkPasteKey, { url: "https://exemplo.test", pos: startOfBlock("a") }));
    expect(bookmarkPasteKey.getState(editor.state)).not.toBeNull();

    press("Escape");

    expect(bookmarkPasteKey.getState(editor.state)).toBeNull();
    expect(json().content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("https://exemplo.test");
  });

  it("Escape sem menu pendente não faz nada (deixa o atalho para outra coisa)", () => {
    editor = createEditor(emptyParagraphDoc());
    press("Escape");
    expect(json().content?.[0]?.content?.[0]?.content).toBeUndefined();
  });
});

describe("confirmPlainTextPaste", () => {
  it("insere a URL como texto puro, sem criar bookmark nem depender de nenhum mark", () => {
    editor = createEditor(emptyParagraphDoc());
    editor.commands.setTextSelection(startOfBlock("a"));
    const created = confirmPlainTextPaste(editor, { url: "https://exemplo.test", pos: startOfBlock("a") });
    expect(created).toBe(true);
    expect(json().content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("https://exemplo.test");
  });
});
