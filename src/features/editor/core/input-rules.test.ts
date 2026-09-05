/**
 * Os atalhos markdown dos nove tipos estruturais, exercitados digitando de
 * verdade.
 *
 * Uma auditoria da Fase 2 encontrou que EDT-002/003/004/006/007/009/010/012/
 * 016 não tinham prova nenhuma: as `addInputRules` de `schema.ts` foram
 * conferidas lendo o regex, e a persistência foi conferida por round trip em
 * `serialize.test.ts`, mas ninguém nunca digitou `# ` num bloco vazio para
 * ver se ele vira H1. Uma regex certa registrada na extensão errada, ou uma
 * extensão que o `StarterKit` sobrescreve, passa por todos os outros testes
 * deste diretório sem ser notada — e o usuário digita `- ` e não acontece
 * nada.
 *
 * Digitar em ProseMirror não é `insertContent`: input rule é plugin que
 * escuta `handleTextInput`, e conteúdo inserido por comando não passa por
 * ele. `type()` abaixo entrega caractere por caractere pelo mesmo prop que o
 * teclado usaria, caindo em `insertText` só quando nenhuma regra reclamou —
 * é o caminho real, não uma imitação.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "./extensions";
import { NODE_NAMES } from "./node-names";

let editor: Editor;

function createEditorWithEmptyParagraph(): Editor {
  return new Editor({
    extensions: buildEditorExtensions(),
    content: {
      type: NODE_NAMES.doc,
      content: [
        {
          type: NODE_NAMES.block,
          content: [{ type: NODE_NAMES.paragraph, attrs: { id: "a" } }],
        },
      ],
    },
  });
}

/**
 * Digita `text` caractere por caractere pelo caminho do teclado, para as
 * input rules dispararem.
 *
 * O quinto argumento de `handleTextInput` é `deflt`: a transação que o
 * ProseMirror aplicaria se ninguém tratasse a tecla. Passar a mesma closure
 * que usamos no fallback é o que o `prosemirror-view` faz internamente — e é
 * o que mantém este helper honesto: quando nenhuma regra reclama, o caractere
 * é inserido exatamente como seria de verdade.
 */
function type(text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const deflt = () => editor.state.tr.insertText(char, from, to);
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, char, deflt),
    );
    if (!handled) editor.view.dispatch(deflt());
  }
}

/** O nó `blockContent` do primeiro bloco do documento — onde tipo, attrs e texto moram (ver `schema.ts`). */
function firstBlockContent(): JSONContent {
  const doc = editor.getJSON();
  const node = doc.content?.[0]?.content?.[0];
  if (!node) throw new Error("documento sem blockContent no primeiro bloco");
  return node;
}

function textOf(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.text ?? "").join("");
}

afterEach(() => {
  editor?.destroy();
});

describe("atalhos markdown dos tipos estruturais", () => {
  it.each([
    ["# ", 1],
    ["## ", 2],
    ["### ", 3],
  ])("EDT-002/003/004: digitar '%s' num bloco vazio vira heading do nível %i e o marcador some", (marker, level) => {
    editor = createEditorWithEmptyParagraph();
    type(`${marker}Título`);

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.heading);
    expect(node.attrs?.level).toBe(level);
    // "o marcador some": o `#` digitado não pode sobrar como texto.
    expect(textOf(node)).toBe("Título");
  });

  it.each(["- ", "* ", "+ "])("EDT-006: digitar '%s' vira item de lista com marcador", (marker) => {
    editor = createEditorWithEmptyParagraph();
    type(`${marker}item`);

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.bulletedListItem);
    expect(textOf(node)).toBe("item");
  });

  it("EDT-007: digitar '1. ' vira item numerado", () => {
    editor = createEditorWithEmptyParagraph();
    type("1. primeiro");

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.numberedListItem);
    expect(textOf(node)).toBe("primeiro");
  });

  it("EDT-009: digitar '[] ' vira to-do desmarcado", () => {
    editor = createEditorWithEmptyParagraph();
    type("[] comprar pão");

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.todoItem);
    expect(node.attrs?.checked).toBe(false);
    expect(textOf(node)).toBe("comprar pão");
  });

  it("EDT-010: digitar '> ' vira toggle não colapsado", () => {
    editor = createEditorWithEmptyParagraph();
    type("> detalhes");

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.toggle);
    expect(node.attrs?.collapsed).toBe(false);
    expect(textOf(node)).toBe("detalhes");
  });

  it("EDT-012: digitar aspas mais espaço vira citação", () => {
    editor = createEditorWithEmptyParagraph();
    type('" citação');

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.quote);
  });

  it("EDT-016: digitar '---' vira divisor, sem texto editável", () => {
    editor = createEditorWithEmptyParagraph();
    type("---");

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.divider);
    // O divisor é átomo: nada de conteúdo inline sobrando (ver `hasContent:
    // false` no spec dele em `core-specs.ts`).
    expect(node.content).toBeUndefined();
  });

  it("um marcador no meio do texto não converte nada — input rule só vale no início do bloco", () => {
    editor = createEditorWithEmptyParagraph();
    type("veja o item - aqui");

    const node = firstBlockContent();
    expect(node.type).toBe(NODE_NAMES.paragraph);
    expect(textOf(node)).toBe("veja o item - aqui");
  });

  it("o id do bloco sobrevive à conversão por atalho: é o mesmo bloco, não um novo", () => {
    editor = createEditorWithEmptyParagraph();
    type("## Seção");

    // Um id novo aqui faria o autosave apagar a linha antiga e criar outra a
    // cada vez que alguém digitasse um atalho — ver `use-blocks-document.ts`.
    expect(firstBlockContent().attrs?.id).toBe("a");
  });
});
