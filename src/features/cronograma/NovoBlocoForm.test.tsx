import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppError,
  atualizarBloco,
  criarBloco,
  listarMaterias,
  semanaDeEstudo,
  type BlocoPlanejado,
  type Materia,
  type SemanaDeEstudo,
} from "../../lib/ipc";
import { NovoBlocoForm } from "./NovoBlocoForm";
import { useCronogramaStore } from "./store";

/** Mesma fixture de `ConteudoDeCronograma.test.tsx` — todos os campos preenchidos com um padrão plausível. */
function blocoDeExemplo(overrides: Partial<BlocoPlanejado> = {}): BlocoPlanejado {
  return {
    id: "b1",
    localDate: "2026-09-07",
    position: "1",
    startLocalTime: null,
    plannedMinutes: 25,
    activity: "pomodoro",
    pomodoroCycles: null,
    title: null,
    deckId: null,
    pageId: null,
    subjectId: null,
    createdAt: "2026-09-07T09:00:00Z",
    updatedAt: "2026-09-07T09:00:00Z",
    endLocalTime: null,
    crossesMidnight: false,
    ...overrides,
  };
}

function materia(overrides: Partial<Materia> = {}): Materia {
  return {
    id: "m1",
    name: "Matemática",
    color: "azul",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

/** Semana mínima e vazia — só para o `load()` que roda depois de criar ter algo determinístico pra resolver, sem depender do catch interno de `store.load` engolir uma chamada real de IPC não-mockada. */
function semanaVazia(): SemanaDeEstudo {
  return { inicio: "2026-09-07", metaMinutos: 480, dias: [] };
}

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    criarBloco: vi.fn(),
    atualizarBloco: vi.fn(),
    listarMaterias: vi.fn(),
    semanaDeEstudo: vi.fn(),
  };
});

const criarBlocoMock = vi.mocked(criarBloco);
const atualizarBlocoMock = vi.mocked(atualizarBloco);
const listarMateriasMock = vi.mocked(listarMaterias);
const semanaDeEstudoMock = vi.mocked(semanaDeEstudo);

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  listarMateriasMock.mockResolvedValue([]);
  semanaDeEstudoMock.mockResolvedValue(semanaVazia());
  useCronogramaStore.setState({
    status: "ready",
    errorMessage: null,
    inicioDaSemana: "2026-09-07",
    semana: { inicio: "2026-09-07", metaMinutos: 480, dias: [] },
    visao: "colunas",
    materias: [],
    materiasStatus: "idle",
  });
});

