/**
 * EDT-080: "Controles + nas bordas inserem linha/coluna; menu remove"
 * (docs/CHECKLIST.md) - os dois "+" ficam ancorados de verdade à borda
 * direita/inferior da `<table>` real via `getBoundingClientRect`, não numa
 * barra fixa abaixo do bloco, e remover vira um item de um menu (`role`
 * "menu"/"menuitem") atrás de um gatilho "⋮", não um botão sempre visível.
 *
 * A extensão `Table` oficial (`table-schema.ts`, `resizable: true`) sempre
 * embrulha a `<table>` real num `div.tableWrapper` quando é a `NodeView`
 * quem desenha (`node_modules/@tiptap/extension-table/dist/table/index.js`,
 * `TableView` - `this.dom` é o wrapper, `this.dom.querySelector("table")` é
 * a borda de verdade) - por isso `findTableElement` desce mais um nível em
 * vez de medir o wrapper, que tem `overflow-x: auto` e pode não coincidir
 * com a borda visível quando a tabela é mais larga que a coluna do editor.
 *
 * Este overlay é renderizado por `Editor.tsx` como irmão de `EditorContent`
 * (README, ponto de extensão 5), fora de qualquer ancestral posicionado que
 * esta pasta controle - por isso os controles usam `position: fixed` e
 * recalculam sua própria posição a cada transação/scroll/resize em vez de
 * depender de um container relativo que não existe aqui.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { findParentNodeClosestToPos } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { isInTable, TableMap } from "@tiptap/pm/tables";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { TABLE_NODE_NAME } from "./constants";

interface TableControlsProps {
  editor: TiptapEditor;
}

interface TableRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Afasta o "+" da borda da tabela para não sobrepor a linha de grade (px). */
const EDGE_GAP_PX = 8;
/** Metade do tamanho real do botão "+"/gatilho (1.375rem = 22px, ver table.css) - centraliza o botão sobre o meio da borda, não sobre o canto. */
const CONTROL_HALF_PX = 11;
/** Espaço entre o gatilho "⋮" e o menu que abre logo abaixo dele. */
const MENU_GAP_PX = 4;

function readRect(el: HTMLElement): TableRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function findTableElement(editor: TiptapEditor, tablePos: number): HTMLTableElement | null {
  const dom = editor.view.nodeDOM(tablePos);
  if (dom instanceof HTMLTableElement) return dom;
  if (dom instanceof HTMLElement) return dom.querySelector("table");
  return null;
}

/** Move a seleção para a célula em `(row, col)` desta tabela - `add*After` insere relativo à célula selecionada, então "no fim" primeiro exige selecionar a última. */
function selectCell(editor: TiptapEditor, tablePos: number, tableNode: PMNode, row: number, col: number): void {
  const map = TableMap.get(tableNode);
  const relativePos = map.positionAt(row, col, tableNode);
  const $cell = editor.state.doc.resolve(tablePos + 1 + relativePos + 1);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($cell)));
}

/** `mousedown` chega antes de `click`; sem isto o clique tira o foco (e a seleção de célula) do editor antes do `click` conseguir agir sobre ela. */
function keepEditorFocused(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

export function TableControls({ editor }: TableControlsProps) {
  const inTable = isInTable(editor.state);
  const found = inTable
    ? findParentNodeClosestToPos(editor.state.selection.$from, (node) => node.type.name === TABLE_NODE_NAME)
    : undefined;
  const tablePos = found?.pos;

  const [rect, setRect] = useState<TableRect | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Recalcula a borda real da tabela sempre que ela pode ter mudado de
  // tamanho/posição: digitar move o texto (transaction), redimensionar
  // coluna muda a largura sem necessariamente disparar "transaction" de
  // conteúdo (ResizeObserver cobre isso) e rolar/redimensionar a janela
  // move a tabela sem tocar no editor.
  useEffect(() => {
    if (tablePos === undefined) {
      setRect(null);
      return;
    }
    const tableEl = findTableElement(editor, tablePos);
    if (!tableEl) {
      setRect(null);
      return;
    }
    const updateRect = () => setRect(readRect(tableEl));
    updateRect();

    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    editor.on("transaction", updateRect);

    // jsdom (ambiente de teste, ver vite.config.ts) não implementa
    // ResizeObserver - sem esta checagem toda montagem em teste lançaria
    // ReferenceError em vez de simplesmente perder esse gatilho de recálculo.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateRect);
      observer.observe(tableEl);
    }

    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
      editor.off("transaction", updateRect);
      observer?.disconnect();
    };
  }, [editor, tablePos]);

  // Trocar de tabela (ou sair de toda tabela) com o menu aberto deixaria um
  // menu de remover flutuando sem a tabela que ele deveria afetar.
  useEffect(() => {
    setMenuOpen(false);
  }, [tablePos]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeIfOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  if (!found || !rect) return null;

  const { node: tableNode, pos: resolvedTablePos } = found;
  const map = TableMap.get(tableNode);

  const addColumn = () => {
    selectCell(editor, resolvedTablePos, tableNode, 0, map.width - 1);
    editor.chain().focus().addColumnAfter().run();
  };
  const addRow = () => {
    selectCell(editor, resolvedTablePos, tableNode, map.height - 1, 0);
    editor.chain().focus().addRowAfter().run();
  };
  const removeRow = () => {
    setMenuOpen(false);
    editor.chain().focus().deleteRow().run();
  };
  const removeColumn = () => {
    setMenuOpen(false);
    editor.chain().focus().deleteColumn().run();
  };

  const menuTriggerTop = rect.top - CONTROL_HALF_PX * 2 - EDGE_GAP_PX;
  const menuTriggerLeft = rect.right - CONTROL_HALF_PX * 2;

  return (
    <>
      <button
        type="button"
        className="ed-table-controls__add"
        aria-label="Adicionar coluna"
        style={{ top: rect.top + rect.height / 2 - CONTROL_HALF_PX, left: rect.right + EDGE_GAP_PX }}
        onMouseDown={keepEditorFocused}
        onClick={addColumn}
      >
        +
      </button>
      <button
        type="button"
        className="ed-table-controls__add"
        aria-label="Adicionar linha"
        style={{ top: rect.bottom + EDGE_GAP_PX, left: rect.left + rect.width / 2 - CONTROL_HALF_PX }}
        onMouseDown={keepEditorFocused}
        onClick={addRow}
      >
        +
      </button>
      <div ref={menuRef}>
        <button
          type="button"
          className="ed-table-controls__menu-trigger"
          aria-label="Mais opções da tabela"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{ top: menuTriggerTop, left: menuTriggerLeft }}
          onMouseDown={keepEditorFocused}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋮
        </button>
        {menuOpen && (
          <div
            role="menu"
            aria-label="Remover da tabela"
            className="ed-table-controls__menu-list"
            style={{ top: menuTriggerTop + CONTROL_HALF_PX * 2 + MENU_GAP_PX, left: menuTriggerLeft }}
          >
            <button
              type="button"
              role="menuitem"
              aria-label="Remover linha atual"
              disabled={map.height <= 1}
              onMouseDown={keepEditorFocused}
              onClick={removeRow}
            >
              Remover linha
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Remover coluna atual"
              disabled={map.width <= 1}
              onMouseDown={keepEditorFocused}
              onClick={removeColumn}
            >
              Remover coluna
            </button>
          </div>
        )}
      </div>
    </>
  );
}
