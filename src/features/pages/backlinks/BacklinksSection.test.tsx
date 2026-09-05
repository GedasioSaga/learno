import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRow } from "../../../lib/ipc";
import { usePageTreeStore } from "../store";
import { BacklinksSection } from "./BacklinksSection";
import { listBacklinks, type BacklinkRow } from "./ipc";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return { ...actual, listBacklinks: vi.fn() };
});

const listBacklinksMock = vi.mocked(listBacklinks);

function backlinkRow(overrides: Partial<BacklinkRow> & Pick<BacklinkRow, "sourceBlockId" | "sourcePageId">): BacklinkRow {
  return {
    sourcePageTitle: "",
    sourceSnippet: "",
    targetPageId: "glossario",
    ...overrides,
  };
}

function pageRow(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "1",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePageTreeStore.setState({
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

describe("BacklinksSection", () => {
  it("FUN-044: 'Aula 4' e 'Aula 7' mencionando 'Glossário' mostram '2 backlinks' navegáveis com trecho do bloco", async () => {
    listBacklinksMock.mockResolvedValue([
      backlinkRow({
        sourceBlockId: "block-aula4",
        sourcePageId: "aula4",
        sourcePageTitle: "Aula 4",
        sourceSnippet: "Ver o @Glossário para os termos",
      }),
      backlinkRow({
        sourceBlockId: "block-aula7",
        sourcePageId: "aula7",
        sourcePageTitle: "Aula 7",
        sourceSnippet: "Revisão final, ver @Glossário",
      }),
    ]);
    usePageTreeStore.setState({
      pagesById: new Map([
        ["aula4", pageRow({ id: "aula4", title: "Aula 4" })],
        ["aula7", pageRow({ id: "aula7", title: "Aula 7" })],
      ]),
    });

    render(<BacklinksSection pageId="glossario" />);

    expect(await screen.findByRole("heading", { name: "Backlinks" })).toBeInTheDocument();
    expect(screen.getByText("2 backlinks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aula 4/ })).toHaveTextContent("Ver o @Glossário para os termos");
    expect(screen.getByRole("button", { name: /Aula 7/ })).toHaveTextContent("Revisão final, ver @Glossário");
    expect(listBacklinksMock).toHaveBeenCalledWith("glossario");
  });

  it("um único backlink usa o singular '1 backlink'", async () => {
    listBacklinksMock.mockResolvedValue([
      backlinkRow({ sourceBlockId: "block-1", sourcePageId: "aula4", sourcePageTitle: "Aula 4", sourceSnippet: "texto" }),
    ]);

    render(<BacklinksSection pageId="glossario" />);

    expect(await screen.findByText("1 backlink")).toBeInTheDocument();
  });

  it("clicar num backlink navega até a página de origem", async () => {
    const user = userEvent.setup();
    listBacklinksMock.mockResolvedValue([
      backlinkRow({ sourceBlockId: "block-1", sourcePageId: "aula4", sourcePageTitle: "Aula 4", sourceSnippet: "texto" }),
    ]);

    render(<BacklinksSection pageId="glossario" />);
    const item = await screen.findByRole("button", { name: /Aula 4/ });
    await user.click(item);

    expect(usePageTreeStore.getState().selectedPageId).toBe("aula4");
  });

  it("FUN-045: renomear a página de origem atualiza o título do backlink já exibido, sem refazer a consulta", async () => {
    listBacklinksMock.mockResolvedValue([
      backlinkRow({ sourceBlockId: "block-1", sourcePageId: "aula4", sourcePageTitle: "Aula 4", sourceSnippet: "texto" }),
    ]);
    usePageTreeStore.setState({
      pagesById: new Map([["aula4", pageRow({ id: "aula4", title: "Aula 4" })]]),
    });

    render(<BacklinksSection pageId="glossario" />);
    await screen.findByRole("button", { name: /Aula 4/ });
    expect(listBacklinksMock).toHaveBeenCalledTimes(1);

    act(() => {
      usePageTreeStore.setState({
        pagesById: new Map([["aula4", pageRow({ id: "aula4", title: "Aula 4 revisada" })]]),
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /Aula 4 revisada/ })).toBeInTheDocument());
    // Continua sendo a mesma consulta - o título mudou por reatividade do
    // store (`usePageTitle`), não por um novo `listBacklinks`.
    expect(listBacklinksMock).toHaveBeenCalledTimes(1);
  });

  it("sem nenhum backlink, não renderiza seção nenhuma (nunca um cabeçalho vazio)", async () => {
    listBacklinksMock.mockResolvedValue([]);

    render(<BacklinksSection pageId="pagina-sem-mencoes" />);

    await waitFor(() => expect(listBacklinksMock).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Backlinks" })).not.toBeInTheDocument();
    expect(screen.queryByText(/backlink/)).not.toBeInTheDocument();
  });

  it("uma falha na consulta também não deixa a seção travada com erro visível", async () => {
    listBacklinksMock.mockRejectedValue(new Error("sem conexão"));

    render(<BacklinksSection pageId="glossario" />);

    await waitFor(() => expect(listBacklinksMock).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Backlinks" })).not.toBeInTheDocument();
  });

  it("backlink sem sourceSnippet (bloco de origem sem texto) mostra só o título, sem trecho quebrado", async () => {
    listBacklinksMock.mockResolvedValue([
      backlinkRow({ sourceBlockId: "block-sumido", sourcePageId: "aula4", sourcePageTitle: "Aula 4" }),
    ]);

    render(<BacklinksSection pageId="glossario" />);

    const item = await screen.findByRole("button", { name: /Aula 4/ });
    expect(item).toHaveTextContent("Aula 4");
  });
});
