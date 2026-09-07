/**
 * A view Tabela (DBS-030+): linha = registro, coluna = propriedade. Monta a
 * grade e DELEGA cada célula ao `PropertySpec` do tipo (`ValueCell`); o
 * título é coluna própria (`TitleCell`), porque é `pages.title`.
 *
 * Teclado (padrão ARIA grid, foco rotativo): setas movem entre células,
 * Enter/F2 abre a edição, Escape fecha, Espaço alterna um checkbox. Só a
 * célula ativa está na ordem de Tab — uma tabela de 200 linhas não pode
 * custar 2.000 Tabs para atravessar.
 *
 * Fora desta rodada, e por isso AUSENTE da tela (controle que não faz nada
 * é defeito): redimensionar/reordenar/congelar coluna, arrastar linha,
 * seleção múltipla, agrupamento, filtro e ordenação (as duas últimas
 * dependem do pipeline de consulta em Rust, arquitetura §8, que não existe).
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { RecordId } from "../../contract";
import { specForPropertyType, type PropertyDescriptor } from "../../core/property-spec";
import type { ViewRenderContext } from "../../core/view-spec";
import { parseViewConfig } from "../../view-config";
import { columnWidth, DEFAULT_TITLE_WIDTH, orderVisibleColumns } from "./columns";
import { TitleCell } from "./TitleCell";
import { ValueCell } from "./ValueCell";
import "./table.css";

/** `"title"` é a coluna de título; qualquer outra string é um `PropertyId`. */
type ColumnKey = "title" | string;

interface CellAddress {
  recordId: RecordId;
  column: ColumnKey;
}

export interface TableViewProps {
  ctx: ViewRenderContext<unknown>;
}

