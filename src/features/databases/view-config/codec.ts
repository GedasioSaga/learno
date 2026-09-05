/**
 * A fronteira jsonb <-> `ViewConfig` tipado. `parseViewConfig` é TOTAL —
 * nunca lança — no mesmo espírito de `PropertySpec.parse()` (arquitetura
 * §6): um blob corrompido, gravado por uma versão futura do app ou por um
 * bug em outra peça, vira o config vazio (ou os pedaços que ainda fazem
 * sentido), nunca derruba a tela da view. `serializeViewConfig` é o inverso,
 * para o caminho de escrita.
 */
import type { AggregationKind, FilterOperator, PropertyId } from "../contract";
import type {
  ColorRule,
  ColumnVisibilityMode,
  FilterCondition,
  FilterGroup,
  FilterNode,
  GroupSpec,
  SortSpec,
  ViewConfig,
} from "./contract";

const FILTER_OPERATORS: readonly FilterOperator[] = [
  "is",
  "isNot",
  "contains",
  "doesNotContain",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isBefore",
  "isAfter",
  "isOnOrBefore",
  "isOnOrAfter",
  "isWithin",
  "isChecked",
  "isNotChecked",
  "isEmpty",
  "isNotEmpty",
  "containsAny",
  "containsAll",
];
const FILTER_OPERATOR_SET: ReadonlySet<string> = new Set(FILTER_OPERATORS);

const AGGREGATION_KINDS: readonly AggregationKind[] = [
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
];
const AGGREGATION_KIND_SET: ReadonlySet<string> = new Set(AGGREGATION_KINDS);

const COLUMN_VISIBILITY_MODES: readonly ColumnVisibilityMode[] = ["always", "hide_when_empty", "never"];
const COLUMN_VISIBILITY_MODE_SET: ReadonlySet<string> = new Set(COLUMN_VISIBILITY_MODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === "string" && FILTER_OPERATOR_SET.has(value);
}

function isAggregationKind(value: unknown): value is AggregationKind {
  return typeof value === "string" && AGGREGATION_KIND_SET.has(value);
}

function isColumnVisibilityMode(value: unknown): value is ColumnVisibilityMode {
  return typeof value === "string" && COLUMN_VISIBILITY_MODE_SET.has(value);
}

/** `null` quando o nó não é reconhecível — o chamador decide se descarta o nó ou a árvore inteira. */
function parseFilterNode(raw: unknown): FilterNode | null {
  if (!isRecord(raw)) return null;

  if (raw.kind === "condition") {
    const propertyId = raw.propertyId;
    const operator = raw.operator;
    if (typeof propertyId !== "string" || !isFilterOperator(operator)) return null;
    const condition: FilterCondition = { kind: "condition", propertyId, operator };
    // `value` fica de fora do objeto quando ausente — não vira `undefined`
    // explícito, para casar com "ausente em isEmpty/isNotEmpty" da §8.
    if ("value" in raw) condition.value = raw.value;
    return condition;
  }

  if (raw.kind === "group") {
    const connective = raw.connective === "or" ? "or" : raw.connective === "and" ? "and" : null;
    if (connective === null) return null;
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const children: FilterNode[] = [];
    for (const rawChild of rawChildren) {
      const child = parseFilterNode(rawChild);
      if (child !== null) children.push(child);
    }
    const group: FilterGroup = { kind: "group", connective, children };
    return group;
  }

  return null;
}

function parseSortSpec(raw: unknown): SortSpec | null {
  if (!isRecord(raw)) return null;
  const propertyId = raw.propertyId;
  if (propertyId !== null && typeof propertyId !== "string") return null;
  const direction = raw.direction === "desc" ? "desc" : raw.direction === "asc" ? "asc" : null;
  if (direction === null) return null;
  return { propertyId, direction };
}

function parseGroupSpec(raw: unknown): GroupSpec | null {
  if (!isRecord(raw)) return null;
  const propertyId = raw.propertyId;
  if (typeof propertyId !== "string") return null;
  const order =
    raw.order === "descending" ? "descending" : raw.order === "manual" ? "manual" : raw.order === "ascending" ? "ascending" : null;
  if (order === null) return null;
  const hideEmpty = raw.hideEmpty === true;
  const spec: GroupSpec = { propertyId, hideEmpty, order };
  if (Array.isArray(raw.manualOrder)) {
    const manualOrder = raw.manualOrder.filter((entry): entry is string => typeof entry === "string");
    spec.manualOrder = manualOrder;
  }
  return spec;
}

