import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listTrashedPages, permanentlyDeletePage, restorePage, type PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { TrashDialog } from "./TrashDialog";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listTrashedPages: vi.fn(),
    restorePage: vi.fn(),
    permanentlyDeletePage: vi.fn(),
  };
});

const listTrashedPagesMock = vi.mocked(listTrashedPages);
const restorePageMock = vi.mocked(restorePage);
const permanentlyDeletePageMock = vi.mocked(permanentlyDeletePage);

// Um teste substitui `load` por um espião — restaurado depois para não
// vazar para os testes seguintes deste arquivo.
const originalLoad = usePageTreeStore.getState().load;

function row(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "1",
    is_favorite: false,
    deleted_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  // `resetAllMocks` (não `clearAllMocks`): um teste que usa
  // `mockResolvedValueOnce` só consome a fila se chegar até lá — se falhar
  // antes, o valor enfileirado sobra para o próximo teste. `clearAllMocks`
  // não esvazia essa fila, só o histórico de chamadas.
  vi.resetAllMocks();
  usePageTreeStore.setState({
    status: "ready",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
    load: originalLoad,
  });
});

afterEach(() => {
  usePageTreeStore.setState({ load: originalLoad });
});

describe("TrashDialog", () => {
  it("fechado não busca a lixeira", () => {
    render(<TrashDialog isOpen={false} onClose={vi.fn()} />);

    expect(listTrashedPagesMock).not.toHaveBeenCalled();
  });

  it("FUN-027: ao abrir, lista as páginas na lixeira", async () => {
    listTrashedPagesMock.mockResolvedValue([row({ id: "rascunho", title: "Rascunho Antigo" })]);

    render(<TrashDialog isOpen onClose={vi.fn()} />);

    expect(await screen.findByText(/Rascunho Antigo/, { selector: "span" })).toBeInTheDocument();
  });

  it("a lixeira vazia mostra uma mensagem em vez de uma lista em branco", async () => {
    listTrashedPagesMock.mockResolvedValue([]);

    render(<TrashDialog isOpen onClose={vi.fn()} />);

    expect(await screen.findByText("A lixeira está vazia.")).toBeInTheDocument();
  });

  it("FUN-029/030: Restaurar chama restorePage e recarrega a lixeira e a árvore principal", async () => {
    const user = userEvent.setup();
    const loadSpy = vi.fn().mockResolvedValue(undefined);
    usePageTreeStore.setState({ load: loadSpy });
    listTrashedPagesMock
      .mockResolvedValueOnce([row({ id: "rascunho", title: "Rascunho Antigo" })])
      .mockResolvedValueOnce([]);
    restorePageMock.mockResolvedValue(row({ id: "rascunho", title: "Rascunho Antigo", deleted_at: null }));

    render(<TrashDialog isOpen onClose={vi.fn()} />);
    await screen.findByText(/Rascunho Antigo/, { selector: "span" });

    // `hidden: true`: mesma razão de `MoveToDialog` nos testes de `PageTree`
    // — o `<dialog>` nunca ganha o atributo `open` no jsdom (`showModal` é
    // indisponível lá), então seu conteúdo fica fora da árvore de acessibilidade.
    await user.click(screen.getByRole("button", { name: "Restaurar", hidden: true }));

    expect(restorePageMock).toHaveBeenCalledWith("rascunho");
    // A página restaurada precisa reaparecer na sidebar, não só sumir daqui.
    expect(loadSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("A lixeira está vazia.")).toBeInTheDocument());
  });

  it("FUN-031: Excluir pede confirmação e só chama permanentlyDeletePage se confirmado", async () => {
    const user = userEvent.setup();
    listTrashedPagesMock.mockResolvedValue([row({ id: "rascunho", title: "Rascunho Antigo" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TrashDialog isOpen onClose={vi.fn()} />);
    await screen.findByText(/Rascunho Antigo/, { selector: "span" });

    await user.click(screen.getByRole("button", { name: "Excluir", hidden: true }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(permanentlyDeletePageMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Excluir", hidden: true }));

    expect(permanentlyDeletePageMock).toHaveBeenCalledWith("rascunho");
    confirmSpy.mockRestore();
  });
});
