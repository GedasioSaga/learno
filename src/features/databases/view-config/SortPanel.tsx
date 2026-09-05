/**
 * DBS-047 — ordenação simples: uma propriedade, crescente ou decrescente.
 * `sorts` da §8 já é uma lista (desempate de várias propriedades), mas o
 * critério pede "uma propriedade" — este painel sempre grava a lista
 * inteira com UM `SortSpec` via `setSingleSort`.
 */
import { useId, useState } from "react";
import type { PropertyId } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import { specForPropertyType } from "../core/property-spec";
import { clearSorts, setSingleSort } from "./sort-builder";
import type { ViewConfig } from "./contract";

interface SortPanelProps {
  properties: readonly PropertyDescriptor[];
  config: ViewConfig;
  onChange(next: ViewConfig): void;
}

/** "none" = tipo declarado como não-ordenável (files, relation, button — arquitetura §6); um tipo sem spec registrado também não entra aqui. */
function sortableProperties(properties: readonly PropertyDescriptor[]): PropertyDescriptor[] {
  return properties.filter((property) => specForPropertyType(property.type)?.sort !== undefined && specForPropertyType(property.type)?.sort !== "none");
}

export function SortPanel({ properties, config, onChange }: SortPanelProps) {
  const options = sortableProperties(properties);
  const hasCustomSort = config.sorts.length > 1;
  const current = config.sorts.length === 1 ? config.sorts[0] : null;

  const [propertyId, setPropertyId] = useState<PropertyId | null>(current?.propertyId ?? options[0]?.id ?? null);
  const [direction, setDirection] = useState<"asc" | "desc">(current?.direction ?? "asc");

  const propertySelectId = useId();

  function handleApply() {
    onChange(setSingleSort(config, propertyId, direction));
  }

  function handleClear() {
    onChange(clearSorts(config));
  }

  if (options.length === 0) {
    return <p className="p-3 text-sm text-ink-muted">Nenhuma propriedade desta database é ordenável.</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2 p-3">
      {hasCustomSort ? <p className="text-xs text-ink-muted">Uma ordenação com desempate está ativa. Aplicar aqui a substitui por uma ordenação simples.</p> : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={propertySelectId} className="text-xs font-medium text-ink-muted">
          Ordenar por
        </label>
        <select
          id={propertySelectId}
          value={propertyId ?? ""}
          onChange={(event) => setPropertyId(event.target.value === "" ? null : event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          <option value="">Ordem manual</option>
          {options.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex gap-3">
        <legend className="mb-1 text-xs font-medium text-ink-muted">Direção</legend>
        <label className="flex items-center gap-1 text-sm text-ink">
          <input type="radio" name="sort-direction" checked={direction === "asc"} onChange={() => setDirection("asc")} />
          Crescente
        </label>
        <label className="flex items-center gap-1 text-sm text-ink">
          <input type="radio" name="sort-direction" checked={direction === "desc"} onChange={() => setDirection("desc")} />
          Decrescente
        </label>
      </fieldset>
      <div className="mt-1 flex justify-between">
        <button type="button" onClick={handleClear} className="rounded px-2 py-1 text-sm text-ink-muted hover:bg-surface-sunken">
          Remover ordenação
        </button>
        <button type="button" onClick={handleApply} className="rounded bg-emerald px-3 py-1 text-sm font-medium text-on-emerald">
          Aplicar ordenação
        </button>
      </div>
    </div>
  );
}
