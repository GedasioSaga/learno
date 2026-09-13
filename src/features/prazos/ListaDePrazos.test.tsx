import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listDecks, listPageTree, type DeckRow, type PageRow } from "../../lib/ipc";
import { ListaDePrazos } from "./ListaDePrazos";
import { atualizarPrazo, criarPrazo, listarPrazos, removerPrazo, type PrazoComContagem, type PrazosListados } from "./ipc";
import { usePrazosStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listDecks: vi.fn(),
    listPageTree: vi.fn(),
  };
});

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
const listDecksMock = vi.mocked(listDecks);
const listPageTreeMock = vi.mocked(listPageTree);

function prazo(overrides: Partial<PrazoComContagem> = {}): PrazoComContagem {
  return {
    id: "p1",
    title: "Prova de Biologia",
    dueLocalDate: "2026-09-20",
    deckId: null,
    pageId: null,
    status: "ativo",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    diasRestantes: 15,
    ...overrides,
  };
}

function listagem(overrides: Partial<PrazosListados> = {}): PrazosListados {
  return { hoje: "2026-09-05", vencidos: [], futuros: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrazosStore.setState({ status: "idle", errorMessage: null, listagem: null });
  listDecksMock.mockResolvedValue([]);
  listPageTreeMock.mockResolvedValue([]);
});

