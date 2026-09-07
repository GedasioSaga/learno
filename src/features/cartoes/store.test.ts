import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeck,
  deckCounts,
  deleteDeck,
  listDecks,
  listNoteTypes,
  renameDeck,
  type DeckCounts,
  type DeckRow,
} from "../../lib/ipc";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listDecks: vi.fn(),
    deckCounts: vi.fn(),
    createDeck: vi.fn(),
    renameDeck: vi.fn(),
    deleteDeck: vi.fn(),
    listNoteTypes: vi.fn(),
  };
});

const listDecksMock = vi.mocked(listDecks);
const deckCountsMock = vi.mocked(deckCounts);
const createDeckMock = vi.mocked(createDeck);
const renameDeckMock = vi.mocked(renameDeck);
const deleteDeckMock = vi.mocked(deleteDeck);
const listNoteTypesMock = vi.mocked(listNoteTypes);

function deck(overrides: Partial<DeckRow> & Pick<DeckRow, "id">): DeckRow {
  return {
    parentId: null,
    name: "",
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function contagem(overrides: Partial<DeckCounts> = {}): DeckCounts {
  return { novos: 0, aprendendo: 0, revisar: 0, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCartoesStore.setState({
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
  });
  deckCountsMock.mockResolvedValue(contagem());
  listNoteTypesMock.mockResolvedValue([]);
});

describe("load", () => {
  it("carrega os baralhos, monta o índice de filhos e busca a contagem de cada um mais o total", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    const verbos = deck({ id: "verbos", parentId: "ingles", name: "Verbos" });
    listDecksMock.mockResolvedValue([ingles, verbos]);
    deckCountsMock.mockImplementation((id) =>
      Promise.resolve(id === "verbos" ? contagem({ novos: 5 }) : contagem({ novos: 1 })),
    );

    await useCartoesStore.getState().load();

    const state = useCartoesStore.getState();
    expect(state.status).toBe("ready");
    expect(state.decksById.get("verbos")?.name).toBe("Verbos");
    expect(state.childrenIndex.get("ingles")?.map((d) => d.id)).toEqual(["verbos"]);
    expect(state.contagens.get(null)).toEqual(contagem({ novos: 1 })); // primeira chamada (deckCounts(null))
    expect(state.contagens.get("verbos")).toEqual(contagem({ novos: 5 }));
    expect(deckCountsMock).toHaveBeenCalledWith(null);
    expect(deckCountsMock).toHaveBeenCalledWith("ingles");
    expect(deckCountsMock).toHaveBeenCalledWith("verbos");
  });

  it("chamada concorrente enquanto já está carregando não dispara uma segunda rodada de listDecks", async () => {
    listDecksMock.mockResolvedValue([]);

    const primeira = useCartoesStore.getState().load();
    const segunda = useCartoesStore.getState().load();
    await Promise.all([primeira, segunda]);

    expect(listDecksMock).toHaveBeenCalledTimes(1);
  });

  it("erro ao listar vira status 'error' com mensagem, sem tentar buscar contagens", async () => {
    listDecksMock.mockRejectedValue(new Error("rede caiu"));

    await useCartoesStore.getState().load();

    const state = useCartoesStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar os baralhos.");
    expect(deckCountsMock).not.toHaveBeenCalled();
  });
});

describe("createDeck", () => {
  it("adiciona o baralho ao índice, zera a contagem localmente (sem round-trip) e marca pendingFocusId", async () => {
    const novo = deck({ id: "novo", name: "Novo baralho" });
    createDeckMock.mockResolvedValue(novo);

    await useCartoesStore.getState().createDeck("Novo baralho", null);

    const state = useCartoesStore.getState();
    expect(state.decksById.get("novo")).toEqual(novo);
    expect(state.contagens.get("novo")).toEqual(contagem());
    expect(state.pendingFocusId).toBe("novo");
    expect(deckCountsMock).not.toHaveBeenCalled();
  });

  it("cria como filho e expande o pai automaticamente", async () => {
    const pai = deck({ id: "pai", name: "Pai" });
    useCartoesStore.setState({ decksById: new Map([["pai", pai]]) });
    const filho = deck({ id: "filho", parentId: "pai", name: "Filho" });
    createDeckMock.mockResolvedValue(filho);

    await useCartoesStore.getState().createDeck("Filho", "pai");

    expect(useCartoesStore.getState().expandedIds.has("pai")).toBe(true);
  });

  it("erro do backend vira errorMessage e a promise rejeita (quem chamou decide o que fazer)", async () => {
    createDeckMock.mockRejectedValue(new Error("nome inválido"));

    await expect(useCartoesStore.getState().createDeck("", null)).rejects.toThrow();
    expect(useCartoesStore.getState().errorMessage).toBe("Não foi possível criar o baralho.");
  });
});

describe("renameDeck", () => {
  it("substitui a linha do baralho pelo retorno do backend", async () => {
    const original = deck({ id: "a", name: "A" });
    useCartoesStore.setState({ decksById: new Map([["a", original]]) });
    renameDeckMock.mockResolvedValue(deck({ id: "a", name: "A renomeado" }));

    await useCartoesStore.getState().renameDeck("a", "A renomeado");

    expect(useCartoesStore.getState().decksById.get("a")?.name).toBe("A renomeado");
  });
});

describe("deleteDeck", () => {
  it("some do índice e, se era o selecionado, volta a seleção para 'Todos os baralhos' e a tela para resumo", async () => {
    const alvo = deck({ id: "alvo", name: "Alvo" });
    useCartoesStore.setState({
      decksById: new Map([["alvo", alvo]]),
      childrenIndex: new Map([[null, [alvo]]]),
      deckSelecionadoId: "alvo",
      tela: "estudo",
    });
    deleteDeckMock.mockResolvedValue(undefined);
    listDecksMock.mockResolvedValue([]);

    await useCartoesStore.getState().deleteDeck("alvo");

    const state = useCartoesStore.getState();
    expect(state.decksById.has("alvo")).toBe(false);
    expect(state.deckSelecionadoId).toBeNull();
    expect(state.tela).toBe("resumo");
  });

  it("baralho apagado que não era o selecionado não mexe na seleção atual", async () => {
    const outro = deck({ id: "outro", name: "Outro" });
    useCartoesStore.setState({ deckSelecionadoId: "mantido", tela: "criar" });
    deleteDeckMock.mockResolvedValue(undefined);
    listDecksMock.mockResolvedValue([outro]);

    await useCartoesStore.getState().deleteDeck("apagado");

    const state = useCartoesStore.getState();
    expect(state.deckSelecionadoId).toBe("mantido");
    expect(state.tela).toBe("criar");
  });

  it("erro ao apagar não recarrega a árvore nem mexe na seleção", async () => {
    useCartoesStore.setState({ deckSelecionadoId: "alvo" });
    deleteDeckMock.mockRejectedValue(new Error("tem subbaralho"));

    await expect(useCartoesStore.getState().deleteDeck("alvo")).rejects.toThrow();

    expect(listDecksMock).not.toHaveBeenCalled();
    expect(useCartoesStore.getState().deckSelecionadoId).toBe("alvo");
  });
});

describe("selectDeck", () => {
  it("tira o usuário de uma sessão de estudo, que pertence ao baralho anterior", () => {
    useCartoesStore.setState({ tela: "estudo" });

    useCartoesStore.getState().selectDeck("x");

    const state = useCartoesStore.getState();
    expect(state.deckSelecionadoId).toBe("x");
    expect(state.tela).toBe("resumo");
  });

  it("tira o usuário do formulário de criação pelo mesmo motivo", () => {
    useCartoesStore.setState({ tela: "criar" });

    useCartoesStore.getState().selectDeck("x");

    expect(useCartoesStore.getState().tela).toBe("resumo");
  });

  // Painel e Estatísticas recarregam sozinhas quando o baralho muda: são as
  // duas telas construídas justamente para responder a esta troca. Voltar
  // para o resumo expulsava o usuário da aba no instante em que ela ia
  // mostrar o que ele acabou de pedir.
  it.each(["painel", "estatisticas"] as const)("permanece na aba %s ao trocar de baralho", (tela) => {
    useCartoesStore.setState({ tela });

    useCartoesStore.getState().selectDeck("x");

    const state = useCartoesStore.getState();
    expect(state.deckSelecionadoId).toBe("x");
    expect(state.tela).toBe(tela);
  });
});
