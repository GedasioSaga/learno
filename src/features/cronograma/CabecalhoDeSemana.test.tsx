import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copiarSemana, semanaDeEstudo, type BlocoPlanejado, type DiaDaSemana, type SemanaDeEstudo } from "../../lib/ipc";
import { CabecalhoDeSemana } from "./CabecalhoDeSemana";
import { useCronogramaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    semanaDeEstudo: vi.fn(),
    copiarSemana: vi.fn(),
  };
});

const semanaDeEstudoMock = vi.mocked(semanaDeEstudo);
const copiarSemanaMock = vi.mocked(copiarSemana);

/** Fixture mínima de `BlocoPlanejado` — só os campos que `contarBlocos` (por dia, `blocos.length`) precisa existir de verdade; o resto é preenchimento plausível. */
function blocoDeExemplo(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: "2026-08-31",
    position: "1",
    startLocalTime: "09:00",
    plannedMinutes: 30,
    activity: "other",
    pomodoroCycles: null,
    title: null,
    deckId: null,
    pageId: null,
    subjectId: null,
    createdAt: "2026-08-31T09:00:00Z",
    updatedAt: "2026-08-31T09:00:00Z",
    endLocalTime: "09:30",
    crossesMidnight: false,
    ...overrides,
  };
}

function diasComBlocos(inicio: string, blocosPorDia: number[]): DiaDaSemana[] {
  return blocosPorDia.map((quantidade, indice) => ({
    data: somarDias(inicio, indice),
    blocos: Array.from({ length: quantidade }, (_valor, i) => blocoDeExemplo({ id: `${inicio}-${indice}-${i}` })),
    minutosRealizados: 0,
  }));
}

// Reimplementação mínima local (mesma técnica de `date-utils.ts`) só para
// montar as fixtures do teste — não é a função sob teste.
function somarDias(dataIso: string, dias: number): string {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const data = new Date(ano, mes - 1, dia + dias);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
}

