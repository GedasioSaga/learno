import { describe, expect, it } from "vitest";
import type { BlocoPlanejado } from "../../lib/ipc";
import { ANTECEDENCIA_DO_LEMBRETE_MIN, lembretesDeHoje } from "./lembrete-de-blocos";

const HOJE = "2026-09-14";

function bloco(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: HOJE,
    position: "1",
    startLocalTime: "14:00",
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

/** `new Date(ano, mês, dia, h, m)` é hora LOCAL, a mesma que `startLocalTime` descreve. */
const agoraAs = (horas: number, minutos: number) => new Date(2026, 8, 14, horas, minutos, 0, 0);

describe("lembretesDeHoje", () => {
  it("agenda o lembrete para antes do horário do bloco", () => {
    const [lembrete] = lembretesDeHoje([bloco()], HOJE, agoraAs(13, 0), new Set());

    expect(lembrete.emMs).toBe((60 - ANTECEDENCIA_DO_LEMBRETE_MIN) * 60_000);
    expect(lembrete.titulo).toBe("Bloco às 14:00");
    expect(lembrete.corpo).toBe(`Redação começa em ${ANTECEDENCIA_DO_LEMBRETE_MIN} min.`);
  });

  it("app aberto dentro da janela avisa na hora; bloco já começado não avisa", () => {
    expect(lembretesDeHoje([bloco()], HOJE, agoraAs(13, 58), new Set())[0].emMs).toBe(0);
    expect(lembretesDeHoje([bloco()], HOJE, agoraAs(14, 0), new Set())).toEqual([]);
    expect(lembretesDeHoje([bloco()], HOJE, agoraAs(15, 0), new Set())).toEqual([]);
  });

  it("ignora outro dia, bloco sem horário, horário corrompido e bloco já avisado", () => {
    const blocos = [
      bloco({ id: "ontem", localDate: "2026-09-13" }),
      bloco({ id: "sem-horario", startLocalTime: null }),
      bloco({ id: "corrompido", startLocalTime: "xx:yy" }),
      bloco({ id: "avisado" }),
      bloco({ id: "valido", startLocalTime: "16:30", title: null, activity: "review" }),
    ];

    const lembretes = lembretesDeHoje(blocos, HOJE, agoraAs(13, 0), new Set(["avisado"]));

    expect(lembretes.map((l) => l.blocoId)).toEqual(["valido"]);
  });
});
