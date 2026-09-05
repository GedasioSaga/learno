/**
 * Exercises the real `Suggestion` plugin through a real (headless) `Editor`
 * instance - same technique `core/commands.test.ts` uses for the structural
 * keymap - instead of calling internal functions directly, so these tests
 * catch a wiring mistake (wrong `pluginKey`, `shouldShow` never reached,
 * priority losing the race against `Enter`) that a pure unit test of
 * `date-parsing.ts` alone could not.
 */
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDateMentionCalendarStore } from "./date-mention-calendar-store";
import { DateMention, MENTION_DATE_NODE_NAME, insertDateMention, mentionDateSuggestionPluginKey } from "./date-mention-node";

let editor: Editor;

function createEditor(content?: JSONContent): Editor {
  return new Editor({
    extensions: [StarterKit, DateMention],
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
}

function press(key: string) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/**
 * `Editor.getJSON()`'s declared return type recursively narrows nested
 * content to `NodeType | TextType` (no `.attrs` on the text branch) - exactly
 * right for that API, pointless friction for a test that just wants to read
 * an attr back. `JSONContent` is the loose shape `core/commands.test.ts`'s
 * own `json()` helper widens to for the same reason.
 */
function json(): JSONContent {
  return editor.getJSON();
}

afterEach(() => {
  editor?.destroy();
  useDateMentionCalendarStore.getState().close();
});

describe("EDT-045: o gatilho @ fica em silêncio para quem não é data", () => {
  it("EDT-045: '@joao' (um nome, provável menção de página) não ativa a sugestão de data", () => {
    editor = createEditor();
    editor.commands.insertContent("@joao");
    expect(mentionDateSuggestionPluginKey.getState(editor.state)?.active).toBe(false);
  });

  it("EDT-045: '@amanha' ativa a sugestão de data com a query certa", () => {
    editor = createEditor();
    editor.commands.insertContent("@amanha");
    const state = mentionDateSuggestionPluginKey.getState(editor.state);
    expect(state?.active).toBe(true);
    expect(state?.query).toBe("amanha");
  });

  it("EDT-045: '@25/12' (formato de data) também ativa a sugestão", () => {
    editor = createEditor();
    editor.commands.insertContent("@25/12");
    expect(mentionDateSuggestionPluginKey.getState(editor.state)?.active).toBe(true);
  });
});

describe("EDT-045: inserção do chip grava ISO, nunca o texto digitado", () => {
  it("attrs.date é a data resolvida em ISO, não 'amanha'", () => {
    editor = createEditor();
    insertDateMention(editor, { from: 1, to: 1 }, "2026-09-04");
    const mentionNode = json().content?.[0]?.content?.[0];
    expect(mentionNode?.type).toBe(MENTION_DATE_NODE_NAME);
    expect(mentionNode?.attrs?.date).toBe("2026-09-04");
  });

  it("o chip renderizado mostra a data formatada em pt-BR, não o ISO cru", () => {
    editor = createEditor();
    insertDateMention(editor, { from: 1, to: 1 }, "2026-09-04");
    const chip = editor.view.dom.querySelector(`[data-type="${MENTION_DATE_NODE_NAME}"]`);
    expect(chip?.textContent).toBe("04/09/2026");
  });

  it("EDT-045: chip com attrs.date ausente (null) mostra rótulo 'Data' em vez de quebrar, no NodeView de verdade", () => {
    editor = createEditor();
    // Sem `attrs`, o default declarado em `addAttributes` (`null as string | null`)
    // é o que preenche `date` - o mesmo caminho que `syncLabel`/`renderHTML`
    // têm que sobreviver sem lançar.
    editor.chain().focus().insertContentAt(1, { type: MENTION_DATE_NODE_NAME }).run();
    const chip = editor.view.dom.querySelector(`[data-type="${MENTION_DATE_NODE_NAME}"]`);
    expect(chip?.textContent).toBe("Data");
    expect(chip?.getAttribute("aria-label")).toBe("Data mencionada sem valor. Clique para editar.");
  });

  it("clicar no chip abre o mini-calendário com a data atual do nó, não vazio", () => {
    editor = createEditor();
    insertDateMention(editor, { from: 1, to: 1 }, "2026-09-04");
    const chip = editor.view.dom.querySelector(`[data-type="${MENTION_DATE_NODE_NAME}"]`);
    expect(chip).not.toBeNull();
    chip?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    const overlay = useDateMentionCalendarStore.getState();
    expect(overlay.pos).not.toBeNull();
    expect(overlay.iso).toBe("2026-09-04");
  });
});

describe("EDT-045: confirmar pelo teclado (Enter) resolve com tempo controlado", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Quinta-feira, 3 de setembro de 2026 - nunca o dia real de execução.
    vi.setSystemTime(new Date(2026, 8, 3, 9, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Enter em '@amanha' confirma o único candidato e grava o dia seguinte ao agora fixado", () => {
    editor = createEditor();
    editor.commands.insertContent("@amanha");
    expect(mentionDateSuggestionPluginKey.getState(editor.state)?.active).toBe(true);

    press("Enter");

    const mentionNode = json().content?.[0]?.content?.[0];
    expect(mentionNode?.type).toBe(MENTION_DATE_NODE_NAME);
    expect(mentionNode?.attrs?.date).toBe("2026-09-04");
    // A sugestão não fica pendurada depois de confirmada.
    expect(mentionDateSuggestionPluginKey.getState(editor.state)?.active).toBe(false);
  });

  it("um Enter comum (sem sugestão de data ativa) continua dividindo o bloco normalmente", () => {
    editor = createEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Olá" }] }] });
    editor.commands.setTextSelection(4); // fim de "Olá"
    press("Enter");
    expect(editor.getJSON().content).toHaveLength(2);
  });
});
