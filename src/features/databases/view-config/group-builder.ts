/** Construtores PUROS de agrupamento de uma view (DBS-049). */
import type { PropertyId } from "../contract";
import type { GroupSpec, ViewConfig } from "./contract";

/** DBS-049 — agrupamento por propriedade. `hideEmpty`/`order` têm default sensato (mostrar o grupo vazio, ordem crescente); quem chama só sobrescreve o que precisa. */
export function groupByProperty(config: ViewConfig, propertyId: PropertyId, overrides: Partial<Omit<GroupSpec, "propertyId">> = {}): ViewConfig {
  const group: GroupSpec = {
    propertyId,
    hideEmpty: overrides.hideEmpty ?? false,
    order: overrides.order ?? "ascending",
  };
  if (overrides.manualOrder !== undefined) group.manualOrder = overrides.manualOrder;
  return { ...config, group };
}

export function clearGroup(config: ViewConfig): ViewConfig {
  return { ...config, group: null };
}

export function setGroupHideEmpty(config: ViewConfig, hideEmpty: boolean): ViewConfig {
  if (config.group === null) return config;
  return { ...config, group: { ...config.group, hideEmpty } };
}

export function setGroupOrder(config: ViewConfig, order: GroupSpec["order"], manualOrder?: string[]): ViewConfig {
  if (config.group === null) return config;
  const group: GroupSpec = { ...config.group, order };
  if (manualOrder !== undefined) group.manualOrder = manualOrder;
  return { ...config, group };
}
