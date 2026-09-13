import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pomodoroToday, type PomodoroToday } from "../../lib/ipc";
import { CartaoDeProgresso } from "./CartaoDeProgresso";
import { desafiosHoje, nivelAtual, registrarXpDesafioDiario, type Desafio, type EstadoDeNivel } from "./ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    pomodoroToday: vi.fn(),
  };
});

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    nivelAtual: vi.fn(),
    desafiosHoje: vi.fn(),
    registrarXpDesafioDiario: vi.fn(),
  };
});

const nivelAtualMock = vi.mocked(nivelAtual);
const desafiosHojeMock = vi.mocked(desafiosHoje);
const pomodoroTodayMock = vi.mocked(pomodoroToday);
const registrarXpDesafioDiarioMock = vi.mocked(registrarXpDesafioDiario);

function nivel(overrides: Partial<EstadoDeNivel> = {}): EstadoDeNivel {
  return { nivel: 1, xpTotal: 500, xpNoNivelAtual: 10, xpParaProximoNivel: 90, progresso: 0.9, ...overrides };
}

function desafio(overrides: Partial<Desafio> = {}): Desafio {
  return {
    tipo: "revisar_cartoes",
    titulo: "Revisar cartões",
    unidade: "cartões",
    meta: 20,
    progresso: 5,
    concluido: false,
    xpRecompensa: 50,
    xpCreditado: false,
    ...overrides,
  };
}

function pomodoro(overrides: Partial<PomodoroToday> = {}): PomodoroToday {
  return { focosCompletos: 0, segundosFocados: 0, sequenciaDias: 0, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CartaoDeProgresso", () => {
  it("mostra o nível e usa o `progresso` que o backend manda, sem recalcular a partir de outros campos", async () => {
    // `xpNoNivelAtual`/`xpParaProximoNivel` sozinhos dariam 10/(10+90) = 10%
    // se o componente recalculasse a fração por conta própria. `progresso`
    // diz 90% — é este valor que precisa aparecer na barra, prova de que o
    // componente confia no campo pronto em vez de derivar um novo.
    nivelAtualMock.mockResolvedValue(nivel({ nivel: 1, xpNoNivelAtual: 10, xpParaProximoNivel: 90, progresso: 0.9 }));
    desafiosHojeMock.mockResolvedValue([]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<CartaoDeProgresso />);

    expect(await screen.findByText("Nível 1")).toBeInTheDocument();
    // `as` seguro aqui: `getByRole("progressbar", ...)` só casa com o `<progress>`
    // nativo que o componente renderiza (role implícita), então o valor já é o
    // elemento certo — o cast só nomeia o tipo pra acessar `.value` tipado.
    const barra = screen.getByRole("progressbar", { name: "Progresso para o nível 2" }) as HTMLProgressElement;
    expect(barra.value).toBe(90);
    expect(screen.getByText("Faltam 90 XP para o nível 2")).toBeInTheDocument();
  });

  it("mostra a sequência de dias vinda de pomodoroToday", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    desafiosHojeMock.mockResolvedValue([]);
    pomodoroTodayMock.mockResolvedValue(pomodoro({ sequenciaDias: 4 }));

    render(<CartaoDeProgresso />);

    expect(await screen.findByText("4 dias seguidos de foco")).toBeInTheDocument();
  });

  it("desafio concluído aparece diferente do desafio em andamento", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    desafiosHojeMock.mockResolvedValue([
      desafio({ tipo: "revisar_cartoes", titulo: "Revisar cartões", progresso: 20, meta: 20, concluido: true, xpCreditado: true }),
      desafio({ tipo: "focar_minutos", titulo: "Focar minutos", progresso: 5, meta: 25, concluido: false }),
    ]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<CartaoDeProgresso />);

    await screen.findByText("Revisar cartões");

    // Concluído: rótulo de XP creditado, sem botão de registrar.
    expect(screen.getByText("50 XP creditado")).toBeInTheDocument();
    // Em andamento: nem rótulo de creditado, nem botão (só creditável quando concluído).
    expect(screen.queryByRole("button", { name: /Registrar/ })).not.toBeInTheDocument();
  });

  it("desafio concluído e ainda não creditado oferece registrar, e credita ao clicar", async () => {
    const user = userEvent.setup();
    nivelAtualMock.mockResolvedValue(nivel());
    desafiosHojeMock.mockResolvedValue([
      desafio({ tipo: "concluir_blocos", titulo: "Concluir um bloco", progresso: 1, meta: 1, concluido: true, xpCreditado: false, xpRecompensa: 50 }),
    ]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());
    registrarXpDesafioDiarioMock.mockResolvedValue({
      id: "evt-1",
      amount: 50,
      origin: "desafio_diario",
      referenceId: "2026-09-05:concluir_blocos",
      createdAt: "2026-09-05T00:00:00.000Z",
      jaCreditado: false,
    });

    render(<CartaoDeProgresso />);

    const botao = await screen.findByRole("button", { name: "Registrar 50 XP" });
    await user.click(botao);

    expect(registrarXpDesafioDiarioMock).toHaveBeenCalledWith("concluir_blocos");
    expect(await screen.findByText("50 XP creditado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Registrar/ })).not.toBeInTheDocument();
  });

  it("estado vazio: quem nunca gerou XP vê um convite, não 'Nível 1 — 0%'", async () => {
    nivelAtualMock.mockResolvedValue(nivel({ nivel: 1, xpTotal: 0, xpNoNivelAtual: 0, xpParaProximoNivel: 100, progresso: 0 }));
    desafiosHojeMock.mockResolvedValue([desafio()]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<CartaoDeProgresso />);

    expect(await screen.findByText("Comece a estudar para acumular XP")).toBeInTheDocument();
    expect(screen.queryByText("Nível 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("erro em qualquer uma das chamadas vira mensagem visível em vez de tela branca", async () => {
    nivelAtualMock.mockRejectedValue(new Error("rede caiu"));
    desafiosHojeMock.mockResolvedValue([]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<CartaoDeProgresso />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o seu progresso.");
  });

  it("erro ao registrar XP de um desafio aparece junto do desafio, sem derrubar o cartão inteiro", async () => {
    const user = userEvent.setup();
    nivelAtualMock.mockResolvedValue(nivel());
    desafiosHojeMock.mockResolvedValue([
      desafio({ tipo: "concluir_blocos", titulo: "Concluir um bloco", progresso: 1, meta: 1, concluido: true, xpCreditado: false }),
    ]);
    pomodoroTodayMock.mockResolvedValue(pomodoro());
    registrarXpDesafioDiarioMock.mockRejectedValue(new Error("rede caiu"));

    render(<CartaoDeProgresso />);

    const botao = await screen.findByRole("button", { name: "Registrar 50 XP" });
    await user.click(botao);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível registrar o XP deste desafio.");
    await waitFor(() => expect(botao).not.toBeDisabled());
  });
});
