import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { deckForecast } from "../../lib/ipc";
import { PainelDePrevisao } from "./PainelDePrevisao";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    deckForecast: vi.fn(),
  };
});

const deckForecastMock = vi.mocked(deckForecast);

beforeEach(() => {
  vi.clearAllMocks();
  useCartoesStore.setState({ deckSelecionadoId: "ingles", tela: "painel" });
});

describe("PainelDePrevisao", () => {
  it("busca a previsão de 30 dias do baralho selecionado e mostra o total em texto visível", async () => {
    deckForecastMock.mockResolvedValue([
      { data: "2026-09-06", quantidade: 5 },
      { data: "2026-09-07", quantidade: 3 },
    ]);

    render(<PainelDePrevisao />);

    expect(await screen.findByText("8 cartões nos próximos 30 dias")).toBeInTheDocument();
    expect(deckForecastMock).toHaveBeenCalledWith("ingles", 30);
    // A contagem de cada dia já está em texto na barra, não só numa dica de hover.
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("nada vencendo mostra estado vazio honesto, não uma tela em branco", async () => {
    deckForecastMock.mockResolvedValue([{ data: "2026-09-06", quantidade: 0 }]);

    render(<PainelDePrevisao />);

    expect(await screen.findByText(/Nada vencendo nos próximos 30 dias/)).toBeInTheDocument();
  });

  it("erro do backend (comando ainda não registrado, por exemplo) mostra alerta em vez de travar", async () => {
    deckForecastMock.mockRejectedValue(new Error("comando não encontrado"));

    render(<PainelDePrevisao />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a previsão.");
  });

  it("'Todos os baralhos' selecionado (deckSelecionadoId ausente) busca a previsão da coleção inteira", async () => {
    useCartoesStore.setState({ deckSelecionadoId: null });
    deckForecastMock.mockResolvedValue([]);

    render(<PainelDePrevisao />);

    await waitFor(() => expect(deckForecastMock).toHaveBeenCalledWith(null, 30));
  });

  // A troca passa pela ação `selectDeck`, que é o que a árvore de baralhos
  // chama de verdade — e não por `setState` cru. A diferença não é cosmética:
  // `selectDeck` também decide em que aba o usuário fica, e enquanto ela
  // voltava para o resumo em toda troca, este painel era desmontado antes de
  // qualquer refetch chegar à tela. Com `setState` o teste passava mesmo
  // assim, provando um caminho que nenhum clique percorre.
  it("trocar de baralho pela árvore refaz a busca com o novo id, sem sair da aba", async () => {
    deckForecastMock.mockResolvedValue([]);
    const { rerender } = render(<PainelDePrevisao />);
    await waitFor(() => expect(deckForecastMock).toHaveBeenCalledWith("ingles", 30));

    useCartoesStore.getState().selectDeck("espanhol");
    rerender(<PainelDePrevisao />);

    expect(useCartoesStore.getState().tela).toBe("painel");
    await waitFor(() => expect(deckForecastMock).toHaveBeenCalledWith("espanhol", 30));
  });
});
