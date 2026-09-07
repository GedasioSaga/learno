/**
 * DBS-001/DBS-002: a peça compartilhada entre o bloco inline (dentro de uma
 * nota, `mode="inline"`) e a database de página inteira (`mode="fullPage"`).
 * Ver `types.ts` para por que este arquivo nunca chama `invoke`.
 */
import { useState } from "react";
import type { PropertyType } from "../../../lib/ipc";
import { isBackendPropertyType } from "../core/backend-property-types";
import { ensureDatabaseExtensionsDiscovered } from "../core/discover-extensions";
import { specForPropertyType, type PropertyDescriptor, type PropertySpec } from "../core/property-spec";
import { DatabaseContainerBody } from "./DatabaseContainerBody";
import { DatabaseContainerHeader } from "./DatabaseContainerHeader";
import { ExpandedDatabaseOverlay } from "./ExpandedDatabaseOverlay";
import { PropertyConfigDialog } from "./PropertyConfigDialog";
import type { PropertyActions, ViewMutations } from "../core/view-spec";
import type { DatabaseContainerActions, DatabaseContainerMode, DatabaseContainerState, PropertyMutations } from "./types";

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
  /** As escritas de ESTRUTURA do menu de coluna. Ausente/`null` = sem menu; `database.isLocked` também o suprime. */
  propertyMutations?: PropertyMutations | null;
  activeViewId?: string;
}

const NO_ACTIONS: DatabaseContainerActions = {};

/** O que o diálogo de configuração está fazendo: criando uma propriedade de um tipo, ou editando uma existente. */
type Configuring = { mode: "create"; spec: PropertySpec } | { mode: "edit"; spec: PropertySpec; property: PropertyDescriptor };

export function DatabaseContainer({
  state,
  mode,
  actions = NO_ACTIONS,
  mutations = null,
  propertyMutations = null,
  activeViewId,
}: DatabaseContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // O diálogo de configuração abre aqui, onde schema e registros já existem
  // — tanto para o tipo escolhido no "+ Propriedade" que pede configuração
  // antes de nascer (Fórmula) quanto para "Editar fórmula" no menu de coluna.
  const [configuring, setConfiguring] = useState<Configuring | null>(null);

  // Um tipo com `renderConfigForm` passa pelo diálogo; os outros nascem
  // direto, como antes. O cabeçalho continua sem saber de nenhum dos dois.
  const onAddProperty = actions.onAddProperty;
  const headerActions: DatabaseContainerActions = onAddProperty
    ? {
        ...actions,
        onAddProperty: (type: PropertyType, name: string, config?: unknown) => {
          const spec = specForPropertyType(type);
          if (spec?.renderConfigForm && config === undefined) setConfiguring({ mode: "create", spec });
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

  // DBS-002: o gate de estrutura é `database.isLocked`, aplicado AQUI —
  // a view recebe `null` e não desenha menu de coluna; o corpo nunca vê o
  // bloqueio. `editConfig` é a única ação que não escreve: ela abre o
  // diálogo acima, e é o diálogo que chama `setConfig`.
  const propertyActions: PropertyActions | null =
    propertyMutations && !schema.database.isLocked
      ? {
          rename: propertyMutations.rename,
          changeType: (propertyId, newType) =>
            isBackendPropertyType(newType)
              ? propertyMutations.changeType(propertyId, newType)
              : Promise.resolve({ ok: false, message: `O tipo "${newType}" não existe neste app.` }),
          reorder: propertyMutations.reorder,
          delete: propertyMutations.delete,
          editConfig: (property) => {
            const spec = specForPropertyType(property.type);
            if (spec?.renderConfigForm) setConfiguring({ mode: "edit", spec, property });
          },
        }
      : null;

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border bg-surface">
      <DatabaseContainerHeader
        database={schema.database}
        mode={mode}
        actions={headerActions}
        onExpand={mode === "inline" ? () => setIsExpanded(true) : undefined}
      />
      <div className="min-h-0">
        <DatabaseContainerBody
          schema={schema}
          records={records}
          mutations={mutations}
          propertyActions={propertyActions}
          activeViewId={activeViewId}
        />
      </div>
      {configuring?.mode === "create" && onAddProperty && !isExpanded ? (
        <PropertyConfigDialog
          mode="create"
          spec={configuring.spec}
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
      {configuring?.mode === "edit" && propertyMutations && !isExpanded ? (
        <PropertyConfigDialog
          mode="edit"
          spec={configuring.spec}
          property={configuring.property}
          databaseId={schema.database.id}
          properties={schema.properties}
          records={records}
          onCancel={() => setConfiguring(null)}
          onSave={async (config) => {
            const result = await propertyMutations.setConfig(configuring.property.id, config);
            if (result.ok) setConfiguring(null);
            return result;
          }}
        />
      ) : null}
      {isExpanded ? (
        <ExpandedDatabaseOverlay
          state={state}
          actions={actions}
          mutations={mutations}
          propertyMutations={propertyMutations}
          activeViewId={activeViewId}
          onClose={() => setIsExpanded(false)}
        />
      ) : null}
    </div>
  );
}
