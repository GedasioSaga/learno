import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDeck, deckCounts, deleteDeck, listDecks, renameDeck, type DeckRow } from "../../lib/ipc";
import { PainelDeCartoes } from "./DeckTree";
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
  };
});

const listDecksMock = vi.mocked(listDecks);
const deckCountsMock = vi.mocked(deckCounts);
const createDeckMock = vi.mocked(createDeck);
const renameDeckMock = vi.mocked(renameDeck);
const deleteDeckMock = vi.mocked(deleteDeck);

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
    pendingFocusId: null,
  });
  deckCountsMock.mockResolvedValue({ novos: 0, aprendendo: 0, revisar: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PainelDeCartoes", () => {
  it("mostra 'Todos os baralhos' e cada baralho com seus três contadores", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    listDecksMock.mockResolvedValue([ingles]);
    deckCountsMock.mockImplementation((id) =>
      Promise.resolve(id === "ingles" ? { novos: 3, aprendendo: 1, revisar: 2 } : { novos: 3, aprendendo: 1, revisar: 2 }),
    );

    render(<PainelDeCartoes />);

    expect(await screen.findByText("Inglês")).toBeInTheDocument();
    expect(screen.getByText("Todos os baralhos")).toBeInTheDocument();
    expect(screen.getAllByLabelText("3 novos").length).toBeGreaterThan(0);
  });

  it("clicar num baralho seleciona ele na store", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    listDecksMock.mockResolvedValue([ingles]);

    render(<PainelDeCartoes />);
    fireEvent.click(await screen.findByText("Inglês"));

    expect(useCartoesStore.getState().deckSelecionadoId).toBe("ingles");
  });

  it("'Novo baralho' chama createDeck e a linha nasce em modo de edição de nome", async () => {
    listDecksMock.mockResolvedValue([]);
    createDeckMock.mockResolvedValue(deck({ id: "novo", name: "Novo baralho" }));
    render(<PainelDeCartoes />);
    await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Novo baralho/ }));

    expect(await screen.findByRole("textbox", { name: "Nome do baralho Novo baralho" })).toBeInTheDocument();
    expect(createDeckMock).toHaveBeenCalledWith("Novo baralho", null);
  });

  it("renomear: duplo clique entra em edição, Enter confirma e chama renameDeck", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    listDecksMock.mockResolvedValue([ingles]);
    renameDeckMock.mockResolvedValue(deck({ id: "ingles", name: "English" }));
    render(<PainelDeCartoes />);
    const linha = await screen.findByText("Inglês");

    fireEvent.doubleClick(linha);
    const input = screen.getByRole("textbox", { name: "Nome do baralho Inglês" });
    fireEvent.change(input, { target: { value: "English" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameDeckMock).toHaveBeenCalledWith("ingles", "English"));
  });

  it("apagar pede confirmação e só chama deleteDeck se confirmado", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    listDecksMock.mockResolvedValue([ingles]);
    deleteDeckMock.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PainelDeCartoes />);
    await screen.findByText("Inglês");

    fireEvent.click(screen.getByRole("button", { name: "Apagar Inglês" }));

    await waitFor(() => expect(deleteDeckMock).toHaveBeenCalledWith("ingles"));
  });

  it("cancelar a confirmação não chama deleteDeck", async () => {
    const ingles = deck({ id: "ingles", name: "Inglês" });
    listDecksMock.mockResolvedValue([ingles]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PainelDeCartoes />);
    await screen.findByText("Inglês");

    fireEvent.click(screen.getByRole("button", { name: "Apagar Inglês" }));

    expect(deleteDeckMock).not.toHaveBeenCalled();
  });
});
