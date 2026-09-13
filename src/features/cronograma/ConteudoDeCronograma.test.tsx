import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { criarBloco, removerBloco, semanaDeEstudo, type BlocoPlanejado, type SemanaDeEstudo } from "../../lib/ipc";
import { ConteudoDeCronograma } from "./ConteudoDeCronograma";
import { useCronogramaStore } from "./store";

/**
 * Fixture de `BlocoPlanejado` com todos os campos preenchidos com um padrão
 * plausível — `endLocalTime`/`crossesMidnight` (Fase 1 do Cronograma) são
 * DERIVADOS pelo backend, nunca digitados; aqui bastam valores coerentes com
 * `startLocalTime`/`plannedMinutes` do próprio teste, então quem chama só
 * sobrescreve o que o cenário precisa.
 */
function blocoDeExemplo(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: "2026-09-07",
    position: "1",
    startLocalTime: "09:00",
    plannedMinutes: 30,
    activity: "other",
    pomodoroCycles: null,
    title: null,
    deckId: null,
    pageId: null,
    subjectId: null,
    createdAt: "2026-09-07T09:00:00Z",
    updatedAt: "2026-09-07T09:00:00Z",
    endLocalTime: "09:30",
    crossesMidnight: false,
    ...overrides,
  };
}

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    semanaDeEstudo: vi.fn(),
    definirMetaSemanal: vi.fn(),
    criarBloco: vi.fn(),
    removerBloco: vi.fn(),
  };
});

const semanaDeEstudoMock = vi.mocked(semanaDeEstudo);
const criarBlocoMock = vi.mocked(criarBloco);
const removerBlocoMock = vi.mocked(removerBloco);

