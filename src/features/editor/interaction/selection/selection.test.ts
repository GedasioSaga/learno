/**
 * EDT-055/057/058 (vitest, `docs/CHECKLIST.md`) - os três itens deste
 * checklist que não dependem de layout/hit-testing real. EDT-053/054/059
 * são `e2e-webdriverio` no mesmo checklist (arrasto de margem, shift+clique
 * e um round-trip de clipboard real precisam de `getBoundingClientRect()`/
 * `ClipboardEvent`, que jsdom não tem - ver `e2e/specs/block-selection.e2e.mjs`
 * e o cabeçalho de `selection-mouse.ts`); a lógica pura por trás deles
 * (`siblingIdsBetween`, a serialização de clipboard) ainda ganha teste
 * direto aqui, sem depender do gesto de DOM em si.
 *
 * Mesmo formato de `core/commands.test.ts`: um `Editor` de verdade,
 * `KeyboardEvent`s reais em `editor.view.dom` (não as funções de comando
 * chamadas direto), pra provar o atalho de teclado, não só a função.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import "./register";
import {
  BLOCKS_MIME,
  handlePasteSelectedBlocks,
  parseBlocksFromClipboard,
  serializeSelectedBlocksToClipboardJson,
  serializeSelectedBlocksToHtml,
  serializeSelectedBlocksToText,
} from "./selection-clipboard";
import { resolveSelectionRangeIds, siblingIdsBetween } from "./selection-commands";
import { getSelectedBlockIds, setSelectedBlockIds } from "./selection-state";

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

/** A `Block` wrapper's `blockContent` child - onde id/tipo/texto vivem (mesmo helper de `core/commands.test.ts`). */
function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper sem filho blockContent");
  return node;
}

/** Posição logo no início do texto do bloco com este id - acha pelo doc em vez de calcular offset na mão. */
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

function paragraphsDoc(entries: Array<[id: string, text: string]>): JSONContent {
  return {
    type: "doc",
    content: entries.map(([id, text]) => ({
      type: "block",
      content: [{ type: "paragraph", attrs: { id }, content: text ? [{ type: "text", text }] : undefined }],
    })),
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-055: Ctrl/Cmd+A no bloco", () => {
  it("primeira pressionada seleciona todo o texto do bloco sob o cursor, sem afetar vizinhos", () => {
    editor = createEditor(paragraphsDoc([["a", "Olá"], ["b", "Mundo"]]));
    editor.commands.setTextSelection(startOfBlock("a") + 1); // meio de "Olá"

    press("a", { ctrlKey: true });

    const { selection, doc } = editor.state;
    expect(doc.textBetween(selection.from, selection.to)).toBe("Olá");
    // Nunca alcança o bloco vizinho.
    expect(selection.to).toBeLessThan(startOfBlock("b"));
    // Nada no documento mudou - só a seleção.
    expect(json()).toEqual(paragraphsDoc([["a", "Olá"], ["b", "Mundo"]]));
  });

  it("vence o Mod-a default do TipTap (selectAll do documento inteiro)", () => {
    editor = createEditor(paragraphsDoc([["a", "Olá"], ["b", "Mundo"]]));
    editor.commands.setTextSelection(startOfBlock("a"));

    press("a", { ctrlKey: true });

    // Se o `selectAll` default tivesse vencido, a seleção cobriria o
    // documento inteiro (incluindo o bloco "b") - `to` ficaria bem além do
    // fim de "a".
    const endOfA = startOfBlock("a") + "Olá".length;
    expect(editor.state.selection.to).toBe(endOfA);
  });
});

