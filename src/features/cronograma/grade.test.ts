import { describe, expect, it } from "vitest";
import type { BlocoPlanejado, DiaDaSemana, SemanaDeEstudo } from "../../lib/ipc";
import { construirGrade, GRANULARIDADE_MINUTOS, minutosParaRotulo, type ColunaDaGrade, type GradeSemana } from "./grade";

let proximoId = 0;

function pad2(valor: number): string {
  return String(valor).padStart(2, "0");
}

/**
 * `endLocalTime`/`crossesMidnight` são DERIVADOS pelo backend (Fase 1 do
 * Cronograma) a partir de `startLocalTime` + `plannedMinutes` — nunca
 * digitados. `grade.ts` agora lê esses dois campos direto de
 * `BlocoPlanejado` (em vez de recalcular), então a fixture precisa produzir
 * valores coerentes; esta é a MESMA regra de `fim_local` no Rust,
 * reimplementada aqui só para gerar dado de teste plausível.
 */
function derivarFim(startLocalTime: string | null, plannedMinutes: number): { endLocalTime: string | null; crossesMidnight: boolean } {
  if (startLocalTime === null) return { endLocalTime: null, crossesMidnight: false };
  const [horas, minutos] = startLocalTime.split(":").map(Number);
  const totalFim = horas * 60 + minutos + plannedMinutes;
  const crossesMidnight = totalFim >= 24 * 60;
  const fimNoDia = totalFim % (24 * 60);
  return { endLocalTime: `${pad2(Math.floor(fimNoDia / 60))}:${pad2(fimNoDia % 60)}`, crossesMidnight };
}

function bloco(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  proximoId += 1;
  const startLocalTime = overrides.startLocalTime ?? null;
  const plannedMinutes = overrides.plannedMinutes ?? 30;
  const derivado = derivarFim(startLocalTime, plannedMinutes);
  return {
    id: `b${proximoId}`,
    localDate: "2026-09-07",
    position: "1",
    startLocalTime,
    plannedMinutes,
    activity: "other",
    pomodoroCycles: null,
    title: null,
    deckId: null,
    pageId: null,
    subjectId: null,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    endLocalTime: derivado.endLocalTime,
    crossesMidnight: derivado.crossesMidnight,
    ...overrides,
  };
}

const DIAS_DA_SEMANA = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-12",
  "2026-09-13",
];

function semana(blocosPorDia: Partial<Record<string, BlocoPlanejado[]>> = {}): SemanaDeEstudo {
  const dias: DiaDaSemana[] = DIAS_DA_SEMANA.map((data) => ({
    data,
    blocos: blocosPorDia[data] ?? [],
    minutosRealizados: 0,
  }));
  return { inicio: "2026-09-07", metaMinutos: 480, dias };
}

/**
 * A coluna de um dia, ou lança — `semana()` sempre gera os 7 dias fixos de
 * `DIAS_DA_SEMANA`, então "não achou" é sempre bug do teste, nunca caso
 * esperado; lançar em vez de `!` deixa isso explícito sem calar o
 * compilador (regra de nunca usar non-null assertion sem justificar).
 */
function colunaDoDia(grade: GradeSemana, data: string): ColunaDaGrade {
  const coluna = grade.colunas.find((c) => c.data === data);
  if (!coluna) throw new Error(`nenhuma coluna para ${data} — bug no fixture do teste, não no código`);
  return coluna;
}

describe("minutosParaRotulo", () => {
  it("570 minutos vira '09:30'", () => {
    expect(minutosParaRotulo(570)).toBe("09:30");
  });

  it("0 minutos vira '00:00'", () => {
    expect(minutosParaRotulo(0)).toBe("00:00");
  });
});

describe("construirGrade — semana vazia (sem NENHUM bloco com horário)", () => {
  it("sem bloco algum: temBlocoComHorario é false e não há faixas", () => {
    const grade = construirGrade(semana());

    expect(grade.temBlocoComHorario).toBe(false);
    expect(grade.faixas).toHaveLength(0);
  });

  it("com blocos, mas todos SEM horário: ainda é 'vazia' pra grade, e os blocos aparecem em `semHorario` — não somem", () => {
    const semTitulo = bloco({ localDate: "2026-09-07", startLocalTime: null, title: "Ler capítulo 3" });
    const grade = construirGrade(semana({ "2026-09-07": [semTitulo] }));

    expect(grade.temBlocoComHorario).toBe(false);
    expect(grade.faixas).toHaveLength(0);
    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.semHorario).toEqual([semTitulo]);
    expect(coluna.blocosPosicionados).toHaveLength(0);
  });
});

