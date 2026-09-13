import type { Categoria, CategoriasDoLivro, LivroNaEstante } from "../../lib/ipc";
import type { FiltroDeStatus } from "./store";

/**
 * Aplica o filtro do painel sobre a estante. Pura, sem estado — testável sem
 * montar a store, e é o que garante que "Lendo" filtra por `progresso.status`
 * e não por alguma outra ideia de "em andamento" inventada na tela.
 */
export function filtrarLivros(livros: readonly LivroNaEstante[], filtro: FiltroDeStatus): LivroNaEstante[] {
  if (filtro === "todos") return [...livros];
  return livros.filter((item) => item.progresso.status === filtro);
}

/** Quantos livros caem em cada filtro — alimenta os contadores do painel. */
export function contarPorStatus(livros: readonly LivroNaEstante[]): Record<FiltroDeStatus, number> {
  const contagem: Record<FiltroDeStatus, number> = { todos: livros.length, unread: 0, reading: 0, finished: 0 };
  for (const item of livros) {
    contagem[item.progresso.status] += 1;
  }
  return contagem;
}

/**
 * `listarCategoriasPorLivro()` devolve uma linha por livro (a forma "à prova
 * de N+1" que o backend escolheu, ver `biblioteca_categorias.rs`); a estante
 * e o `LivroCard` precisam de lookup por id, não de uma lista para varrer a
 * cada render — daí este índice.
 */
export function indexarCategoriasPorLivro(linhas: readonly CategoriasDoLivro[]): Map<string, Categoria[]> {
  const mapa = new Map<string, Categoria[]>();
  for (const linha of linhas) mapa.set(linha.livroId, linha.categorias);
  return mapa;
}

/**
 * `categoriaId: null` é "todas as categorias" — a estante inteira, sem
 * filtrar (mesma convenção de `filtrarLivros` com `"todos"`). Um livro sem
 * nenhuma categoria atribuída só some quando um `categoriaId` específico é
 * escolhido; ele nunca desaparece do "todas as categorias" só por não ter
 * categoria nenhuma.
 *
 * D1: filtrar por uma categoria-PAI mostra também os livros dos
 * descendentes — sem isto, "Fantasia" apareceria com zero livros tendo dez
 * guardados um nível abaixo em "Fantasia > Épico". `categorias` é a árvore
 * inteira (para achar os descendentes de `categoriaId`); parâmetro opcional
 * com padrão `[]` para não quebrar quem já chamava esta função só com
 * `categoriasPorLivro` — nesse caso o filtro cai de volta em "só a própria
 * categoria", sem descendentes.
 */
export function filtrarPorCategoria(
  livros: readonly LivroNaEstante[],
  categoriaId: string | null,
  categoriasPorLivro: ReadonlyMap<string, Categoria[]>,
  categorias: readonly Categoria[] = [],
): LivroNaEstante[] {
  if (categoriaId === null) return [...livros];
  const childrenIndex = buildCategoriaChildrenIndex(categorias);
  const alvo = new Set([categoriaId, ...getCategoriaDescendantIds(categoriaId, childrenIndex)]);
  return livros.filter((item) =>
    (categoriasPorLivro.get(item.livro.id) ?? []).some((categoria) => alvo.has(categoria.id)),
  );
}

// ---- Árvore de categorias -------------------------------------------------
//
// Mesmo raciocínio de `features/pages/tree-utils.ts` (lista plana com
// ponteiro para o pai virando árvore na tela) — reaproveitado aqui, não
// reinventado, só trocando `PageRow`/`parent_id` por `Categoria`/`parentId`.

/** Ordena por `position` com comparação simples de string — mesma convenção fracionária de `PageRow.position` em `tree-utils.ts`. */
function compareCategoriaPosition(a: Categoria, b: Categoria): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return 0;
}

/** Agrupa categorias por `parentId`, cada grupo já ordenado por posição. A chave `null` é a lista de categorias-raiz. */
export function buildCategoriaChildrenIndex(categorias: readonly Categoria[]): Map<string | null, Categoria[]> {
  const index = new Map<string | null, Categoria[]>();
  for (const categoria of categorias) {
    const key = categoria.parentId;
    const siblings = index.get(key);
    if (siblings) {
      siblings.push(categoria);
    } else {
      index.set(key, [categoria]);
    }
  }
  for (const siblings of index.values()) {
    siblings.sort(compareCategoriaPosition);
  }
  return index;
}