describe("EDT-057: Backspace apaga uma seleção múltipla de blocos numa única ação", () => {
  function fourParagraphs() {
    return paragraphsDoc([
      ["a", "Um"],
      ["b", "Dois"],
      ["c", "Três"],
      ["d", "Quatro"],
    ]);
  }

  it("some com os 3 blocos selecionados, deixando só o resto - e um Ctrl/Cmd+Z desfaz tudo de uma vez", () => {
    editor = createEditor(fourParagraphs());
    setSelectedBlockIds(editor, ["a", "b", "c"]);

    press("Backspace");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "d" }, content: [{ text: "Quatro" }] });
    expect(getSelectedBlockIds(editor)).toEqual([]); // a seleção múltipla não sobrevive à própria exclusão

    // Uma única desfeita restaura os 3 - se fossem 3 transações separadas,
    // um só Ctrl/Cmd+Z devolveria apenas o último.
    press("z", { ctrlKey: true });
    expect(json()).toEqual(fourParagraphs());
  });

  it("sem seleção múltipla, devolve o Backspace pro comportamento normal de cursor simples (core/commands.ts)", () => {
    editor = createEditor(paragraphsDoc([["a", "Olá"], ["b", "Mundo"]]));
    editor.commands.setTextSelection(startOfBlock("b")); // cursor simples, início do bloco "b"

    press("Backspace");

    // EDT-069: funde "b" no fim de "a" - o comportamento estrutural do
    // core, intocado.
    const doc = json();
    expect(doc.content).toHaveLength(1);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "OláMundo" }] });
  });

  it("selecionar TODOS os blocos e apagar deixa um parágrafo novo válido, nunca a página sem nenhum bloco", () => {
    editor = createEditor(paragraphsDoc([["a", "Um"], ["b", "Dois"]]));
    setSelectedBlockIds(editor, ["a", "b"]);

    press("Backspace");

    const doc = json();
    expect(doc.content).toHaveLength(1);
    const remaining = contentOf(doc.content![0]);
    expect(remaining.type).toBe("paragraph");
    expect(typeof remaining.attrs?.id).toBe("string");
    expect(remaining.attrs?.id).not.toBe(""); // um id de verdade, não o preenchimento silencioso do ProseMirror (que nasceria sem id)
  });
});

describe("EDT-058: Ctrl/Cmd+D duplica", () => {
  it('duplica o bloco do cursor logo abaixo, com o mesmo texto e um id novo ("Nota A")', () => {
    editor = createEditor(paragraphsDoc([["a", "Nota A"]]));
    editor.commands.setTextSelection(startOfBlock("a"));

    press("d", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(2);
    expect(contentOf(doc.content![0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Nota A" }] });
    const duplicate = contentOf(doc.content![1]);
    expect(duplicate.content).toEqual([{ type: "text", text: "Nota A" }]);
    expect(duplicate.attrs?.id).not.toBe("a");
    expect(typeof duplicate.attrs?.id).toBe("string");
  });

  it("com seleção múltipla, duplica a seleção inteira como grupo, preservando a ordem", () => {
    editor = createEditor(paragraphsDoc([["a", "Um"], ["b", "Dois"], ["c", "Três"]]));
    setSelectedBlockIds(editor, ["a", "b"]);

    press("d", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(5);
    const texts = doc.content!.map((wrapper) => contentOf(wrapper).content?.[0]?.text);
    expect(texts).toEqual(["Um", "Dois", "Um", "Dois", "Três"]);
    const ids = doc.content!.map((wrapper) => contentOf(wrapper).attrs?.id);
    expect(new Set(ids).size).toBe(5); // 5 ids distintos - nenhum reaproveitado
    expect(ids.slice(0, 2)).toEqual(["a", "b"]); // originais intocados
  });

  it("duplica um bloco com filho aninhado dando id novo pros dois, não só pro pai", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "toggle", attrs: { id: "t", collapsed: false }, content: [{ type: "text", text: "Toggle" }] },
            {
              type: "childBlocks",
              content: [
                { type: "block", content: [{ type: "paragraph", attrs: { id: "child" }, content: [{ type: "text", text: "Filho" }] }] },
              ],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("t"));

    press("d", { ctrlKey: true });

    const doc = json();
    expect(doc.content).toHaveLength(2);
    const duplicateWrapper = doc.content![1];
    const duplicateToggle = contentOf(duplicateWrapper);
    expect(duplicateToggle.attrs?.id).not.toBe("t");
    const duplicateChildWrapper = duplicateWrapper.content?.[1]?.content?.[0];
    const duplicateChild = duplicateChildWrapper?.content?.[0];
    expect(duplicateChild?.attrs?.id).not.toBe("child"); // o filho também ganha id novo
    expect(duplicateChild?.content).toEqual([{ type: "text", text: "Filho" }]);
  });
});

describe("siblingIdsBetween (a lógica de EDT-054, sem o clique real)", () => {
  it("devolve os ids entre âncora e alvo, inclusive, na ordem do documento", () => {
    editor = createEditor(paragraphsDoc([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]));
    expect(siblingIdsBetween(editor.state.doc, "a", "c")).toEqual(["a", "b", "c"]);
    expect(siblingIdsBetween(editor.state.doc, "c", "a")).toEqual(["a", "b", "c"]); // ordem do clique não importa, o range é sempre em ordem de documento
  });

  it("devolve null quando os dois ids não são irmãos no mesmo nível", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "toggle", attrs: { id: "t", collapsed: false } },
            { type: "childBlocks", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "child" } }] }] },
          ],
        },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "sibling" } }] },
      ],
    });
    expect(siblingIdsBetween(editor.state.doc, "child", "sibling")).toBeNull();
  });
});

