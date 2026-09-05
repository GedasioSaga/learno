import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DateMentionCalendarOverlay } from "./DateMentionCalendarOverlay";
import { useDateMentionCalendarStore } from "./date-mention-calendar-store";
import { DateMention, MENTION_DATE_NODE_NAME, insertDateMention } from "./date-mention-node";

let editor: Editor;

afterEach(() => {
  editor?.destroy();
  useDateMentionCalendarStore.getState().close();
});

/** Position of the one `mentionDate` node in the doc - found by walking it, same technique `core/commands.test.ts`'s `startOfBlock` uses, so this never hardcodes an offset the schema could shift. */
function mentionPos(target: Editor): number {
  let result: number | null = null;
  target.state.doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.type.name === MENTION_DATE_NODE_NAME) {
      result = pos;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error("mentionDate node not found in the current doc");
  return result;
}

/** Widens `getJSON()`'s recursively-narrowed return type back to the loose `JSONContent` shape - same friction (and same fix) as `core/commands.test.ts`'s own `json()` helper. */
function json(target: Editor): JSONContent {
  return target.getJSON();
}

function mentionDateAttr(target: Editor): unknown {
  const mentionNode = json(target).content?.[0]?.content?.[0];
  return mentionNode?.attrs?.date;
}

function openCalendarOnFixture(): void {
  editor = new Editor({
    extensions: [StarterKit, DateMention],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  insertDateMention(editor, { from: 1, to: 1 }, "2026-09-04");
  const pos = mentionPos(editor);
  act(() => {
    useDateMentionCalendarStore.getState().open(pos, "2026-09-04", new DOMRect(10, 20, 0, 0));
  });
  render(<DateMentionCalendarOverlay editor={editor} />);
}

describe("EDT-045: mini-calendário - navegação por teclado", () => {
  it("seta para a direita move o dia rascunho, sem gravar nada no nó ainda", () => {
    openCalendarOnFixture();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    // Nada commitado só de mover o rascunho.
    expect(mentionDateAttr(editor)).toBe("2026-09-04");
  });

  it("Enter confirma o dia rascunho e grava no nó, não só no popup", () => {
    openCalendarOnFixture();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(mentionDateAttr(editor)).toBe("2026-09-05");
    expect(useDateMentionCalendarStore.getState().pos).toBeNull(); // fecha ao confirmar
  });

  it("seta para baixo avança uma semana inteira (7 dias)", () => {
    openCalendarOnFixture();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(mentionDateAttr(editor)).toBe("2026-09-11");
  });

  it("Esc cancela sem alterar a data do nó, e fecha o overlay", () => {
    openCalendarOnFixture();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(mentionDateAttr(editor)).toBe("2026-09-04"); // inalterado
    expect(useDateMentionCalendarStore.getState().pos).toBeNull();
  });

  it("clicar num dia da grade confirma direto, sem precisar do teclado", () => {
    openCalendarOnFixture();
    const day = screen.getByRole("button", { name: "05/09/2026" });
    fireEvent.click(day);
    expect(mentionDateAttr(editor)).toBe("2026-09-05");
  });
});
