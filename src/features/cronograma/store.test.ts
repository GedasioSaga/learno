import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  atualizarMateria,
  copiarSemana,
  criarBloco,
  criarMateria,
  definirMetaSemanal,
  listarMaterias,
  removerBloco,
  removerMateria,
  semanaDeEstudo,
  type Materia,
  type SemanaDeEstudo,
} from "../../lib/ipc";
import { lerVisaoPersistida, useCronogramaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    semanaDeEstudo: vi.fn(),
    definirMetaSemanal: vi.fn(),
    criarBloco: vi.fn(),
    removerBloco: vi.fn(),
    listarMaterias: vi.fn(),
    criarMateria: vi.fn(),
    atualizarMateria: vi.fn(),
    removerMateria: vi.fn(),
    copiarSemana: vi.fn(),
  };
});

const semanaDeEstudoMock = vi.mocked(semanaDeEstudo);
const definirMetaSemanalMock = vi.mocked(definirMetaSemanal);
const criarBlocoMock = vi.mocked(criarBloco);
const removerBlocoMock = vi.mocked(removerBloco);
const listarMateriasMock = vi.mocked(listarMaterias);
const criarMateriaMock = vi.mocked(criarMateria);
const atualizarMateriaMock = vi.mocked(atualizarMateria);
const removerMateriaMock = vi.mocked(removerMateria);
const copiarSemanaMock = vi.mocked(copiarSemana);

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

function semanaVazia(overrides: Partial<SemanaDeEstudo> = {}): SemanaDeEstudo {
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
    materias: [],
    materiasStatus: "idle",
    materiasErrorMessage: null,
  });
});

describe("load", () => {
  it("carrega a semana em `inicioDaSemana` e fica 'ready'", async () => {
    semanaDeEstudoMock.mockResolvedValue(semanaVazia());

    await useCronogramaStore.getState().load();

    const state = useCronogramaStore.getState();
    expect(state.status).toBe("ready");
    expect(state.semana?.inicio).toBe("2026-09-07");
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-07");
  });

  it("chamado com um `inicioDaSemana` explícito, passa a valer esse a partir de então", async () => {
    semanaDeEstudoMock.mockResolvedValue(semanaVazia({ inicio: "2026-09-14" }));

    await useCronogramaStore.getState().load("2026-09-14");

    expect(useCronogramaStore.getState().inicioDaSemana).toBe("2026-09-14");
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-14");
  });

  it("chamada concorrente enquanto já está carregando não dispara uma segunda rodada", async () => {
    semanaDeEstudoMock.mockResolvedValue(semanaVazia());

    const primeira = useCronogramaStore.getState().load();
    const segunda = useCronogramaStore.getState().load();
    await Promise.all([primeira, segunda]);

    expect(semanaDeEstudoMock).toHaveBeenCalledTimes(1);
  });

  it("erro vira status 'error' com mensagem", async () => {
    semanaDeEstudoMock.mockRejectedValue(new Error("rede caiu"));

    await useCronogramaStore.getState().load();

    const state = useCronogramaStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar a semana.");
  });
});

describe("navegação entre semanas — o local nunca se perde", () => {
  beforeEach(() => {
    semanaDeEstudoMock.mockImplementation((inicio) => Promise.resolve(semanaVazia({ inicio })));
  });

  it("semanaAnterior pede a semana 7 dias antes da atual", async () => {
    useCronogramaStore.setState({ inicioDaSemana: "2026-09-07" });

    await useCronogramaStore.getState().semanaAnterior();

    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-08-31");
    expect(useCronogramaStore.getState().inicioDaSemana).toBe("2026-08-31");
  });

  it("proximaSemana pede a semana 7 dias depois da atual", async () => {
    useCronogramaStore.setState({ inicioDaSemana: "2026-09-07" });

    await useCronogramaStore.getState().proximaSemana();

    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-14");
    expect(useCronogramaStore.getState().inicioDaSemana).toBe("2026-09-14");
  });

  it("navegar duas semanas para frente e uma para trás pousa na semana certa (nunca perde o lugar)", async () => {
    useCronogramaStore.setState({ inicioDaSemana: "2026-09-07" });

    await useCronogramaStore.getState().proximaSemana();
    await useCronogramaStore.getState().proximaSemana();
    await useCronogramaStore.getState().semanaAnterior();

    expect(useCronogramaStore.getState().inicioDaSemana).toBe("2026-09-14");
  });

  it("irParaHoje recarrega a semana que contém a data atual do sistema", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 23, 0)); // quinta-feira 23h — a virada é local

    useCronogramaStore.setState({ inicioDaSemana: "2026-01-01" });
    await useCronogramaStore.getState().irParaHoje();

    expect(useCronogramaStore.getState().inicioDaSemana).toBe("2026-09-07");

    vi.useRealTimers();
  });
});

