import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { startPomodoro, type BlocoPlanejado } from "../../lib/ipc";
import { useNavegacaoStore } from "../navegacao";
import { usePomodoroStore } from "../pomodoro";
import { BlocoCard } from "./BlocoCard";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, startPomodoro: vi.fn() };
});

function bloco(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: "2026-09-14",
    position: "1",
    startLocalTime: null,
    plannedMinutes: 50,
    activity: "reading",
    pomodoroCycles: null,
    title: null,
    deckId: null,
    pageId: null,
    subjectId: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    endLocalTime: null,
    crossesMidnight: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(startPomodoro).mockReset();
  useNavegacaoStore.setState({ secaoAtiva: "cronograma", painelRecolhido: false, ultimaTrocaPor: null });
  usePomodoroStore.setState({
    fase: "focus",
    status: "idle",
    focusNumeroNoCiclo: 1,
    terminaEm: null,
    restantesAoPausar: null,
    sessionId: null,
    erro: null,
    blocoAlvo: null,
  });
});

describe("BlocoCard", () => {
  it("Focar leva para Hoje e inicia o Pomodoro ligado ao bloco", async () => {
    vi.mocked(startPomodoro).mockResolvedValue({
      id: "s1",
      kind: "focus",
      startedAt: "2026-09-14T10:00:00.000Z",
      endedAt: null,
      durationSeconds: 1500,
      completed: false,
      planBlockId: "b9",
      createdAt: "2026-09-14T10:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<BlocoCard bloco={bloco({ id: "b9", title: "Redação" })} />);

    await user.click(screen.getByRole("button", { name: "Focar neste bloco: Redação" }));

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("hoje");
    expect(startPomodoro).toHaveBeenCalledWith("focus", 1500, "b9");
    expect(usePomodoroStore.getState().blocoAlvo).toEqual({ id: "b9", rotulo: "Redação" });
  });

  it("bloco sem título usa o rótulo da atividade no botão", () => {
    render(<BlocoCard bloco={bloco({ activity: "reading", title: "  " })} />);

    expect(screen.getByRole("button", { name: /^Focar neste bloco: / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Remover bloco/ })).toBeInTheDocument();
  });
});
