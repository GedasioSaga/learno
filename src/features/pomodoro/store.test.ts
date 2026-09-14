import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, finishPomodoro, startPomodoro, type PomodoroSessionRow } from "../../lib/ipc";
import { avisar } from "../../lib/notificacao";
import {
  avisoDeFimDeFase,
  calcularProximaFase,
  DURACAO_SEGUNDOS,
  FOCUS_SESSIONS_BEFORE_LONG_BREAK,
  usePomodoroStore,
} from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    startPomodoro: vi.fn(),
    finishPomodoro: vi.fn(),
  };
});

vi.mock("../../lib/notificacao", () => ({ avisar: vi.fn().mockResolvedValue(undefined) }));

const startMock = vi.mocked(startPomodoro);
const finishMock = vi.mocked(finishPomodoro);

function sessao(overrides: Partial<PomodoroSessionRow> & Pick<PomodoroSessionRow, "id">): PomodoroSessionRow {
  return {
    kind: "focus",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    durationSeconds: DURACAO_SEGUNDOS.focus,
    completed: false,
    planBlockId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Espera microtarefas pendentes (a resolução de um mock assíncrono + o `set` que vem depois dela) drenarem antes de checar o estado. */
async function esvaziarMicrotarefas(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
  startMock.mockReset();
  finishMock.mockReset();
  vi.mocked(avisar).mockClear();
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

afterEach(() => {
  vi.useRealTimers();
});

describe("usePomodoroStore — aviso do sistema", () => {
  it("o fim natural de um foco avisa a pausa que vem", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    finishMock.mockResolvedValue(sessao({ id: "sessao-1", completed: true }));
    await usePomodoroStore.getState().iniciar();

    vi.setSystemTime(new Date(Date.now() + DURACAO_SEGUNDOS.focus * 1000 + 1000));
    usePomodoroStore.getState().verificarFimDaFase();
    await esvaziarMicrotarefas();

    expect(avisar).toHaveBeenCalledWith("Foco concluído", "Hora da pausa curta.");
  });

  it("reiniciar no meio não avisa nada", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    finishMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    await usePomodoroStore.getState().iniciar();

    await usePomodoroStore.getState().reiniciar();
    await esvaziarMicrotarefas();

    expect(avisar).not.toHaveBeenCalled();
  });

  it("as mensagens dizem o que vem depois", () => {
    expect(avisoDeFimDeFase("focus", "long_break")).toEqual(["Foco concluído", "Hora da pausa longa."]);
    expect(avisoDeFimDeFase("short_break", "focus")).toEqual(["Pausa encerrada", "Hora de voltar ao foco."]);
  });
});

describe("usePomodoroStore — foco ligado a um bloco", () => {
  it("focar num bloco inicia um foco ligado a ele", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1", planBlockId: "b1" }));

    await usePomodoroStore.getState().focarNoBloco({ id: "b1", rotulo: "Leitura" });

    expect(startMock).toHaveBeenCalledWith("focus", DURACAO_SEGUNDOS.focus, "b1");
    expect(usePomodoroStore.getState().status).toBe("executando");
    expect(usePomodoroStore.getState().blocoAlvo).toEqual({ id: "b1", rotulo: "Leitura" });
  });

  it("a pausa entre dois focos não é ligada ao bloco", async () => {
    usePomodoroStore.setState({ fase: "short_break", blocoAlvo: { id: "b1", rotulo: "Leitura" } });
    startMock.mockResolvedValue(sessao({ id: "pausa-1", kind: "short_break" }));

    await usePomodoroStore.getState().iniciar();

    expect(startMock).toHaveBeenCalledWith("short_break", DURACAO_SEGUNDOS.short_break);
  });

  it("outro bloco com pomodoro em andamento é recusado, e desvincular só vale parado", async () => {
    usePomodoroStore.setState({
      status: "executando",
      sessionId: "sessao-1",
      terminaEm: Date.now() + 60_000,
      blocoAlvo: { id: "b1", rotulo: "Leitura" },
    });

    await usePomodoroStore.getState().focarNoBloco({ id: "b2", rotulo: "Redação" });
    expect(startMock).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().blocoAlvo?.id).toBe("b1");
    expect(usePomodoroStore.getState().erro).toMatch(/Reinicie/);

    usePomodoroStore.getState().desvincularBloco();
    expect(usePomodoroStore.getState().blocoAlvo?.id).toBe("b1");

    usePomodoroStore.setState({ status: "idle", sessionId: null, terminaEm: null });
    usePomodoroStore.getState().desvincularBloco();
    expect(usePomodoroStore.getState().blocoAlvo).toBeNull();
  });

  it("focar de novo no mesmo bloco já em andamento não faz nada", async () => {
    usePomodoroStore.setState({ status: "executando", sessionId: "sessao-1", terminaEm: Date.now() + 60_000, blocoAlvo: { id: "b1", rotulo: "Leitura" } });

    await usePomodoroStore.getState().focarNoBloco({ id: "b1", rotulo: "Leitura" });

    expect(startMock).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().erro).toBeNull();
  });
});

