import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { semanaDeEstudo, type BlocoPlanejado, type SemanaDeEstudo } from "../../lib/ipc";
import { avisar } from "../../lib/notificacao";
import { ANTECEDENCIA_DO_LEMBRETE_MIN } from "./lembrete-de-blocos";
import { RELEITURA_DO_PLANO_MS, useLembreteDeBlocos } from "./useLembreteDeBlocos";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, semanaDeEstudo: vi.fn() };
});
vi.mock("../../lib/notificacao", () => ({ avisar: vi.fn().mockResolvedValue(undefined) }));

const HOJE = "2026-09-14";

function bloco(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: HOJE,
    position: "1",
    startLocalTime: "13:30",
    plannedMinutes: 50,
    activity: "reading",
    pomodoroCycles: null,
    title: "Redação",
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

function semanaCom(blocos: BlocoPlanejado[]): SemanaDeEstudo {
  const dias = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];
  return { inicio: dias[0], metaMinutos: 0, dias: dias.map((data) => ({ data, blocos: data === HOJE ? blocos : [], minutosRealizados: 0 })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 13:00 local de uma segunda-feira: a semana começa hoje.
  vi.useFakeTimers({ now: new Date(2026, 8, 14, 13, 0, 0, 0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLembreteDeBlocos", () => {
  it("avisa alguns minutos antes do bloco de hoje, e uma vez só", async () => {
    vi.mocked(semanaDeEstudo).mockResolvedValue(semanaCom([bloco()]));
    renderHook(() => useLembreteDeBlocos());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync((30 - ANTECEDENCIA_DO_LEMBRETE_MIN) * 60_000 - 1_000);
    expect(avisar).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(avisar).toHaveBeenCalledWith("Bloco às 13:30", `Redação começa em ${ANTECEDENCIA_DO_LEMBRETE_MIN} min.`);

    await vi.advanceTimersByTimeAsync(RELEITURA_DO_PLANO_MS);
    expect(avisar).toHaveBeenCalledTimes(1);
  });

  it("a releitura pega bloco criado depois de o app abrir e esquece bloco apagado", async () => {
    vi.mocked(semanaDeEstudo).mockResolvedValueOnce(semanaCom([bloco({ id: "apagado", startLocalTime: "13:40" })]));
    renderHook(() => useLembreteDeBlocos());
    await vi.advanceTimersByTimeAsync(0);

    vi.mocked(semanaDeEstudo).mockResolvedValue(semanaCom([bloco({ id: "novo", startLocalTime: "13:20", title: "Leitura" })]));
    // A releitura acontece às 13:10; o lembrete do bloco das 13:20 sai às 13:15.
    await vi.advanceTimersByTimeAsync(RELEITURA_DO_PLANO_MS);
    expect(avisar).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync((10 - ANTECEDENCIA_DO_LEMBRETE_MIN) * 60_000);

    expect(avisar).toHaveBeenCalledWith("Bloco às 13:20", `Leitura começa em ${ANTECEDENCIA_DO_LEMBRETE_MIN} min.`);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(avisar).not.toHaveBeenCalledWith("Bloco às 13:40", expect.any(String));
  });

  it("desmontar cancela os lembretes pendentes", async () => {
    vi.mocked(semanaDeEstudo).mockResolvedValue(semanaCom([bloco()]));
    const { unmount } = renderHook(() => useLembreteDeBlocos());
    await vi.advanceTimersByTimeAsync(0);

    unmount();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(avisar).not.toHaveBeenCalled();
  });

  // A trava da ligação: o agendador existir, testado, e nunca rodar no app de verdade.
  it("a casca do app liga o agendador", () => {
    const casca = fs.readFileSync(path.resolve(__dirname, "../../components/AppShell.tsx"), "utf-8");
    expect(casca).toMatch(/^\s*useLembreteDeBlocos\(\);$/m);
  });
});
