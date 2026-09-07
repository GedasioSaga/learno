/**
 * A primeira coluna: o TÍTULO do registro, que é `pages.title` (um registro
 * é uma página, 0007) — não uma propriedade, então não passa pelo registro
 * de tipos nem por `database_record_values`. Editar aqui é `rename_page`.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RecordRow } from "../../contract";
import type { ViewMutations } from "../../core/view-spec";
import { EditorFlyout } from "./EditorFlyout";

export const UNTITLED_RECORD = "Sem título";

interface TitleCellProps {
  record: RecordRow;
  mutations: ViewMutations | null;
  editing: boolean;
  focused: boolean;
  /** Muda quando a grade pede que a célula ativa receba o foco de verdade; `0` na montagem = nunca roubar o foco. */
  focusTick: number;
  onStartEdit(): void;
  onStopEdit(): void;
  onFocusCell(): void;
  onNavigate(event: KeyboardEvent<HTMLTableCellElement>): void;
}

export function TitleCell({ record, mutations, editing, focused, focusTick, onStartEdit, onStopEdit, onFocusCell, onNavigate }: TitleCellProps) {
  const cellRef = useRef<HTMLTableCellElement>(null);
  const readOnly = mutations === null;

  useEffect(() => {
    if (focused && !editing && focusTick > 0) cellRef.current?.focus();
  }, [focused, editing, focusTick]);

  function handleKeyDown(event: KeyboardEvent<HTMLTableCellElement>) {
    if (editing) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      if (!readOnly) onStartEdit();
      return;
    }
    onNavigate(event);
  }

  return (
    <td
      ref={cellRef}
      role="gridcell"
      className={readOnly ? "db-table__cell db-table__cell--readonly" : "db-table__cell"}
      tabIndex={focused ? 0 : -1}
      onClick={() => {
        if (editing) return;
        onFocusCell();
        if (!readOnly) onStartEdit();
      }}
      onKeyDown={handleKeyDown}
      onFocus={onFocusCell}
    >
      <span className={record.title ? "db-table__value db-table__value--title" : "db-table__value db-table__value--placeholder"}>
        {record.title || UNTITLED_RECORD}
      </span>
      {editing && mutations ? (
        <EditorFlyout anchorRef={cellRef} label="Editar título" onClose={onStopEdit}>
          <TitleInput initial={record.title} onCommit={(title) => void mutations.renameRecord(record.id, title)} onClose={onStopEdit} />
        </EditorFlyout>
      ) : null}
    </td>
  );
}

function TitleInput({ initial, onCommit, onClose }: { initial: string; onCommit(title: string): void; onClose(): void }) {
  const [draft, setDraft] = useState(initial);
  const committedRef = useRef(false);

  function commitAndClose() {
    if (committedRef.current) return;
    committedRef.current = true;
    const next = draft.trim();
    if (next !== initial) onCommit(next);
    onClose();
  }

  return (
    <input
      type="text"
      className="db-table__title-input"
      aria-label="Título do registro"
      placeholder={UNTITLED_RECORD}
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitAndClose}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitAndClose();
        } else if (event.key === "Escape") {
          event.preventDefault();
          committedRef.current = true; // cancela: nada vai para o banco
          onClose();
        }
      }}
    />
  );
}