describe("construirGrade — posiciona o bloco na célula certa (dia + linha)", () => {
  it("bloco alinhado à faixa de 30min (09:00, 25min) cabe em UMA linha, sem perder a duração real", () => {
    const pomodoro = bloco({
      localDate: "2026-09-08",
      startLocalTime: "09:00",
      plannedMinutes: 25,
      activity: "pomodoro",
    });
    const grade = construirGrade(semana({ "2026-09-08": [pomodoro] }));

    const coluna = colunaDoDia(grade, "2026-09-08");
    expect(coluna.blocosPosicionados).toHaveLength(1);
    const posicao = coluna.blocosPosicionados[0];
    if (!posicao) throw new Error("bloco não foi posicionado na grade");
    expect(posicao.linhaSpan).toBe(1); // cabe numa linha de 30min mesmo tendo só 25min
    expect(posicao.horaInicio).toBe("09:00");
    expect(posicao.horaFim).toBe("09:25"); // a duração exata não se perde: está no texto, não só na linha
    expect(grade.faixas[posicao.linhaInicio].minutoInicio % GRANULARIDADE_MINUTOS).toBe(0);
  });

  it("bloco que atravessa a fronteira de 30min (09:10, 25min) ocupa DUAS linhas — a granularidade é visual, não corta o bloco", () => {
    const pomodoro = bloco({ localDate: "2026-09-08", startLocalTime: "09:10", plannedMinutes: 25 });
    const grade = construirGrade(semana({ "2026-09-08": [pomodoro] }));

    const posicao = colunaDoDia(grade, "2026-09-08").blocosPosicionados[0];
    expect(posicao?.linhaSpan).toBe(2);
  });

  it("bloco de 90min (3 faixas de 30) ocupa 3 linhas — o título não se repete (é só uma célula com rowSpan)", () => {
    const revisao = bloco({ localDate: "2026-09-09", startLocalTime: "14:00", plannedMinutes: 90, activity: "review" });
    const grade = construirGrade(semana({ "2026-09-09": [revisao] }));

    const posicao = colunaDoDia(grade, "2026-09-09").blocosPosicionados[0];
    expect(posicao?.linhaSpan).toBe(3);
    expect(posicao?.horaFim).toBe("15:30");
  });

  it("dois blocos em dias DIFERENTES, mesmo horário, cada um na coluna do seu próprio dia", () => {
    const segunda = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 30 });
    const terca = bloco({ localDate: "2026-09-08", startLocalTime: "10:00", plannedMinutes: 30 });
    const grade = construirGrade(semana({ "2026-09-07": [segunda], "2026-09-08": [terca] }));

    const colunaSegunda = colunaDoDia(grade, "2026-09-07");
    const colunaTerca = colunaDoDia(grade, "2026-09-08");
    expect(colunaSegunda.blocosPosicionados.map((p) => p.bloco.id)).toEqual([segunda.id]);
    expect(colunaTerca.blocosPosicionados.map((p) => p.bloco.id)).toEqual([terca.id]);
  });
});