/** Todo id de descendente de `id` (não inclui `id`), via BFS no índice de filhos. */
export function getCategoriaDescendantIds(id: string, childrenIndex: Map<string | null, Categoria[]>): Set<string> {
  const descendants = new Set<string>();
  const queue = [...(childrenIndex.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    descendants.add(next.id);
    queue.push(...(childrenIndex.get(next.id) ?? []));
  }
  return descendants;
}

/**
 * `id` e todo descendente dele. Usado por `store.ts` para decidir se REMOVER
 * `id` também invalida um filtro que está numa categoria mais funda (D1 ao
 * contrário): se o filtro atual é `id` ou um descendente de `id`, ele fica
 * órfão quando `id` some, e o painel volta para "Todas as categorias".
 */
export function categoriaSelfAndDescendantIds(id: string, categorias: readonly Categoria[]): Set<string> {
  const childrenIndex = buildCategoriaChildrenIndex(categorias);
  return new Set([id, ...getCategoriaDescendantIds(id, childrenIndex)]);
}

/** Nó achatado para renderização indentada da árvore de categorias — mesma forma de `FlatPageNode` em `tree-utils.ts`. */
export interface CategoriaFlatNode {
  categoria: Categoria;
  depth: number;
  hasChildren: boolean;
}

/**
 * Só os nós visíveis dado o conjunto de ids recolhidos — recolher um pai
 * remove sua subárvore inteira da lista. `collapsedIds` vazio (o padrão que
 * a tela usa) mostra a árvore inteira expandida — chamar com um `Set` vazio
 * também serve para "flatten sem recolhimento nenhum" (usado por
 * `categoriaMoveTargets` abaixo, que precisa de toda a árvore).
 */
export function flattenVisibleCategoriaTree(
  childrenIndex: Map<string | null, Categoria[]>,
  collapsedIds: ReadonlySet<string>,
  parentId: string | null = null,
  depth = 0,
): CategoriaFlatNode[] {
  const nodes: CategoriaFlatNode[] = [];
  for (const categoria of childrenIndex.get(parentId) ?? []) {
    const children = childrenIndex.get(categoria.id) ?? [];
    nodes.push({ categoria, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && !collapsedIds.has(categoria.id)) {
      nodes.push(...flattenVisibleCategoriaTree(childrenIndex, collapsedIds, categoria.id, depth + 1));
    }
  }
  return nodes;
}

/**
 * Alvos válidos para `moverCategoria(categoriaId, ...)`: qualquer categoria
 * exceto a própria e qualquer descendente dela — mover para lá criaria um
 * ciclo. Mesmo raciocínio de `isValidDropTarget` em `features/pages/tree-utils.ts`;
 * o backend confirma de novo com `is_within_subtree` (`mover_categoria`), este
 * filtro aqui só evita oferecer uma opção que o backend recusaria.
 */
export function categoriaMoveTargets(categoriaId: string, categorias: readonly Categoria[]): CategoriaFlatNode[] {
  const childrenIndex = buildCategoriaChildrenIndex(categorias);
  const excluidos = new Set([categoriaId, ...getCategoriaDescendantIds(categoriaId, childrenIndex)]);
  return flattenVisibleCategoriaTree(childrenIndex, new Set()).filter((node) => !excluidos.has(node.categoria.id));
}

// ---- Agrupamento da estante por categoria/subcategoria --------------------

/** Um subgrupo dentro de uma categoria-raiz. `subcategoria: null` é o balde dos livros atribuídos DIRETO à raiz, sem nenhuma subcategoria. */
export interface SubgrupoDeLivros {
  subcategoria: Categoria | null;
  livros: LivroNaEstante[];
}

/** Uma categoria-raiz e os subgrupos dela — nunca um subgrupo vazio (ver `agruparEstantePorCategoria`). */
export interface GrupoDeCategoriaRaiz {
  raiz: Categoria;
  subgrupos: SubgrupoDeLivros[];
}

export interface EstanteAgrupada {
  grupos: GrupoDeCategoriaRaiz[];
  /** Livros sem NENHUMA categoria atribuída — nunca somem, viram sua própria seção. */
  semCategoria: LivroNaEstante[];
}

/** `id` e a cadeia de ancestrais dele até a raiz, nessa ordem: `[id, pai, avô, ..., raiz]`. Guarda contra ciclo (não deveria existir, mas `getCategoriaDescendantIds`/`ancestraisDe` já se protegem do mesmo jeito). */
function ancestorChainIncludingSelf(id: string, parentById: ReadonlyMap<string, string | null>): string[] {
  const chain = [id];
  let atual = parentById.get(id) ?? null;
  while (atual !== null && !chain.includes(atual)) {
    chain.push(atual);
    atual = parentById.get(atual) ?? null;
  }
  return chain;
}

/**
 * Agrupa a estante (já filtrada por status/categoria em `ConteudoDeBiblioteca`)
 * em categoria-raiz > subcategoria, respondendo as quatro perguntas do pedido:
 *
 * 1. Livro em DUAS categorias aparece em CADA balde que essas categorias
 *    mapeiam — nunca só na primeira. Esconder uma das atribuições mentiria
 *    sobre o que o usuário marcou no livro; duplicar o cartão é o preço, e é
 *    aceitável porque cada aparição está num contexto diferente (categoria
 *    diferente). `baldesDesteLivro` só evita duplicar dentro do MESMO balde.
 * 2. Livro SEM NENHUMA categoria vai para `semCategoria` — nunca some.
 * 3. Livro atribuído tanto ao PAI (a raiz) quanto a um FILHO dela mapeia para
 *    dois baldes DIFERENTES (`raiz::_` e `raiz::filhoId`) e por isso aparece
 *    nos dois grupos — mesmo mecanismo do item 1, é só um caso particular.
 * 4. Profundidade: só DOIS níveis de cabeçalho (raiz + subcategoria), mesmo
 *    que a árvore vá mais fundo — uma categoria de neto (ou mais funda) cai
 *    no balde do seu ancestral de profundidade 1. Cabeçalho por nível de uma
 *    árvore de 15 categorias com netos e bisnetos era o que a tarefa avisou
 *    para NÃO fazer ("cabeçalho que ocupa muito espaço vertical mata a
 *    grade") — dois níveis já entrega "separa por categoria e dentro da
 *    categoria por subcategoria", que foi o pedido literal.
 *
 * Grupo/subgrupo vazio nunca entra no resultado (filtrado ao montar).
 */
export function agruparEstantePorCategoria(
  livros: readonly LivroNaEstante[],
  categorias: readonly Categoria[],
  categoriasPorLivro: ReadonlyMap<string, Categoria[]>,
): EstanteAgrupada {
  const childrenIndex = buildCategoriaChildrenIndex(categorias);
  const parentById = new Map(categorias.map((categoria) => [categoria.id, categoria.parentId]));
  const raizes = childrenIndex.get(null) ?? [];

  const baldes = new Map<string, Map<string, LivroNaEstante>>();
  const semCategoria: LivroNaEstante[] = [];

  for (const item of livros) {
    const categoriasDoLivro = categoriasPorLivro.get(item.livro.id) ?? [];
    if (categoriasDoLivro.length === 0) {
      semCategoria.push(item);
      continue;
    }
    const baldesDesteLivro = new Set<string>();
    for (const categoriaDoLivro of categoriasDoLivro) {
      const cadeia = ancestorChainIncludingSelf(categoriaDoLivro.id, parentById);
      const raizId = cadeia[cadeia.length - 1];
      // Profundidade 1 = filho direto da raiz. Quando a categoria atribuída
      // É a própria raiz, `cadeia.length` é 1 e não há subcategoria.
      const subcategoriaId = cadeia.length >= 2 ? cadeia[cadeia.length - 2] : null;
      const chave = `${raizId}::${subcategoriaId ?? "_"}`;
      if (baldesDesteLivro.has(chave)) continue;
      baldesDesteLivro.add(chave);
      let balde = baldes.get(chave);
      if (!balde) {
        balde = new Map();
        baldes.set(chave, balde);
      }
      // `Map` preserva ordem de inserção, e `livros` já chega ordenado por
      // `position` (o backend ordena `list_shelf` assim) — cada balde nasce
      // na ordem certa sem precisar reordenar aqui.
      balde.set(item.livro.id, item);
    }
  }

  const grupos: GrupoDeCategoriaRaiz[] = [];
  for (const raiz of raizes) {
    const subgrupos: SubgrupoDeLivros[] = [];
    const semSubcategoria = baldes.get(`${raiz.id}::_`);
    if (semSubcategoria && semSubcategoria.size > 0) {
      subgrupos.push({ subcategoria: null, livros: [...semSubcategoria.values()] });
    }
    for (const filha of childrenIndex.get(raiz.id) ?? []) {
      const balde = baldes.get(`${raiz.id}::${filha.id}`);
      if (balde && balde.size > 0) {
        subgrupos.push({ subcategoria: filha, livros: [...balde.values()] });
      }
    }
    if (subgrupos.length > 0) grupos.push({ raiz, subgrupos });
  }

  return { grupos, semCategoria };
}