function semana(overrides: Partial<SemanaDeEstudo> = {}): SemanaDeEstudo {
  return {
    inicio: "2026-09-07",
    metaMinutos: 480,
    dias: diasComBlocos("2026-09-07", [0, 0, 0, 0, 0, 0, 0]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useCronogramaStore.setState({
    status: "ready",
    errorMessage: null,
    inicioDaSemana: "2026-09-07",
    semana: semana(),
  });
});

describe("CabecalhoDeSemana — semana modelo", () => {
  it("'Copiar semana passada' mostra a confirmação com a contagem certa e as duas semanas por extenso", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana({ inicio: "2026-08-31", dias: diasComBlocos("2026-08-31", [2, 1, 0, 0, 0, 0, 0]) }));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));

    // A ORIGEM pedida ao backend é a semana passada, nunca a atual — trocar
    // as duas apaga silenciosamente o planejamento do ponto de vista do usuário.
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-08-31");

    const confirmacao = await screen.findByRole("alertdialog");
    expect(confirmacao).toHaveTextContent("Copiar 3 blocos");
    expect(confirmacao).toHaveTextContent("31 de agosto de 2026 a 6 de setembro de 2026");
    expect(confirmacao).toHaveTextContent("7 de setembro de 2026 a 13 de setembro de 2026");
  });

  it("confirmar chama copiarSemana com (origem, destino) certos e cancelar não chama nada", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockImplementation((inicio) => Promise.resolve(semana({ inicio, dias: diasComBlocos(inicio, [1, 0, 0, 0, 0, 0, 0]) })));
    copiarSemanaMock.mockResolvedValue([]);

    render(<CabecalhoDeSemana semana={semana()} />);

    // Cancelar primeiro: fecha sem tocar no IPC de cópia.
    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(copiarSemanaMock).not.toHaveBeenCalled();

    // Agora confirma de verdade.
    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Copiar" }));

    expect(copiarSemanaMock).toHaveBeenCalledWith("2026-08-31", "2026-09-07");
  });

  it("erro ao copiar vira mensagem visível, e o diálogo continua aberto", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockImplementation((inicio) => Promise.resolve(semana({ inicio, dias: diasComBlocos(inicio, [1, 0, 0, 0, 0, 0, 0]) })));
    copiarSemanaMock.mockRejectedValue(new Error("falha de rede"));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Copiar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível copiar a semana modelo.");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("semana de destino sem bloco nenhum não mostra o aviso de soma", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana({ inicio: "2026-08-31", dias: diasComBlocos("2026-08-31", [1, 0, 0, 0, 0, 0, 0]) }));

    render(<CabecalhoDeSemana semana={semana({ dias: diasComBlocos("2026-09-07", [0, 0, 0, 0, 0, 0, 0]) })} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));

    const confirmacao = await screen.findByRole("alertdialog");
    expect(confirmacao).not.toHaveTextContent("já tem");
  });

  it("semana de destino com blocos mostra o aviso de que o resultado é a soma dos dois", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana({ inicio: "2026-08-31", dias: diasComBlocos("2026-08-31", [1, 0, 0, 0, 0, 0, 0]) }));

    render(<CabecalhoDeSemana semana={semana({ dias: diasComBlocos("2026-09-07", [2, 0, 0, 0, 0, 0, 0]) })} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));

    const confirmacao = await screen.findByRole("alertdialog");
    expect(confirmacao).toHaveTextContent("A semana de destino já tem 2 blocos — o resultado será a soma dos dois, não uma substituição.");
  });

  it("cancelar o diálogo de confirmação depois de um erro de cópia também limpa o banner global de erro", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockImplementation((inicio) => Promise.resolve(semana({ inicio, dias: diasComBlocos(inicio, [1, 0, 0, 0, 0, 0, 0]) })));
    copiarSemanaMock.mockRejectedValue(new Error("falha de rede"));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Copiar" }));
    await screen.findByRole("alert");

    // `copiarSemanaModelo` (store.ts) grava o erro em `errorMessage` global
    // além do erro local do diálogo — sem limpar os dois, o banner de
    // `ConteudoDeCronograma.tsx` ficaria preso na tela depois de fechado.
    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível copiar a semana modelo.");

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useCronogramaStore.getState().errorMessage).toBeNull();
  });

  it("cancelar 'outra semana' enquanto a verificação está em voo descarta a resposta tardia — não abre a confirmação", async () => {
    const user = userEvent.setup();
    let resolverVerificacao!: (valor: SemanaDeEstudo) => void;
    semanaDeEstudoMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolverVerificacao = resolve;
        }),
    );

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar de outra semana…" }));
    fireEvent.change(screen.getByLabelText("Copiar a semana que contém"), { target: { value: "2026-08-20" } });
    await user.click(screen.getByRole("button", { name: "Usar esta semana" }));

    expect(await screen.findByText("Verificando blocos da semana escolhida…")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Verificando blocos da semana escolhida…")).not.toBeInTheDocument();

    // A resposta chega DEPOIS do cancelamento — não deve reabrir nada.
    resolverVerificacao(semana({ inicio: "2026-08-17", dias: diasComBlocos("2026-08-17", [4, 0, 0, 0, 0, 0, 0]) }));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Verificando blocos da semana escolhida…")).not.toBeInTheDocument();
  });

  it("erro ao verificar a semana passada mostra alerta local e não abre a confirmação", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockRejectedValue(new Error("falha de rede"));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar semana passada" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível verificar a semana escolhida.");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("erro ao verificar 'outra semana' mostra alerta local e não abre a confirmação", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockRejectedValue(new Error("falha de rede"));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar de outra semana…" }));
    fireEvent.change(screen.getByLabelText("Copiar a semana que contém"), { target: { value: "2026-08-20" } });
    await user.click(screen.getByRole("button", { name: "Usar esta semana" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível verificar a semana escolhida.");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("escolher outra semana calcula a segunda-feira daquela semana como origem", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockImplementation((inicio) => Promise.resolve(semana({ inicio, dias: diasComBlocos(inicio, [4, 0, 0, 0, 0, 0, 0]) })));

    render(<CabecalhoDeSemana semana={semana()} />);

    await user.click(screen.getByRole("button", { name: "Copiar de outra semana…" }));
    // `<input type="date">` só aceita "YYYY-MM-DD" via evento nativo — mesma
    // convenção de `date-cell.test.tsx`, `type` do userEvent não é confiável aqui.
    fireEvent.change(screen.getByLabelText("Copiar a semana que contém"), { target: { value: "2026-08-20" } });
    await user.click(screen.getByRole("button", { name: "Usar esta semana" }));

    // 20/08/2026 é uma quinta-feira; a segunda daquela semana é 17/08/2026.
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-08-17");
    const confirmacao = await screen.findByRole("alertdialog");
    expect(confirmacao).toHaveTextContent("17 de agosto de 2026");
  });
});
