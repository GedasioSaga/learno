import { create } from "zustand";
import {
  AppError,
  createDeck as ipcCreateDeck,
  deckCounts,
  deleteDeck as ipcDeleteDeck,
  listDecks,
  listNoteTypes,
  renameDeck as ipcRenameDeck,
  type DeckCounts,
  type DeckRow,
  type NoteTypeRow,
} from "../../lib/ipc";
import { buildChildrenIndex } from "./tree-utils";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/**
 * A tela ativa dentro da seção Cartões — decide o que `ConteudoDeCartoes`
 * desenha. `"painel"` e `"estatisticas"` são as duas abas novas (previsão de
 * vencimentos e histórico de estudo); `"estudo"` não é aba — só é alcançada
 * a partir do botão Estudar em `"resumo"`, nunca aparece em `AbasDeCartoes`,
 * e ao sair sempre volta para `"resumo"` (o único ponto de entrada dela).
 * `"opcoes"` (agendador e configuração de estudo de UM baralho) também não
 * é aba: chega-se por "Opções do baralho" no resumo ou pela engrenagem da
 * linha na árvore, a barra de abas continua visível com "Baralhos" acesa, e
 * Voltar devolve a `"resumo"`.
 */
export type TelaDeCartoes = "resumo" | "estudo" | "criar" | "painel" | "estatisticas" | "opcoes";

interface CartoesState {
  status: LoadStatus;
  errorMessage: string | null;
  decksById: Map<string, DeckRow>;
  childrenIndex: Map<string | null, DeckRow[]>;
  expandedIds: Set<string>;
  /** `null` é "Todos os baralhos" — a coleção inteira, não um baralho real. */
  deckSelecionadoId: string | null;
  /** Contagens por baralho; a chave `null` guarda a coleção inteira. */
  contagens: Map<string | null, DeckCounts>;
  noteTypes: NoteTypeRow[];
  noteTypesStatus: LoadStatus;
  tela: TelaDeCartoes;
  /**
   * Id do baralho recém-criado pelo "+"/"Novo baralho" que ainda precisa
   * entrar em modo de edição de nome assim que sua linha for renderizada.
   * Mesmo padrão de `pendingFocusId` em `features/pages/store.ts`:
   * `DeckTreeRow` consome (limpa) isto num efeito.
   */
  pendingFocusId: string | null;

