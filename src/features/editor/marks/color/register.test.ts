/**
 * EDT-040/041: prova de que aplicar cor de texto e cor de fundo sobrevive ao
 * round trip de salvar/abrir - a parte "persiste ao desfocar" do critério,
 * que uma marca comum ganha de graça (ver comentário em `register.ts`), mas
 * que vale provar em vez de assumir. `ColorMenuButton.test.tsx` cobre a
 * interação de UI; este arquivo cobre só o dado.
 *
 * Os valores de `TEXT_COLORS`/`HIGHLIGHT_COLORS` deixaram de ser hex literal
 * e passaram a `color-mix()` (ver `palette.ts`) - a maioria dos testes abaixo
 * usa esses valores DA PALETA, não um hex hardcoded, para continuar provando
 * o que a UI de fato produz hoje. As duas seções "compatibilidade" no fim de
 * cada `describe` são a exceção deliberada: usam o hex ANTIGO direto,
 * simulando um `Block` já salvo antes desta mudança, para provar que ele
 * ainda é lido e renderizado sem precisar de migração.
 */
import { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { HIGHLIGHT_COLORS, type NamedColor, TEXT_COLORS } from "./palette";
import "./register";

let editor: Editor;

/** Acha uma cor pela `id` na paleta e falha alto (não silencioso) se a
    paleta mudou e a cor sumiu - preferível a `!` num teste. */
function colorValue(list: NamedColor[], id: string): string {
  const found = list.find((color) => color.id === id);
  if (!found) throw new Error(`cor "${id}" não está na paleta`);
  return found.value;
}

const RED_TEXT = colorValue(TEXT_COLORS, "red");
const YELLOW_HIGHLIGHT = colorValue(HIGHLIGHT_COLORS, "yellow");

/** O literal que `TEXT_COLORS`/`HIGHLIGHT_COLORS` guardavam antes da migração
    para `color-mix()` (matiz + tema). Nunca deve virar `RED_TEXT`/
    `YELLOW_HIGHLIGHT` acima - o objetivo dos testes de compatibilidade é
    justamente que ele continue sendo um literal independente da paleta. */
const OLD_RED_HEX = "#b3261e";
const OLD_YELLOW_HIGHLIGHT_HEX = "#eab30866";

function createEditor(): Editor {
  return new Editor({
    extensions: buildEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá mundo" }] }],
        },
      ],
    },
  });
}

function selectWord() {
  // "Olá" - posição 2 é o início do texto dentro do parágrafo (doc(1) > block(1) > paragraph(1) > texto).
  editor.commands.setTextSelection({ from: 2, to: 5 });
}

function storedBlockFor(id: string, blockType: string, content: Block["content"], plainText: string): Block {
  return {
    id,
    pageId: "page-1",
    parentBlockId: null,
    blockType,
    content,
    plainText,
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
  };
}

beforeEach(() => {
  editor = createEditor();
});

describe("EDT-040: cor de texto inline", () => {
  it("aplicar 'Vermelho' muda a cor da fonte no texto selecionado", () => {
    selectWord();
    const applied = editor.commands.setColor(RED_TEXT);
    expect(applied).toBe(true);

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle");
    expect(mark?.attrs.color).toBe(RED_TEXT);
  });

  it("persiste ao desfocar: sobrevive ao round trip doc -> Block[] -> doc", () => {
    selectWord();
    editor.commands.setColor(RED_TEXT);

    const [flat] = docToFlatBlocks(editor.getJSON());
    expect(flat.content).toMatchObject({
      inline: [
        { type: "text", text: "Olá", marks: [{ type: "textStyle", attrs: { color: RED_TEXT } }] },
        { type: "text", text: " mundo" },
      ],
    });

    // Reabrir: um `Block` guardado com essa marca reconstrói o doc com ela intacta.
    const reopened = blocksToDoc([storedBlockFor("p1", "paragraph", flat.content, flat.plainText)]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "textStyle", attrs: { color: RED_TEXT } });
  });

  it("'Remover cor' tira a marca de novo", () => {
    selectWord();
    editor.commands.setColor(RED_TEXT);
    editor.commands.unsetColor();

    const mark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "textStyle" && m.attrs.color);
    expect(mark).toBeUndefined();
  });

  it("compatibilidade: um Block salvo com o hex ANTIGO (de antes da migração para color-mix) ainda é lido e renderizado", () => {
    // Não passa pelo editor/`setColor` - simula um documento que já estava
    // salvo em disco com o literal antigo, sem nenhuma migração rodar nele.
    const oldBlock = storedBlockFor(
      "p1",
      "paragraph",
      { inline: [{ type: "text", text: "Olá", marks: [{ type: "textStyle", attrs: { color: OLD_RED_HEX } }] }] },
      "Olá",
    );

    const reopened = blocksToDoc([oldBlock]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "textStyle", attrs: { color: OLD_RED_HEX } });
  });
});

describe("EDT-041: cor de fundo (highlight) inline", () => {
  it("aplicar 'Amarelo background' é uma marca diferente de EDT-040, não a mesma renomeada", () => {
    selectWord();
    editor.commands.setHighlight({ color: YELLOW_HIGHLIGHT });

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    const highlightMark = marks.find((m) => m.type.name === "highlight");
    expect(highlightMark?.attrs.color).toBe(YELLOW_HIGHLIGHT);
    // A marca de cor de texto continua ausente - as duas nunca colapsam numa só.
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color)).toBe(false);
  });

  it("cor de texto e cor de fundo combinam no mesmo trecho", () => {
    selectWord();
    editor.commands.setColor(RED_TEXT);
    editor.commands.setHighlight({ color: YELLOW_HIGHLIGHT });

    const marks = editor.state.doc.nodeAt(2)?.marks ?? [];
    expect(marks.some((m) => m.type.name === "textStyle" && m.attrs.color === RED_TEXT)).toBe(true);
    expect(marks.some((m) => m.type.name === "highlight" && m.attrs.color === YELLOW_HIGHLIGHT)).toBe(true);
  });

  it("persiste ao desfocar: sobrevive ao round trip doc -> Block[] -> doc", () => {
    selectWord();
    editor.commands.setHighlight({ color: YELLOW_HIGHLIGHT });

    const [flat] = docToFlatBlocks(editor.getJSON());
    const reopened = blocksToDoc([storedBlockFor("p1", "paragraph", flat.content, flat.plainText)]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "highlight", attrs: { color: YELLOW_HIGHLIGHT } });
  });

  it("'Remover destaque' tira a marca de novo", () => {
    selectWord();
    editor.commands.setHighlight({ color: YELLOW_HIGHLIGHT });
    editor.commands.unsetHighlight();

    const highlightMark = editor.state.doc.nodeAt(2)?.marks.find((m) => m.type.name === "highlight");
    expect(highlightMark).toBeUndefined();
  });

  it("compatibilidade: um Block salvo com o hex+alpha ANTIGO ainda é lido e renderizado", () => {
    const oldBlock = storedBlockFor(
      "p1",
      "paragraph",
      { inline: [{ type: "text", text: "Olá", marks: [{ type: "highlight", attrs: { color: OLD_YELLOW_HIGHLIGHT_HEX } }] }] },
      "Olá",
    );

    const reopened = blocksToDoc([oldBlock]);
    const reopenedText = reopened.content?.[0]?.content?.[0]?.content?.[0];
    expect(reopenedText?.marks).toContainEqual({ type: "highlight", attrs: { color: OLD_YELLOW_HIGHLIGHT_HEX } });
  });
});
