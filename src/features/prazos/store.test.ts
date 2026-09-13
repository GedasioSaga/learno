import { beforeEach, describe, expect, it, vi } from "vitest";
import { atualizarPrazo, criarPrazo, listarPrazos, removerPrazo, type PrazosListados } from "./ipc";
import { usePrazosStore } from "./store";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    listarPrazos: vi.fn(),
    criarPrazo: vi.fn(),
    atualizarPrazo: vi.fn(),
    removerPrazo: vi.fn(),
  };
});

const listarPrazosMock = vi.mocked(listarPrazos);
const criarPrazoMock = vi.mocked(criarPrazo);
const atualizarPrazoMock = vi.mocked(atualizarPrazo);
const removerPrazoMock = vi.mocked(removerPrazo);

function listagemVazia(overrides: Partial<PrazosListados> = {}): PrazosListados {
  return { hoje: "2026-09-05", vencidos: [], futuros: [], ...overrides };
}

function prazoRow(overrides: Partial<Awaited<ReturnType<typeof criarPrazo>>> = {}) {
  return {
    id: "p1",
    title: "Prova de Biologia",
    dueLocalDate: "2026-09-20",
    deckId: null,
    pageId: null,
    status: "ativo" as const,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrazosStore.setState({ status: "idle", errorMessage: null, listagem: null });
});

describe("load", () => {
  it("carrega a listagem e fica 'ready'", async () => {
    listarPrazosMock.mockResolvedValue(listagemVazia());

    await usePrazosStore.getState().load();

    const state = usePrazosStore.getState();
    expect(state.status).toBe("ready");
    expect(state.listagem?.hoje).toBe("2026-09-05");
  });

  it("chamada concorrente enquanto já está carregando não dispara uma segunda rodada", async () => {
    listarPrazosMock.mockResolvedValue(listagemVazia());

    const primeira = usePrazosStore.getState().load();
    const segunda = usePrazosStore.getState().load();
    await Promise.all([primeira, segunda]);

    expect(listarPrazosMock).toHaveBeenCalledTimes(1);
  });

  it("erro vira status 'error' com mensagem", async () => {
    listarPrazosMock.mockRejectedValue(new Error("rede caiu"));

    await usePrazosStore.getState().load();

    const state = usePrazosStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar os prazos.");
  });
});

describe("criar", () => {
  it("cria no backend e recarrega a listagem", async () => {
    criarPrazoMock.mockResolvedValue(prazoRow());
    listarPrazosMock.mockResolvedValue(listagemVazia());

    await usePrazosStore.getState().criar("Prova de Biologia", "2026-09-20", "deck-1");

    expect(criarPrazoMock).toHaveBeenCalledWith("Prova de Biologia", "2026-09-20", "deck-1");
    expect(listarPrazosMock).toHaveBeenCalledTimes(1);
    expect(usePrazosStore.getState().status).toBe("ready");
  });

  it("erro do backend vira errorMessage, a promise rejeita, e não recarrega", async () => {
    criarPrazoMock.mockRejectedValue(new Error("título vazio"));

    await expect(usePrazosStore.getState().criar("", "2026-09-20")).rejects.toThrow();

    expect(usePrazosStore.getState().errorMessage).toBe("Não foi possível criar o prazo.");
    expect(listarPrazosMock).not.toHaveBeenCalled();
  });
});

describe("atualizar", () => {
  it("salva o patch e recarrega", async () => {
    atualizarPrazoMock.mockResolvedValue(prazoRow({ title: "Novo título" }));
    listarPrazosMock.mockResolvedValue(listagemVazia());

    await usePrazosStore.getState().atualizar("p1", { title: "Novo título" });

    expect(atualizarPrazoMock).toHaveBeenCalledWith("p1", { title: "Novo título" });
    expect(listarPrazosMock).toHaveBeenCalledTimes(1);
  });

  it("erro do backend vira errorMessage e a promise rejeita", async () => {
    atualizarPrazoMock.mockRejectedValue(new Error("data inválida"));

    await expect(usePrazosStore.getState().atualizar("p1", { dueLocalDate: "lixo" })).rejects.toThrow();
    expect(usePrazosStore.getState().errorMessage).toBe("Não foi possível salvar o prazo.");
  });
});

describe("concluir", () => {
  it("manda o patch de status='concluido' e recarrega", async () => {
    atualizarPrazoMock.mockResolvedValue(prazoRow({ status: "concluido" }));
    listarPrazosMock.mockResolvedValue(listagemVazia());

    await usePrazosStore.getState().concluir("p1");

    expect(atualizarPrazoMock).toHaveBeenCalledWith("p1", { status: "concluido" });
    expect(listarPrazosMock).toHaveBeenCalledTimes(1);
  });

  it("erro do backend vira errorMessage e a promise rejeita", async () => {
    atualizarPrazoMock.mockRejectedValue(new Error("id não existe"));

    await expect(usePrazosStore.getState().concluir("fantasma")).rejects.toThrow();
    expect(usePrazosStore.getState().errorMessage).toBe("Não foi possível concluir o prazo.");
  });
});

describe("remover", () => {
  it("remove no backend e recarrega", async () => {
    removerPrazoMock.mockResolvedValue(undefined);
    listarPrazosMock.mockResolvedValue(listagemVazia());

    await usePrazosStore.getState().remover("p1");

    expect(removerPrazoMock).toHaveBeenCalledWith("p1");
    expect(listarPrazosMock).toHaveBeenCalledTimes(1);
  });

  it("erro do backend vira errorMessage e a promise rejeita, e não recarrega", async () => {
    removerPrazoMock.mockRejectedValue(new Error("prazo não existe"));

    await expect(usePrazosStore.getState().remover("fantasma")).rejects.toThrow();

    expect(usePrazosStore.getState().errorMessage).toBe("Não foi possível apagar o prazo.");
    expect(listarPrazosMock).not.toHaveBeenCalled();
  });
});
