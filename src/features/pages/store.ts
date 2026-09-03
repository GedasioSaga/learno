import { create } from "zustand";
import {
  AppError,
  createPage,
  duplicatePage,
  listPageTree,
  movePage,
  renamePage,
  setPageFavorite,
  setPageIcon,
  trashPage,
  type PageRow,
  type SiblingPosition,
} from "../../lib/ipc";
import { buildChildrenIndex } from "./tree-utils";

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface PageTreeState {
  status: LoadStatus;
  errorMessage: string | null;
  pagesById: Map<string, PageRow>;
  childrenIndex: Map<string | null, PageRow[]>;
  expandedIds: Set<string>;
  selectedPageId: string | null;
  /**
   * FUN-002: id da página que acabou de nascer pelo `+`/"Nova página" e
   * ainda precisa entrar em modo de edição de título assim que sua linha
   * for renderizada. `PageTreeItem` consome (limpa) isto num efeito — não é
   * estado de UI permanente, só a ponte de um frame entre "página criada" e
   * "linha montada" que o próprio `createChild` não consegue atravessar
   * sozinho (a linha nova não existe ainda no DOM quando ele resolve).
   */
  pendingFocusId: string | null;

  load: () => Promise<void>;
  selectPage: (id: string | null) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  toggleExpanded: (id: string) => void;
  createChild: (parentId: string | null, title?: string) => Promise<PageRow>;
  consumePendingFocus: (id: string) => void;
  rename: (id: string, title: string) => Promise<void>;
  setFavorite: (id: string, isFavorite: boolean) => Promise<void>;
  setIcon: (id: string, icon: string | null) => Promise<void>;
  move: (id: string, newParentId: string | null, target: SiblingPosition) => Promise<void>;
  duplicate: (id: string) => Promise<PageRow>;
  trash: (id: string) => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Sobe a cadeia de pais de `id` (excluindo `id`) e devolve o conjunto — usado
 * para expandir cada ancestral quando uma página nasce ou é selecionada por
 * fora da árvore (breadcrumb), senão ela ficaria selecionada mas escondida
 * atrás de um pai colapsado.
 */
function ancestorChainOf(id: string, pagesById: Map<string, PageRow>): string[] {
  const chain: string[] = [];
  let current = pagesById.get(id)?.parent_id ?? null;
  while (current !== null) {
    chain.push(current);
    current = pagesById.get(current)?.parent_id ?? null;
  }
  return chain;
}

export const usePageTreeStore = create<PageTreeState>((set, get) => {
  /**
   * Toda mutação de uma página só (renomear, favoritar, ícone, mover) volta
   * a mesma forma do backend: a `PageRow` já atualizada. Isto é o que todas
   * elas fazem com ela — atualizar o mapa e recalcular o índice de filhos,
   * que é barato para o tamanho de árvore que uma página de estudo tem.
   */
  function patchPage(row: PageRow): void {
    const pagesById = new Map(get().pagesById).set(row.id, row);
    set({ pagesById, childrenIndex: buildChildrenIndex([...pagesById.values()]), errorMessage: null });
  }

  return {
    status: "idle",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
    pendingFocusId: null,

    load: async () => {
      set({ status: "loading", errorMessage: null });
      try {
        const rows = await listPageTree();
        // `as const` (não um cast de tipo — só fixa a tupla `[string, PageRow]`
        // em vez de deixar TS alargar para `(string | PageRow)[]`) é o que
        // permite ao `new Map` abaixo inferir as chaves e valores corretos.
        const pagesById = new Map(rows.map((row) => [row.id, row] as const));
        set({ status: "ready", pagesById, childrenIndex: buildChildrenIndex(rows) });
      } catch (error) {
        set({ status: "error", errorMessage: messageFor(error, "Não foi possível carregar as páginas.") });
      }
    },

    selectPage: (id) => {
      if (id === null) {
        set({ selectedPageId: null });
        return;
      }
      const { pagesById, expandedIds } = get();
      const nextExpanded = new Set(expandedIds);
      for (const ancestorId of ancestorChainOf(id, pagesById)) {
        nextExpanded.add(ancestorId);
      }
      set({ selectedPageId: id, expandedIds: nextExpanded });
    },

    expand: (id) => {
      set((state) => ({ expandedIds: new Set(state.expandedIds).add(id) }));
    },

    collapse: (id) => {
      set((state) => {
        const next = new Set(state.expandedIds);
        next.delete(id);
        return { expandedIds: next };
      });
    },

    toggleExpanded: (id) => {
      if (get().expandedIds.has(id)) {
        get().collapse(id);
      } else {
        get().expand(id);
      }
    },

    createChild: async (parentId, title) => {
      try {
        const row = await createPage(parentId, title);
        set((state) => {
          const pagesById = new Map(state.pagesById).set(row.id, row);
          return {
            pagesById,
            childrenIndex: buildChildrenIndex([...pagesById.values()]),
            expandedIds: parentId ? new Set(state.expandedIds).add(parentId) : state.expandedIds,
            selectedPageId: row.id,
            // FUN-002: "nasce com foco no título" — a linha ainda não está
            // montada aqui, então só marcamos a intenção; `PageTreeItem`
            // entra em modo de edição sozinho quando vir seu próprio id.
            pendingFocusId: row.id,
            errorMessage: null,
          };
        });
        return row;
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível criar a página.") });
        throw error;
      }
    },

    consumePendingFocus: (id) => {
      if (get().pendingFocusId === id) {
        set({ pendingFocusId: null });
      }
    },

    rename: async (id, title) => {
      try {
        const row = await renamePage(id, title);
        patchPage(row);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível renomear a página.") });
        throw error;
      }
    },

    setFavorite: async (id, isFavorite) => {
      try {
        const row = await setPageFavorite(id, isFavorite);
        patchPage(row);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível favoritar a página.") });
        throw error;
      }
    },

    setIcon: async (id, icon) => {
      try {
        const row = await setPageIcon(id, icon);
        patchPage(row);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível trocar o ícone.") });
        throw error;
      }
    },

    move: async (id, newParentId, target) => {
      try {
        const row = await movePage(id, newParentId, target);
        patchPage(row);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível mover a página.") });
        throw error;
      }
    },

    duplicate: async (id) => {
      try {
        const newRoot = await duplicatePage(id);
        // FUN-020 duplica a subárvore inteira no banco, mas o comando só
        // devolve a nova raiz (ver comentário em `ipc::commands::duplicate_page`)
        // — recarregar é o jeito simples de trazer as novas filhas também, e
        // duplicar não é uma ação de alta frequência que precise de melhor.
        await get().load();
        get().selectPage(newRoot.id);
        return newRoot;
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível duplicar a página.") });
        throw error;
      }
    },

    trash: async (id) => {
      try {
        await trashPage(id);
        // FUN-027 pode tornar invisíveis mais do que só `id` (uma página
        // cujo pai acabou de ir para a lixeira some da árvore ativa junto,
        // mesmo com seu próprio `deleted_at` continuando nulo — ver
        // `PageRepository::list_tree`) — recarregar do backend é o que
        // reflete isso corretamente, em vez de só remover uma entrada daqui.
        await get().load();
        if (get().selectedPageId === id) {
          get().selectPage(null);
        }
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível mover a página para a lixeira.") });
        throw error;
      }
    },
  };
});
