/**
 * A `Table` oficial (@tiptap/extension-table 3.31) nasce `group: "block"` e
 * sem `id` - inadequada para viver dentro do wrapper `Block` deste projeto
 * (ver README, seção "Blocos ricos"): um nó no grupo "block" apareceria
 * solto sob `doc`/`childBlocks` e `docToFlatBlocks` o ignoraria em
 * silêncio por não achar `attrs.id` no lugar esperado. Aqui ela troca para
 * `group: "blockContent"` e ganha o mesmo padrão de `id` refletido em
 * `data-block-id` que todo nó de `core/schema.ts` usa - nada além disso é
 * tocado: conteúdo (`"tableRow+"`), comandos (`insertTable`,
 * `addColumnAfter`, `deleteRow`, ...), atalhos de teclado (Tab/Shift-Tab
 * andam entre células, não indentam - ver `table-column-row.test.ts`) e o
 * plugin de redimensionar coluna continuam exatamente os da biblioteca,
 * testados por ela, não por nós.
 *
 * `tableCell`/`tableHeader` nascem com `content: "block+"` - nesse "block"
 * resolveria para o grupo já ocupado pelo wrapper `Block` deste schema
 * (`core/schema.ts`), não para um parágrafo solto como na maioria dos
 * schemas TipTap. Como o pedido é tabela de texto plano (EDT-079, sem
 * recursos de database), a célula troca para `content: "inline*"` - o
 * mesmo modelo dos nove tipos estruturais do core, só que dentro de uma
 * célula em vez de um `Block` inteiro. `parseHTML` também é substituído
 * porque o original usa `fillEmptyCellContent`, que preenche uma célula
 * vazia colada com um parágrafo - o preenchimento certo para `"block+"`,
 * errado para `"inline*"`.
 */
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";

const idAttribute = {
  id: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const BlockTable = Table.extend({
  group: "blockContent",
  addAttributes() {
    // `Table` não declara `addAttributes` própria - `this.parent?.()` sempre
    // resolve a `undefined` aqui, e `{ ...undefined }` não acrescenta nada.
    // Mantido mesmo assim: é o padrão seguro de `.extend()` caso uma versão
    // futura da lib passe a declarar um attr próprio (`style`, por exemplo).
    return { ...this.parent?.(), ...idAttribute };
  },
});

export const BlockTableCell = TableCell.extend({
  content: "inline*",
  parseHTML() {
    return [{ tag: "td" }];
  },
});

export const BlockTableHeader = TableHeader.extend({
  content: "inline*",
  parseHTML() {
    return [{ tag: "th" }];
  },
});

export const BlockTableRow = TableRow;