describe("NovoBlocoForm", () => {
  it("sem matéria cadastrada, mostra um campo para criar em vez de um seletor vazio", async () => {
    listarMateriasMock.mockResolvedValue([]);

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    expect(await screen.findByText("Nenhuma matéria ainda.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome da nova matéria")).toBeInTheDocument();
    expect(screen.queryByLabelText("Matéria (opcional)")).not.toBeInTheDocument();
  });

  it("falha ao listar matérias mostra o erro em vez de um seletor vazio, e permite tentar de novo", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockRejectedValueOnce(new AppError({ kind: "unknown", message: "banco bloqueado" }));

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("banco bloqueado");
    // Nem o seletor normal nem o campo de criação aparecem — os dois
    // pressupõem que a listagem funcionou, e aqui ela falhou.
    expect(screen.queryByLabelText("Matéria (opcional)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Nome da nova matéria")).not.toBeInTheDocument();

    listarMateriasMock.mockResolvedValueOnce([materia()]);
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

    expect(await screen.findByLabelText("Matéria (opcional)")).toBeInTheDocument();
  });

  it("criar com matéria selecionada passa o subjectId certo para o IPC", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([materia()]);
    criarBlocoMock.mockResolvedValue(blocoDeExemplo({ subjectId: "m1" }));
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    const seletorDeMateria = await screen.findByLabelText("Matéria (opcional)");
    await user.selectOptions(seletorDeMateria, "m1");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-07", "pomodoro", 25, null, null, null, "m1");
    expect(onFechar).toHaveBeenCalled();
  });

  it("criar sem matéria escolhida passa subjectId nulo", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([materia()]);
    criarBlocoMock.mockResolvedValue(blocoDeExemplo());
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    await screen.findByLabelText("Matéria (opcional)");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-07", "pomodoro", 25, null, null, null, null);
    expect(onFechar).toHaveBeenCalled();
  });

  it("cria a primeira matéria pelo campo inline e ela sai pré-selecionada", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);
    const materiaCriada = materia({ id: "nova", name: "Física" });
    useCronogramaStore.setState({
      criarMateria: vi.fn().mockImplementation(async (nome: string) => {
        const criada = { ...materiaCriada, name: nome };
        useCronogramaStore.setState((state) => ({ materias: [...state.materias, criada] }));
        return criada;
      }),
    });
    criarBlocoMock.mockResolvedValue(blocoDeExemplo({ subjectId: "nova" }));
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    await user.type(await screen.findByLabelText("Nome da nova matéria"), "Física");
    await user.click(screen.getByRole("button", { name: "Criar matéria" }));

    // A matéria recém-criada substitui o campo de criação pelo seletor normal, já selecionada.
    const seletor = await screen.findByLabelText("Matéria (opcional)");
    expect(seletor).toHaveValue("nova");

    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-07", "pomodoro", 25, null, null, null, "nova");
    expect(onFechar).toHaveBeenCalled();
  });

  it("falha ao criar a matéria pelo campo inline mostra erro e mantém o campo de criação visível", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);
    useCronogramaStore.setState({
      criarMateria: vi.fn().mockRejectedValue(new AppError({ kind: "conflict", message: "matéria duplicada" })),
    });

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    const campoNome = await screen.findByLabelText("Nome da nova matéria");
    await user.type(campoNome, "Física");
    await user.click(screen.getByRole("button", { name: "Criar matéria" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("matéria duplicada");
    // Não trava em "Criando…" nem troca pelo seletor normal — o texto digitado
    // continua ali, pronto para tentar de novo.
    expect(screen.getByRole("button", { name: "Criar matéria" })).toBeEnabled();
    expect(campoNome).toHaveValue("Física");
    expect(screen.queryByLabelText("Matéria (opcional)")).not.toBeInTheDocument();
  });

  it("horário com formato inválido (25:00) não chega ao IPC", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    await user.type(screen.getByLabelText("Horário de início (opcional)"), "25:00");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Horário inválido");
    expect(criarBlocoMock).not.toHaveBeenCalled();
  });

  it("horário como texto solto não chega ao IPC", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    await user.type(screen.getByLabelText("Horário de início (opcional)"), "amanhã cedo");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Horário inválido");
    expect(criarBlocoMock).not.toHaveBeenCalled();
  });

  it("horário válido cria o bloco e depois chama atualizarBloco com o id certo", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);
    criarBlocoMock.mockResolvedValue(blocoDeExemplo({ id: "b-novo" }));
    atualizarBlocoMock.mockResolvedValue(blocoDeExemplo({ id: "b-novo", startLocalTime: "14:30" }));
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    await user.type(screen.getByLabelText("Horário de início (opcional)"), "14:30");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    // `salvando` não volta a `false` depois de um sucesso (mesmo padrão de
    // `removendo` em `BlocoCard.tsx`) — o formulário conta com `onFechar` para
    // desmontar; aqui é `onFechar` que prova que o fluxo completou, não o texto do botão.
    await vi.waitFor(() => expect(onFechar).toHaveBeenCalled());
    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-07", "pomodoro", 25, null, null, null, null);
    expect(atualizarBlocoMock).toHaveBeenCalledWith("b-novo", { startLocalTime: "14:30" });
  });

  it("segunda chamada (marcar horário) falhando depois da primeira ter criado o bloco avisa claramente e não fecha o formulário", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);
    criarBlocoMock.mockResolvedValue(blocoDeExemplo({ id: "b-parcial" }));
    atualizarBlocoMock.mockRejectedValue(new AppError({ kind: "unknown", message: "conexão perdida" }));
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    await user.type(screen.getByLabelText("Horário de início (opcional)"), "14:30");
    await user.click(screen.getByRole("button", { name: "Criar" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("O bloco foi criado");
    expect(alerta).toHaveTextContent("conexão perdida");
    expect(onFechar).not.toHaveBeenCalled();
    // O formulário não fica pela metade sem indicar o que aconteceu: os
    // outros campos travam porque o bloco já existe com o que foi mandado.
    expect(screen.getByRole("button", { name: "Salvar horário" })).toBeInTheDocument();

    // Retentar não cria um SEGUNDO bloco — só tenta marcar o horário de novo no mesmo id.
    atualizarBlocoMock.mockResolvedValue(blocoDeExemplo({ id: "b-parcial", startLocalTime: "14:30" }));
    await user.click(screen.getByRole("button", { name: "Salvar horário" }));

    await vi.waitFor(() => expect(onFechar).toHaveBeenCalled());
    expect(criarBlocoMock).toHaveBeenCalledTimes(1);
    expect(atualizarBlocoMock).toHaveBeenLastCalledWith("b-parcial", { startLocalTime: "14:30" });
  });

  it("falha ao criar o bloco (primeiro passo) mostra erro e não chama atualizarBloco", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);
    criarBlocoMock.mockRejectedValue(new Error("rede caiu"));
    const onFechar = vi.fn();

    render(<NovoBlocoForm dia="2026-09-07" onFechar={onFechar} />);

    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível criar o bloco.");
    expect(atualizarBlocoMock).not.toHaveBeenCalled();
    expect(onFechar).not.toHaveBeenCalled();
  });

  it("duração inválida não chega a chamar o IPC", async () => {
    const user = userEvent.setup();
    listarMateriasMock.mockResolvedValue([]);

    render(<NovoBlocoForm dia="2026-09-07" onFechar={vi.fn()} />);

    // Campo vazio, não "0": com `min="1"` no `<input type="number">`, um valor
    // "0" reprova a validação NATIVA do HTML5 e o navegador (jsdom incluso)
    // bloqueia o evento de `submit` antes de qualquer JS rodar — o cenário
    // ficaria testando o browser, não a validação desta função. Vazio não
    // viola `min` (não é `required`), então o `submit` chega até `handleSubmit`,
    // e `Number("")` é `0` — cai na mesma checagem de "maior que zero".
    await user.clear(screen.getByLabelText("Duração (min)"));
    await user.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Duração precisa ser maior que zero.");
    expect(criarBlocoMock).not.toHaveBeenCalled();
  });
});
