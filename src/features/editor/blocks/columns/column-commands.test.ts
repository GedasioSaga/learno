/**
 * EDT-033: colunas / layout multi-coluna.
 *
 * Duas frentes: (1) persistência pura (`docToFlatBlocks`/`blocksToDoc`, sem
 * `Editor` - mesmo estilo de `core/serialize.test.ts`) prova que a árvore
 * `columnList -> childBlocks -> column -> childBlocks -> bloco` round-tripa
 * sem tocar em `core/`; (2) os comandos e o NodeView desta peça, exercitados
 * contra um `Editor` real (mesmo estilo de `core/commands.test.ts`), provam
 * que "envolver em colunas" e "redimensionar" (mouse E teclado) produzem a
 * árvore certa.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { collectSlashMenuItems, collectTurnIntoItems } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import "./register";
import { resizeColumnBoundary, wrapBlocksInColumns, wrapCurrentBlockInColumns } from "./column-commands";
import { COLUMN_MIN_WIDTH, COLUMN_RESIZE_STEP, DEFAULT_COLUMN_WIDTH } from "./node-names";

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function json(): JSONContent {
  return editor.getJSON();
}

/** Um `Block` wrapper's `blockContent` filho - onde id/tipo/texto moram (mesmo helper de `core/commands.test.ts`). */
function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper sem blockContent");
  return node;
}