function semana(overrides: Partial<SemanaDeEstudo> = {}): SemanaDeEstudo {
  return {
    inicio: "2026-09-07",
    metaMinutos: 480,
    dias: [
      { data: "2026-09-07", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
      { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useCronogramaStore.setState({
    status: "idle",
    errorMessage: null,
    inicioDaSemana: "2026-09-07",
    semana: null,
    visao: "colunas",
  });
});

describe("ConteudoDeCronograma", () => {
  it("mostra 'Carregando semana…' e depois a semana com as sete colunas", async () => {
    semanaDeEstudoMock.mockResolvedValue(semana());

    render(<ConteudoDeCronograma />);

    expect(screen.getByText("Carregando semana…")).toBeInTheDocument();
    expect(await screen.findByText("Cronograma")).toBeInTheDocument();
    expect(screen.getAllByText(/^(seg|ter|qua|qui|sex|sáb|dom)$/)).toHaveLength(7);
  });

  it("mostra o total planejado x realizado da semana ('Horas na semana X / Y')", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        metaMinutos: 480,
        dias: [
          { data: "2026-09-07", blocos: [], minutosRealizados: 130 },
          { data: "2026-09-08", blocos: [], minutosRealizados: 260 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );

    render(<ConteudoDeCronograma />);

    expect(await screen.findByText("6,5 / 8")).toBeInTheDocument();
  });

  it("uma chamada rejeitada mostra erro em vez de travar em 'Carregando…'", async () => {
    semanaDeEstudoMock.mockRejectedValue(new Error("rede caiu"));

    render(<ConteudoDeCronograma />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a semana.");
  });

  it("dia sem bloco nenhum mostra 'Nada planejado.' em vez de uma coluna vazia muda", async () => {
    semanaDeEstudoMock.mockResolvedValue(semana());

    render(<ConteudoDeCronograma />);

    expect(await screen.findAllByText("Nada planejado.")).toHaveLength(7);
  });

  it("mostra o bloco do dia com horário, atividade e duração", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: [
          {
            data: "2026-09-07",
            minutosRealizados: 0,
            blocos: [
              blocoDeExemplo({
                plannedMinutes: 50,
                activity: "pomodoro",
                pomodoroCycles: 2,
                endLocalTime: "09:50",
              }),
            ],
          },
          { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );

    render(<ConteudoDeCronograma />);

    expect(await screen.findByText("09:00 · Pomodoro")).toBeInTheDocument();
    expect(screen.getByText("2×25 min")).toBeInTheDocument();
  });

  it("bloco recém-criado, com startLocalTime null, mostra só o rótulo — nunca 'undefined'", async () => {
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: [
          {
            data: "2026-09-07",
            minutosRealizados: 0,
            blocos: [
              blocoDeExemplo({
                startLocalTime: null,
                plannedMinutes: 25,
                activity: "reading",
                endLocalTime: null,
              }),
            ],
          },
          { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );

    render(<ConteudoDeCronograma />);

    expect(await screen.findByText("Leitura")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remover bloco de Leitura" })).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it("clicar em '+ bloco', preencher e criar chama criarBloco com o dia certo e recarrega a semana", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana());
    criarBlocoMock.mockResolvedValue(
      blocoDeExemplo({
        id: "novo",
        localDate: "2026-09-08",
        activity: "review",
        title: "Verbos irregulares",
        createdAt: "2026-09-08T09:00:00Z",
        updatedAt: "2026-09-08T09:00:00Z",
      }),
    );

    render(<ConteudoDeCronograma />);

    const colunaTerca = (await screen.findAllByLabelText(/^Adicionar bloco em/))[1];
    await user.click(colunaTerca);

    const formulario = await screen.findByRole("form", { name: "Novo bloco" });
    await user.selectOptions(within(formulario).getByLabelText("Atividade"), "review");
    await user.clear(within(formulario).getByLabelText("Duração (min)"));
    await user.type(within(formulario).getByLabelText("Duração (min)"), "30");
    await user.type(within(formulario).getByLabelText("Título (opcional)"), "Verbos irregulares");
    await user.click(within(formulario).getByRole("button", { name: "Criar" }));

    // `null` explícito, e não `undefined`, nos três opcionais: o formulário
    // agora tem campo de matéria, e `undefined` some do JSON que atravessa o
    // IPC — o backend receberia o argumento AUSENTE em vez de "sem valor".
    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-08", "review", 30, "Verbos irregulares", null, null, null);
    expect(semanaDeEstudoMock).toHaveBeenCalledTimes(2); // o load inicial + o recarregar depois de criar
  });

  it("clicar em remover um bloco chama removerBloco e recarrega", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: [
          {
            data: "2026-09-07",
            minutosRealizados: 0,
            blocos: [
              blocoDeExemplo({
                plannedMinutes: 25,
                activity: "mindmap",
                endLocalTime: "09:25",
              }),
            ],
          },
          { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );
    removerBlocoMock.mockResolvedValue(undefined);

    render(<ConteudoDeCronograma />);

    await user.click(await screen.findByRole("button", { name: "Remover bloco de Mapa mental às 09:00" }));

    expect(removerBlocoMock).toHaveBeenCalledWith("b1");
    expect(semanaDeEstudoMock).toHaveBeenCalledTimes(2);
  });

  it("trocar de visão (Colunas ↔ Grade) preserva os dados da semana — nenhum recarregamento extra", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(
      semana({
        dias: [
          {
            data: "2026-09-07",
            minutosRealizados: 0,
            blocos: [
              blocoDeExemplo({
                plannedMinutes: 50,
                activity: "pomodoro",
                title: "Matemática",
                endLocalTime: "09:50",
              }),
            ],
          },
          { data: "2026-09-08", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-09", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-10", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-11", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-12", blocos: [], minutosRealizados: 0 },
          { data: "2026-09-13", blocos: [], minutosRealizados: 0 },
        ],
      }),
    );

    render(<ConteudoDeCronograma />);
    await screen.findByText("Cronograma");
    expect(screen.getByText("09:00 · Matemática")).toBeInTheDocument(); // visão de Colunas (BlocoCard)

    await user.click(screen.getByRole("button", { name: "Grade" }));

    expect(screen.getByRole("group", { name: /^Grade da semana de/ })).toBeInTheDocument();
    expect(screen.getByText("Matemática")).toBeInTheDocument(); // mesmo bloco, agora na grade

    await user.click(screen.getByRole("button", { name: "Colunas" }));

    expect(screen.getByText("09:00 · Matemática")).toBeInTheDocument(); // volta, dado intacto
    expect(semanaDeEstudoMock).toHaveBeenCalledTimes(1); // trocar de visão nunca busca a semana de novo
  });

  it("navegar para a semana anterior pede a semana certa ao backend", async () => {
    const user = userEvent.setup();
    semanaDeEstudoMock.mockResolvedValue(semana());

    render(<ConteudoDeCronograma />);
    await screen.findByText("Cronograma");

    await user.click(screen.getByRole("button", { name: "‹ Semana anterior" }));

    expect(semanaDeEstudoMock).toHaveBeenLastCalledWith("2026-08-31");
  });
});
