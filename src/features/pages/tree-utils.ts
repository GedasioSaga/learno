import type { PageRow, SiblingPosition } from "../../lib/ipc";

/**
 * Ordena por `position` com comparação simples de string (`<`/`>`), não
 * `localeCompare` — o backend grava um índice fracionário (`fractional_index`
 * em Rust) cuja ordem lexicográfica em bytes é a ordem real dos irmãos; uma
 * comparação sensível a localidade poderia divergir dela para certos locales.
 */
function comparePosition(a: PageRow, b: PageRow): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return 0;
}

/**
 * Agrupa páginas ativas por `parent_id`, cada grupo já ordenado por posição.
 * A chave `null` é a lista de páginas raiz.
 */
export function buildChildrenIndex(pages: PageRow[]): Map<string | null, PageRow[]> {
  const index = new Map<string | null, PageRow[]>();
  for (const page of pages) {
    const key = page.parent_id;
    const siblings = index.get(key);
    if (siblings) {
      siblings.push(page);
    } else {
      index.set(key, [page]);
    }
  }
  for (const siblings of index.values()) {
    siblings.sort(comparePosition);
  }
  return index;
}

/** Todo id de descendente de `id` (não inclui `id`), via BFS no índice de filhos. */
export function getDescendantIds(id: string, childrenIndex: Map<string | null, PageRow[]>): Set<string> {
  const descendants = new Set<string>();
  const queue = [...(childrenIndex.get(id) ?? [])];
  while (queue.length > 0) {
    // `shift()` sobre um array pequeno (profundidade real de uma árvore de
    // páginas de estudo) é mais simples que uma fila com ponteiro — não vale
    // a complexidade extra para o tamanho que isto de fato assume.
    const next = queue.shift();
    if (!next) continue;
    descendants.add(next.id);
    queue.push(...(childrenIndex.get(next.id) ?? []));
  }
  return descendants;
}

/**
 * FUN-005/FUN-006/FUN-022: um alvo de destino é inválido quando é a própria
 * página arrastada ou um descendente dela — mover para lá criaria um ciclo.
 * Espelha a mesma regra que `PageRepository::is_within_subtree` aplica no
 * backend; isto existe para desabilitar o alvo na UI *antes* de tentar (o
 * backend continua sendo a fonte de verdade, caso a árvore em memória esteja
 * desatualizada).
 */
export function isValidDropTarget(
  draggedId: string,
  candidateParentId: string | null,
  childrenIndex: Map<string | null, PageRow[]>,
): boolean {
  if (candidateParentId === null) return true;
  if (candidateParentId === draggedId) return false;
  return !getDescendantIds(draggedId, childrenIndex).has(candidateParentId);
}

/**
 * FUN-004/FUN-005/FUN-006/FUN-022: dado a lista (já ordenada, sem a página
 * sendo movida) dos futuros irmãos ativos no destino, calcula o
 * `SiblingPosition` que pousa a página imediatamente antes ou depois de
 * `siblingId` — o mesmo par (irmão-âncora, lado) que
 * `PageRepository::neighbours_for` espera do lado do backend, só que decidido
 * aqui a partir de onde o usuário soltou/moveu, não de um índice numérico.
 */
export function dropPositionRelativeToSibling(
  siblings: readonly PageRow[],
  siblingId: string,
  edge: "before" | "after",
): SiblingPosition {
  const index = siblings.findIndex((page) => page.id === siblingId);
  if (index === -1) {
    throw new Error(`"${siblingId}" não está entre os irmãos ativos do destino`);
  }

  if (edge === "after") {
    return { type: "after", value: siblingId };
  }

  const previous = siblings[index - 1];
  return previous ? { type: "after", value: previous.id } : { type: "start" };
}

