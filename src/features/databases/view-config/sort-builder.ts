/**
 * Construtores PUROS de ordenação de uma view (DBS-047). `sorts` já é uma
 * lista na §8 (ordenação primária + desempates) mas o critério de DBS-047
 * pede "uma propriedade" — `setSingleSort` é o atalho que a barra de
 * ferramentas usa; `addSort`/`removeSort`/`reorderSorts` ficam disponíveis
 * pra quando alguém precisar de desempate de verdade.
 */
import type { PropertyId } from "../contract";
import type { SortSpec, ViewConfig } from "./contract";

/** DBS-047 — ordenação simples: a lista de ordenação vira UM `SortSpec`, substituindo qualquer ordenação composta anterior. */
export function setSingleSort(config: ViewConfig, propertyId: PropertyId | null, direction: "asc" | "desc"): ViewConfig {
  return { ...config, sorts: [{ propertyId, direction }] };
}

export function clearSorts(config: ViewConfig): ViewConfig {
  return { ...config, sorts: [] };
}

/** Acrescenta (ou substitui, se `propertyId` já estava na lista) um critério de desempate ao fim da lista. */
export function addSort(config: ViewConfig, spec: SortSpec): ViewConfig {
  const withoutSameProperty = config.sorts.filter((sort) => sort.propertyId !== spec.propertyId);
  return { ...config, sorts: [...withoutSameProperty, spec] };
}

export function removeSort(config: ViewConfig, propertyId: PropertyId | null): ViewConfig {
  return { ...config, sorts: config.sorts.filter((sort) => sort.propertyId !== propertyId) };
}

export function toggleSortDirection(config: ViewConfig, propertyId: PropertyId | null): ViewConfig {
  return {
    ...config,
    sorts: config.sorts.map((sort) => (sort.propertyId === propertyId ? { ...sort, direction: sort.direction === "asc" ? "desc" : "asc" } : sort)),
  };
}

/** Move o critério em `fromIndex` para `toIndex` — muda a prioridade de desempate, não a direção de nenhum. */
export function reorderSorts(config: ViewConfig, fromIndex: number, toIndex: number): ViewConfig {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= config.sorts.length || toIndex < 0 || toIndex >= config.sorts.length) {
    return config;
  }
  const sorts = [...config.sorts];
  const [moved] = sorts.splice(fromIndex, 1);
  sorts.splice(toIndex, 0, moved);
  return { ...config, sorts };
}
