/**
 * `table-content.ts` é o "bloco estruturado" que o README aponta
 * (EDT-079/080): sem ele, `table` seria salvo como parágrafo vazio e o
 * texto de cada célula desapareceria na primeira gravação. Estes testes
 * provam o ciclo salvar/abrir e a busca (plainText) sem precisar de editor
 * nem de DOM - mesmo formato de `core/serialize.test.ts` e
 * `core/block-spec.test.ts`.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import "./register"; // efeito colateral: registra o BlockSpec de "table"
import {
  nodeContentFromTableContent,
  readStoredRows,
  tableContentFromNodeContent,
  tableContentToPlainText,
} from "./table-content";

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

function cellJson(type: "tableCell" | "tableHeader", inline: JSONContent[] = []): JSONContent {
  return {
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
    ...(inline.length > 0 ? { content: inline } : {}),
  };
}

function rowJson(cells: JSONContent[]): JSONContent {
  return { type: "tableRow", content: cells };
}

function storedBlock(overrides: Partial<Block>): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    parentBlockId: null,
    blockType: "table",
    content: { rows: [] },
    plainText: "",
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

describe("table-content: linhas/células reais <-> content.rows", () => {
  it("EDT-079: duas células mantêm seu texto de forma independente na ida (nó -> content.rows)", () => {
    const nodeContent = [rowJson([cellJson("tableCell", [text("Um")]), cellJson("tableCell", [text("Dois")])])];
    const rows = readStoredRows(tableContentFromNodeContent(nodeContent));
    expect(rows).toHaveLength(1);
    expect(rows[0].map((cell) => cell.inline)).toEqual([[text("Um")], [text("Dois")]]);
  });

  it("EDT-079: e na volta (content.rows -> linhas/células reais), sem misturar o texto de uma célula na outra", () => {
    const content = {
      rows: [
        [
          { header: false, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [text("A")] },
          { header: false, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [text("B")] },
        ],
      ],
    };
    expect(nodeContentFromTableContent(content)).toEqual([
      rowJson([cellJson("tableCell", [text("A")]), cellJson("tableCell", [text("B")])]),
    ]);
  });

  it("uma célula de cabeçalho vira tableHeader na volta, não tableCell", () => {
    const content = {
      rows: [[{ header: true, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [text("Título")] }]],
    };
    const [row] = nodeContentFromTableContent(content);
    expect(row.content?.[0]?.type).toBe("tableHeader");
  });

  it("achata todas as células em plainText separadas por espaço, para a busca global (README)", () => {
    const content = tableContentFromNodeContent([
      rowJson([cellJson("tableCell", [text("Primeira")]), cellJson("tableCell", [text("Segunda")])]),
      rowJson([cellJson("tableCell", [text("Terceira")]), cellJson("tableCell")]), // célula vazia não deixa espaço sobrando
    ]);
    expect(tableContentToPlainText(content)).toBe("Primeira Segunda Terceira");
  });

  it("larguras de coluna (colwidth) sobrevivem ao round trip (EDT-080)", () => {
    const content = tableContentFromNodeContent([
      rowJson([{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [180], align: null } }]),
    ]);
    expect(readStoredRows(content)[0][0].colwidth).toEqual([180]);
    expect(nodeContentFromTableContent(content)[0].content?.[0]?.attrs?.colwidth).toEqual([180]);
  });

  it("um content.rows com campos faltando (versão futura) ainda abre com defaults seguros", () => {
    expect(readStoredRows({ rows: [[{}]] })).toEqual([
      [{ header: false, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [] }],
    ]);
    expect(readStoredRows({})).toEqual([]);
  });
});

describe("table round trip via serialize.ts (registro externo, não lista interna do core)", () => {
  it("EDT-079: sobrevive a blocksToDoc -> docToFlatBlocks com cada célula independente", () => {
    const stored = storedBlock({
      content: {
        rows: [
          [
            { header: false, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [text("Nome")] },
            { header: false, colspan: 1, rowspan: 1, colwidth: null, align: null, inline: [text("Idade")] },
          ],
        ],
      },
      plainText: "Nome Idade",
    });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("table");
    expect(contentNode?.attrs?.id).toBe(stored.id); // sem isto o bloco vira "paragraph" em silêncio (README)

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("table");
    const rows = readStoredRows(flat.content);
    expect(rows[0].map((cell) => cell.inline[0]?.text)).toEqual(["Nome", "Idade"]);
    expect(flat.plainText).toBe("Nome Idade");
  });

  it("um blockType 'table' sem BlockSpec (build antiga) degradaria para parágrafo - aqui não degrada, prova que o registro externo funcionou", () => {
    const doc = blocksToDoc([storedBlock({})]);
    expect(doc.content?.[0]?.content?.[0]?.type).toBe("table");
  });
});
