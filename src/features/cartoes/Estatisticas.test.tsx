import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { estudoEstatisticas, type EstatisticasDeEstudo } from "../../lib/ipc";
import { Estatisticas } from "./Estatisticas";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    estudoEstatisticas: vi.fn(),
  };
});

const estudoEstatisticasMock = vi.mocked(estudoEstatisticas);

function estatisticas(overrides: Partial<EstatisticasDeEstudo> = {}): EstatisticasDeEstudo {
  return {
    porDia: [],
    totalRevisoes: 0,
    mediaDiaria: 0,
    diasEstudados: 0,
    maiorSequencia: 0,
    sequenciaAtual: 0,
    retencao: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Congela só `Date`: `findBy`/`waitFor` do Testing Library dependem de
  // temporizador de verdade pra fazer polling — só o "hoje" do mapa de calor
  // precisa ser fixo.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 5)); // sábado, 5 de setembro de 2026
  useCartoesStore.setState({ deckSelecionadoId: "ingles", tela: "estatisticas" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Estatisticas", () => {
  it("busca a janela do mapa de calor pelo baralho selecionado e mostra os quatro números", async () => {
    estudoEstatisticasMock.mockResolvedValue(
      estatisticas({
        porDia: [{ dia: "2026-09-05", revisoes: 7, segundos: 120 }],
        diasEstudados: 12,
        mediaDiaria: 5.5,
        maiorSequencia: 9,
        sequenciaAtual: 3,
      }),
    );

    render(<Estatisticas />);

    expect(await screen.findByText("5,5")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("9 dias")).toBeInTheDocument();
    expect(screen.getByText("3 dias")).toBeInTheDocument();
    expect(estudoEstatisticasMock).toHaveBeenCalledWith("ingles", 371);
  });

  it("a informação de cada dia está em texto, não só na dica de hover do mapa de calor", async () => {
    estudoEstatisticasMock.mockResolvedValue(
      estatisticas({ porDia: [{ dia: "2026-09-05", revisoes: 7, segundos: 0 }], diasEstudados: 1 }),
    );

    render(<Estatisticas />);
    await screen.findByText("Estatísticas");

    // Mesmo sem abrir o <details>, o texto por extenso do dia já está no DOM
    // (jsdom não recolhe visualmente o conteúdo — mas o ponto que importa é
    // que não existe só um `title` de hover carregando esta informação).
    expect(screen.getByText("sábado, 5 de setembro")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("retenção aparece com a frase do que ela mede quando vem preenchida", async () => {
    estudoEstatisticasMock.mockResolvedValue(estatisticas({ diasEstudados: 1, retencao: 0.82 }));

    render(<Estatisticas />);

    expect(await screen.findByText("82% de retenção")).toBeInTheDocument();
  });

  it("retenção null (sem revisão madura na janela) não mostra número inventado", async () => {
    estudoEstatisticasMock.mockResolvedValue(estatisticas({ diasEstudados: 1, retencao: null }));

    render(<Estatisticas />);

    await screen.findByText("Estatísticas");
    expect(screen.queryByText(/de retenção/)).not.toBeInTheDocument();
  });

  it("'Todos os baralhos' selecionado (deckSelecionadoId ausente) busca as estatísticas da coleção inteira", async () => {
    useCartoesStore.setState({ deckSelecionadoId: null });
    estudoEstatisticasMock.mockResolvedValue(estatisticas({ diasEstudados: 0 }));

    render(<Estatisticas />);

    await screen.findByText("Ainda sem histórico por aqui");
    expect(estudoEstatisticasMock).toHaveBeenCalledWith(null, 371);
  });

  it("quem nunca estudou vê um estado vazio honesto, não um mapa de calor apagado sem contexto", async () => {
    estudoEstatisticasMock.mockResolvedValue(estatisticas({ diasEstudados: 0 }));

    render(<Estatisticas />);

    expect(await screen.findByText("Ainda sem histórico por aqui")).toBeInTheDocument();
    expect(screen.queryByText("Dias estudados")).not.toBeInTheDocument();
  });

  it("erro do backend (study_stats ainda não registrado) mostra alerta em vez de tela branca", async () => {
    estudoEstatisticasMock.mockRejectedValue(new Error("comando não encontrado"));

    render(<Estatisticas />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as estatísticas.");
  });
});
