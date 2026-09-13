import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { finishPomodoro, startPomodoro, type PomodoroSessionRow } from "../../lib/ipc";
import { CartaoPomodoro } from "./CartaoPomodoro";
import { DURACAO_SEGUNDOS, usePomodoroStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    startPomodoro: vi.fn(),
    finishPomodoro: vi.fn(),
  };
});

const startMock = vi.mocked(startPomodoro);
const finishMock = vi.mocked(finishPomodoro);

function sessao(overrides: Partial<PomodoroSessionRow> & Pick<PomodoroSessionRow, "id">): PomodoroSessionRow {
  return {
    kind: "focus",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    durationSeconds: DURACAO_SEGUNDOS.focus,
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Clica e espera o `iniciar`/`pausar`/`reiniciar` assíncrono (e o re-render que ele dispara) terminarem, sem depender de `findBy` — que, com temporizador falso, ficaria esperando um `setTimeout` que nunca dispara sozinho. */
async function clicarEEsperar(nome: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: nome }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  startMock.mockReset();
  finishMock.mockReset();
  usePomodoroStore.setState({
    fase: "focus",
    status: "idle",
    focusNumeroNoCiclo: 1,
    terminaEm: null,
    restantesAoPausar: null,
    sessionId: null,
    erro: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CartaoPomodoro", () => {
  it("parado, mostra a duração cheia do foco 1 de 4 e só o botão Iniciar", () => {
    render(<CartaoPomodoro />);

    expect(screen.getByText("25:00")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agora — pomodoro 1 de 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reiniciar" })).toBeDisabled();
  });

  it("Iniciar abre a sessão no backend e troca o botão para Pausar", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    render(<CartaoPomodoro />);

    await clicarEEsperar("Iniciar");

    expect(startMock).toHaveBeenCalledWith("focus", DURACAO_SEGUNDOS.focus);
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reiniciar" })).not.toBeDisabled();
  });

  it("o mostrador desce sozinho a cada tique enquanto o foco está executando", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    render(<CartaoPomodoro />);
    await clicarEEsperar("Iniciar");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByText("24:57")).toBeInTheDocument();
  });

  it("Pausar congela o mostrador; Reiniciar volta a 25:00 e fecha a sessão como não concluída", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    finishMock.mockResolvedValue(sessao({ id: "sessao-1", completed: false }));
    render(<CartaoPomodoro />);

    await clicarEEsperar("Iniciar");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await clicarEEsperar("Pausar");
    expect(screen.getByText("24:50")).toBeInTheDocument();

    // Pausado, o relógio andar não deveria mexer no mostrador.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText("24:50")).toBeInTheDocument();

    await clicarEEsperar("Reiniciar");

    expect(finishMock).toHaveBeenCalledWith("sessao-1", false);
    expect(screen.getByText("25:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar" })).toBeInTheDocument();
  });

  it("um erro ao iniciar aparece na tela em vez de falhar silenciosamente", async () => {
    startMock.mockRejectedValue(new Error("sem conexão com o banco"));
    render(<CartaoPomodoro />);

    await clicarEEsperar("Iniciar");

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível iniciar o pomodoro.");
  });
});
