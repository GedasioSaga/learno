import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pomodoroToday, semanaDeEstudo, type BlocoPlanejado, type PomodoroToday, type SemanaDeEstudo } from "../../lib/ipc";
import { SECAO_PADRAO, useNavegacaoStore } from "../navegacao";
import { PlanoDoDia } from "./PlanoDoDia";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    semanaDeEstudo: vi.fn(),
    pomodoroToday: vi.fn(),
  };
});

const semanaDeEstudoMock = vi.mocked(semanaDeEstudo);
const pomodoroTodayMock = vi.mocked(pomodoroToday);

// Quinta-feira — a mesma semana usada em `cronograma/store.test.ts`, cuja
// segunda-feira é "2026-09-07".
const HOJE = "2026-09-10";

function bloco(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: HOJE,
    position: "1",
    startLocalTime: null,
    plannedMinutes: 30,
    activity: "pomodoro",
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

function semana(overrides: Partial<SemanaDeEstudo> = {}): SemanaDeEstudo {
  return {
    inicio: "2026-09-07",
    metaMinutos: 480,
    dias: [
      { data: "2026-09-07", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
      { data: HOJE, blocos: [], minutosRealizados: 0 },
      { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
    ],
    ...overrides,
  };
}

function pomodoro(overrides: Partial<PomodoroToday> = {}): PomodoroToday {
  return { focosCompletos: 0, segundosFocados: 0, sequenciaDias: 0, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Só a `Date` é falsa aqui (sem `vi.useFakeTimers()`) — `setSystemTime`
  // sozinho mocka `new Date()` sem tocar em `setTimeout`/`setInterval`, que o
  // `findBy`/`waitFor` da testing-library usa por baixo. Fake timers
  // completos travariam esse polling sem um `advanceTimersByTime` manual.
  vi.setSystemTime(new Date(2026, 8, 10, 10, 0));
  useNavegacaoStore.setState({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false, ultimaTrocaPor: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlanoDoDia", () => {
  it("mostra os blocos de hoje e não os de outro dia", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: [
          { data: "2026-09-08", blocos: [bloco({ id: "outro-dia", title: "Bloco de outro dia" })], minutosRealizados: 0 },
          { data: HOJE, blocos: [bloco({ id: "hoje-1", title: "Revisar SQL" })], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-07", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<PlanoDoDia />);

    expect(await screen.findByText("Revisar SQL")).toBeInTheDocument();
    expect(screen.queryByText("Bloco de outro dia")).not.toBeInTheDocument();
  });

  /**
   * A porcentagem compara o foco do Pomodoro com os minutos de Pomodoro
   * planejados — nunca com o total do dia.
   *
   * A primeira versão comparava com o total de QUALQUER atividade, e o número
   * mentia nas duas direções: ler 60 minutos sem ligar o timer aparecia como
   * "0% cumprido", e rodar o Pomodoro em algo fora do plano aparecia como
   * "50%" de um plano que ninguém tocou. O teste que existia aqui afirmava
   * justamente esse comportamento errado — ele passava, e o que ele guardava
   * era o defeito.
   */
  it("compara o foco só com o Pomodoro planejado, e informa o resto do plano sem prometer progresso", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: semana().dias.map((dia) =>
          dia.data === HOJE
            ? {
                ...dia,
                blocos: [
                  bloco({ id: "b1", plannedMinutes: 30, activity: "pomodoro", title: "Foco" }),
                  bloco({ id: "b2", plannedMinutes: 60, activity: "reading", title: "Leitura" }),
                ],
              }
            : dia,
        ),
      }),
    );
    pomodoroTodayMock.mockResolvedValue(pomodoro({ segundosFocados: 15 * 60 }));

    render(<PlanoDoDia />);

    // 15 de 30 min de Pomodoro = 50%. Os 60 min de leitura entram no total
    // mostrado, mas NÃO no denominador: o timer não mede leitura.
    expect(await screen.findByText("15 min de 30 min de Pomodoro planejados (50%)")).toBeInTheDocument();
    expect(screen.getByText("90 min planejados no total hoje")).toBeInTheDocument();
  });

  it("dia planejado sem nenhum Pomodoro não afirma porcentagem nenhuma", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: semana().dias.map((dia) =>
          dia.data === HOJE
            ? {
                ...dia,
                blocos: [
                  bloco({ id: "b1", plannedMinutes: 30, activity: "review", title: "Cartões" }),
                  bloco({ id: "b2", plannedMinutes: 60, activity: "reading", title: "Leitura" }),
                ],
              }
            : dia,
        ),
      }),
    );
    pomodoroTodayMock.mockResolvedValue(pomodoro({ segundosFocados: 45 * 60 }));

    render(<PlanoDoDia />);

    // O foco existe e é mostrado como fato isolado. Nenhum "%" aparece: não há
    // com o que comparar sem misturar unidades.
    expect(await screen.findByText("45 min de foco hoje")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByText("90 min planejados no total hoje")).toBeInTheDocument();
  });

  it("bloco sem horário não mostra 'undefined'", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: semana().dias.map((dia) =>
          dia.data === HOJE
            ? { ...dia, blocos: [bloco({ startLocalTime: null, activity: "mindmap", title: null })] }
            : dia,
        ),
      }),
    );
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<PlanoDoDia />);

    expect(await screen.findByText("Mapa mental")).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it("sem nada planejado, não aparece porcentagem nem NaN — só o que foi feito", async () => {
    semanaDeEstudoMock.mockResolvedValue(semana());
    pomodoroTodayMock.mockResolvedValue(pomodoro({ segundosFocados: 5 * 60 }));

    render(<PlanoDoDia />);

    expect(await screen.findByText("5 min de foco hoje")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("estado vazio: sem bloco planejado e sem foco registrado, oferece ir planejar no Cronograma", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana());
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<PlanoDoDia />);

    expect(await screen.findByText("Nada planejado para hoje.")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Planejar no Cronograma" }));

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("cronograma");
  });

  it("erro em qualquer uma das chamadas vira mensagem visível em vez de tela branca", async () => {
    semanaDeEstudoMock.mockRejectedValue(new Error("rede caiu"));
    pomodoroTodayMock.mockResolvedValue(pomodoro());

    render(<PlanoDoDia />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o plano do dia.");
  });
});
