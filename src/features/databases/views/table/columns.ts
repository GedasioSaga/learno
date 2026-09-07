/**
 * Lógica PURA de colunas da Tabela: ordem, visibilidade e largura a partir
 * do `ViewConfig` (DBS-053/054) INTERSECTADO com a lista viva de
 * propriedades — uma entrada citando uma propriedade apagada é tolerada
 * (ver `view-config/orphans.ts`), nunca motivo de a view quebrar.
 */
import type { PropertyId } from "../../contract";
import type { PropertyDescriptor } from "../../core/property-spec";
import type { ViewConfig } from "../../view-config";

/** Largura padrão de uma coluna de propriedade e da coluna de título (a que o olho lê primeiro), em px. Só vale quando `columnWidths` não decidiu. */
export const DEFAULT_COLUMN_WIDTH = 180;
export const DEFAULT_TITLE_WIDTH = 260;
export const MIN_COLUMN_WIDTH = 80;

/**
 * As propriedades na ordem que a view mostra: primeiro as citadas em
 * `columnOrder` (na ordem de lá), depois as que a view nunca ordenou, pela
 * `position` da database. "never" some; "hide_when_empty" é decidido POR
 * REGISTRO (`isPropertyVisibleForRecord`), então aqui a coluna continua —
 * uma grade não pode ter coluna que existe numa linha e não na outra.
 */
export function orderVisibleColumns(config: ViewConfig, properties: readonly PropertyDescriptor[]): PropertyDescriptor[] {
  const byId = new Map(properties.map((property) => [property.id, property]));
  const ordered: PropertyDescriptor[] = [];
  for (const id of config.columnOrder) {
    const property = byId.get(id);
    if (property && !ordered.includes(property)) ordered.push(property);
  }
  for (const property of properties) if (!ordered.includes(property)) ordered.push(property);
  return ordered.filter((property) => config.columnVisibility[property.id] !== "never");
}

export function columnWidth(config: ViewConfig, propertyId: PropertyId): number {
  const width = config.columnWidths[propertyId];
  return typeof width === "number" && Number.isFinite(width) ? Math.max(MIN_COLUMN_WIDTH, width) : DEFAULT_COLUMN_WIDTH;
}
