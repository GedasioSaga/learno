/**
 * DBS-001: "expandir abre como página inteira com os mesmos registros" — o
 * MESMO `state` que o cartão inline já tinha, só redesenhado com
 * `mode="fullPage"`. "Os mesmos registros" sai de graça porque não existe
 * um segundo carregamento aqui, só um segundo `mode` sobre o mesmo dado.
 * Mesmo padrão de sobreposição de `VersionHistoryDialog` (backdrop fecha,
 * clique dentro não propaga, Escape fecha).
 */
import type { KeyboardEvent, MouseEvent } from "react";
import { DatabaseContainer } from "./DatabaseContainer";
import type { DatabaseContainerActions, DatabaseContainerState } from "./types";

interface ExpandedDatabaseOverlayProps {
  state: DatabaseContainerState;
  actions: DatabaseContainerActions;
  activeViewId?: string;
  onClose(): void;
}

export function ExpandedDatabaseOverlay({ state, actions, activeViewId, onClose }: ExpandedDatabaseOverlayProps) {
  const title = state.status === "ready" ? state.schema.database.name || "Database" : "Database";

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function stopPropagation(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-stretch bg-ink/40 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} — página inteira`}
        onClick={stopPropagation}
        onKeyDown={handleKeyDown}
        className="flex w-full flex-col overflow-y-auto rounded-sm border border-border bg-surface p-4 shadow-hard"
      >
        <div className="mb-2 flex justify-end">
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-ink-muted hover:text-ink">
            ✕
          </button>
        </div>
        <DatabaseContainer state={state} mode="fullPage" actions={actions} activeViewId={activeViewId} />
      </div>
    </div>
  );
}