function parseColorRule(raw: unknown): ColorRule | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  const color = raw.color;
  if (typeof id !== "string" || typeof color !== "string") return null;
  const when = parseFilterNode(raw.when);
  // `ColorRule.when` é sempre um `FilterGroup` (§8) — uma condição solta
  // não é uma forma válida aqui, mesmo sendo um `FilterNode` legítimo.
  if (when === null || when.kind !== "group") return null;
  const target = parseColorRuleTarget(raw.target);
  if (target === null) return null;
  return { id, when, target, color };
}

function parseColorRuleTarget(raw: unknown): ColorRule["target"] | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "row") return { kind: "row" };
  if (raw.kind === "property" && typeof raw.propertyId === "string") {
    return { kind: "property", propertyId: raw.propertyId };
  }
  return null;
}

/** O `ViewConfig` de uma view sem nenhuma configuração salva ainda — `database_views.config` nasce `'{}'::jsonb` (0008). */
export function createEmptyViewConfig(): ViewConfig {
  return {
    filter: null,
    sorts: [],
    group: null,
    colorRules: [],
    columnOrder: [],
    columnWidths: {},
    columnVisibility: {},
    footers: {},
    frozenUpTo: null,
  };
}

/**
 * jsonb -> `ViewConfig`. TOTAL: nunca lança. Cada campo é validado
 * isoladamente — um `sorts` corrompido não impede `filter` de carregar — e
 * um campo que não valida vira o default daquele campo (nunca a view
 * inteira sendo descartada por um pedaço ruim).
 */
export function parseViewConfig(raw: unknown): ViewConfig {
  const config = createEmptyViewConfig();
  if (!isRecord(raw)) return config;

  if (raw.filter !== undefined && raw.filter !== null) {
    config.filter = parseFilterNode(raw.filter);
  }

  if (Array.isArray(raw.sorts)) {
    for (const rawSort of raw.sorts) {
      const sort = parseSortSpec(rawSort);
      if (sort !== null) config.sorts.push(sort);
    }
  }

  if (raw.group !== undefined && raw.group !== null) {
    config.group = parseGroupSpec(raw.group);
  }

  if (Array.isArray(raw.colorRules)) {
    for (const rawRule of raw.colorRules) {
      const rule = parseColorRule(rawRule);
      if (rule !== null) config.colorRules.push(rule);
    }
  }

  if (Array.isArray(raw.columnOrder)) {
    config.columnOrder = raw.columnOrder.filter((entry): entry is PropertyId => typeof entry === "string");
  }

  if (isRecord(raw.columnWidths)) {
    for (const [propertyId, width] of Object.entries(raw.columnWidths)) {
      if (typeof width === "number" && Number.isFinite(width)) config.columnWidths[propertyId] = width;
    }
  }

  if (isRecord(raw.columnVisibility)) {
    for (const [propertyId, mode] of Object.entries(raw.columnVisibility)) {
      if (isColumnVisibilityMode(mode)) config.columnVisibility[propertyId] = mode;
    }
  }

  if (isRecord(raw.footers)) {
    for (const [propertyId, calculation] of Object.entries(raw.footers)) {
      if (calculation === null || isAggregationKind(calculation)) config.footers[propertyId] = calculation;
    }
  }

  if (typeof raw.frozenUpTo === "string") config.frozenUpTo = raw.frozenUpTo;

  if (raw.defaultTemplateId === null || typeof raw.defaultTemplateId === "string") {
    config.defaultTemplateId = raw.defaultTemplateId;
  }

  if (raw.interactionFilter === "parentsOnly" || raw.interactionFilter === "subItemsOnly" || raw.interactionFilter === "both") {
    config.interactionFilter = raw.interactionFilter;
  }

  if (raw.subItemDisplay === "nestedToggle" || raw.subItemDisplay === "flattened" || raw.subItemDisplay === "cardProperty") {
    config.subItemDisplay = raw.subItemDisplay;
  }

  if (isRecord(raw.layout)) config.layout = raw.layout;

  return config;
}

/** `ViewConfig` -> jsonb. Campos opcionais ausentes ficam de fora do objeto (nunca `undefined` explícito) para o blob salvo não crescer com lixo. */
export function serializeViewConfig(config: ViewConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    filter: config.filter,
    sorts: config.sorts,
    group: config.group,
    colorRules: config.colorRules,
    columnOrder: config.columnOrder,
    columnWidths: config.columnWidths,
    columnVisibility: config.columnVisibility,
    footers: config.footers,
    frozenUpTo: config.frozenUpTo,
  };
  if (config.defaultTemplateId !== undefined) out.defaultTemplateId = config.defaultTemplateId;
  if (config.interactionFilter !== undefined) out.interactionFilter = config.interactionFilter;
  if (config.subItemDisplay !== undefined) out.subItemDisplay = config.subItemDisplay;
  if (config.layout !== undefined) out.layout = config.layout;
  return out;
}