describe("resolveSelectionRangeIds (EDT-053/054: âncora e alvo de um gesto de mouse real)", () => {
  /** Raiz "a", "b" (toggle com filho "child" aninhado), "c" - o mesmo formato de "não são irmãos" acima, com um vizinho raiz de cada lado do toggle. */
  function docWithNestedChild(): JSONContent {
    return {
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] },
        {
          type: "block",
          content: [
            { type: "toggle", attrs: { id: "b", collapsed: false } },
            { type: "childBlocks", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "child" } }] }] },
          ],
        },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "c" } }] },
      ],
    };
  }

  it("gesto que atravessa níveis - começa num bloco raiz, termina num filho de outro bloco raiz - normaliza pro ancestral raiz do alvo", () => {
    editor = createEditor(docWithNestedChild());
    // Arrasto de "a" (raiz) até "child" (dentro de "b") - `siblingIdsBetween`
    // sozinho devolveria `null` aqui (níveis diferentes); a normalização
    // sobe "child" até "b", o ancestral que é irmão de "a".
    expect(resolveSelectionRangeIds(editor.state.doc, "a", "child")).toEqual(["a", "b"]);
  });

  it("gesto invertido (de baixo pra cima) cruzando níveis - mesmo resultado independente de quem é âncora e quem é alvo", () => {
    editor = createEditor(docWithNestedChild());
    // Começa em "c" (raiz, depois de "b" no documento) e termina em "child"
    // (aninhado, dentro de "b", que vem antes de "c") - o range final ainda
    // sai em ordem de documento, não na ordem em que o mouse passou.
    expect(resolveSelectionRangeIds(editor.state.doc, "c", "child")).toEqual(["b", "c"]);
  });

  it("mesmo nível (o caso comum) continua delegando pra siblingIdsBetween sem mudar o resultado", () => {
    editor = createEditor(docWithNestedChild());
    expect(resolveSelectionRangeIds(editor.state.doc, "a", "c")).toEqual(siblingIdsBetween(editor.state.doc, "a", "c"));
  });

  it("id inexistente no doc devolve null, em vez de travar num range parcial", () => {
    editor = createEditor(docWithNestedChild());
    expect(resolveSelectionRangeIds(editor.state.doc, "a", "fantasma")).toBeNull();
  });
});

describe("serialização de clipboard (o núcleo puro de EDT-059)", () => {
  it("H2 + lista de 2 itens: o HTML gerado carrega os três tipos, em ordem, com o texto de cada um", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "heading", attrs: { id: "h", level: 2 }, content: [{ type: "text", text: "Título" }] }] },
        { type: "block", content: [{ type: "bulletedListItem", attrs: { id: "i1" }, content: [{ type: "text", text: "Item 1" }] }] },
        { type: "block", content: [{ type: "bulletedListItem", attrs: { id: "i2" }, content: [{ type: "text", text: "Item 2" }] }] },
      ],
    });
    setSelectedBlockIds(editor, ["h", "i1", "i2"]);

    const html = serializeSelectedBlocksToHtml(editor);
    if (html === null) throw new Error("esperava HTML serializado para uma seleção múltipla não vazia");
    const order = [...html.matchAll(/data-block-type="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["heading", "bulletedListItem", "bulletedListItem"]);
    expect(html).toContain("Título");
    expect(html).toContain("Item 1");
    expect(html).toContain("Item 2");

    expect(serializeSelectedBlocksToText(editor)).toBe("Título\nItem 1\nItem 2");
  });

  it("sem seleção múltipla, devolve null (deixa o copy default de texto acontecer)", () => {
    editor = createEditor(paragraphsDoc([["a", "Olá"]]));
    expect(serializeSelectedBlocksToHtml(editor)).toBeNull();
    expect(serializeSelectedBlocksToText(editor)).toBeNull();
  });
});

