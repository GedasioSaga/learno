import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppError, getPageBreadcrumb, type PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { Breadcrumb } from "./Breadcrumb";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, getPageBreadcrumb: vi.fn() };
});

const getPageBreadcrumbMock = vi.mocked(getPageBreadcrumb);

function row(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
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
    status: "idle",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

describe("Breadcrumb", () => {
  it("FUN-019: mostra a trilha A / B / C da raiz até a página aberta", async () => {
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    getPageBreadcrumbMock.mockResolvedValue([a, b, c]);

    render(<Breadcrumb pageId="C" />);

    const nav = await screen.findByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/A.*B.*C/);
    // A página atual (C) não é um link — é só o item corrente da trilha.
    expect(screen.getByText(/C/, { selector: "[aria-current='page']" })).toBeInTheDocument();
  });

  it("FUN-019: clicar num ancestral da trilha navega até ele", async () => {
    const user = userEvent.setup();
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    getPageBreadcrumbMock.mockResolvedValue([a, b, c]);
    usePageTreeStore.setState({ pagesById: new Map([["A", a], ["B", b], ["C", c]]) });

    render(<Breadcrumb pageId="C" />);

    await user.click(await screen.findByRole("button", { name: /B/ }));

    expect(usePageTreeStore.getState().selectedPageId).toBe("B");
  });

  it("FUN-011: o ícone da página aparece na trilha de navegação", async () => {
    const a = row({ id: "A", title: "A", icon: "🧠" });
    const b = row({ id: "B", parent_id: "A", title: "B", icon: "🔬" });
    getPageBreadcrumbMock.mockResolvedValue([a, b]);

    render(<Breadcrumb pageId="B" />);

    const nav = await screen.findByRole("navigation", { name: "Trilha de navegação" });
    // O critério de aceite fala do emoji APARECENDO — não só de o backend
    // devolver o campo `icon` (isso já era garantido pelo tipo `PageRow`).
    // Cobre os dois papéis que um item da trilha pode ter: ancestral
    // clicável (A) e item corrente (B, `aria-current="page"`).
    expect(within(nav).getByRole("button", { name: /🧠 A/ })).toBeInTheDocument();
    expect(within(nav).getByText(/🔬 B/, { selector: "[aria-current='page']" })).toBeInTheDocument();
  });

  it("uma página sem título vira 'Sem título' na trilha, nunca um item em branco", async () => {
    getPageBreadcrumbMock.mockResolvedValue([row({ id: "raiz", title: "" })]);

    render(<Breadcrumb pageId="raiz" />);

    expect(await screen.findByText(/Sem título/)).toBeInTheDocument();
  });

  it("mostra o erro do backend em vez de travar em 'Carregando'", async () => {
    getPageBreadcrumbMock.mockRejectedValue(new AppError({ kind: "not_found", message: "página não existe" }));

    render(<Breadcrumb pageId="fantasma" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("página não existe");
  });
});