/** Os filhos aninhados de um `Block` wrapper, se houver. */
function childrenOf(wrapper: JSONContent): JSONContent[] {
  const childBlocks = wrapper.content?.[1];
  return childBlocks?.type === "childBlocks" ? (childBlocks.content ?? []) : [];
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
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado`);
  return result;
}

afterEach(() => {
  editor?.destroy();
});

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

/** Um `Block` wrapper para os testes de serialização pura - mesmo formato de `serialize.test.ts`. */
function block(id: string, type: string, attrs: Record<string, unknown>, children: JSONContent[] = []): JSONContent {
  const contentNode: JSONContent = { type, attrs: { ...attrs, id } };
  const wrapperContent = [contentNode, ...(children.length > 0 ? [{ type: "childBlocks", content: children }] : [])];
  return { type: "block", content: wrapperContent };
}

function paragraphBlock(id: string, value: string): JSONContent {
  return { type: "block", content: [{ type: "paragraph", attrs: { id }, content: [text(value)] }] };
}

describe("EDT-033: persistência (columnList -> column -> bloco, sem Editor)", () => {
  it("achata a árvore de duas colunas mantendo o parentBlockId encadeado e a largura de cada coluna", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        block("cl", "columnList", {}, [
          block("c1", "column", { width: 0.3 }, [paragraphBlock("p1", "Esquerda")]),
          block("c2", "column", { width: 0.7 }, [paragraphBlock("p2", "Direita")]),
        ]),
      ],
    };

    const flat = docToFlatBlocks(doc);

    expect(flat.map((b) => b.id)).toEqual(["cl", "c1", "p1", "c2", "p2"]);
    expect(flat.find((b) => b.id === "cl")).toMatchObject({ parentBlockId: null, blockType: "column_list" });
    expect(flat.find((b) => b.id === "c1")).toMatchObject({
      parentBlockId: "cl",
      blockType: "column",
      content: { width: 0.3 },
    });
    expect(flat.find((b) => b.id === "p1")).toMatchObject({
      parentBlockId: "c1",
      blockType: "paragraph",
      plainText: "Esquerda",
    });
    expect(flat.find((b) => b.id === "c2")).toMatchObject({ parentBlockId: "cl", content: { width: 0.7 } });
    expect(flat.find((b) => b.id === "p2")).toMatchObject({ parentBlockId: "c2", plainText: "Direita" });
  });

  it("blocksToDoc reconstrói a mesma árvore que docToFlatBlocks devolve (round trip)", () => {
    function makeBlock(overrides: Partial<Block> & Pick<Block, "id" | "blockType">): Block {
      return {
        pageId: "page-1",
        parentBlockId: null,
        content: {},
        plainText: "",
        syncedSourceId: null,
        position: "m",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      };
    }

    const blocks: Block[] = [
      makeBlock({ id: "cl", blockType: "column_list", position: "a" }),
      makeBlock({ id: "c1", blockType: "column", parentBlockId: "cl", content: { width: 0.4 }, position: "a" }),
      makeBlock({
        id: "p1",
        blockType: "paragraph",
        parentBlockId: "c1",
        plainText: "Um",
        content: { inline: [text("Um")] },
        position: "a",
      }),
      makeBlock({ id: "c2", blockType: "column", parentBlockId: "cl", content: { width: 0.6 }, position: "b" }),
      makeBlock({
        id: "p2",
        blockType: "paragraph",
        parentBlockId: "c2",
        plainText: "Dois",
        content: { inline: [text("Dois")] },
        position: "a",
      }),
    ];

    const doc = blocksToDoc(blocks);
    const roundTripped = docToFlatBlocks(doc);

    expect(roundTripped.map((b) => ({ id: b.id, parentBlockId: b.parentBlockId, blockType: b.blockType }))).toEqual([
      { id: "cl", parentBlockId: null, blockType: "column_list" },
      { id: "c1", parentBlockId: "cl", blockType: "column" },
      { id: "p1", parentBlockId: "c1", blockType: "paragraph" },
      { id: "c2", parentBlockId: "cl", blockType: "column" },
      { id: "p2", parentBlockId: "c2", blockType: "paragraph" },
    ]);
    expect(roundTripped.find((b) => b.id === "c1")?.content).toEqual({ width: 0.4 });
    expect(roundTripped.find((b) => b.id === "p2")?.plainText).toBe("Dois");
  });
});

describe("wrapCurrentBlockInColumns (EDT-033, caminho sem mouse)", () => {
  it("envolve o bloco do cursor em duas colunas, criando um parágrafo vazio como a segunda", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    expect(wrapCurrentBlockInColumns(editor)).toBe(true);

    const doc = json();
    expect(doc.content).toHaveLength(1);
    const columnListWrapper = doc.content![0];
    expect(contentOf(columnListWrapper).type).toBe("columnList");

    const columns = childrenOf(columnListWrapper);
    expect(columns).toHaveLength(2);
    expect(contentOf(columns[0]).type).toBe("column");
    expect(contentOf(columns[1]).type).toBe("column");

    const leftBlocks = childrenOf(columns[0]);
    expect(leftBlocks).toHaveLength(1);
    expect(contentOf(leftBlocks[0])).toMatchObject({ type: "paragraph", attrs: { id: "a" }, content: [{ text: "Olá" }] });

    const rightBlocks = childrenOf(columns[1]);
    expect(rightBlocks).toHaveLength(1);
    const rightContent = contentOf(rightBlocks[0]);
    expect(rightContent.type).toBe("paragraph");
    expect(rightContent.content).toBeUndefined(); // vazio
    expect(rightContent.attrs?.id).not.toBe("a");
  });

  it("é o comando por trás do atalho Mod-Alt-2 (caminho de teclado)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    // `editor.commands.keyboardShortcut` monta e despacha o `KeyboardEvent`
    // certo para "Mod-Alt-2" já resolvendo Mod->Ctrl/Cmd pela plataforma -
    // mais confiável em teste do que montar o evento à mão (ver
    // `@tiptap/core`'s `normalizeKeyName`/`isMacOS`).
    editor.commands.keyboardShortcut("Mod-Alt-2");

    expect(contentOf(json().content![0]).type).toBe("columnList");
  });

  it("EDT-033/item 4: aceita N colunas - wrapCurrentBlockInColumns(editor, 3) cria três, não duas", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Olá" }] }] },
      ],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    expect(wrapCurrentBlockInColumns(editor, 3)).toBe(true);

    const columnListWrapper = json().content![0];
    expect(contentOf(columnListWrapper).type).toBe("columnList");
    const columns = childrenOf(columnListWrapper);
    expect(columns).toHaveLength(3);
    // A original ("a", com seu texto) é sempre a primeira coluna - conteúdo
    // nunca some ao envolver.
    expect(contentOf(childrenOf(columns[0])[0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Olá" }] });
    // As outras duas nascem parágrafos vazios, com ids novos e distintos.
    const otherIds = [1, 2].map((i) => contentOf(childrenOf(columns[i])[0]).attrs?.id);
    expect(new Set(otherIds).size).toBe(2);
    expect(otherIds).not.toContain("a");
    // Largura dividida em partes iguais entre as três (não 0.5 fixo, que só faz sentido para duas).
    for (const column of columns) {
      expect(contentOf(column).attrs?.width).toBeCloseTo(1 / 3);
    }
  });

  it("recusa columnCount menor que 2 sem tocar a transação", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);

    expect(wrapCurrentBlockInColumns(editor, 1)).toBe(false);
    expect(contentOf(json().content![0]).type).toBe("paragraph"); // doc intacto
  });
});

describe('"Transformar em" > Duas colunas / Três colunas', () => {
  it("os dois itens estão registrados no menu \"/\" e em \"Transformar em\"", () => {
    expect(collectSlashMenuItems().find((i) => i.id === "blocks:columns:three")).toMatchObject({ title: "Três colunas" });
    expect(collectTurnIntoItems().find((i) => i.id === "blocks:turn:columns:two")).toMatchObject({ title: "Duas colunas" });
    expect(collectTurnIntoItems().find((i) => i.id === "blocks:turn:columns:three")).toMatchObject({ title: "Três colunas" });
  });

  it("\"Transformar em\" > \"Duas colunas\" aplicado a um parágrafo com texto - o documento resultante tem columnList e o texto sobrevive", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Conteúdo" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);
    const item = collectTurnIntoItems().find((i) => i.id === "blocks:turn:columns:two");
    if (!item) throw new Error('item "blocks:turn:columns:two" não registrado');

    expect(item.run(editor)).toBe(true);

    const columnListWrapper = json().content![0];
    expect(contentOf(columnListWrapper).type).toBe("columnList");
    const columns = childrenOf(columnListWrapper);
    expect(columns).toHaveLength(2);
    expect(contentOf(childrenOf(columns[0])[0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "Conteúdo" }] });
  });

  it("\"Transformar em\" > \"Três colunas\" aplicado a um parágrafo vazio - o documento resultante tem columnList com três colunas", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);
    const item = collectTurnIntoItems().find((i) => i.id === "blocks:turn:columns:three");
    if (!item) throw new Error('item "blocks:turn:columns:three" não registrado');

    expect(item.run(editor)).toBe(true);

    const columnListWrapper = json().content![0];
    expect(contentOf(columnListWrapper).type).toBe("columnList");
    expect(childrenOf(columnListWrapper)).toHaveLength(3);
  });
});

// Estes casos provam a cirurgia de árvore (`wrapBlocksInColumns` chamada
// diretamente com ids já resolvidos), não o gesto de mouse em si - o gesto
// "arrastar até a faixa de colunas" que EDT-033 descreve (docs/CHECKLIST.md:124)
// é `interaction/drag/drag-extension.ts` chamando esta mesma função a partir
// da zona `{ kind: "columns" }` que `interaction/drag/drop-zone.ts` resolve
// (ver `drop-zone.test.ts` para a decisão geométrica e
// `drag-extension.test.ts` para a ligação com um `drop` real).
describe("wrapBlocksInColumns (EDT-033, cirurgia de árvore)", () => {
  it("junta dois blocos existentes em colunas: alvo à esquerda, o que chega à direita", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "A" }] }] },
        { type: "block", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "B" }] }] },
      ],
    });

    expect(wrapBlocksInColumns(editor, "a", "b")).toBe(true);

    const doc = json();
    expect(doc.content).toHaveLength(1); // "a" e "b" não sobram soltos no topo
    const columns = childrenOf(doc.content![0]);
    expect(columns).toHaveLength(2);
    expect(contentOf(childrenOf(columns[0])[0])).toMatchObject({ attrs: { id: "a" }, content: [{ text: "A" }] });
    expect(contentOf(childrenOf(columns[1])[0])).toMatchObject({ attrs: { id: "b" }, content: [{ text: "B" }] });
  });

  it("preserva os filhos aninhados do bloco arrastado (envolver nunca descarta conteúdo)", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "A" }] }] },
        {
          type: "block",
          content: [
            { type: "toggle", attrs: { id: "b", collapsed: false }, content: [{ type: "text", text: "B" }] },
            { type: "childBlocks", content: [paragraphBlock("b-child", "Filho de B")] },
          ],
        },
      ],
    });

    expect(wrapBlocksInColumns(editor, "a", "b")).toBe(true);

    const rightColumnBlocks = childrenOf(childrenOf(json().content![0])[1]);
    expect(rightColumnBlocks).toHaveLength(1);
    expect(contentOf(rightColumnBlocks[0])).toMatchObject({ type: "toggle", attrs: { id: "b" } });
    expect(childrenOf(rightColumnBlocks[0])).toHaveLength(1);
    expect(contentOf(childrenOf(rightColumnBlocks[0])[0])).toMatchObject({ attrs: { id: "b-child" } });
  });

  it("recusa quando os dois ids são o mesmo bloco, ou quando um deles não existe", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" } }] }],
    });

    expect(wrapBlocksInColumns(editor, "a", "a")).toBe(false);
    expect(wrapBlocksInColumns(editor, "a", "nao-existe")).toBe(false);
    expect(wrapBlocksInColumns(editor, "nao-existe", "a")).toBe(false);
  });

  it("recusa soltar um bloco dentro do próprio filho (ciclo), nos dois sentidos", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            { type: "toggle", attrs: { id: "a", collapsed: false }, content: [{ type: "text", text: "A" }] },
            { type: "childBlocks", content: [paragraphBlock("a-child", "Filho de A")] },
          ],
        },
      ],
    });

    // "a" contém "a-child" - envolver um dentro do outro, em qualquer
    // sentido, corromperia a árvore (o pai desapareceria dentro de si
    // mesmo). `rangesOverlap` recusa os dois sentidos.
    expect(wrapBlocksInColumns(editor, "a", "a-child")).toBe(false);
    expect(wrapBlocksInColumns(editor, "a-child", "a")).toBe(false);

    // Documento intacto - nenhuma das tentativas mexeu na árvore.
    const doc = json();
    expect(contentOf(doc.content![0]).type).toBe("toggle");
    expect(childrenOf(doc.content![0])).toHaveLength(1);
  });
});

describe("resizeColumnBoundary", () => {
  function twoColumnsDoc(leftWidth: number, rightWidth: number): JSONContent {
    return {
      type: "doc",
      content: [
        block("cl", "columnList", {}, [
          block("c1", "column", { width: leftWidth }, [paragraphBlock("p1", "Um")]),
          block("c2", "column", { width: rightWidth }, [paragraphBlock("p2", "Dois")]),
        ]),
      ],
    };
  }

  it("transfere largura da coluna esquerda para a direita (delta positivo) e vice-versa", () => {
    editor = createEditor(twoColumnsDoc(DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH));

    expect(resizeColumnBoundary(editor, "c1", 0.1)).toBe(true);
    let doc = json();
    let columns = childrenOf(doc.content![0]);
    expect(contentOf(columns[0]).attrs?.width).toBeCloseTo(0.6);
    expect(contentOf(columns[1]).attrs?.width).toBeCloseTo(0.4);

    expect(resizeColumnBoundary(editor, "c1", -0.2)).toBe(true);
    doc = json();
    columns = childrenOf(doc.content![0]);
    expect(contentOf(columns[0]).attrs?.width).toBeCloseTo(0.4);
    expect(contentOf(columns[1]).attrs?.width).toBeCloseTo(0.6);
  });

  it("nunca deixa uma coluna encolher abaixo de COLUMN_MIN_WIDTH", () => {
    editor = createEditor(twoColumnsDoc(DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH));

    expect(resizeColumnBoundary(editor, "c1", 10)).toBe(true); // pedido absurdo, deve ser cravado no clamp
    const columns = childrenOf(json().content![0]);
    expect(contentOf(columns[0]).attrs?.width).toBeCloseTo(1 - COLUMN_MIN_WIDTH);
    expect(contentOf(columns[1]).attrs?.width).toBeCloseTo(COLUMN_MIN_WIDTH);
  });

  it("não faz nada quando já está no limite e o pedido empurra na mesma direção", () => {
    editor = createEditor(twoColumnsDoc(1 - COLUMN_MIN_WIDTH, COLUMN_MIN_WIDTH));
    expect(resizeColumnBoundary(editor, "c1", 0.05)).toBe(false);
  });

  it("devolve false para a última coluna (não há vizinha à direita) e para um id inexistente", () => {
    editor = createEditor(twoColumnsDoc(DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH));
    expect(resizeColumnBoundary(editor, "c2", 0.1)).toBe(false);
    expect(resizeColumnBoundary(editor, "nao-existe", 0.1)).toBe(false);
  });
});

describe("EDT-033: alça de redimensionar por teclado (NodeView)", () => {
  it("ArrowRight na alça da coluna esquerda transfere COLUMN_RESIZE_STEP para a direita", async () => {
    editor = createEditor({
      type: "doc",
      content: [
        block("cl", "columnList", {}, [
          block("c1", "column", { width: DEFAULT_COLUMN_WIDTH }, [paragraphBlock("p1", "Um")]),
          block("c2", "column", { width: DEFAULT_COLUMN_WIDTH }, [paragraphBlock("p2", "Dois")]),
        ]),
      ],
    });

    // A visibilidade da alça só é decidida depois de um microtask (ver
    // `column-node-view.ts`) - preciso deixar a fila de microtasks esvaziar
    // antes de procurar o botão visível.
    await Promise.resolve();

    const handles = editor.view.dom.querySelectorAll<HTMLButtonElement>(".ed-column-resize-handle");
    // Duas colunas -> só a esquerda tem vizinha à direita, então só uma alça
    // fica visível (a outra existe no DOM mas com `hidden`).
    const visible = [...handles].filter((el) => !el.hidden);
    expect(visible).toHaveLength(1);

    visible[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));

    const columns = childrenOf(json().content![0]);
    expect(contentOf(columns[0]).attrs?.width).toBeCloseTo(DEFAULT_COLUMN_WIDTH + COLUMN_RESIZE_STEP);
    expect(contentOf(columns[1]).attrs?.width).toBeCloseTo(DEFAULT_COLUMN_WIDTH - COLUMN_RESIZE_STEP);
  });
});