describe("construirGrade — faixa de horário derivada dos blocos, não fixa", () => {
  it("semana só com blocos de madrugada NÃO gera uma grade 7h–23h — a faixa cobre o horário real", () => {
    const madrugada = bloco({ localDate: "2026-09-07", startLocalTime: "02:00", plannedMinutes: 30 });
    const grade = construirGrade(semana({ "2026-09-07": [madrugada] }));

    const primeiraFaixa = grade.faixas[0].minutoInicio;
    expect(primeiraFaixa).toBeLessThanOrEqual(2 * 60);
    // não injeta uma faixa às 7h só porque é o "padrão" de outra ferramenta
    expect(grade.faixas.some((f) => f.minutoInicio === 7 * 60)).toBe(false);
  });

  it("um único bloco curto ainda gera uma grade com várias linhas (mínimo de 3h), não uma grade de uma linha só", () => {
    const curto = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 15 });
    const grade = construirGrade(semana({ "2026-09-07": [curto] }));

    expect(grade.faixas.length).toBeGreaterThanOrEqual(6); // 3h / 30min
  });

  it("a faixa nunca ultrapassa a meia-noite (23:45 + bloco curto)", () => {
    // Achado do revisor: 23:45 + 15min dá EXATAMENTE 00:00 (0 minutos de
    // sobra) — este caso passa, mas por coincidência aritmética, nunca
    // exercitou um bloco que de verdade atravessa pro dia seguinte (ver o
    // teste com 30min logo abaixo, que tem 15min de sobra real).
    const tarde = bloco({ localDate: "2026-09-07", startLocalTime: "23:45", plannedMinutes: 15 });
    const grade = construirGrade(semana({ "2026-09-07": [tarde] }));

    const ultimaFaixa = grade.faixas.at(-1);
    if (!ultimaFaixa) throw new Error("grade sem faixa alguma — bug no fixture do teste, não no código");
    expect(ultimaFaixa.minutoInicio).toBeLessThan(24 * 60);
  });

  it("bloco que atravessa a meia-noite DE VERDADE (23:45 + 30min, termina 00:15): texto certo, célula para na última linha do dia, sinal presente", () => {
    const estudoNoturno = bloco({ localDate: "2026-09-07", startLocalTime: "23:45", plannedMinutes: 30 });
    // `derivarFim` (topo do arquivo) espelha a regra do backend: 23:45+30min
    // estoura pra 00:15 do dia seguinte — confere a fixture antes de confiar
    // nela, porque é exatamente essa sobra que o achado do revisor cobra.
    expect(estudoNoturno.endLocalTime).toBe("00:15");
    expect(estudoNoturno.crossesMidnight).toBe(true);

    const grade = construirGrade(semana({ "2026-09-07": [estudoNoturno] }));
    const coluna = colunaDoDia(grade, "2026-09-07");
    const posicao = coluna.blocosPosicionados[0];
    if (!posicao) throw new Error("bloco não foi posicionado na grade");

    // 1) o texto da célula mostra o intervalo certo — "00:15" real, nunca o
    //    "24:00" que o clipe interno em minutos produziria se fosse exibido cru.
    expect(posicao.horaFim).toBe("00:15");
    // 2) o alcance da célula (linhaInicio..linhaFim via linhaSpan) para na
    //    última linha da grade DAQUELE DIA — nunca inventa uma linha além da meia-noite.
    expect(posicao.linhaInicio + posicao.linhaSpan - 1).toBe(grade.faixas.length - 1);
    // 3) o sinal de "continua amanhã": o modelo carrega `crossesMidnight` até
    //    a célula (`BlocoNaCelula.bloco`), é o que `GradeSemanal.tsx` usa pra
    //    desenhar o aviso visível+acessível — sem isto a UI não teria como saber.
    expect(posicao.bloco.crossesMidnight).toBe(true);
  });
});

