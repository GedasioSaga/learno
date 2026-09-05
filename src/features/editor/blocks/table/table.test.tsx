/**
 * Drives the real Table extension through a headless `Editor` - same spirit
 * as `core/commands.test.ts`: real `KeyboardEvent`s and real commands, not
 * the helper functions called directly - plus `TableControls` (EDT-080)
 * clicked for real via `@testing-library/react`.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { insertBlockHere } from "../../core/commands";
import { buildEditorExtensions } from "../../core/extensions";
import "./register";
import { TABLE_NODE_NAME } from "./constants";
import { buildEmptyTableRows } from "./table-content";
import { TableControls } from "./TableControls";

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

/** O nó "table" real, dentro do wrapper `Block` (ver `core/schema.ts`). */
function tableNodeOf(doc: JSONContent): JSONContent {
  const node = doc.content?.[0]?.content?.[0];
  if (!node || node.type !== TABLE_NODE_NAME) throw new Error("nenhuma tabela no topo do documento");
  return node;
}

/** Posição logo dentro de cada célula, na ordem do documento - recalculada a cada chamada porque digitar desloca tudo depois do ponto de inserção. */
function cellStartPositions(): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") positions.push(pos + 1);
    return true;
  });
  return positions;
}

function tableDoc(rows: number, cols: number): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "block",
        content: [
          {
            type: TABLE_NODE_NAME,
            attrs: { id: "t" },
            content: Array.from({ length: rows }, () => ({
              type: "tableRow",
              content: Array.from({ length: cols }, () => ({
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
              })),
            })),
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("EDT-079: tabela simples via menu /", () => {
  it("insere uma grade 2x2 como um Block com id (senão docToFlatBlocks descartaria o bloco em silêncio)", () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p" } }] }] });
    editor.commands.setTextSelection(1);

    const rows = buildEmptyTableRows(editor.state.schema, 2, 2);
    const inserted = insertBlockHere(editor, TABLE_NODE_NAME, {}, rows);
    expect(inserted).toBe(true);

    // `insertBlockHere` nunca converte um bloco vazio quando `content` é
    // passado (só quando o novo tipo não precisa de conteúdo semeado) - uma
    // tabela sempre entra como irmã abaixo do parágrafo original, que
    // continua ali (ver `core/commands.ts`, doc de `insertBlockHere`).
    const doc = json();
    expect(doc.content).toHaveLength(2);
    const table = tableNodeOf({ content: [doc.content![1]] });
    expect(typeof table.attrs?.id).toBe("string");
    expect((table.attrs?.id as string).length).toBeGreaterThan(0);
    expect(table.content).toHaveLength(2);
    table.content?.forEach((row) => expect(row.content).toHaveLength(2));
  });

  it("cada célula guarda seu texto de forma independente", () => {
    editor = createEditor(tableDoc(2, 2));

    editor.commands.setTextSelection(cellStartPositions()[0]);
    editor.commands.insertContent("Um");

    editor.commands.setTextSelection(cellStartPositions()[1]);
    editor.commands.insertContent("Dois");

    const [firstRow, secondRow] = tableNodeOf(json()).content ?? [];
    expect(firstRow?.content?.[0]?.content?.[0]?.text).toBe("Um");
    expect(firstRow?.content?.[1]?.content?.[0]?.text).toBe("Dois");
    // O texto não vazou para as células que ninguém tocou.
    expect(secondRow?.content?.[0]?.content).toBeUndefined();
    expect(secondRow?.content?.[1]?.content).toBeUndefined();
  });
});

describe("Tab dentro da tabela move para a próxima célula, não indenta o bloco (README: forma de conteúdo diferente exige atalho próprio)", () => {
  it("EDT-079/080: Tab avança para a célula seguinte", () => {
    editor = createEditor(tableDoc(2, 2));
    const [firstCell, secondCell] = cellStartPositions();
    editor.commands.setTextSelection(firstCell);

    press("Tab");

    expect(editor.state.selection.from).toBe(secondCell);
    // Nada foi indentado pelo BlockKeymap genérico: continua um único Block (a tabela), sem childBlocks.
    expect(json().content).toHaveLength(1);
  });

  it("Shift-Tab volta para a célula anterior", () => {
    editor = createEditor(tableDoc(2, 2));
    const [firstCell, secondCell] = cellStartPositions();
    editor.commands.setTextSelection(secondCell);

    press("Tab", { shiftKey: true });

    expect(editor.state.selection.from).toBe(firstCell);
  });
});

describe("EDT-080: os controles da tabela, clicados de verdade", () => {
  it("os '+' ficam ancorados à borda da tabela (top/left calculados a partir do rect), não numa barra fixa abaixo do bloco", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    // jsdom não faz layout: getBoundingClientRect devolve um rect zerado, mas
    // isso já basta para provar que a posição vem de EDGE_GAP_PX somado ao
    // rect (8px de afastamento da borda) - uma barra fixa por margin não
    // teria essa aritmética por instância.
    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    expect(getByLabelText("Adicionar coluna").style.left).toBe("8px");
    expect(getByLabelText("Adicionar linha").style.top).toBe("8px");
    unmount();
  });

  it("+ adiciona uma coluna vazia no fim, ajustando a grade", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Adicionar coluna"));
    fireEvent.click(getByLabelText("Adicionar coluna"));
    unmount();

    const table = tableNodeOf(json());
    table.content?.forEach((row) => expect(row.content).toHaveLength(3));
  });

  it("+ adiciona uma linha vazia no fim", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Adicionar linha"));
    fireEvent.click(getByLabelText("Adicionar linha"));
    unmount();

    expect(tableNodeOf(json()).content).toHaveLength(3);
  });

  it("EDT-080: remover é um menu (role=menu/menuitem) atrás do gatilho '⋮', não um botão sempre visível", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    const { queryByRole, getByLabelText, unmount } = render(<TableControls editor={editor} />);
    // Fechado por padrão - a lista de remoção não deveria estar no DOM antes do clique.
    expect(queryByRole("menu")).toBeNull();

    fireEvent.mouseDown(getByLabelText("Mais opções da tabela"));
    fireEvent.click(getByLabelText("Mais opções da tabela"));

    expect(queryByRole("menu", { name: "Remover da tabela" })).not.toBeNull();
    unmount();
  });

  it("Remover coluna atual (no menu) some com a coluna que contém o cursor", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]); // cursor na primeira coluna

    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Mais opções da tabela"));
    fireEvent.click(getByLabelText("Mais opções da tabela"));
    fireEvent.mouseDown(getByLabelText("Remover coluna atual"));
    fireEvent.click(getByLabelText("Remover coluna atual"));
    unmount();

    const table = tableNodeOf(json());
    table.content?.forEach((row) => expect(row.content).toHaveLength(1));
  });

  it("Remover linha atual (no menu) some com a linha que contém o cursor", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]); // cursor na primeira linha

    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Mais opções da tabela"));
    fireEvent.click(getByLabelText("Mais opções da tabela"));
    fireEvent.mouseDown(getByLabelText("Remover linha atual"));
    fireEvent.click(getByLabelText("Remover linha atual"));
    unmount();

    expect(tableNodeOf(json()).content).toHaveLength(1);
  });

  it("Escape fecha o menu sem remover nada", () => {
    editor = createEditor(tableDoc(2, 2));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    const { getByLabelText, queryByRole, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Mais opções da tabela"));
    fireEvent.click(getByLabelText("Mais opções da tabela"));
    expect(queryByRole("menu")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(queryByRole("menu")).toBeNull();
    expect(tableNodeOf(json()).content).toHaveLength(2);
    unmount();
  });

  it("os itens de remover ficam desabilitados quando só resta uma linha/coluna - nada depende só de cor", () => {
    editor = createEditor(tableDoc(1, 1));
    editor.commands.setTextSelection(cellStartPositions()[0]);

    const { getByLabelText, unmount } = render(<TableControls editor={editor} />);
    fireEvent.mouseDown(getByLabelText("Mais opções da tabela"));
    fireEvent.click(getByLabelText("Mais opções da tabela"));

    expect(getByLabelText("Remover linha atual")).toBeDisabled();
    expect(getByLabelText("Remover coluna atual")).toBeDisabled();
    unmount();
  });

  it("não renderiza nada quando o cursor está fora de qualquer tabela", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p" } }] }],
    });
    editor.commands.setTextSelection(1);

    const { container, unmount } = render(<TableControls editor={editor} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
  });
});
