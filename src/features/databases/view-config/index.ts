/**
 * Superfície pública desta peça (S3 — configuração de view e barra de
 * ferramentas). Quem monta a tela de uma `DatabaseView` importa daqui, não
 * de um arquivo específico dentro da pasta — mesmo padrão de
 * `src/features/editor/index.ts`.
 */
export type {
  ColorRule,
  ColumnVisibilityMode,
  FilterCondition,
  FilterGroup,
  FilterNode,
  GroupSpec,
  SortSpec,
  ViewConfig,
} from "./contract";

export { createEmptyViewConfig, parseViewConfig, serializeViewConfig } from "./codec";

export { readViewConfig, updateViewConfig, withViewConfig } from "./store";

export {
  addConditionAt,
  applySimpleFilter,
  clearFilter,
  createCondition,
  createGroup,
  getFilterNodeAt,
  removeNodeAt,
  setFilter,
  setGroupConnectiveAt,
  updateConditionAt,
} from "./filter-builder";

export { addSort, clearSorts, removeSort, reorderSorts, setSingleSort, toggleSortDirection } from "./sort-builder";

export { clearGroup, groupByProperty, setGroupHideEmpty, setGroupOrder } from "./group-builder";

export {
  DEFAULT_COLUMN_VISIBILITY,
  getColumnVisibilityMode,
  isPropertyVisibleForRecord,
  resolveVisibleProperties,
  setColumnVisibility,
} from "./visibility";

export type { OrphanRef, OrphanRefLocation } from "./orphans";
export { cleanOrphanPropertyRefs, findOrphanPropertyRefs } from "./orphans";

export { ViewToolbar, type ViewToolbarProps } from "./Toolbar";
export { FilterPanel } from "./FilterPanel";
export { SortPanel } from "./SortPanel";
export { GroupPanel } from "./GroupPanel";
export { VisibilityPanel } from "./VisibilityPanel";
