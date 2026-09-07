/**
 * DBS-001/DBS-002: a peça compartilhada entre o bloco inline (dentro de uma
 * nota, `mode="inline"`) e a database de página inteira (`mode="fullPage"`).
 * Ver `types.ts` para por que este arquivo nunca chama `invoke`.
 */
import { useState } from "react";
import type { PropertyType } from "../../../lib/ipc";
import { ensureDatabaseExtensionsDiscovered } from "../core/discover-extensions";
import { specForPropertyType, type PropertySpec } from "../core/property-spec";
import { DatabaseContainerBody } from "./DatabaseContainerBody";
import { DatabaseContainerHeader } from "./DatabaseContainerHeader";
import { ExpandedDatabaseOverlay } from "./ExpandedDatabaseOverlay";
import { NewPropertyDialog } from "./NewPropertyDialog";
import type { ViewMutations } from "../core/view-spec";
import type { DatabaseContainerActions, DatabaseContainerMode, DatabaseContainerState } from "./types";

// Roda uma vez no carregamento do módulo, antes de qualquer database montar:
// puxa todo `properties/**/register.ts` e `views/**/register.ts`, que é como
// um tipo de propriedade ou de view entra nos registros de `core/` sem
// ninguém importá-lo explicitamente.
//
// Esta linha existe porque ela FALTAVA, e a falta era invisível: o mecanismo
// de descoberta estava escrito e testado, e nenhum arquivo do projeto o
// chamava — `rg` achava só a própria definição. O sintoma seria uma database
// que abre com todas as células vazias e nenhum tipo de propriedade
// disponível, sem erro nenhum no console. É o mesmo padrão do editor
// (`features/editor/core/Editor.tsx`), onde a chamada mora no componente que
// monta a coisa, e não num módulo que alguém precise lembrar de importar.
ensureDatabaseExtensionsDiscovered();

interface DatabaseContainerProps {
  state: DatabaseContainerState;
  mode: DatabaseContainerMode;
  actions?: DatabaseContainerActions;
  /** O que a view ativa pode escrever. Ausente/`null` = view somente-leitura (ver `ViewMutations`). */
  mutations?: ViewMutations | null;
  activeViewId?: string;
}

const NO_ACTIONS: DatabaseContainerActions = {};

export function DatabaseContainer({ state, mode, actions = NO_ACTIONS, mutations = null, activeViewId }: DatabaseContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // O tipo escolhido no menu cujo spec pede configuração antes de nascer
  // (Fórmula): o diálogo abre aqui, onde schema e registros já existem.
  const [configuring, setConfiguring] = useState<PropertySpec | null>(null);

  // Um tipo com `renderConfigForm` passa pelo diálogo; os outros nascem
  // direto, como antes. O cabeçalho continua sem saber de nenhum dos dois.
  const onAddProperty = actions.onAddProperty;
  const headerActions: DatabaseContainerActions = onAddProperty
    ? {
        ...actions,
        onAddProperty: (type: PropertyType, name: string, config?: unknown) => {
          const spec = specForPropertyType(type);
          if (spec?.renderConfigForm && config === undefined) setConfiguring(spec);
          else if (config === undefined) onAddProperty(type, name);
          else onAddProperty(type, name, config);
        },
      }
    : actions;

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

  const { schema, records } = state;

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border bg-surface">
      <DatabaseContainerHeader
        database={schema.database}
        mode={mode}
        actions={headerActions}
        onExpand={mode === "inline" ? () => setIsExpanded(true) : undefined}
      />
      <div className="min-h-0">
        <DatabaseContainerBody schema={schema} records={records} mutations={mutations} activeViewId={activeViewId} />
      </div>
      {configuring && onAddProperty && !isExpanded ? (
        <NewPropertyDialog
          spec={configuring}
          databaseId={schema.database.id}
          properties={schema.properties}
          records={records}
          onCancel={() => setConfiguring(null)}
          // Um callback síncrono (`void`) conta como sucesso; um assíncrono
          // decide — o diálogo só fecha com `ok`.
          onCreate={async (type, name, config) => {
            const result = await onAddProperty(type, name, config);
            if (result === undefined || result.ok) setConfiguring(null);
            return result ?? { ok: true };
          }}
        />
      ) : null}
      {isExpanded ? (
        <ExpandedDatabaseOverlay
          state={state}
          actions={actions}
          mutations={mutations}
          activeViewId={activeViewId}
          onClose={() => setIsExpanded(false)}
        />
      ) : null}
    </div>
  );
}