describe("definirMeta", () => {
  it("salva no backend e atualiza a meta na semana já carregada, sem recarregar", async () => {
    useCronogramaStore.setState({ semana: semanaVazia({ metaMinutos: 480 }) });
    definirMetaSemanalMock.mockResolvedValue(undefined);

    await useCronogramaStore.getState().definirMeta(600);

    expect(definirMetaSemanalMock).toHaveBeenCalledWith("2026-09-07", 600);
    expect(useCronogramaStore.getState().semana?.metaMinutos).toBe(600);
    expect(semanaDeEstudoMock).not.toHaveBeenCalled();
  });

  it("erro do backend vira errorMessage e a promise rejeita", async () => {
    definirMetaSemanalMock.mockRejectedValue(new Error("minutos inválidos"));

    await expect(useCronogramaStore.getState().definirMeta(-10)).rejects.toThrow();
    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível salvar a meta semanal.");
  });
});

describe("criarBloco", () => {
  it("cria e recarrega a MESMA semana (não pula para a semana do dia criado)", async () => {
    criarBlocoMock.mockResolvedValue({
      id: "b1",
      localDate: "2026-09-08",
      position: "1",
      startLocalTime: "09:00",
      plannedMinutes: 50,
      activity: "pomodoro",
      pomodoroCycles: null,
      title: null,
      deckId: null,
      pageId: null,
      subjectId: null,
      createdAt: "2026-09-08T09:00:00Z",
      updatedAt: "2026-09-08T09:00:00Z",
      endLocalTime: "09:50",
      crossesMidnight: false,
    });
    semanaDeEstudoMock.mockResolvedValue(semanaVazia());

    await useCronogramaStore.getState().criarBloco("2026-09-08", "pomodoro", 50);

    expect(criarBlocoMock).toHaveBeenCalledWith(
      "2026-09-08",
      "pomodoro",
      50,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-07");
    expect(useCronogramaStore.getState().status).toBe("ready");
  });

  it("repassa o subjectId ao backend quando informado", async () => {
    criarBlocoMock.mockResolvedValue({
      id: "b2",
      localDate: "2026-09-08",
      position: "1",
      startLocalTime: null,
      plannedMinutes: 50,
      activity: "reading",
      pomodoroCycles: null,
      title: null,
      deckId: null,
      pageId: null,
      subjectId: "m1",
      createdAt: "2026-09-08T09:00:00Z",
      updatedAt: "2026-09-08T09:00:00Z",
      endLocalTime: null,
      crossesMidnight: false,
    });
    semanaDeEstudoMock.mockResolvedValue(semanaVazia());

    await useCronogramaStore.getState().criarBloco("2026-09-08", "reading", 50, null, null, null, "m1");

    expect(criarBlocoMock).toHaveBeenCalledWith("2026-09-08", "reading", 50, null, null, null, "m1");
  });

  it("erro do backend vira errorMessage, a promise rejeita, e não recarrega", async () => {
    criarBlocoMock.mockRejectedValue(new Error("dia inválido"));

    await expect(useCronogramaStore.getState().criarBloco("2026-09-08", "pomodoro", 50)).rejects.toThrow();

    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível criar o bloco.");
    expect(semanaDeEstudoMock).not.toHaveBeenCalled();
  });
});

describe("removerBloco", () => {
  it("remove no backend e recarrega a semana", async () => {
    removerBlocoMock.mockResolvedValue(undefined);
    semanaDeEstudoMock.mockResolvedValue(semanaVazia());

    await useCronogramaStore.getState().removerBloco("b1");

    expect(removerBlocoMock).toHaveBeenCalledWith("b1");
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-07");
  });

  it("erro do backend vira errorMessage e a promise rejeita", async () => {
    removerBlocoMock.mockRejectedValue(new Error("bloco não existe"));

    await expect(useCronogramaStore.getState().removerBloco("fantasma")).rejects.toThrow();
    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível remover o bloco.");
  });
});

describe("carregarMaterias", () => {
  it("busca a lista e fica 'ready'", async () => {
    listarMateriasMock.mockResolvedValue([materia()]);

    await useCronogramaStore.getState().carregarMaterias();

    const state = useCronogramaStore.getState();
    expect(state.materiasStatus).toBe("ready");
    expect(state.materias).toEqual([materia()]);
    expect(listarMateriasMock).toHaveBeenCalledTimes(1);
  });

  it("chamada de novo depois de 'ready' não refaz o round-trip", async () => {
    listarMateriasMock.mockResolvedValue([materia()]);

    await useCronogramaStore.getState().carregarMaterias();
    await useCronogramaStore.getState().carregarMaterias();

    expect(listarMateriasMock).toHaveBeenCalledTimes(1);
  });

  it("chamada concorrente enquanto já está carregando não dispara uma segunda rodada", async () => {
    listarMateriasMock.mockResolvedValue([materia()]);

    const primeira = useCronogramaStore.getState().carregarMaterias();
    const segunda = useCronogramaStore.getState().carregarMaterias();
    await Promise.all([primeira, segunda]);

    expect(listarMateriasMock).toHaveBeenCalledTimes(1);
  });

  it("erro vira materiasStatus 'error' com mensagem, sem lançar", async () => {
    listarMateriasMock.mockRejectedValue(new Error("rede caiu"));

    await useCronogramaStore.getState().carregarMaterias();

    const state = useCronogramaStore.getState();
    expect(state.materiasStatus).toBe("error");
    expect(state.materiasErrorMessage).toBe("Não foi possível carregar as matérias.");
  });
});

describe("criarMateria", () => {
  it("cria no backend, insere localmente e devolve a matéria criada", async () => {
    const nova = materia({ id: "m2", name: "Física", color: "roxo" });
    criarMateriaMock.mockResolvedValue(nova);
    useCronogramaStore.setState({ materias: [materia()] });

    const resultado = await useCronogramaStore.getState().criarMateria("Física", "roxo");

    expect(criarMateriaMock).toHaveBeenCalledWith("Física", "roxo");
    expect(resultado).toEqual(nova);
    expect(useCronogramaStore.getState().materias).toEqual([materia(), nova]);
  });

  it("erro do backend vira errorMessage, a promise rejeita e não insere nada", async () => {
    criarMateriaMock.mockRejectedValue(new Error("nome vazio"));
    useCronogramaStore.setState({ materias: [] });

    await expect(useCronogramaStore.getState().criarMateria("", null)).rejects.toThrow();

    expect(useCronogramaStore.getState().materiasErrorMessage).toBe("Não foi possível criar a matéria.");
    expect(useCronogramaStore.getState().materias).toEqual([]);
  });
});

describe("atualizarMateria", () => {
  it("atualiza no backend e substitui a entrada local pelo objeto retornado", async () => {
    const atualizada = materia({ name: "Matemática II" });
    atualizarMateriaMock.mockResolvedValue(atualizada);
    useCronogramaStore.setState({ materias: [materia()] });

    await useCronogramaStore.getState().atualizarMateria("m1", { name: "Matemática II" });

    expect(atualizarMateriaMock).toHaveBeenCalledWith("m1", { name: "Matemática II" });
    expect(useCronogramaStore.getState().materias).toEqual([atualizada]);
  });

  it("erro do backend vira errorMessage, a promise rejeita e não altera a lista local", async () => {
    atualizarMateriaMock.mockRejectedValue(new Error("cor inválida"));
    useCronogramaStore.setState({ materias: [materia()] });

    await expect(
      useCronogramaStore.getState().atualizarMateria("m1", { color: "azul" }),
    ).rejects.toThrow();

    expect(useCronogramaStore.getState().materiasErrorMessage).toBe("Não foi possível atualizar a matéria.");
    expect(useCronogramaStore.getState().materias).toEqual([materia()]);
  });
});

describe("removerMateria — o bloco que apontava para ela sobrevive sem a matéria (ON DELETE SET NULL)", () => {
  it("remove no backend, tira da lista local e recarrega a semana para refletir o subjectId solto", async () => {
    useCronogramaStore.setState({
      materias: [materia()],
      inicioDaSemana: "2026-09-07",
    });
    removerMateriaMock.mockResolvedValue(undefined);
    // A semana recarregada é a verdade pós-remoção: o bloco que apontava
    // para "m1" continua existindo (ON DELETE SET NULL), só que agora com
    // subjectId null — exatamente o que a store precisa expor para a tela
    // parar de pintá-lo com uma matéria que não existe mais.
    semanaDeEstudoMock.mockResolvedValue(
      semanaVazia({
        dias: [
          {
            data: "2026-09-07",
            minutosRealizados: 0,
            blocos: [
              {
                id: "b1",
                localDate: "2026-09-07",
                position: "1",
                startLocalTime: null,
                plannedMinutes: 30,
                activity: "reading",
                pomodoroCycles: null,
                title: "Revisão",
                deckId: null,
                pageId: null,
                subjectId: null,
                createdAt: "2026-09-07T00:00:00Z",
                updatedAt: "2026-09-07T00:00:00Z",
                endLocalTime: null,
                crossesMidnight: false,
              },
            ],
          },
        ],
      }),
    );

    await useCronogramaStore.getState().removerMateria("m1");

    expect(removerMateriaMock).toHaveBeenCalledWith("m1");
    expect(useCronogramaStore.getState().materias).toEqual([]);
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-07");
    expect(useCronogramaStore.getState().semana?.dias[0].blocos[0].subjectId).toBeNull();
  });

  it("erro do backend vira errorMessage, a promise rejeita e não mexe na lista nem recarrega", async () => {
    removerMateriaMock.mockRejectedValue(new Error("matéria não existe"));
    useCronogramaStore.setState({ materias: [materia()] });

    await expect(useCronogramaStore.getState().removerMateria("fantasma")).rejects.toThrow();

    expect(useCronogramaStore.getState().materiasErrorMessage).toBe("Não foi possível remover a matéria.");
    expect(useCronogramaStore.getState().materias).toEqual([materia()]);
    expect(semanaDeEstudoMock).not.toHaveBeenCalled();
  });
});

describe("materiasErrorMessage é separado de errorMessage", () => {
  it("um erro de bloco pendente sobrevive a uma ação de matéria bem-sucedida", async () => {
    // Antes do achado corrigido, `criarMateria` bem-sucedida fazia
    // `errorMessage: null` — apagando em silêncio este erro de bloco que o
    // usuário ainda não viu no banner de `ConteudoDeCronograma`.
    criarBlocoMock.mockRejectedValue(new Error("dia inválido"));
    await expect(useCronogramaStore.getState().criarBloco("2026-09-08", "pomodoro", 50)).rejects.toThrow();
    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível criar o bloco.");

    criarMateriaMock.mockResolvedValue(materia({ id: "m2", name: "Física", color: "roxo" }));
    await useCronogramaStore.getState().criarMateria("Física", "roxo");

    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível criar o bloco.");
    expect(useCronogramaStore.getState().materiasErrorMessage).toBeNull();
  });
});

describe("copiarSemanaModelo", () => {
  it("copia da origem para a semana ATUALMENTE aberta e recarrega essa semana", async () => {
    useCronogramaStore.setState({ inicioDaSemana: "2026-09-14" });
    copiarSemanaMock.mockResolvedValue([]);
    semanaDeEstudoMock.mockResolvedValue(semanaVazia({ inicio: "2026-09-14" }));

    await useCronogramaStore.getState().copiarSemanaModelo("2026-09-07");

    expect(copiarSemanaMock).toHaveBeenCalledWith("2026-09-07", "2026-09-14");
    expect(semanaDeEstudoMock).toHaveBeenCalledWith("2026-09-14");
  });

  it("erro do backend vira errorMessage, a promise rejeita e não recarrega", async () => {
    copiarSemanaMock.mockRejectedValue(new Error("semana inválida"));

    await expect(useCronogramaStore.getState().copiarSemanaModelo("2026-09-07")).rejects.toThrow();

    expect(useCronogramaStore.getState().errorMessage).toBe("Não foi possível copiar a semana modelo.");
    expect(semanaDeEstudoMock).not.toHaveBeenCalled();
  });
});

describe("visao — a escolha entre Colunas e Grade sobrevive a fechar o app", () => {
  it("sem nada salvo, começa em 'colunas' (a visão original, que não some)", () => {
    expect(lerVisaoPersistida()).toBe("colunas");
  });

  it("definirVisao muda o estado e grava no localStorage", () => {
    useCronogramaStore.getState().definirVisao("grade");

    expect(useCronogramaStore.getState().visao).toBe("grade");
    expect(window.localStorage.getItem("learno:cronograma-visao")).toBe("grade");
  });

  it("lerVisaoPersistida lê de volta o que foi salvo", () => {
    useCronogramaStore.getState().definirVisao("grade");

    expect(lerVisaoPersistida()).toBe("grade");
  });

  it("valor corrompido no localStorage cai no padrão 'colunas', nunca lança", () => {
    window.localStorage.setItem("learno:cronograma-visao", "algo-invalido");

    expect(lerVisaoPersistida()).toBe("colunas");
  });
});