export function TableView({ ctx }: TableViewProps) {
  const { view, properties, records, mutations } = ctx;
  const config = useMemo(() => parseViewConfig(view.config), [view]);
  const columns = useMemo(() => orderVisibleColumns(config, properties), [config, properties]);

  const [editing, setEditing] = useState<CellAddress | null>(null);
  const [active, setActive] = useState<CellAddress | null>(null);
  const [creating, setCreating] = useState(false);
  // Sobe a cada pedido de "leve o foco para a célula ativa" (setas, fechar
  // editor, nova linha). Zero na montagem: uma database no meio de uma nota
  // NÃO pode roubar o foco do editor de blocos só por ter carregado.
  const [focusTick, setFocusTick] = useState(0);
  const requestFocus = () => setFocusTick((tick) => tick + 1);

  // A célula ativa pode ter sumido (registro apagado, coluna oculta): volta
  // ao canto superior esquerdo em vez de deixar a grade sem nenhuma célula
  // alcançável por Tab.
  useEffect(() => {
    if (records.length === 0) {
      if (active !== null) setActive(null);
      return;
    }
    const stillThere = active && records.some((record) => record.id === active.recordId) && (active.column === "title" || columns.some((column) => column.id === active.column));
    if (!stillThere) setActive({ recordId: records[0].id, column: "title" });
  }, [records, columns, active]);

  const columnKeys: ColumnKey[] = useMemo(() => ["title", ...columns.map((column) => column.id)], [columns]);

  function navigate(from: CellAddress, event: KeyboardEvent<HTMLTableCellElement>) {
    const rowIndex = records.findIndex((record) => record.id === from.recordId);
    const colIndex = columnKeys.indexOf(from.column);
    if (rowIndex < 0 || colIndex < 0) return;
    let nextRow = rowIndex;
    let nextCol = colIndex;
    switch (event.key) {
      case "ArrowUp":
        nextRow = Math.max(0, rowIndex - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(records.length - 1, rowIndex + 1);
        break;
      case "ArrowLeft":
        nextCol = Math.max(0, colIndex - 1);
        break;
      case "ArrowRight":
        nextCol = Math.min(columnKeys.length - 1, colIndex + 1);
        break;
      case "Home":
        nextCol = 0;
        break;
      case "End":
        nextCol = columnKeys.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActive({ recordId: records[nextRow].id, column: columnKeys[nextCol] });
    requestFocus();
  }

  function stopEditing() {
    setEditing(null);
    requestFocus();
  }

  async function addRow() {
    if (!mutations || creating) return;
    setCreating(true);
    try {
      const id = await mutations.createRecord();
      // O registro nasce sem título: abre direto na célula de título, como
      // o Notion — a primeira coisa que o usuário quer é nomear a linha.
      setActive({ recordId: id, column: "title" });
      setEditing({ recordId: id, column: "title" });
      requestFocus();
    } catch {
      // O carregador já guardou a mensagem e recarregou; nada a repetir aqui.
    } finally {
      setCreating(false);
    }
  }

  const isEditing = (address: CellAddress) => editing?.recordId === address.recordId && editing.column === address.column;
  const isActive = (address: CellAddress) => active?.recordId === address.recordId && active.column === address.column;

  return (
    <div className="db-table">
      <div className="db-table__scroll">
        <table className="db-table__grid" role="grid" aria-label={view.name} aria-rowcount={records.length + 1} aria-colcount={columnKeys.length}>
          <colgroup>
            <col style={{ width: DEFAULT_TITLE_WIDTH }} />
            {columns.map((column) => (
              <col key={column.id} style={{ width: columnWidth(config, column.id) }} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className="db-table__th">
                <span className="db-table__th-icon" aria-hidden="true">
                  Aa
                </span>
                Nome
              </th>
              {columns.map((column) => (
                <ColumnHeader key={column.id} property={column} />
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={record.id} className="db-table__row" aria-rowindex={index + 2}>
                <TitleCell
                  record={record}
                  mutations={mutations}
                  editing={isEditing({ recordId: record.id, column: "title" })}
                  focused={isActive({ recordId: record.id, column: "title" })}
                  focusTick={focusTick}
                  onStartEdit={() => setEditing({ recordId: record.id, column: "title" })}
                  onStopEdit={stopEditing}
                  onFocusCell={() => setActive({ recordId: record.id, column: "title" })}
                  onNavigate={(event) => navigate({ recordId: record.id, column: "title" }, event)}
                />
                {columns.map((column) => (
                  <ValueCell
                    key={column.id}
                    record={record}
                    property={column}
                    spec={specForPropertyType(column.type)}
                    mutations={mutations}
                    editing={isEditing({ recordId: record.id, column: column.id })}
                    focused={isActive({ recordId: record.id, column: column.id })}
                    focusTick={focusTick}
                    onStartEdit={() => setEditing({ recordId: record.id, column: column.id })}
                    onStopEdit={stopEditing}
                    onFocusCell={() => setActive({ recordId: record.id, column: column.id })}
                    onNavigate={(event) => navigate({ recordId: record.id, column: column.id }, event)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 ? (
          <p className="db-table__empty">
            {mutations ? "Nenhum registro ainda. Clique em “Nova linha” para começar." : "Nenhum registro."}
          </p>
        ) : null}
        {mutations ? (
          <button type="button" className="db-table__add-row" onClick={() => void addRow()} disabled={creating}>
            <span aria-hidden="true">+</span>
            Nova linha
          </button>
        ) : null}
      </div>
      <p className="db-table__status" role="status">
        {records.length === 1 ? "1 registro" : `${records.length} registros`}
      </p>
    </div>
  );
}

function ColumnHeader({ property }: { property: PropertyDescriptor }) {
  const spec = specForPropertyType(property.type);
  const readOnly = !spec?.renderEditor;
  return (
    <th scope="col" className="db-table__th" title={readOnly ? `${property.name} — calculado automaticamente` : property.name}>
      <span className="db-table__th-icon" aria-hidden="true">
        {spec?.icon ?? "?"}
      </span>
      {property.name}
    </th>
  );
}

/** Exposto para o teste montar a tabela com um contexto explícito, sem passar pelo registro. */
export function renderTableView(ctx: ViewRenderContext<unknown>) {
  return <TableView ctx={ctx} />;
}
