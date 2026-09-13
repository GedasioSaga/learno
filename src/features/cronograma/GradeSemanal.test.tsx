import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listarMaterias, type BlocoPlanejado, type DiaDaSemana, type Materia, type SemanaDeEstudo } from "../../lib/ipc";
import { GradeSemanal } from "./GradeSemanal";
import { useCronogramaStore } from "./store";

// `GradeSemanal` carrega matérias via `useCronogramaStore` (`carregarMaterias`,
// que chama `listarMaterias()` de verdade) — sem mock, o teste bateria no
// `invoke` real do Tauri, inexistente em jsdom. Mesmo padrão de
// `ConteudoDeCronograma.test.tsx`: mocka só o que faz IPC, mantém o resto real.
vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, listarMaterias: vi.fn() };
});

const listarMateriasMock = vi.mocked(listarMaterias);

function materia(overrides: Partial<Materia> = {}): Materia {
  return {
    id: "s1",
    name: "Física",
    color: "roxo",
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listarMateriasMock.mockResolvedValue([]);
  useCronogramaStore.setState({ materias: [], materiasStatus: "idle" });
});

let proximoId = 0;

function pad2(valor: number): string {
  return String(valor).padStart(2, "0");
}

/** `endLocalTime`/`crossesMidnight` são DERIVADOS pelo backend — ver a mesma função em `grade.test.ts`. */
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
  "2026-09-07", // segunda
  "2026-09-08", // terça
  "2026-09-09", // quarta
  "2026-09-10", // quinta
  "2026-09-11", // sexta
  "2026-09-12", // sábado
  "2026-09-13", // domingo
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
 * A posição de um bloco na grade é o que `cronograma-grade.css` lê: a
 * coluna do dia (`data-dia`) e as variáveis CSS em minutos (`--inicio`
 * desde o topo da grade, `--duracao`) mais a lane. Afirmar sobre elas é
 * afirmar EM QUE lugar o bloco caiu, não só que ele apareceu.
 */
function posicaoDoBloco(texto: string): { dia: string | null; inicio: string; duracao: string; lane: string } {
  const bloco = screen.getByText(texto).closest<HTMLElement>('[data-slot="bloco-na-grade"]');
  if (!bloco) throw new Error(`bloco "${texto}" não está na grade`);
  return {
    dia: bloco.closest<HTMLElement>("[data-dia]")?.getAttribute("data-dia") ?? null,
    inicio: bloco.style.getPropertyValue("--inicio"),
    duracao: bloco.style.getPropertyValue("--duracao"),
    lane: bloco.style.getPropertyValue("--lane"),
  };
}