describe("construirGrade — dois blocos no mesmo horário do mesmo dia não se sobrepõem", () => {
  it("horários que se cruzam recebem lanes diferentes", () => {
    const primeiro = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Matemática" });
    const segundo = bloco({ localDate: "2026-09-07", startLocalTime: "10:30", plannedMinutes: 30, title: "Física" });
    const grade = construirGrade(semana({ "2026-09-07": [primeiro, segundo] }));

    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.totalLanes).toBe(2);
    const lanes = coluna.blocosPosicionados.map((p) => p.lane);
    expect(new Set(lanes).size).toBe(2); // lanes diferentes = nunca desenhados um sobre o outro
  });

  it("horários que só se TOCAM (um termina quando o outro começa) NÃO são conflito — mesma lane", () => {
    const primeiro = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 30 });
    const segundo = bloco({ localDate: "2026-09-07", startLocalTime: "10:30", plannedMinutes: 30 });
    const grade = construirGrade(semana({ "2026-09-07": [primeiro, segundo] }));

    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.totalLanes).toBe(1);
  });

  it("três blocos, todos no mesmo horário exato, abrem três lanes", () => {
    const blocos = [0, 1, 2].map(() => bloco({ localDate: "2026-09-07", startLocalTime: "09:00", plannedMinutes: 30 }));
    const grade = construirGrade(semana({ "2026-09-07": blocos }));

    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.totalLanes).toBe(3);
  });

  it("lanes são contadas POR GRUPO de conflito: um bloco sozinho à tarde não paga pelo conflito da manhã", () => {
    const manha = [0, 1, 2].map(() => bloco({ localDate: "2026-09-07", startLocalTime: "09:00", plannedMinutes: 30 }));
    const tarde = bloco({ localDate: "2026-09-07", startLocalTime: "14:00", plannedMinutes: 40, title: "Sozinho" });
    const grade = construirGrade(semana({ "2026-09-07": [...manha, tarde] }));

    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.totalLanes).toBe(3); // o máximo do dia continua sendo o do pior grupo
    expect(coluna.grupos).toHaveLength(2);
    expect(coluna.grupos[0]).toMatchObject({ inicio: 9 * 60, fim: 9 * 60 + 30, totalLanes: 3 });
    expect(coluna.grupos[0].blocos).toHaveLength(3);
    expect(coluna.grupos[1]).toMatchObject({ inicio: 14 * 60, fim: 14 * 60 + 40, totalLanes: 1 });
    const sozinho = coluna.blocosPosicionados.find((p) => p.bloco.title === "Sozinho");
    expect(sozinho).toMatchObject({ lane: 0, totalLanes: 1, grupo: 1 });
  });

  it("o par de terça da vitrine (09:00+50 e 09:30+45, mais um bloco solto às 14:00) cai no MESMO grupo, em lanes distintas — nunca lane 0 de dois grupos ocupando o mesmo lugar", () => {
    // Os horários REAIS de `src/vitrine/cenarios.tsx` (terça, 2026-09-08):
    // o defeito relatado era os dois blocos desenhados um por cima do outro,
    // e a suspeita era cada um receber lane 0 de um grupo diferente.
    const historia = bloco({ localDate: "2026-09-08", startLocalTime: "09:00", plannedMinutes: 50, title: "História" });
    const redacao = bloco({ localDate: "2026-09-08", startLocalTime: "09:30", plannedMinutes: 45, title: "Redação" });
    const biologia = bloco({ localDate: "2026-09-08", startLocalTime: "14:00", plannedMinutes: 40, title: "Biologia" });
    const grade = construirGrade(semana({ "2026-09-08": [historia, redacao, biologia] }));

    const coluna = colunaDoDia(grade, "2026-09-08");
    const posHistoria = coluna.blocosPosicionados.find((p) => p.bloco.title === "História");
    const posRedacao = coluna.blocosPosicionados.find((p) => p.bloco.title === "Redação");
    const posBiologia = coluna.blocosPosicionados.find((p) => p.bloco.title === "Biologia");
    if (!posHistoria || !posRedacao || !posBiologia) throw new Error("bloco da fixture não posicionado");

    expect(coluna.grupos).toHaveLength(2);
    expect(posHistoria.grupo).toBe(posRedacao.grupo);
    expect(posHistoria.lane).not.toBe(posRedacao.lane);
    expect(new Set([posHistoria.lane, posRedacao.lane])).toEqual(new Set([0, 1]));
    expect(posHistoria.totalLanes).toBe(2);
    expect(posRedacao.totalLanes).toBe(2);
    expect(coluna.grupos[posHistoria.grupo]).toMatchObject({ inicio: 9 * 60, fim: 10 * 60 + 15, totalLanes: 2 });
    // O bloco das 14:00 é outro grupo, sozinho, e não paga pelo conflito da manhã.
    expect(posBiologia).toMatchObject({ lane: 0, totalLanes: 1 });
    expect(posBiologia.grupo).not.toBe(posHistoria.grupo);
  });

  it("conflito em cadeia (A cruza B, B cruza C, A não cruza C) é UM grupo só, com as lanes que a cadeia precisa", () => {
    const a = bloco({ localDate: "2026-09-07", startLocalTime: "09:00", plannedMinutes: 50, title: "A" });
    const b = bloco({ localDate: "2026-09-07", startLocalTime: "09:30", plannedMinutes: 45, title: "B" });
    const c = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 30, title: "C" });
    const grade = construirGrade(semana({ "2026-09-07": [a, b, c] }));

    const coluna = colunaDoDia(grade, "2026-09-07");
    expect(coluna.grupos).toHaveLength(1);
    // A e C não se cruzam, então C reaproveita a lane de A — o grupo precisa de 2, não 3.
    expect(coluna.grupos[0]).toMatchObject({ inicio: 9 * 60, fim: 10 * 60 + 30, totalLanes: 2 });
    expect(coluna.grupos[0].blocos.map((p) => p.bloco.title)).toEqual(["A", "B", "C"]);
  });
});
