/**
 * DBS-001/DBS-002: a peça compartilhada entre o bloco inline (dentro de uma
 * nota, `mode="inline"`) e a database de página inteira (`mode="fullPage"`).
 * Ver `types.ts` para por que este arquivo nunca chama `invoke`.
 */
import { useState } from "react";
import { DatabaseContainerBody } from "./DatabaseContainerBody";
import { DatabaseContainerHeader } from "./DatabaseContainerHeader";
import { ExpandedDatabaseOverlay } from "./ExpandedDatabaseOverlay";
import type { DatabaseContainerActions, DatabaseContainerMode, DatabaseContainerState } from "./types";

interface DatabaseContainerProps {
  state: DatabaseContainerState;
  mode: DatabaseContainerMode;
  actions?: DatabaseContainerActions;
  activeViewId?: string;
}

const NO_ACTIONS: DatabaseContainerActions = {};

export function DatabaseContainer({ state, mode, actions = NO_ACTIONS, activeViewId }: DatabaseContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (state.status === "loading") {
    return (
      <p role="status" className="px-2 py-3 text-sm text-ink-muted">
        Carregando database…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="px-2 py-3 text-sm text-terracotta-ink">
        {state.message}
      </p>
    );
  }

  const { schema } = state;

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border bg-surface">
      <DatabaseContainerHeader
        database={schema.database}
        mode={mode}
        actions={actions}
        onExpand={mode === "inline" ? () => setIsExpanded(true) : undefined}
      />
      <div className="min-h-0">
        <DatabaseContainerBody schema={schema} activeViewId={activeViewId} />
      </div>
      {isExpanded ? (
        <ExpandedDatabaseOverlay
          state={state}
          actions={actions}
          activeViewId={activeViewId}
          onClose={() => setIsExpanded(false)}
        />
      ) : null}
    </div>
  );
}
