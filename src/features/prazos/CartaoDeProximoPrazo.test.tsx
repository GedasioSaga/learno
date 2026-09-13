import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CartaoDeProximoPrazo } from "./CartaoDeProximoPrazo";
import { listarPrazos, type PrazoComContagem, type PrazosListados } from "./ipc";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    listarPrazos: vi.fn(),
  };
});

const listarPrazosMock = vi.mocked(listarPrazos);

function prazo(overrides: Partial<PrazoComContagem> = {}): PrazoComContagem {
  return {
    id: "p1",
    title: "Prova de Biologia",
    dueLocalDate: "2026-09-20",
    deckId: null,
    pageId: null,
    status: "ativo",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    diasRestantes: 5,
    ...overrides,
  };
}

function listagem(overrides: Partial<PrazosListados> = {}): PrazosListados {
  return { hoje: "2026-09-05", vencidos: [], futuros: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CartaoDeProximoPrazo", () => {
  it("estado vazio: sem nenhum prazo ativo, mostra mensagem honesta", async () => {
    listarPrazosMock.mockResolvedValue(listagem());

    render(<CartaoDeProximoPrazo />);

    expect(await screen.findByText("Nenhum prazo cadastrado ainda.")).toBeInTheDocument();
  });

  it("mostra o futuro mais próximo com a contagem exata do backend", async () => {
    listarPrazosMock.mockResolvedValue(
      listagem({ futuros: [prazo({ diasRestantes: 3 }), prazo({ id: "p2", diasRestantes: 20 })] }),
    );

    render(<CartaoDeProximoPrazo />);

    expect(await screen.findByText("Prova de Biologia")).toBeInTheDocument();
    expect(screen.getByText("Faltam 3 dias")).toBeInTheDocument();
  });

  it("um vencido tem prioridade sobre qualquer futuro — não fica escondido atrás do que ainda vai acontecer", async () => {
    listarPrazosMock.mockResolvedValue(
      listagem({
        vencidos: [prazo({ id: "v1", title: "Prova de Química", diasRestantes: -2 })],
        futuros: [prazo({ id: "f1", title: "Prova de Biologia", diasRestantes: 1 })],
      }),
    );

    render(<CartaoDeProximoPrazo />);

    expect(await screen.findByText("Prova de Química")).toBeInTheDocument();
    expect(screen.getByText("Venceu há 2 dias")).toBeInTheDocument();
    expect(screen.queryByText("Prova de Biologia")).not.toBeInTheDocument();
  });

  it("erro na chamada vira mensagem visível em vez de tela branca", async () => {
    listarPrazosMock.mockRejectedValue(new Error("rede caiu"));

    render(<CartaoDeProximoPrazo />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os prazos.");
  });

  it("sem `onVerTodos`, não mostra nenhum atalho", async () => {
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));

    render(<CartaoDeProximoPrazo />);

    await screen.findByText("Prova de Biologia");
    expect(screen.queryByRole("button", { name: "Ver todos os prazos" })).not.toBeInTheDocument();
  });

  it("com `onVerTodos`, o botão aparece e chama o callback ao clicar", async () => {
    const user = userEvent.setup();
    const onVerTodos = vi.fn();
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));

    render(<CartaoDeProximoPrazo onVerTodos={onVerTodos} />);

    const botao = await screen.findByRole("button", { name: "Ver todos os prazos" });
    await user.click(botao);

    expect(onVerTodos).toHaveBeenCalledTimes(1);
  });
});
