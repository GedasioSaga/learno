import type { DeckRow } from "../../lib/ipc";

/**
 * Ordena por `position` com comparação simples de string (`<`/`>`), não
 * `localeCompare` — mesma razão do `tree-utils.ts` de `features/pages`: o
 * backend grava um índice fracionário cuja ordem lexicográfica em bytes já É
 * a ordem real dos irmãos.
 */
function comparePosition(a: DeckRow, b: DeckRow): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return 0;
}

/**
 * Agrupa baralhos por `parentId`, cada grupo já ordenado por posição. A
 * chave `null` é a lista de baralhos raiz.
 */
export function buildChildrenIndex(decks: DeckRow[]): Map<string | null, DeckRow[]> {
  const index = new Map<string | null, DeckRow[]>();
  for (const deck of decks) {
    const key = deck.parentId;
    const siblings = index.get(key);
    if (siblings) {
      siblings.push(deck);
    } else {
      index.set(key, [deck]);
    }
  }
  for (const siblings of index.values()) {
    siblings.sort(comparePosition);
  }
  return index;
}

/** Nó achatado para renderização indentada da árvore de baralhos. */
export interface FlatDeckNode {
  deck: DeckRow;
  depth: number;
  hasChildren: boolean;
}

/**
 * Só os nós visíveis dado o conjunto de ids expandidos — colapsar um pai
 * remove sua subárvore da lista, o que é o que o painel de baralhos desenha.
 */
export function flattenVisibleTree(
  childrenIndex: Map<string | null, DeckRow[]>,
  expandedIds: ReadonlySet<string>,
  rootId: string | null = null,
  depth = 0,
): FlatDeckNode[] {
  const nodes: FlatDeckNode[] = [];
  for (const deck of childrenIndex.get(rootId) ?? []) {
    const children = childrenIndex.get(deck.id) ?? [];
    nodes.push({ deck, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && expandedIds.has(deck.id)) {
      nodes.push(...flattenVisibleTree(childrenIndex, expandedIds, deck.id, depth + 1));
    }
  }
  return nodes;
}

/**
 * Toda a árvore, achatada, sem depender de `expandedIds` — usado pelo
 * `<select>` de baralho da tela "Criar cartão", que precisa listar todo
 * mundo, recolhido ou não na árvore do painel.
 */
export function flattenAllDecks(
  childrenIndex: Map<string | null, DeckRow[]>,
  rootId: string | null = null,
  depth = 0,
): FlatDeckNode[] {
  const nodes: FlatDeckNode[] = [];
  for (const deck of childrenIndex.get(rootId) ?? []) {
    nodes.push({ deck, depth, hasChildren: (childrenIndex.get(deck.id)?.length ?? 0) > 0 });
    nodes.push(...flattenAllDecks(childrenIndex, deck.id, depth + 1));
  }
  return nodes;
}

/** Rótulo de exibição de um baralho sem nome — nunca um item em branco na árvore. */
export function displayDeckName(deck: Pick<DeckRow, "name">): string {
  return deck.name.trim() === "" ? "Sem nome" : deck.name;
}
