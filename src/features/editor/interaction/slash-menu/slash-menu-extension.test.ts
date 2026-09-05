/**
 * Exercita o gatilho real: um `Editor` de verdade, texto inserido como uma
 * transação de doc (não há "digitar" de fato em jsdom - ver `commands.test.ts`
 * pro mesmo raciocínio sobre Enter/Tab/Backspace) e `KeyboardEvent`s reais
 * despachados em `editor.view.dom`, pra provar que o plugin intercepta a
 * tecla antes do keymap estrutural (`BlockKeymap`) e não só que a função de
 * filtro sozinha funciona (isso já está em `slash-menu-filter.test.ts`).
 *
 * Os itens de heading/citação usados aqui são registrados pelo próprio teste
 * - esta pasta não registra bloco nenhum (é consumidora do registro, ver
 * README), então "a lista filtra headings" só pode ser provado com um item
 * que o teste mesmo declara, como o enunciado da tarefa pede.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSlashMenuItem, resetBlockRegistriesForTests } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import "./register"; // side effect: registra a extensão do "/" e o overlay
import { useSlashMenuStore } from "./slash-menu-store";

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

/** Posição logo no início do texto do bloco com este id - acha pelo doc em vez de calcular offset na mão (mesma técnica de `commands.test.ts`). */
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

function emptyParagraphDoc(id: string): JSONContent {
  return { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id } }] }] };
}

beforeEach(() => {
  resetBlockRegistriesForTests();
  useSlashMenuStore.getState().close();
});

afterEach(() => {
  editor?.destroy();
});

describe("EDT-047: menu de barra", () => {
  it('EDT-047: digitar "/head" num bloco vazio ativa o menu com a query "head"', () => {
    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/head");

    expect(useSlashMenuStore.getState().active).toBe(true);
    expect(useSlashMenuStore.getState().query).toBe("head");
  });

  it('EDT-047: "/head" filtra pro item de heading registrado por outro builder e esconde os que não casam', () => {
    let insertedRun = "";
    registerTestItem("test:heading_1", "Título 1", ["heading", "titulo"], () => {
      insertedRun = "heading_1";
      return true;
    });
    registerTestItem("test:quote", "Citação", ["quote", "citacao"], () => {
      insertedRun = "quote";
      return true;
    });

    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/head");
    press("Enter");

    expect(insertedRun).toBe("heading_1");
  });

  it("EDT-047: Enter na opção realçada roda o run() dela e apaga o \"/\" e o filtro antes", () => {
    registerTestItem("test:heading_1", "Título 1", ["heading"], (ed) => {
      ed.commands.insertContent("BLOCO-INSERIDO");
      return true;
    });

    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/head");
    press("Enter");

    const paragraphText = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
    expect(paragraphText).toBe("BLOCO-INSERIDO");
    expect(paragraphText).not.toContain("/head");
    expect(useSlashMenuStore.getState().active).toBe(false);
  });

  it("EDT-047: setas navegam entre as opções visíveis antes do Enter confirmar", () => {
    const runs: string[] = [];
    registerTestItem("test:a", "Alfa", ["alfa"], () => {
      runs.push("a");
      return true;
    });
    registerTestItem("test:b", "Beta", ["beta"], () => {
      runs.push("b");
      return true;
    });

    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/"); // sem filtro: os dois itens ficam visíveis

    press("ArrowDown"); // do implícito "primeiro item" (Alfa) pra Beta
    press("Enter");

    expect(runs).toEqual(["b"]);
  });

  it("EDT-047: quando nada casa, o menu segue ativo (não some) e Enter não insere nada", () => {
    registerTestItem("test:heading_1", "Título 1", ["heading"], () => true);

    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/nada-disso-existe");

    expect(useSlashMenuStore.getState().active).toBe(true); // "diz que nada casou" em vez de sumir

    const before = editor.getJSON();
    press("Enter");
    expect(editor.getJSON()).toEqual(before); // Enter não fez nada além de continuar engolido
  });

  it("EDT-047: Esc fecha o menu sem alterar o texto", () => {
    registerTestItem("test:heading_1", "Título 1", ["heading"], () => true);

    editor = createEditor(emptyParagraphDoc("a"));
    editor.commands.setTextSelection(startOfBlock("a"));
    editor.commands.insertContent("/head");
    expect(useSlashMenuStore.getState().active).toBe(true);

    press("Escape");
    expect(useSlashMenuStore.getState().active).toBe(false);
    const paragraphText = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
    expect(paragraphText).toBe("/head");
  });
});

// Registra um item mínimo do jeito que outro builder registraria o dele -
// só o suficiente pra este arquivo verificar que o menu renderiza (e insere)
// o que está no registro, sem este builder ser dono de bloco nenhum.
function registerTestItem(id: string, title: string, keywords: string[], run: (editor: Editor) => boolean) {
  registerSlashMenuItem({ id, title, keywords, group: "Teste", run });
}
