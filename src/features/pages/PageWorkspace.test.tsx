import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createPageVersionSnapshot,
  getPageBreadcrumb,
  listPageVersions,
  renamePage,
  setPageFavorite,
  setPageIcon,
  type PageRow,
} from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { PageWorkspace } from "./PageWorkspace";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    getPageBreadcrumb: vi.fn(),
    setPageFavorite: vi.fn(),
    setPageIcon: vi.fn(),
    renamePage: vi.fn(),
    // `VersionHistoryDialog` (FUN-035) carrega o histórico assim que monta,
    // mesmo fechado — todo teste deste arquivo renderiza `PageWorkspace`,
    // que sempre a monta, então precisa de um retorno controlado aqui.
    listPageVersions: vi.fn(),
    createPageVersionSnapshot: vi.fn(),
  };
});

const getPageBreadcrumbMock = vi.mocked(getPageBreadcrumb);
const setPageFavoriteMock = vi.mocked(setPageFavorite);
const setPageIconMock = vi.mocked(setPageIcon);
const renamePageMock = vi.mocked(renamePage);
const listPageVersionsMock = vi.mocked(listPageVersions);
const createPageVersionSnapshotMock = vi.mocked(createPageVersionSnapshot);

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
  getPageBreadcrumbMock.mockResolvedValue([row({ id: "cronograma", title: "Cronograma" })]);
  listPageVersionsMock.mockResolvedValue([]);
  usePageTreeStore.setState({
    status: "ready",
    errorMessage: null,
    pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma" })]]),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: "cronograma",
  });
});

describe("PageWorkspace", () => {
  it("FUN-008: a estrela no topo favorita a página aberta", async () => {
    const user = userEvent.setup();
    setPageFavoriteMock.mockResolvedValue(
      row({ id: "cronograma", title: "Cronograma", is_favorite: true }),
    );
    render(<PageWorkspace pageId="cronograma" />);

    const star = await screen.findByRole("button", { name: "Favoritar" });
    expect(star).toHaveAttribute("aria-pressed", "false");

    await user.click(star);

    expect(setPageFavoriteMock).toHaveBeenCalledWith("cronograma", true);
  });

  it("a estrela já favoritada mostra 'Remover dos favoritos' e desfavorita ao clicar", async () => {
    const user = userEvent.setup();
    usePageTreeStore.setState({
      pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma", is_favorite: true })]]),
    });
    setPageFavoriteMock.mockResolvedValue(
      row({ id: "cronograma", title: "Cronograma", is_favorite: false }),
    );
    render(<PageWorkspace pageId="cronograma" />);

    const star = await screen.findByRole("button", { name: "Remover dos favoritos" });
    await user.click(star);

    expect(setPageFavoriteMock).toHaveBeenCalledWith("cronograma", false);
  });

  it("editar o título e sair do campo (blur) chama renamePage", async () => {
    const user = userEvent.setup();
    renamePageMock.mockResolvedValue(row({ id: "cronograma", title: "Cronograma 2026" }));
    render(<PageWorkspace pageId="cronograma" />);

    const titleField = await screen.findByLabelText("Título da página");
    await user.clear(titleField);
    await user.type(titleField, "Cronograma 2026");
    await user.tab();

    expect(renamePageMock).toHaveBeenCalledWith("cronograma", "Cronograma 2026");
  });

  it("FUN-011: escolher um ícone no cabeçalho faz o emoji aparecer no botão-gatilho", async () => {
    const user = userEvent.setup();
    setPageIconMock.mockResolvedValue(row({ id: "cronograma", title: "Cronograma", icon: "🧪" }));
    render(<PageWorkspace pageId="cronograma" />);

    // O critério de aceite fala do emoji APARECENDO no cabeçalho — não só de
    // `setPageIcon` sendo chamado com os argumentos certos (ver o comentário
    // em `EmojiIconPicker.test.tsx`). `{ hidden: true }` porque o painel é
    // `popover="auto"` e fica `display: none` no jsdom, mesma lógica de
    // `PageTree.test.tsx`.
    const trigger = await screen.findByRole("button", { name: "Ícone de Cronograma", hidden: true });
    expect(trigger).toHaveTextContent("📄");

    await user.click(screen.getByRole("button", { name: "Escolher ícone 🧪", hidden: true }));

    expect(setPageIconMock).toHaveBeenCalledWith("cronograma", "🧪");
    await waitFor(() => expect(trigger).toHaveTextContent("🧪"));
  });

  it("uma página inexistente mostra um estado vazio em vez de quebrar", () => {
    usePageTreeStore.setState({ pagesById: new Map() });

    render(<PageWorkspace pageId="fantasma" />);

    expect(screen.getByText("Página não encontrada")).toBeInTheDocument();
  });

  it("FUN-035: o botão Histórico abre o VersionHistoryDialog da página aberta", async () => {
    const user = userEvent.setup();
    render(<PageWorkspace pageId="cronograma" />);

    await user.click(screen.getByRole("button", { name: "Histórico" }));

    expect(await screen.findByRole("dialog", { name: /Histórico de versões de Cronograma/ })).toBeInTheDocument();
    expect(listPageVersionsMock).toHaveBeenCalledWith("cronograma");
  });

  it("FUN-023: o botão de exportar Markdown da página aberta está presente", () => {
    render(<PageWorkspace pageId="cronograma" />);

    expect(screen.getByRole("button", { name: "Exportar como Markdown" })).toBeInTheDocument();
  });
});

describe("FUN-034: snapshot automático de versão", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("não cria snapshot antes do intervalo de 10 minutos", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

    expect(createPageVersionSnapshotMock).not.toHaveBeenCalled();
  });

  it("cria um snapshot de autosave a cada 10 minutos de edição contínua, com conteúdo distinto a cada vez", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    // "Edição contínua": o título muda entre um disparo do timer e outro —
    // sem isso o efeito propositalmente não teria nada novo pra congelar
    // (ver o comentário de `usePeriodicVersionSnapshot`).
    usePageTreeStore.setState({
      pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma revisado" })]]),
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    usePageTreeStore.setState({
      pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma revisado de novo" })]]),
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(createPageVersionSnapshotMock).toHaveBeenCalledTimes(2);
    expect(createPageVersionSnapshotMock).toHaveBeenNthCalledWith(
      1,
      "cronograma",
      "Cronograma revisado",
      { title: "Cronograma revisado" },
    );
    expect(createPageVersionSnapshotMock).toHaveBeenNthCalledWith(
      2,
      "cronograma",
      "Cronograma revisado de novo",
      { title: "Cronograma revisado de novo" },
    );
  });

  it("não repete o snapshot no intervalo seguinte se o título não mudou de novo", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    usePageTreeStore.setState({
      pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Mudou uma vez" })]]),
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(createPageVersionSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
