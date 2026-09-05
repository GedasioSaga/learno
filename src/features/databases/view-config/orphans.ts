/**
 * TOLERÂNCIA A CHAVE ÓRFÃ (briefing desta peça): o `ViewConfig` de uma view
 * pode citar um `PropertyId` que já foi apagado da database — outra tela
 * apagou a propriedade, ou uma sincronização futura remove uma sem passar
 * por esta pasta. A UI IGNORA essas referências (nunca deixa uma coluna
 * fantasma aparecer, nunca lança) e OFERECE limpar — nunca quebra a view.
 *
 * `findOrphanPropertyRefs` é só leitura, pra UI mostrar "3 referências a
 * propriedades apagadas" com nome de onde cada uma está.
 * `cleanOrphanPropertyRefs` é a limpeza de fato, pura — devolve um
 * `ViewConfig` novo sem as referências mortas.
 */
import type { PropertyId } from "../contract";
import type { ColorRule, FilterGroup, FilterNode, ViewConfig } from "./contract";

export type OrphanRefLocation =
  | "filter"
  | "sort"
  | "group"
  | "columnOrder"
  | "columnWidths"
  | "columnVisibility"
  | "footers"
  | "frozenUpTo"
  | "colorRule";

export interface OrphanRef {
  where: OrphanRefLocation;
  propertyId: PropertyId;
  /** Presente só para `filter`/`colorRule`, cujo `propertyId` mora dentro de uma árvore. */
  path?: number[];
}

function collectFilterOrphans(node: FilterNode | null, live: ReadonlySet<PropertyId>, path: number[], where: OrphanRefLocation, out: OrphanRef[]): void {
  if (node === null) return;
  if (node.kind === "condition") {
    if (!live.has(node.propertyId)) out.push({ where, propertyId: node.propertyId, path });
    return;
  }
  node.children.forEach((child, index) => collectFilterOrphans(child, live, [...path, index], where, out));
}

/** Toda referência a um `PropertyId` que `live` não reconhece mais, com onde ela está. Não muta nada — só relata. */
export function findOrphanPropertyRefs(config: ViewConfig, live: ReadonlySet<PropertyId>): OrphanRef[] {
  const out: OrphanRef[] = [];

  collectFilterOrphans(config.filter, live, [], "filter", out);

  for (const sort of config.sorts) {
    if (sort.propertyId !== null && !live.has(sort.propertyId)) out.push({ where: "sort", propertyId: sort.propertyId });
  }

  if (config.group !== null && !live.has(config.group.propertyId)) {
    out.push({ where: "group", propertyId: config.group.propertyId });
  }

  for (const propertyId of config.columnOrder) {
    if (!live.has(propertyId)) out.push({ where: "columnOrder", propertyId });
  }

  for (const propertyId of Object.keys(config.columnWidths)) {
    if (!live.has(propertyId)) out.push({ where: "columnWidths", propertyId });
  }

  for (const propertyId of Object.keys(config.columnVisibility)) {
    if (!live.has(propertyId)) out.push({ where: "columnVisibility", propertyId });
  }

  for (const propertyId of Object.keys(config.footers)) {
    if (!live.has(propertyId)) out.push({ where: "footers", propertyId });
  }

  if (config.frozenUpTo !== null && !live.has(config.frozenUpTo)) {
    out.push({ where: "frozenUpTo", propertyId: config.frozenUpTo });
  }

  config.colorRules.forEach((rule, ruleIndex) => {
    collectFilterOrphans(rule.when, live, [ruleIndex], "colorRule", out);
    if (rule.target.kind === "property" && !live.has(rule.target.propertyId)) {
      out.push({ where: "colorRule", propertyId: rule.target.propertyId, path: [ruleIndex] });
    }
  });

  return out;
}

/** Remove condições órfãs de uma árvore de filtro, colapsando grupo vazio a `null` e grupo de UM filho ao próprio filho (menos aninhamento morto sobrando pra sempre). */
function pruneFilterNode(node: FilterNode | null, live: ReadonlySet<PropertyId>): FilterNode | null {
  if (node === null) return null;
  if (node.kind === "condition") return live.has(node.propertyId) ? node : null;
  const children = node.children.map((child) => pruneFilterNode(child, live)).filter((child): child is FilterNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** Mesma poda de `pruneFilterNode`, mas para a raiz de um `ColorRule.when` — que é sempre um `FilterGroup`, nunca uma condição solta. `null` quando não sobra condição nenhuma. */
function pruneColorRuleWhen(when: FilterGroup, live: ReadonlySet<PropertyId>): FilterGroup | null {
  const pruned = pruneFilterNode(when, live);
  if (pruned === null) return null;
  return pruned.kind === "group" ? pruned : { kind: "group", connective: "and", children: [pruned] };
}

/**
 * `ViewConfig` novo sem nenhuma referência a um `PropertyId` fora de `live`.
 * Uma regra de cor cuja condição ou alvo fica sem propriedade nenhuma é
 * removida inteira — uma regra sem condição não significa nada.
 */
export function cleanOrphanPropertyRefs(config: ViewConfig, live: ReadonlySet<PropertyId>): ViewConfig {
  const columnWidths: Record<PropertyId, number> = {};
  for (const [propertyId, width] of Object.entries(config.columnWidths)) {
    if (live.has(propertyId)) columnWidths[propertyId] = width;
  }

  const columnVisibility: Record<PropertyId, ViewConfig["columnVisibility"][string]> = {};
  for (const [propertyId, mode] of Object.entries(config.columnVisibility)) {
    if (live.has(propertyId)) columnVisibility[propertyId] = mode;
  }

  const footers: ViewConfig["footers"] = {};
  for (const [propertyId, calculation] of Object.entries(config.footers)) {
    if (live.has(propertyId)) footers[propertyId] = calculation;
  }

  const colorRules: ColorRule[] = [];
  for (const rule of config.colorRules) {
    if (rule.target.kind === "property" && !live.has(rule.target.propertyId)) continue;
    const when = pruneColorRuleWhen(rule.when, live);
    if (when === null) continue;
    colorRules.push({ ...rule, when });
  }

  return {
    ...config,
    filter: pruneFilterNode(config.filter, live),
    sorts: config.sorts.filter((sort) => sort.propertyId === null || live.has(sort.propertyId)),
    group: config.group !== null && live.has(config.group.propertyId) ? config.group : null,
    colorRules,
    columnOrder: config.columnOrder.filter((propertyId) => live.has(propertyId)),
    columnWidths,
    columnVisibility,
    footers,
    frozenUpTo: config.frozenUpTo !== null && live.has(config.frozenUpTo) ? config.frozenUpTo : null,
  };
}