describe("ListaDePrazos", () => {
  it("estado vazio: sem nenhum prazo cadastrado, mostra mensagem honesta, não uma lista muda", async () => {
    listarPrazosMock.mockResolvedValue(listagem());

    render(<ListaDePrazos />);

    expect(await screen.findByText(/Nenhum prazo cadastrado ainda/)).toBeInTheDocument();
  });

  it("mostra a contagem exata que o backend mandou, sem recalcular", async () => {
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo({ diasRestantes: 12 })] }));

    render(<ListaDePrazos />);

    expect(await screen.findByText("Faltam 12 dias")).toBeInTheDocument();
  });

  it("prazo vencido aparece numa seção 'Vencidos' distinta e NÃO some da tela", async () => {
    listarPrazosMock.mockResolvedValue(
      listagem({
        vencidos: [prazo({ id: "v1", title: "Prova de Química", diasRestantes: -3 })],
        futuros: [prazo({ id: "f1", title: "Prova de Biologia", diasRestantes: 5 })],
      }),
    );

    render(<ListaDePrazos />);

    const secaoVencidos = await screen.findByRole("heading", { name: "Vencidos" });
    expect(secaoVencidos).toBeInTheDocument();
    expect(screen.getByText("Prova de Química")).toBeInTheDocument();
    expect(screen.getByText("Venceu há 3 dias")).toBeInTheDocument();
    // O futuro continua visível ao lado — vencido não empurra o resto para fora.
    expect(screen.getByText("Prova de Biologia")).toBeInTheDocument();
  });

  it("baralho ligado aparece como o que o prazo cobra", async () => {
    listDecksMock.mockResolvedValue([{ id: "deck-1", parentId: null, name: "Anatomia", options: null, position: "1", deletedAt: null, createdAt: "", updatedAt: "" } as DeckRow]);
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo({ deckId: "deck-1" })] }));

    render(<ListaDePrazos />);

    expect(await screen.findByText("Baralho: Anatomia")).toBeInTheDocument();
  });

  it("página ligada aparece como o que o prazo cobra", async () => {
    listPageTreeMock.mockResolvedValue([
      { id: "page-1", parent_id: null, database_id: null, title: "Resumo de Genética", icon: null, position: "1", is_favorite: false, deleted_at: null, created_at: "", updated_at: "" } as PageRow,
    ]);
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo({ pageId: "page-1" })] }));

    render(<ListaDePrazos />);

    expect(await screen.findByText("Página: Resumo de Genética")).toBeInTheDocument();
  });

  it("erro ao carregar vira mensagem visível em vez de tela branca", async () => {
    listarPrazosMock.mockRejectedValue(new Error("rede caiu"));

    render(<ListaDePrazos />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os prazos.");
  });

  it("criar um prazo pelo formulário chama criarPrazo e recarrega a lista", async () => {
    const user = userEvent.setup();
    listarPrazosMock.mockResolvedValue(listagem());
    criarPrazoMock.mockResolvedValue({
      id: "novo",
      title: "Prova de Física",
      dueLocalDate: "2026-10-01",
      deckId: null,
      pageId: null,
      status: "ativo",
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    });

    render(<ListaDePrazos />);
    await screen.findByText(/Nenhum prazo cadastrado ainda/);

    await user.click(screen.getByRole("button", { name: "+ Novo prazo" }));
    const formulario = await screen.findByRole("form", { name: "Novo prazo" });
    await user.type(within(formulario).getByLabelText("Título"), "Prova de Física");
    await user.type(within(formulario).getByLabelText("Data-limite"), "2026-10-01");

    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo({ id: "novo", title: "Prova de Física" })] }));
    await user.click(within(formulario).getByRole("button", { name: "Criar" }));

    expect(criarPrazoMock).toHaveBeenCalledWith("Prova de Física", "2026-10-01", null);
    expect(await screen.findByText("Prova de Física")).toBeInTheDocument();
  });

  it("concluir um prazo chama atualizarPrazo com status='concluido' e recarrega", async () => {
    const user = userEvent.setup();
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));
    atualizarPrazoMock.mockResolvedValue({ ...prazo(), status: "concluido" });

    render(<ListaDePrazos />);
    await screen.findByText("Prova de Biologia");

    listarPrazosMock.mockResolvedValue(listagem());
    await user.click(screen.getByRole("button", { name: "Concluir" }));

    expect(atualizarPrazoMock).toHaveBeenCalledWith("p1", { status: "concluido" });
    expect(await screen.findByText(/Nenhum prazo cadastrado ainda/)).toBeInTheDocument();
  });

  it("apagar um prazo pede confirmação e, confirmado, chama removerPrazo e recarrega", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));
    removerPrazoMock.mockResolvedValue(undefined);

    render(<ListaDePrazos />);
    await screen.findByText("Prova de Biologia");

    listarPrazosMock.mockResolvedValue(listagem());
    await user.click(screen.getByRole("button", { name: "Apagar prazo Prova de Biologia" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(removerPrazoMock).toHaveBeenCalledWith("p1");
    expect(await screen.findByText(/Nenhum prazo cadastrado ainda/)).toBeInTheDocument();
  });

  it("apagar um prazo e CANCELAR a confirmação não chama removerPrazo", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));

    render(<ListaDePrazos />);
    await screen.findByText("Prova de Biologia");

    await user.click(screen.getByRole("button", { name: "Apagar prazo Prova de Biologia" }));

    expect(removerPrazoMock).not.toHaveBeenCalled();
    expect(screen.getByText("Prova de Biologia")).toBeInTheDocument();
  });

  it("editar um prazo abre o formulário preenchido e salva via atualizarPrazo", async () => {
    const user = userEvent.setup();
    listarPrazosMock.mockResolvedValue(listagem({ futuros: [prazo()] }));
    atualizarPrazoMock.mockResolvedValue({ ...prazo(), title: "Prova de Biologia (2ª chamada)" });

    render(<ListaDePrazos />);
    await screen.findByText("Prova de Biologia");

    await user.click(screen.getByRole("button", { name: "Editar" }));
    const formulario = await screen.findByRole("form", { name: "Editar prazo" });
    expect(within(formulario).getByLabelText("Título")).toHaveValue("Prova de Biologia");

    await user.clear(within(formulario).getByLabelText("Título"));
    await user.type(within(formulario).getByLabelText("Título"), "Prova de Biologia (2ª chamada)");

    listarPrazosMock.mockResolvedValue(listagem({ futuros: [{ ...prazo(), title: "Prova de Biologia (2ª chamada)" }] }));
    await user.click(within(formulario).getByRole("button", { name: "Salvar" }));

    expect(atualizarPrazoMock).toHaveBeenCalledWith("p1", { title: "Prova de Biologia (2ª chamada)", dueLocalDate: "2026-09-20" });
  });
});
