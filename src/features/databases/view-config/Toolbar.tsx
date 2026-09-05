/**
 * A barra de ferramentas de uma view: gatilhos pra Filtro (DBS-045),
 * Ordenar (DBS-047), Agrupar (DBS-049) e Propriedades (DBS-054), mais o
 * aviso de referência órfã (TOLERÂNCIA A CHAVE ÓRFÃ do briefing desta peça)
 * quando o `ViewConfig` cita uma propriedade que já foi apagada — em
 * qualquer um dos quatro, não só em visibilidade.
 *
 * Puramente de apresentação + composição: quem monta a tela da database é
 * quem decide como persistir `onConfigChange` (comando Tauri ainda
 * inexistente nesta rodada — ver `divergencias_da_arquitetura`). Este
 * componente nunca fala com o IPC.
 */
import { useId, useMemo, type ReactNode } from "react";
import type { PropertyId } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import { FilterPanel } from "./FilterPanel";
import { SortPanel } from "./SortPanel";
import { GroupPanel } from "./GroupPanel";
import { VisibilityPanel } from "./VisibilityPanel";
import { cleanOrphanPropertyRefs, findOrphanPropertyRefs } from "./orphans";
import { useTogglePanel } from "./use-toggle-panel";
import type { ViewConfig } from "./contract";

export interface ViewToolbarProps {
  properties: readonly PropertyDescriptor[];
  config: ViewConfig;
  onConfigChange(next: ViewConfig): void;
}

function ToolbarMenu({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  const { open, toggle, containerRef } = useTogglePanel();
  const panelId = useId();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className={`rounded px-2 py-1 text-sm ${active ? "font-medium text-ink" : "text-ink-muted"} hover:bg-surface-sunken`}
      >
        {label}
        {active ? " •" : ""}
      </button>
      {open ? <div id={panelId} className="absolute left-0 top-full z-10 mt-1 rounded border border-border bg-surface shadow-hard-sm">{children}</div> : null}
    </div>
  );
}

export function ViewToolbar({ properties, config, onConfigChange }: ViewToolbarProps) {
  const livePropertyIds: ReadonlySet<PropertyId> = useMemo(() => new Set(properties.map((property) => property.id)), [properties]);
  const orphanRefs = useMemo(() => findOrphanPropertyRefs(config, livePropertyIds), [config, livePropertyIds]);

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <ToolbarMenu label="Filtro" active={config.filter !== null}>
        <FilterPanel properties={properties} config={config} onChange={onConfigChange} />
      </ToolbarMenu>
      <ToolbarMenu label="Ordenar" active={config.sorts.length > 0}>
        <SortPanel properties={properties} config={config} onChange={onConfigChange} />
      </ToolbarMenu>
      <ToolbarMenu label="Agrupar" active={config.group !== null}>
        <GroupPanel properties={properties} config={config} onChange={onConfigChange} />
      </ToolbarMenu>
      <ToolbarMenu label="Propriedades" active={Object.keys(config.columnVisibility).length > 0}>
        <VisibilityPanel properties={properties} config={config} onChange={onConfigChange} />
      </ToolbarMenu>
      {orphanRefs.length > 0 ? (
        <button
          type="button"
          onClick={() => onConfigChange(cleanOrphanPropertyRefs(config, livePropertyIds))}
          className="ml-auto rounded px-2 py-1 text-sm text-terracotta-ink hover:bg-surface-sunken"
        >
          {orphanRefs.length === 1
            ? "1 referência a uma propriedade apagada — Limpar"
            : `${orphanRefs.length} referências a propriedades apagadas — Limpar`}
        </button>
      ) : null}
    </div>
  );
}
