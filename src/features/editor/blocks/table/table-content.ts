/**
 * Tradução entre o nó "table" real (linhas/células do ProseMirror) e o
 * `content` estruturado que `Block.content` persiste - o caso que o
 * README chama de "bloco estruturado" e `core/block-spec.test.ts`
 * exemplifica: uma tabela não cabe em `content.inline`, então guarda sua
 * própria matriz em `content.rows` e expõe as três funções que
 * `BlockSpec.serialization` pede (`content`, `nodeContent`, `plainText`)
 * para fechar o ciclo salvar/abrir. Sem tocar em ProseMirror `Editor`/
 * `view` - mesmo espírito de `core/serialize.ts`, testável sem editor.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type { BlockContent } from "../../contract";
import { TABLE_CELL_NODE_NAME, TABLE_HEADER_NODE_NAME, TABLE_ROW_NODE_NAME } from "./constants";

const CELL_ALIGNMENTS = ["left", "right", "center"] as const;
type CellAlign = (typeof CELL_ALIGNMENTS)[number];

export interface StoredTableCell {
  header: boolean;
  colspan: number;
  rowspan: number;
  /** Largura da coluna em pixels (EDT-080) - o mesmo attr que a extensão oficial já usa para redimensionamento, só persistido aqui. */
  colwidth: number[] | null;
  align: CellAlign | null;
  inline: JSONContent[];
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readColwidth(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  // `Array.isArray` só estreita para `any[]` no lib.d.ts do TS - sem este
  // `every` checando cada elemento antes do cast, um `colwidth` corrompido
  // (string, objeto) passaria como `number[]` sem erro de tipo nenhum.
  return value.every((width) => typeof width === "number") ? (value as number[]) : null;
}

function readAlign(value: unknown): CellAlign | null {
  return typeof value === "string" && (CELL_ALIGNMENTS as readonly string[]).includes(value)
    ? (value as CellAlign)
    : null;
}

function readInline(value: unknown): JSONContent[] {
  // Mesma confiança que `core/serialize.ts` deposita em `content.inline`
  // vindo do JSONB (ver `nodeContentFor` lá): quem escreveu foi este mesmo
  // editor, então um array é tratado como `JSONContent[]` sem validar cada
  // nó por dentro - não é uma fronteira de entrada hostil (usuário externo
  // não escreve nesta coluna), é o próprio editor relendo o que salvou.
  return Array.isArray(value) ? (value as JSONContent[]) : [];
}

function normalizeCell(raw: unknown): StoredTableCell {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    header: obj.header === true,
    colspan: readPositiveInt(obj.colspan, 1),
    rowspan: readPositiveInt(obj.rowspan, 1),
    colwidth: readColwidth(obj.colwidth),
    align: readAlign(obj.align),
    inline: readInline(obj.inline),
  };
}

/** `Block.content.rows`, validado e com defaults - nunca confia cegamente no JSONB (um documento de uma build futura pode ter um formato diferente). */
export function readStoredRows(content: BlockContent): StoredTableCell[][] {
  const raw = content.rows;
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => (Array.isArray(row) ? row.map(normalizeCell) : []));
}

/** `BlockSpecSerialization.content`: linhas/células reais do doc -> `content.rows`. */
export function tableContentFromNodeContent(nodeContent: JSONContent[]): BlockContent {
  const rows: StoredTableCell[][] = nodeContent.map((rowNode) => {
    const cells = rowNode.content ?? [];
    return cells.map((cellNode) => ({
      header: cellNode.type === TABLE_HEADER_NODE_NAME,
      colspan: readPositiveInt(cellNode.attrs?.colspan, 1),
      rowspan: readPositiveInt(cellNode.attrs?.rowspan, 1),
      colwidth: readColwidth(cellNode.attrs?.colwidth),
      align: readAlign(cellNode.attrs?.align),
      inline: cellNode.content ?? [],
    }));
  });
  return { rows };
}

/** `BlockSpecSerialization.nodeContent`: `content.rows` -> linhas/células reais para reconstruir o nó ao abrir a página. */
export function nodeContentFromTableContent(content: BlockContent): JSONContent[] {
  return readStoredRows(content).map((row) => ({
    type: TABLE_ROW_NODE_NAME,
    content: row.map((cell) => ({
      type: cell.header ? TABLE_HEADER_NODE_NAME : TABLE_CELL_NODE_NAME,
      attrs: { colspan: cell.colspan, rowspan: cell.rowspan, colwidth: cell.colwidth, align: cell.align },
      ...(cell.inline.length > 0 ? { content: cell.inline } : {}),
    })),
  }));
}

function flattenInlineText(inline: JSONContent[]): string {
  let text = "";
  for (const node of inline) {
    if (typeof node.text === "string") text += node.text;
    else if (node.type === "hardBreak") text += "\n";
  }
  return text;
}

/** `BlockSpecSerialization.plainText`: todo texto de toda célula, achatado e separado por espaço - senão a busca global não acha texto que está dentro de uma tabela (README). */
export function tableContentToPlainText(content: BlockContent): string {
  return readStoredRows(content)
    .flatMap((row) => row.map((cell) => flattenInlineText(cell.inline)))
    .filter((text) => text.length > 0)
    .join(" ");
}

/** Grade vazia (EDT-079) para semear a inserção pelo menu `/` via `insertBlockHere(editor, "table", {}, content)` - só células comuns, sem cabeçalho, texto puro. */
export function buildEmptyTableRows(schema: Schema, rowCount: number, colCount: number): PMNode[] {
  const rowType = schema.nodes[TABLE_ROW_NODE_NAME];
  const cellType = schema.nodes[TABLE_CELL_NODE_NAME];
  const rows: PMNode[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cells: PMNode[] = [];
    for (let col = 0; col < colCount; col += 1) cells.push(cellType.create(null));
    rows.push(rowType.create(null, cells));
  }
  return rows;
}
