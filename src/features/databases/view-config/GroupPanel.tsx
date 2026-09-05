/**
 * DBS-049 — agrupamento por propriedade: a view vira N seções, uma por
 * valor distinto. Só oferece propriedades cujo `PropertySpec.grouping` está
 * declarado (arquitetura §6) — o Rust decide como particionar a partir de
 * `grouping.strategy`, este painel só escolhe a propriedade e as opções.
 */
import { useId, useState } from "react";
import type { PropertyId } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import { specForPropertyType } from "../core/property-spec";
import { clearGroup, groupByProperty } from "./group-builder";
import type { GroupSpec, ViewConfig } from "./contract";

interface GroupPanelProps {
  properties: readonly PropertyDescriptor[];
  config: ViewConfig;
  onChange(next: ViewConfig): void;
}

function groupableProperties(properties: readonly PropertyDescriptor[]): PropertyDescriptor[] {
  return properties.filter((property) => specForPropertyType(property.type)?.grouping !== undefined);
}

export function GroupPanel({ properties, config, onChange }: GroupPanelProps) {
  const options = groupableProperties(properties);
  const current = config.group;

  const [propertyId, setPropertyId] = useState<PropertyId | "">(current?.propertyId ?? "");
  const [hideEmpty, setHideEmpty] = useState(current?.hideEmpty ?? false);
  const [order, setOrder] = useState<GroupSpec["order"]>(current?.order ?? "ascending");

  const propertySelectId = useId();
  const orderSelectId = useId();

  function handleApply() {
    if (propertyId === "") return;
    onChange(groupByProperty(config, propertyId, { hideEmpty, order }));
  }

  function handleClear() {
    onChange(clearGroup(config));
  }

  if (options.length === 0) {
    return <p className="p-3 text-sm text-ink-muted">Nenhuma propriedade desta database pode ser usada pra agrupar.</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={propertySelectId} className="text-xs font-medium text-ink-muted">
          Agrupar por
        </label>
        <select
          id={propertySelectId}
          value={propertyId}
          onChange={(event) => setPropertyId(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          <option value="">Nenhum</option>
          {options.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />
        Ocultar seção vazia
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor={orderSelectId} className="text-xs font-medium text-ink-muted">
          Ordem das seções
        </label>
        <select
          id={orderSelectId}
          value={order}
          // `as` seguro aqui: as três `<option>` abaixo são exatamente os
          // três literais de `GroupSpec["order"]" — o navegador nunca
          // devolve outro valor num `change` deste `<select>`.
          onChange={(event) => setOrder(event.target.value as GroupSpec["order"])}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          <option value="ascending">Crescente</option>
          <option value="descending">Decrescente</option>
          <option value="manual">Manual (arrastar seções)</option>
        </select>
      </div>
      <div className="mt-1 flex justify-between">
        <button type="button" onClick={handleClear} className="rounded px-2 py-1 text-sm text-ink-muted hover:bg-surface-sunken">
          Remover agrupamento
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={propertyId === ""}
          className="rounded bg-emerald px-3 py-1 text-sm font-medium text-on-emerald disabled:opacity-50"
        >
          Aplicar agrupamento
        </button>
      </div>
    </div>
  );
}