describe("GradeSemanal", () => {
  it("semana totalmente sem horário mostra estado vazio honesto, não uma grade sem nada dentro", () => {
    render(<GradeSemanal semana={semana()} />);

    expect(screen.getByText(/Nenhum bloco com horário definido/)).toBeInTheDocument();
    expect(document.querySelector("[data-dia]")).toBeNull();
  });

  it("bloco sem horário não some: aparece na seção 'Sem horário definido'", () => {
    const leitura = bloco({ localDate: "2026-09-09", startLocalTime: null, title: "Ler capítulo 3", activity: "reading" });
    render(<GradeSemanal semana={semana({ "2026-09-09": [leitura] })} />);

    expect(screen.getByText("Sem horário definido")).toBeInTheDocument();
    expect(screen.getByText("Ler capítulo 3")).toBeInTheDocument();
  });

  it("posiciona o bloco no LUGAR certo: coluna do dia certo, minuto de início contado do topo da grade", () => {
    const fisica = bloco({ localDate: "2026-09-07", startLocalTime: "08:00", plannedMinutes: 30, title: "Física" });
    const matematica = bloco({
      localDate: "2026-09-08", // terça
      startLocalTime: "09:00",
      plannedMinutes: 25,
      title: "Matemática",
    });
    render(<GradeSemanal semana={semana({ "2026-09-07": [fisica], "2026-09-08": [matematica] })} />);

    // A grade começa às 08:00 (menor início, arredondado pra hora cheia) —
    // 09:00 é 60 minutos abaixo do topo, na coluna de terça, nunca na de segunda.
    expect(posicaoDoBloco("Matemática")).toMatchObject({ dia: "2026-09-08", inicio: "60", duracao: "25" });
    expect(posicaoDoBloco("Física")).toMatchObject({ dia: "2026-09-07", inicio: "0", duracao: "30" });
  });

  it("bloco de 25 minutos cabe (não desaparece, mostra a duração real, não 30min)", () => {
    const pomodoro = bloco({ localDate: "2026-09-07", startLocalTime: "09:00", plannedMinutes: 25, title: "Pomodoro" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [pomodoro] })} />);

    expect(screen.getByText("Pomodoro")).toBeInTheDocument();
    // Início e fim são spans separados (o CSS decide quanto do horário
    // cabe na largura real) — o texto rendido continua sendo o horário inteiro.
    const grupo = screen.getByRole("group", { name: /Pomodoro/ });
    expect(within(grupo).getByText("09:00")).toBeInTheDocument();
    expect(grupo).toHaveTextContent("09:00–09:25");
  });

  it("bloco curto (uma linha) com a coluna inteira mostra a MESMA informação mínima dos maiores: matéria e horário, não só o título", () => {
    // Sem medida de largura (jsdom) `useLanesQueCabem` devolve Infinity e
    // o bloco fica sozinho na coluna: é o caso "com espaço de sobra" — o
    // que antes rendia só "Pomodoro" (achado da rodada 5: o nível 1 nem
    // tinha matéria, e o horário sumia numa fileira escondida).
    useCronogramaStore.setState({ materias: [materia({ id: "s-ingles", name: "Inglês" })], materiasStatus: "ready" });
    const pomodoro = bloco({ localDate: "2026-09-09", startLocalTime: "08:50", plannedMinutes: 25, title: "Pomodoro", subjectId: "s-ingles" });
    render(<GradeSemanal semana={semana({ "2026-09-09": [pomodoro] })} />);

    const grupo = screen.getByRole("group", { name: /Pomodoro, Inglês/ });
    expect(grupo.getAttribute("data-nivel")).toBe("1");
    expect(grupo.getAttribute("data-dividido")).toBeNull();
    // Título, matéria e horário estão na linha — como texto, dentro do bloco.
    expect(within(grupo).getByText("Pomodoro")).toBeInTheDocument();
    expect(within(grupo).getByText("Inglês")).toBeInTheDocument();
    expect(within(grupo).getByText("08:50")).toBeInTheDocument();
    expect(within(grupo).getByText("–09:15")).toBeInTheDocument();
    // E o que a largura vier a esconder continua recuperável no tooltip.
    expect(grupo.getAttribute("title")).toBe("Pomodoro — Inglês, 08:50–09:15, 25 min");
  });

  it("toda linha que carrega horário termina na marca de omissão, na mesma linha do que a cobre — o que a largura descartar não some em silêncio", () => {
    // jsdom não aplica CSS: a marca (`.grade__bloco-omitido`) só aparece
    // quando o horário (níveis 1 e 2) ou a duração (nível 3) não está por
    // cima dela — `display: none` na lane dividida, fileira escondida do
    // `flex-wrap` na coluna inteira. O que dá pra afirmar aqui é a
    // ESTRUTURA de que a cobertura depende: uma marca por bloco, sempre
    // dentro da mesma `.grade__bloco-linha` do elemento que a cobre, e
    // invisível pro leitor de tela (o `aria-label` já tem o horário).
    useCronogramaStore.setState({ materias: [materia({ id: "s-hist", name: "História" })], materiasStatus: "ready" });
    const nivel1 = bloco({ localDate: "2026-09-07", startLocalTime: "08:00", plannedMinutes: 25, title: "Curto", subjectId: "s-hist" });
    const nivel2 = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 45, title: "Médio", subjectId: "s-hist" });
    const nivel3 = bloco({ localDate: "2026-09-07", startLocalTime: "12:00", plannedMinutes: 50, title: "Longo", subjectId: "s-hist" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [nivel1, nivel2, nivel3] })} />);

    const casos: Array<[string, string, string]> = [
      ["Curto", "1", ".grade__bloco-horario"],
      ["Médio", "2", ".grade__bloco-horario"],
      ["Longo", "3", ".grade__bloco-duracao"],
    ];
    for (const [titulo, nivel, cobertura] of casos) {
      const grupo = screen.getByRole("group", { name: new RegExp(titulo) });
      expect(grupo.getAttribute("data-nivel")).toBe(nivel);
      const marcas = grupo.querySelectorAll(".grade__bloco-omitido");
      expect(marcas).toHaveLength(1);
      const marca = marcas[0];
      expect(marca.getAttribute("aria-hidden")).toBe("true");
      const linha = marca.closest(".grade__bloco-linha");
      expect(linha).not.toBeNull();
      expect(linha?.querySelector(cobertura)).not.toBeNull();
    }
    // Nível 3 segue a mesma ordem de descarte do nível 1: início e fim em
    // spans separados, pro fim cair antes ("09:00", nunca "09:00–09…").
    const longo = screen.getByRole("group", { name: /Longo/ });
    expect(within(longo).getByText("12:00")).toBeInTheDocument();
    expect(within(longo).getByText("–12:50")).toBeInTheDocument();
  });

  it("bloco que atravessa faixas não repete o título — um elemento só, com a altura da duração inteira", () => {
    const revisao = bloco({ localDate: "2026-09-07", startLocalTime: "14:00", plannedMinutes: 90, title: "Revisão longa" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [revisao] })} />);

    expect(screen.getAllByText("Revisão longa")).toHaveLength(1);
    expect(posicaoDoBloco("Revisão longa").duracao).toBe("90");
  });

  it("dois blocos no mesmo horário do mesmo dia aparecem em CÉLULAS diferentes, nunca uma por cima da outra", () => {
    const matematica = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Matemática" });
    const fisica = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Física" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [matematica, fisica] })} />);

    const matematicaNaGrade = posicaoDoBloco("Matemática");
    const fisicaNaGrade = posicaoDoBloco("Física");
    // Mesmo dia, mesmo minuto de início — lanes diferentes, lado a lado.
    expect(matematicaNaGrade.dia).toBe("2026-09-07");
    expect(fisicaNaGrade.dia).toBe("2026-09-07");
    expect(matematicaNaGrade.inicio).toBe(fisicaNaGrade.inicio);
    expect(matematicaNaGrade.lane).not.toBe(fisicaNaGrade.lane);
    // E a coluna sabe que está dividida: é o que `cronograma-grade.css` lê pra dar metade da largura a cada lane.
    expect(screen.getByText("Matemática").closest("[data-lanes]")?.getAttribute("data-lanes")).toBe("2");
  });

  it("bloco sozinho num dia que tem conflito em OUTRO horário fica com a largura inteira (lanes por grupo, não por dia)", () => {
    const a = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Matemática" });
    const b = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Física" });
    const sozinho = bloco({ localDate: "2026-09-07", startLocalTime: "15:00", plannedMinutes: 40, title: "Sozinho" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [a, b, sozinho] })} />);

    const dividido = screen.getByText("Matemática").closest<HTMLElement>('[data-slot="bloco-na-grade"]');
    expect(dividido?.style.getPropertyValue("--lanes")).toBe("2");
    expect(dividido?.getAttribute("data-dividido")).toBe("true");
    const inteiro = screen.getByText("Sozinho").closest<HTMLElement>('[data-slot="bloco-na-grade"]');
    expect(inteiro?.style.getPropertyValue("--lanes")).toBe("1");
    expect(inteiro?.getAttribute("data-dividido")).toBeNull();
  });

  describe("conflito mais largo que a coluna: '+N' em vez de fatia ilegível", () => {
    // jsdom não mede layout: `useLanesQueCabem` precisa de `ResizeObserver` e
    // de uma largura real de coluna. Simula os dois — uma coluna de 100px,
    // onde cabe UMA lane de 64px — pra exercitar o caminho do "+N".
    const LARGURA_DE_COLUNA_DE_UMA_LANE = 100;
    let observadores: ResizeObserverCallback[];

    beforeEach(() => {
      observadores = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            observadores.push(callback);
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const largura = this.classList.contains("grade__coluna") ? LARGURA_DE_COLUNA_DE_UMA_LANE : 0;
        return { x: 0, y: 0, top: 0, left: 0, right: largura, bottom: 0, width: largura, height: 0, toJSON: () => ({}) };
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("o excedente não some: vira um botão '+N' que abre um painel com os blocos escondidos, inteiros", async () => {
      const a = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Matemática" });
      const b = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Física" });
      const c = bloco({ localDate: "2026-09-07", startLocalTime: "10:30", plannedMinutes: 30, title: "Química" });
      const user = userEvent.setup();
      render(<GradeSemanal semana={semana({ "2026-09-07": [a, b, c] })} />);

      // Só a primeira lane fica na grade, com a largura inteira (não dividida em 3).
      const naGrade = screen.getByText("Matemática").closest<HTMLElement>('[data-slot="bloco-na-grade"]');
      expect(naGrade?.style.getPropertyValue("--lanes")).toBe("1");
      expect(screen.queryByText("Física")).not.toBeInTheDocument();
      expect(screen.queryByText("Química")).not.toBeInTheDocument();

      const mais = screen.getByRole("button", { name: /mais 2 blocos no mesmo horário, 10:00 às 11:00/ });
      expect(mais).toHaveTextContent("+2");
      expect(mais).toHaveAttribute("aria-expanded", "false");

      await user.click(mais);

      const painel = screen.getByRole("dialog", { name: /mais 2 blocos/ });
      expect(mais).toHaveAttribute("aria-expanded", "true");
      expect(painel).toHaveFocus();
      // Os dois escondidos aparecem inteiros: título, matéria/horário e duração.
      expect(within(painel).getByText("Física")).toBeInTheDocument();
      expect(within(painel).getByText("Química")).toBeInTheDocument();
      expect(within(painel).getByText("10:30–11:00")).toBeInTheDocument();
      expect(within(painel).getByText("30 min")).toBeInTheDocument();

      // Escape fecha e devolve o foco ao botão.
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mais).toHaveFocus();
    });

    it("sem excedente não há '+N': dois blocos numa coluna onde cabe um só ainda escondem só o segundo", () => {
      const a = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Matemática" });
      const b = bloco({ localDate: "2026-09-07", startLocalTime: "10:00", plannedMinutes: 60, title: "Física" });
      render(<GradeSemanal semana={semana({ "2026-09-07": [a, b] })} />);

      expect(screen.getByRole("button", { name: /mais 1 bloco no mesmo horário/ })).toHaveTextContent("+1");
      expect(screen.getAllByRole("button", { name: /mais \d+ blocos? no mesmo horário/ })).toHaveLength(1);
    });
  });

  it("cada célula com bloco identifica dia e horário em texto (nunca só cor) — acessibilidade da tabela", () => {
    const bloco1 = bloco({ localDate: "2026-09-10", startLocalTime: "11:00", plannedMinutes: 30, title: "Química" });
    render(<GradeSemanal semana={semana({ "2026-09-10": [bloco1] })} />);

    const grupo = screen.getByRole("group", { name: /qui.*11:00.*11:30.*Química/ });
    expect(grupo).toBeInTheDocument();
    // A cor não é a única pista: o nome está escrito no texto visível do bloco.
    expect(within(grupo).getByText("Química")).toBeInTheDocument();
  });

  it("sete dias nomeados pra leitor de tela (dia da semana + data), com hoje marcado por `aria-current`", () => {
    const bloco1 = bloco({ localDate: "2026-09-07", startLocalTime: "08:00", plannedMinutes: 30 });
    render(<GradeSemanal semana={semana({ "2026-09-07": [bloco1] })} />);

    // Cabeçalho: um por dia, com o nome completo — "seg 7 de set.", não só "7".
    const cabecalhos = document.querySelectorAll(".grade__dia");
    expect(cabecalhos).toHaveLength(7);
    expect(cabecalhos[0].getAttribute("aria-label")).toMatch(/^seg 7 de set\./);
    expect(cabecalhos[6].getAttribute("aria-label")).toMatch(/^dom 13 de set\./);
    // Colunas: uma por dia, nomeadas do mesmo jeito.
    expect(document.querySelectorAll("[data-dia]")).toHaveLength(7);
    expect(screen.getByRole("group", { name: "ter 8 de set." })).toBeInTheDocument();
    // Hoje (se cair na semana) é marcado semanticamente, não só pela bolinha.
    const hoje = document.querySelector('.grade__dia[data-hoje="true"]');
    if (hoje) expect(hoje.getAttribute("aria-current")).toBe("date");
  });

  it("a calha rotula só a hora cheia (07:00, 08:00…), nunca a meia hora — e é decoração, fora da árvore de acessibilidade", () => {
    const bloco1 = bloco({ localDate: "2026-09-07", startLocalTime: "07:00", plannedMinutes: 90 });
    render(<GradeSemanal semana={semana({ "2026-09-07": [bloco1] })} />);

    const calha = document.querySelector(".grade__calha");
    expect(calha?.getAttribute("aria-hidden")).toBe("true");
    const rotulos = Array.from(calha?.querySelectorAll(".grade__hora") ?? []).map((el) => el.textContent);
    expect(rotulos).toContain("07:00");
    expect(rotulos).toContain("08:00");
    expect(rotulos).not.toContain("07:30");
    expect(rotulos).not.toContain("08:30");
  });

  it("bloco sem horário na faixa do topo herda a cor da matéria (acento), não fica cinza", async () => {
    listarMateriasMock.mockResolvedValue([materia({ id: "s1", color: "mint" })]);
    const leitura = bloco({ localDate: "2026-09-09", startLocalTime: null, title: "Ler capítulo 3", subjectId: "s1" });
    render(<GradeSemanal semana={semana({ "2026-09-09": [leitura] })} />);

    const chip = (await screen.findByText("Ler capítulo 3")).closest('[data-slot="bloco-card"]');
    expect(chip?.getAttribute("data-cor")).toBe("mint");
    // E continua removível: o ✕ é o mesmo botão real da visão de Colunas.
    expect(within(chip as HTMLElement).getByRole("button", { name: /Remover bloco/ })).toBeInTheDocument();
  });

  it("bloco COM matéria usa a cor da matéria (Materia.color) — achado do revisor: antes era hash do título, nunca identidade", async () => {
    listarMateriasMock.mockResolvedValue([materia({ id: "s1", color: "roxo" })]);
    const aula = bloco({
      localDate: "2026-09-07",
      startLocalTime: "09:00",
      plannedMinutes: 30,
      title: "Qualquer título",
      subjectId: "s1",
    });
    render(<GradeSemanal semana={semana({ "2026-09-07": [aula] })} />);

    const grupo = await screen.findByRole("group", { name: /Qualquer título/ });
    expect(grupo.getAttribute("data-cor")).toBe("roxo");
  });

  it("bloco SEM matéria continua colorido pelo hash do rótulo (fallback preservado, não apagado)", async () => {
    const leitura = bloco({ localDate: "2026-09-07", startLocalTime: "09:00", plannedMinutes: 30, title: "Ler capítulo 3" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [leitura] })} />);

    const grupo = await screen.findByRole("group", { name: /Ler capítulo 3/ });
    // Sem `subjectId`, não há matéria pra herdar cor: cai no hash — só
    // confere que alguma das 8 cores válidas foi atribuída, sem lançar.
    expect(grupo.getAttribute("data-cor")).not.toBeNull();
  });

  it("bloco que atravessa a meia-noite mostra um sinal visível E acessível de 'continua amanhã' — nunca só cor, nunca só ícone", async () => {
    // 23:45 + 30min termina 00:15 do dia seguinte (sobra real — o mesmo
    // cenário do achado do revisor em `grade.test.ts`).
    const estudoNoturno = bloco({
      localDate: "2026-09-07",
      startLocalTime: "23:45",
      plannedMinutes: 30,
      title: "Revisão noturna",
    });
    render(<GradeSemanal semana={semana({ "2026-09-07": [estudoNoturno] })} />);

    // Texto visível na célula — não é só cor nem só um ícone sem alternativa textual.
    expect(await screen.findByText("continua amanhã")).toBeInTheDocument();
    // E no `aria-label` do grupo, pra quem usa leitor de tela.
    const grupo = screen.getByRole("group", { name: /continua no dia seguinte/ });
    expect(within(grupo).getByText("Revisão noturna")).toBeInTheDocument();
  });

  it("bloco que NÃO atravessa a meia-noite não mostra o sinal 'continua amanhã'", async () => {
    const tarde = bloco({ localDate: "2026-09-07", startLocalTime: "20:00", plannedMinutes: 30, title: "Leitura da noite" });
    render(<GradeSemanal semana={semana({ "2026-09-07": [tarde] })} />);

    await screen.findByText("Leitura da noite");
    expect(screen.queryByText("continua amanhã")).not.toBeInTheDocument();
  });
});
