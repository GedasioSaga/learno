/**
 * DBS-054 — visibilidade de propriedade por view, nos três estados
 * declarados em `ColumnVisibilityMode`. A lógica de "oculta se vazia" (I1)
 * mora em `visibility.ts`; este painel só grava a escolha por propriedade.
 */
import { getColumnVisibilityMode, setColumnVisibility } from "./visibility";
import type { ColumnVisibilityMode, ViewConfig } from "./contract";
import type { PropertyDescriptor } from "../core/property-spec";

interface VisibilityPanelProps {
  properties: readonly PropertyDescriptor[];
  config: ViewConfig;
  onChange(next: ViewConfig): void;
}

const MODE_LABELS: Record<ColumnVisibilityMode, string> = {
  always: "Sempre visível",
  hide_when_empty: "Ocultar se vazia",
  never: "Sempre oculta",
};

export function VisibilityPanel({ properties, config, onChange }: VisibilityPanelProps) {
  if (properties.length === 0) {
    return <p className="p-3 text-sm text-ink-muted">Esta database ainda não tem propriedade.</p>;
  }

  return (
    <div className="flex max-h-80 w-72 flex-col gap-1 overflow-y-auto p-3">
      {properties.map((property) => {
        const mode = getColumnVisibilityMode(config, property.id);
        return (
          <div key={property.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-ink">{property.name}</span>
            <select
              aria-label={`Visibilidade de ${property.name}`}
              value={mode}
              // `as` seguro aqui: as três `<option>` abaixo são exatamente
              // os três literais de `ColumnVisibilityMode`.
              onChange={(event) => onChange(setColumnVisibility(config, property.id, event.target.value as ColumnVisibilityMode))}
              className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
            >
              <option value="always">{MODE_LABELS.always}</option>
              <option value="hide_when_empty">{MODE_LABELS.hide_when_empty}</option>
              <option value="never">{MODE_LABELS.never}</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}