describe("colar preservando estrutura (EDT-059, o par serialize/parse e o handlePaste)", () => {
  /** H2 + lista de 2 itens (as duas fontes de seleção), mais um parágrafo solto que serve de destino da colagem. */
  function docWithHeadingListAndDest(): JSONContent {
    return {
      type: "doc",
      content: [
        { type: "block", content: [{ type: "heading", attrs: { id: "h", level: 2 }, content: [{ type: "text", text: "Título" }] }] },
        { type: "block", content: [{ type: "bulletedListItem", attrs: { id: "i1" }, content: [{ type: "text", text: "Item 1" }] }] },
        { type: "block", content: [{ type: "bulletedListItem", attrs: { id: "i2" }, content: [{ type: "text", text: "Item 2" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "dest" }, content: [{ type: "text", text: "Parágrafo solto" }] }] },
      ],
    };
  }

  // jsdom não implementa `ClipboardEvent`/`DataTransfer` (mesmo raciocínio do
  // dublê em `blocks/media/media-blocks.test.ts`) - este objeto só carrega os
  // dois campos que `handlePasteSelectedBlocks` de fato lê
  // (`clipboardData.getData` e `preventDefault`), então o teste exercita o
  // comportamento real da função sem precisar de uma API que o ambiente de
  // teste não tem.
  function fakeClipboardEvent(data: Record<string, string>): ClipboardEvent {
    return {
      clipboardData: { getData: (format: string) => data[format] ?? "" },
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
  }

  it("serialize -> parse: tipos, atributos e aninhamento sobrevivem ao round-trip", () => {
    editor = createEditor(docWithHeadingListAndDest());
    setSelectedBlockIds(editor, ["h", "i1", "i2"]);

    const blocksJson = serializeSelectedBlocksToClipboardJson(editor);
    if (blocksJson === null) throw new Error("esperava JSON serializado para uma seleção múltipla não vazia");

    const clipboard = fakeClipboardEvent({ [BLOCKS_MIME]: blocksJson }).clipboardData;
    if (!clipboard) throw new Error("dublê de clipboard sem clipboardData - não deveria acontecer, ver fakeClipboardEvent");
    const parsed = parseBlocksFromClipboard(editor.schema, clipboard);
    if (!parsed) throw new Error("esperava reconstruir os wrappers a partir do JSON serializado");

    expect(parsed.map((wrapper) => wrapper.firstChild?.type.name)).toEqual(["heading", "bulletedListItem", "bulletedListItem"]);
    expect(parsed.map((wrapper) => wrapper.firstChild?.textContent)).toEqual(["Título", "Item 1", "Item 2"]);
    expect(parsed[0]?.firstChild?.attrs.level).toBe(2); // atributo do heading sobreviveu, não só o tipo
  });

  it("sem BLOCKS_MIME no clipboard, o parse devolve null", () => {
    editor = createEditor(docWithHeadingListAndDest());
    const clipboard = fakeClipboardEvent({}).clipboardData;
    if (!clipboard) throw new Error("dublê de clipboard sem clipboardData - não deveria acontecer, ver fakeClipboardEvent");
    expect(parseBlocksFromClipboard(editor.schema, clipboard)).toBeNull();
  });

  it("handlePasteSelectedBlocks: cola H2 + lista de 2 itens em outro ponto, mesmo tipo e aninhamento, ids novos", () => {
    editor = createEditor(docWithHeadingListAndDest());
    setSelectedBlockIds(editor, ["h", "i1", "i2"]);
    const blocksJson = serializeSelectedBlocksToClipboardJson(editor);
    if (blocksJson === null) throw new Error("esperava JSON serializado");

    editor.commands.setTextSelection(startOfBlock("dest") + "Parágrafo solto".length); // fim do parágrafo destino

    const handled = handlePasteSelectedBlocks(editor, fakeClipboardEvent({ [BLOCKS_MIME]: blocksJson }));
    expect(handled).toBe(true);

    const doc = json();
    const pasted = doc.content!.slice(-3).map((wrapper) => contentOf(wrapper));
    expect(pasted.map((node) => node.type)).toEqual(["heading", "bulletedListItem", "bulletedListItem"]);
    expect(pasted.map((node) => node.content?.[0]?.text)).toEqual(["Título", "Item 1", "Item 2"]);

    // Ids novos - nenhum reaproveitado dos originais, senão corrompe a linha
    // no banco (dois blocos disputando a mesma linha - ver `README.md`).
    const pastedIds = pasted.map((node) => node.attrs?.id);
    expect(pastedIds).not.toContain("h");
    expect(pastedIds).not.toContain("i1");
    expect(pastedIds).not.toContain("i2");
    const allIds = doc.content!.map((wrapper) => contentOf(wrapper).attrs?.id);
    expect(new Set(allIds).size).toBe(allIds.length); // nenhum id duplicado no doc inteiro após a colagem
  });

  it("sem BLOCKS_MIME (conteúdo de outro app ou outro builder), devolve false e não mexe no documento", () => {
    editor = createEditor(docWithHeadingListAndDest());
    editor.commands.setTextSelection(startOfBlock("dest"));
    const before = json();

    const handled = handlePasteSelectedBlocks(editor, fakeClipboardEvent({ "text/plain": "https://exemplo.test" }));

    expect(handled).toBe(false);
    expect(json()).toEqual(before);
  });
});