/** Nó achatado para navegação por teclado e renderização indentada da árvore. */
export interface FlatPageNode {
  page: PageRow;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * Só os nós visíveis dado o conjunto de ids expandidos — colapsar um pai
 * remove sua subárvore inteira da lista sem que o resto do código precise
 * saber disso, o que é o que a navegação de setas e o roving tabindex leem.
 */
export function flattenVisibleTree(
  childrenIndex: Map<string | null, PageRow[]>,
  expandedIds: ReadonlySet<string>,
  rootId: string | null = null,
  depth = 0,
): FlatPageNode[] {
  const nodes: FlatPageNode[] = [];
  for (const page of childrenIndex.get(rootId) ?? []) {
    const children = childrenIndex.get(page.id) ?? [];
    nodes.push({ page, depth, parentId: rootId, hasChildren: children.length > 0 });
    if (children.length > 0 && expandedIds.has(page.id)) {
      nodes.push(...flattenVisibleTree(childrenIndex, expandedIds, page.id, depth + 1));
    }
  }
  return nodes;
}

/**
 * FUN-022: filtro por título do diálogo "Mover para" — exclui a própria
 * página e toda a sua subárvore (reparentear ali seria o ciclo que
 * `isValidDropTarget` também rejeita) e não lista páginas cujo pai já é
 * `currentParentId` no caso trivial de arrastar para o mesmo lugar. Vazio
 * (`query`) lista tudo que é elegível, para o diálogo abrir já povoado.
 */
export function searchMoveTargets(
  pages: PageRow[],
  query: string,
  movingPageId: string,
  childrenIndex: Map<string | null, PageRow[]>,
): PageRow[] {
  const excluded = getDescendantIds(movingPageId, childrenIndex);
  excluded.add(movingPageId);
  const normalizedQuery = query.trim().toLowerCase();

  return pages
    .filter((page) => !excluded.has(page.id))
    .filter((page) => normalizedQuery === "" || page.title.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
}

/** Rótulo de exibição de uma página sem título — nunca um `<h2>` vazio na árvore/breadcrumb. */
export function displayTitle(page: Pick<PageRow, "title">): string {
  return page.title.trim() === "" ? "Sem título" : page.title;
}

export type KeyboardMoveAction = "reorder-up" | "reorder-down" | "nest" | "unnest";

export interface KeyboardMoveResult {
  newParentId: string | null;
  target: SiblingPosition;
}

/**
 * Equivalente de teclado de FUN-004/005/006 (Alt+seta, ver `PageTree`): a
 * mesma chamada `move(id, newParentId, target)` que o drop do mouse produz,
 * só que decidida a partir da posição atual de `id` entre seus irmãos, não de
 * onde o cursor soltou algo. `null` significa "não há para onde mover" (já é
 * o primeiro/último irmão, não há irmão anterior para aninhar, ou já é raiz)
 * — o chamador simplesmente não invoca `move` nesse caso, sem precisar de
 * outra checagem antes de decidir isso.
 */
export function computeKeyboardMove(
  action: KeyboardMoveAction,
  id: string,
  pagesById: Map<string, PageRow>,
  childrenIndex: Map<string | null, PageRow[]>,
): KeyboardMoveResult | null {
  const page = pagesById.get(id);
  if (!page) return null;

  const parentId = page.parent_id;
  const siblings = childrenIndex.get(parentId) ?? [];
  const index = siblings.findIndex((sibling) => sibling.id === id);
  const siblingsWithoutSelf = siblings.filter((sibling) => sibling.id !== id);

  if (action === "reorder-up") {
    const previous = siblings[index - 1];
    if (!previous) return null;
    return { newParentId: parentId, target: dropPositionRelativeToSibling(siblingsWithoutSelf, previous.id, "before") };
  }

  if (action === "reorder-down") {
    const next = siblings[index + 1];
    if (!next) return null;
    return { newParentId: parentId, target: dropPositionRelativeToSibling(siblingsWithoutSelf, next.id, "after") };
  }

  if (action === "nest") {
    const previous = siblings[index - 1];
    if (!previous || !isValidDropTarget(id, previous.id, childrenIndex)) return null;
    return { newParentId: previous.id, target: { type: "end" } };
  }

  // "unnest": sobe para o nível do avô, como o irmão logo depois do pai atual.
  if (parentId === null) return null;
  const grandParentId = pagesById.get(parentId)?.parent_id ?? null;
  const grandSiblings = childrenIndex.get(grandParentId) ?? [];
  return { newParentId: grandParentId, target: dropPositionRelativeToSibling(grandSiblings, parentId, "after") };
}