describe("usePomodoroStore", () => {
  it("iniciar abre uma sessão no backend e começa a contar a partir da duração cheia do foco", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));

    await usePomodoroStore.getState().iniciar();

    expect(startMock).toHaveBeenCalledWith("focus", DURACAO_SEGUNDOS.focus);
    expect(usePomodoroStore.getState().status).toBe("executando");
    expect(usePomodoroStore.getState().sessionId).toBe("sessao-1");
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus);
  });

  it("o tempo restante vem do relógio, não de uma contagem de tiques", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    await usePomodoroStore.getState().iniciar();

    vi.advanceTimersByTime(10_000);

    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus - 10);
  });

  it("um salto de relógio (aba suspensa) é absorvido inteiro no próximo tique — exatamente o que um setInterval contado erraria", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    finishMock.mockResolvedValue(sessao({ id: "sessao-1", completed: true }));
    await usePomodoroStore.getState().iniciar();

    // Um `setInterval` real teria disparado ~1500 vezes neste intervalo; aqui
    // o relógio pula direto para depois do fim da fase, e só UM tique chega
    // depois disso — o caso que `verificarFimDaFase` precisa cobrir sozinho.
    vi.advanceTimersByTime(DURACAO_SEGUNDOS.focus * 1000 + 5_000);
    usePomodoroStore.getState().verificarFimDaFase();
    await esvaziarMicrotarefas();

    expect(finishMock).toHaveBeenCalledWith("sessao-1", true);
    expect(usePomodoroStore.getState().status).toBe("idle");
    expect(usePomodoroStore.getState().fase).toBe("short_break");
    expect(usePomodoroStore.getState().sessionId).toBeNull();
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.short_break);
  });

  it("um tique antes do fim da fase não faz nada — sem chamar finishPomodoro cedo demais", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    await usePomodoroStore.getState().iniciar();

    vi.advanceTimersByTime(10_000);
    usePomodoroStore.getState().verificarFimDaFase();
    await esvaziarMicrotarefas();

    expect(finishMock).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().status).toBe("executando");
  });

  it("pausar congela os segundos restantes; retomar não abre uma sessão nova", async () => {
    startMock.mockResolvedValue(sessao({ id: "sessao-1" }));
    await usePomodoroStore.getState().iniciar();
    vi.advanceTimersByTime(10_000);

    usePomodoroStore.getState().pausar();
    expect(usePomodoroStore.getState().status).toBe("pausado");
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus - 10);

    // O relógio segue andando enquanto pausado; o valor mostrado não pode mudar.
    vi.advanceTimersByTime(60_000);
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus - 10);

    await usePomodoroStore.getState().iniciar();
    expect(usePomodoroStore.getState().status).toBe("executando");
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus - 10);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("reiniciar fecha a sessão como não concluída e volta à duração cheia da fase, esperando um novo Iniciar", async () => {
    startMock.mockResolvedValueOnce(sessao({ id: "sessao-1" }));
    finishMock.mockResolvedValue(sessao({ id: "sessao-1", completed: false }));
    await usePomodoroStore.getState().iniciar();
    vi.advanceTimersByTime(100_000);

    await usePomodoroStore.getState().reiniciar();

    expect(finishMock).toHaveBeenCalledWith("sessao-1", false);
    expect(usePomodoroStore.getState().status).toBe("idle");
    expect(usePomodoroStore.getState().sessionId).toBeNull();
    expect(usePomodoroStore.getState().segundosRestantes()).toBe(DURACAO_SEGUNDOS.focus);

    startMock.mockResolvedValueOnce(sessao({ id: "sessao-2" }));
    await usePomodoroStore.getState().iniciar();
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(usePomodoroStore.getState().sessionId).toBe("sessao-2");
  });

  it("reiniciar em idle (nada rodando ainda) não chama finishPomodoro", async () => {
    await usePomodoroStore.getState().reiniciar();

    expect(finishMock).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().status).toBe("idle");
  });

  it("erro do backend ao iniciar aparece em `erro`, com a mensagem que o backend mandou, e o cronômetro não sai de idle", async () => {
    startMock.mockRejectedValue(new AppError({ kind: "db", message: "disco cheio" }));

    await usePomodoroStore.getState().iniciar();

    expect(usePomodoroStore.getState().status).toBe("idle");
    expect(usePomodoroStore.getState().erro).toBe("disco cheio");
  });

  it("um erro sem a forma de AppError cai na mensagem padrão, em vez de vazar o erro cru", async () => {
    startMock.mockRejectedValue(new Error("boom"));

    await usePomodoroStore.getState().iniciar();

    expect(usePomodoroStore.getState().erro).toBe("Não foi possível iniciar o pomodoro.");
  });

  describe("calcularProximaFase", () => {
    it("um foco que não é o último do ciclo vira pausa curta e avança o número do próximo foco", () => {
      expect(calcularProximaFase("focus", 1)).toEqual({ proximaFase: "short_break", proximoFocusNumero: 2 });
      expect(calcularProximaFase("focus", 3)).toEqual({ proximaFase: "short_break", proximoFocusNumero: 4 });
    });

    it("o quarto foco vira pausa longa e o número volta a 1", () => {
      expect(calcularProximaFase("focus", FOCUS_SESSIONS_BEFORE_LONG_BREAK)).toEqual({
        proximaFase: "long_break",
        proximoFocusNumero: 1,
      });
    });

    it("depois de qualquer pausa começa um foco novo, sem mexer no número do ciclo", () => {
      expect(calcularProximaFase("short_break", 2)).toEqual({ proximaFase: "focus", proximoFocusNumero: 2 });
      expect(calcularProximaFase("long_break", 1)).toEqual({ proximaFase: "focus", proximoFocusNumero: 1 });
    });
  });

  it("um ciclo completo de 4 focos termina em pausa longa e o número volta a 1 depois dela", async () => {
    let contador = 0;
    startMock.mockImplementation(async (kind, durationSeconds) =>
      sessao({ id: `sessao-${++contador}`, kind, durationSeconds }),
    );
    finishMock.mockImplementation(async (id, completed) => sessao({ id, completed }));

    async function terminarFaseAtual(): Promise<void> {
      const terminaEm = usePomodoroStore.getState().terminaEm;
      if (terminaEm === null) throw new Error("a fase precisa estar executando para poder terminar");
      vi.setSystemTime(terminaEm + 1_000);
      usePomodoroStore.getState().verificarFimDaFase();
      await esvaziarMicrotarefas();
    }

    await usePomodoroStore.getState().iniciar(); // foco 1
    expect(usePomodoroStore.getState().focusNumeroNoCiclo).toBe(1);
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "short_break", focusNumeroNoCiclo: 2 });

    await usePomodoroStore.getState().iniciar(); // pausa curta
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "focus", focusNumeroNoCiclo: 2 });

    await usePomodoroStore.getState().iniciar(); // foco 2
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "short_break", focusNumeroNoCiclo: 3 });

    await usePomodoroStore.getState().iniciar(); // pausa curta
    await terminarFaseAtual();
    await usePomodoroStore.getState().iniciar(); // foco 3
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "short_break", focusNumeroNoCiclo: 4 });

    await usePomodoroStore.getState().iniciar(); // pausa curta
    await terminarFaseAtual();
    await usePomodoroStore.getState().iniciar(); // foco 4
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "long_break", focusNumeroNoCiclo: 1 });

    await usePomodoroStore.getState().iniciar(); // pausa longa
    await terminarFaseAtual();
    expect(usePomodoroStore.getState()).toMatchObject({ fase: "focus", focusNumeroNoCiclo: 1 });
  });
});