  load: () => Promise<void>;
  loadNoteTypes: () => Promise<void>;
  selectDeck: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  irPara: (tela: TelaDeCartoes) => void;
  createDeck: (name: string, parentId: string | null) => Promise<DeckRow>;
  renameDeck: (id: string, name: string) => Promise<void>;
  deleteDeck: (id: string) => Promise<void>;
  consumePendingFocus: (id: string) => void;
  refreshAllCounts: () => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Busca a contagem da coleção inteira (`null`) e de cada baralho em paralelo.
 * `deckCounts` é por-baralho (o contrato não tem um "contagens de todo mundo
 * de uma vez"); para o tamanho de árvore de baralhos de um app de estudo
 * pessoal isto é uma rodada de chamadas pequena, não um problema de escala.
 */
async function fetchAllCounts(deckIds: readonly string[]): Promise<Map<string | null, DeckCounts>> {
  const entradas = await Promise.all([
    deckCounts(null).then((counts) => [null, counts] as const),
    ...deckIds.map((id) => deckCounts(id).then((counts) => [id, counts] as const)),
  ]);
  return new Map(entradas);
}

export const useCartoesStore = create<CartoesState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  decksById: new Map(),
  childrenIndex: new Map(),
  expandedIds: new Set(),
  deckSelecionadoId: null,
  contagens: new Map(),
  noteTypes: [],
  noteTypesStatus: "idle",
  tela: "resumo",
  pendingFocusId: null,

  load: async () => {
    // Painel e Conteúdo montam juntos e os dois chamam `load()` ao subir;
    // esta guarda evita duas rodadas de `listDecks`/`deckCounts` disparando
    // ao mesmo tempo — sem ela, o segundo round-trip pisaria no primeiro.
    if (get().status === "loading") return;
    set({ status: "loading", errorMessage: null });
    try {
      const rows = await listDecks();
      const decksById = new Map(rows.map((row) => [row.id, row] as const));
      set({ status: "ready", decksById, childrenIndex: buildChildrenIndex(rows) });
    } catch (error) {
      set({ status: "error", errorMessage: messageFor(error, "Não foi possível carregar os baralhos.") });
      return;
    }
    await get().refreshAllCounts();
  },

  loadNoteTypes: async () => {
    if (get().noteTypesStatus === "loading" || get().noteTypesStatus === "ready") return;
    set({ noteTypesStatus: "loading" });
    try {
      const noteTypes = await listNoteTypes();
      set({ noteTypes, noteTypesStatus: "ready" });
    } catch (error) {
      set({ noteTypesStatus: "error", errorMessage: messageFor(error, "Não foi possível carregar os tipos de nota.") });
    }
  },

  selectDeck: (id) => {
    // Trocar de baralho tira o usuário de uma sessão de estudo ou de um
    // formulário de criação: os dois pertencem ao baralho anterior e não
    // fazem sentido depois da troca.
    //
    // Painel e Estatísticas são o oposto — foram feitas justamente para
    // responder à troca de baralho, e as duas recarregam sozinhas quando
    // `deckSelecionadoId` muda. Voltar para o resumo aqui expulsava o
    // usuário da aba que ele estava lendo no exato momento em que ela ia
    // mostrar o que ele pediu.
    const telaAtual = get().tela;
    const permaneceNaAba = telaAtual === "painel" || telaAtual === "estatisticas";
    set({ deckSelecionadoId: id, tela: permaneceNaAba ? telaAtual : "resumo" });
  },

  toggleExpanded: (id) => {
    set((state) => {
      const next = new Set(state.expandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedIds: next };
    });
  },

  irPara: (tela) => set({ tela }),

  createDeck: async (name, parentId) => {
    try {
      const row = await ipcCreateDeck(name, parentId);
      set((state) => {
        const decksById = new Map(state.decksById).set(row.id, row);
        const contagens = new Map(state.contagens).set(row.id, { novos: 0, aprendendo: 0, revisar: 0 });
        return {
          decksById,
          childrenIndex: buildChildrenIndex([...decksById.values()]),
          expandedIds: parentId ? new Set(state.expandedIds).add(parentId) : state.expandedIds,
          contagens,
          pendingFocusId: row.id,
          errorMessage: null,
        };
      });
      return row;
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível criar o baralho.") });
      throw error;
    }
  },

  renameDeck: async (id, name) => {
    try {
      const row = await ipcRenameDeck(id, name);
      set((state) => {
        const decksById = new Map(state.decksById).set(id, row);
        return { decksById, childrenIndex: buildChildrenIndex([...decksById.values()]), errorMessage: null };
      });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível renomear o baralho.") });
      throw error;
    }
  },

  deleteDeck: async (id) => {
    try {
      await ipcDeleteDeck(id);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível apagar o baralho.") });
      throw error;
    }
    if (get().deckSelecionadoId === id) {
      set({ deckSelecionadoId: null, tela: "resumo" });
    }
    // Apagar pode levar subárvore junto (decisão do backend, fora do nosso
    // alcance) — recarregar do zero é o que reflete isso corretamente, em
    // vez de só remover uma entrada local daqui (mesmo padrão de `trash` em
    // `features/pages/store.ts`).
    await get().load();
  },

  consumePendingFocus: (id) => {
    if (get().pendingFocusId === id) {
      set({ pendingFocusId: null });
    }
  },

  refreshAllCounts: async () => {
    try {
      const contagens = await fetchAllCounts([...get().decksById.keys()]);
      set({ contagens });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível carregar as contagens dos baralhos.") });
    }
  },
}));
