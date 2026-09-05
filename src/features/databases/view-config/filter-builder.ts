/**
 * Construtores PUROS do filtro de uma view (DBS-045, e a árvore composta que
 * DBS-046-ish/DBS-053 vão precisar depois). Nenhuma função aqui muta o
 * `ViewConfig` recebido — cada uma devolve um objeto NOVO — porque é essa
 * imutabilidade que garante DBS-053 (aplicar filtro numa view não pode
 * vazar, por referência compartilhada, para o `ViewConfig` de outra).
 *
 * Endereçamento por `path` (índices de `.children`, raiz = `[]`) em vez de
 * `id` por nó: a §8 não dá `id` a `FilterCondition`/`FilterGroup`, e inventar
 * um aqui divergiria da forma que `query/contract.ts` vai publicar quando
 * existir (ver divergência em `contract.ts` deste pacote).
 */
import type { FilterOperator, PropertyId, PropertyValue } from "../contract";
import type { FilterCondition, FilterGroup, FilterNode, ViewConfig } from "./contract";

export function createCondition(propertyId: PropertyId, operator: FilterOperator, value?: PropertyValue): FilterCondition {
  const condition: FilterCondition = { kind: "condition", propertyId, operator };
  if (value !== undefined) condition.value = value;
  return condition;
}

export function createGroup(connective: "and" | "or", children: FilterNode[] = []): FilterGroup {
  return { kind: "group", connective, children };
}

/** Substitui a árvore de filtro inteira. */
export function setFilter(config: ViewConfig, filter: FilterNode | null): ViewConfig {
  return { ...config, filter };
}

/**
 * DBS-045 — filtro simples por propriedade: a árvore de filtro vira UMA
 * condição, substituindo qualquer filtro composto que existisse antes. É o
 * atalho que a barra de ferramentas usa; a árvore continua podendo crescer
 * depois via `addConditionAt`/`wrapInGroup` por quem precisar de filtro
 * composto.
 */
export function applySimpleFilter(config: ViewConfig, propertyId: PropertyId, operator: FilterOperator, value?: PropertyValue): ViewConfig {
  return setFilter(config, createCondition(propertyId, operator, value));
}

export function clearFilter(config: ViewConfig): ViewConfig {
  return setFilter(config, null);
}

function getChildAtPath(root: FilterNode | null, path: readonly number[]): FilterNode | null {
  let node = root;
  for (const index of path) {
    if (node === null || node.kind !== "group") return null;
    const child = node.children[index];
    node = child ?? null;
  }
  return node;
}

/** Reconstrói a árvore trocando o nó em `path` pelo resultado de `updater` — imutável, do topo até a folha. `updater(null)` quando o path aponta pra um nó que não existe é a chance de inserir ali. */
function replaceAtPath(root: FilterNode | null, path: readonly number[], updater: (node: FilterNode | null) => FilterNode | null): FilterNode | null {
  if (path.length === 0) return updater(root);
  if (root === null || root.kind !== "group") return root;
  const [index, ...rest] = path;
  const children = root.children.map((child, childIndex) => (childIndex === index ? replaceAtPath(child, rest, updater) : child));
  return { ...root, children: children.filter((child): child is FilterNode => child !== null) };
}

/** Nó no `path` dado, ou `null` se a árvore não chega até lá (path obsoleto). */
export function getFilterNodeAt(config: ViewConfig, path: readonly number[]): FilterNode | null {
  return getChildAtPath(config.filter, path);
}

/** Acrescenta `condition` como filha do grupo em `groupPath`. Se `groupPath` é `[]` e a raiz ainda não é um grupo, ENVOLVE a raiz atual (condição solta ou `null`) num grupo novo antes de acrescentar — é o caminho natural de "simples" para "composto". */
export function addConditionAt(config: ViewConfig, groupPath: readonly number[], condition: FilterCondition): ViewConfig {
  if (groupPath.length === 0) {
    const root = config.filter;
    if (root === null) return setFilter(config, createGroup("and", [condition]));
    if (root.kind === "condition") return setFilter(config, createGroup("and", [root, condition]));
    return setFilter(config, { ...root, children: [...root.children, condition] });
  }
  const next = replaceAtPath(config.filter, groupPath, (node) => {
    if (node === null || node.kind !== "group") return node;
    return { ...node, children: [...node.children, condition] };
  });
  return setFilter(config, next);
}

/** Remove o nó em `path`. Removendo a raiz (`path = []`) zera o filtro inteiro. */
export function removeNodeAt(config: ViewConfig, path: readonly number[]): ViewConfig {
  if (path.length === 0) return clearFilter(config);
  const parentPath = path.slice(0, -1);
  const removedIndex = path[path.length - 1];
  const next = replaceAtPath(config.filter, parentPath, (node) => {
    if (node === null || node.kind !== "group") return node;
    return { ...node, children: node.children.filter((_, index) => index !== removedIndex) };
  });
  return setFilter(config, next);
}

/** Aplica um patch a uma `FilterCondition` existente em `path` — nunca troca o `kind`, e limpar `value` (setando `undefined`) remove a chave em vez de gravar `undefined` explícito. */
export function updateConditionAt(
  config: ViewConfig,
  path: readonly number[],
  patch: Partial<Pick<FilterCondition, "propertyId" | "operator" | "value">>,
): ViewConfig {
  const next = replaceAtPath(config.filter, path, (node) => {
    if (node === null || node.kind !== "condition") return node;
    const updated: FilterCondition = { ...node };
    if (patch.propertyId !== undefined) updated.propertyId = patch.propertyId;
    if (patch.operator !== undefined) updated.operator = patch.operator;
    if ("value" in patch) {
      if (patch.value === undefined) delete updated.value;
      else updated.value = patch.value;
    }
    return updated;
  });
  return setFilter(config, next);
}

export function setGroupConnectiveAt(config: ViewConfig, path: readonly number[], connective: "and" | "or"): ViewConfig {
  const next = replaceAtPath(config.filter, path, (node) => {
    if (node === null || node.kind !== "group") return node;
    return { ...node, connective };
  });
  return setFilter(config, next);
}
