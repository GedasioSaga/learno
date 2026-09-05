import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  autosaveClearPending,
  autosaveWritePending,
  createPageVersionSnapshot,
  getPageBreadcrumb,
  listPageVersions,
  renamePage,
  setPageFavorite,
  setPageIcon,
  type PageRow,
} from "../../lib/ipc";
import { listBacklinks } from "./backlinks/ipc";
import { usePageTreeStore } from "./store";
import { PageWorkspace } from "./PageWorkspace";

vi.mock("./backlinks/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backlinks/ipc")>();
  return { ...actual, listBacklinks: vi.fn() };
});

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
    // PLT-005: `PageWorkspace` now calls `useAutosaveDraft`, which writes
    // and clears the title's draft — without mocking these, those calls
    // would hit the real Tauri `invoke` (absent in jsdom) and reject.
    autosaveWritePending: vi.fn(),
    autosaveClearPending: vi.fn(),
  };
});

const getPageBreadcrumbMock = vi.mocked(getPageBreadcrumb);
const setPageFavoriteMock = vi.mocked(setPageFavorite);
const setPageIconMock = vi.mocked(setPageIcon);
const renamePageMock = vi.mocked(renamePage);
const listPageVersionsMock = vi.mocked(listPageVersions);
const createPageVersionSnapshotMock = vi.mocked(createPageVersionSnapshot);
const autosaveWritePendingMock = vi.mocked(autosaveWritePending);
const autosaveClearPendingMock = vi.mocked(autosaveClearPending);
const listBacklinksMock = vi.mocked(listBacklinks);

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
  autosaveWritePendingMock.mockResolvedValue(undefined);
  autosaveClearPendingMock.mockResolvedValue(undefined);
  listBacklinksMock.mockResolvedValue([]);
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

  it("FUN-023: o botão de exportar Markdown da página aberta está presente", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    // `findBy` (not `getBy`) - no fake timers in this block, so it's free to
    // flush `Editor`'s async initial load the normal way instead of an
    // explicit `act()` dance.
    expect(await screen.findByRole("button", { name: "Exportar como Markdown" })).toBeInTheDocument();
  });

  it("FUN-044: o rodapé de backlinks é montado para a página aberta e mostra o que veio do backend", async () => {
    listBacklinksMock.mockResolvedValue([
      {
        sourceBlockId: "block-1",
        sourcePageId: "aula4",
        sourcePageTitle: "Aula 4",
        sourceSnippet: "Ver o cronograma da disciplina",
        targetPageId: "cronograma",
      },
    ]);
    render(<PageWorkspace pageId="cronograma" />);

    expect(await screen.findByRole("heading", { name: "Backlinks" })).toBeInTheDocument();
    expect(listBacklinksMock).toHaveBeenCalledWith("cronograma");
  });

  it("sem backlinks, o rodapé não aparece (nunca uma seção 'Backlinks' vazia)", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    await screen.findByRole("button", { name: "Exportar como Markdown" });
    expect(screen.queryByRole("heading", { name: "Backlinks" })).not.toBeInTheDocument();
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
    // `Editor` (Fase 2) resolves its initial `blocksApi.list_page_blocks`
    // load a tick after mount, outside the act() boundary `render()` opened
    // - flush it (still under fake timers, via `advanceTimersByTimeAsync(0)`
    // rather than a raw `Promise.resolve()`, which wasn't enough to settle
    // TipTap's own async `useEditor` initialization chain) before anything
    // else touches the tree.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

    expect(createPageVersionSnapshotMock).not.toHaveBeenCalled();
  });

  it("cria um snapshot de autosave a cada 10 minutos de edição contínua, com conteúdo distinto a cada vez", async () => {
    render(<PageWorkspace pageId="cronograma" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // "Edição contínua": o título muda entre um disparo do timer e outro —
    // sem isso o efeito propositalmente não teria nada novo pra congelar
    // (ver o comentário de `usePeriodicVersionSnapshot`). Wrapped in `act`
    // because zustand notifies subscribers (`TitleField`, `PageWorkspace`)
    // synchronously inside `setState` - `Editor`'s own extra render cycle
    // is what makes that update visible enough to warn on now.
    act(() => {
      usePageTreeStore.setState({
        pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma revisado" })]]),
      });
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    act(() => {
      usePageTreeStore.setState({
        pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Cronograma revisado de novo" })]]),
      });
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      usePageTreeStore.setState({
        pagesById: new Map([["cronograma", row({ id: "cronograma", title: "Mudou uma vez" })]]),
      });
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(createPageVersionSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

describe("PLT-005: autosave do rascunho do título — grava enquanto edita", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("grava o rascunho em disco 3s depois que o usuário para de digitar, antes de qualquer confirmação", async () => {
    render(<PageWorkspace pageId="cronograma" />);
    // `Editor` (Fase 2) loads its blocks via a real Promise (`blocksApi`,
    // not mocked here) — one microtask tick after mount, outside any act()
    // boundary `render()` itself opened. Flushing it here, still with fake
    // timers, is what `findBy` would do under real timers (see the comment
    // below on why `findBy` itself is off the table with fake timers active).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Synchronous `getByLabelText`, not `findBy` — with fake timers active,
    // a `findBy`'s internal `waitFor` sits waiting on a polling `setTimeout`
    // that never fires on its own (same pattern as the FUN-034 block above,
    // which also never mixes `findBy` with fake timers).
    const titleField = screen.getByLabelText("Título da página");
    fireEvent.change(titleField, { target: { value: "Cronograma rascunho" } });

    await vi.advanceTimersByTimeAsync(2999);
    expect(autosaveWritePendingMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(autosaveWritePendingMock).toHaveBeenCalledWith("cronograma", "Cronograma rascunho", {
      title: "Cronograma rascunho",
    });
    // Still within the typing debounce — `renamePage` only runs on blur.
    expect(renamePageMock).not.toHaveBeenCalled();
  });

  it("uma tecla nova reinicia o debounce em vez de acumular gravações", async () => {
    render(<PageWorkspace pageId="cronograma" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const titleField = screen.getByLabelText("Título da página");
    fireEvent.change(titleField, { target: { value: "Cronograma A" } });
    await vi.advanceTimersByTimeAsync(1500);
    fireEvent.change(titleField, { target: { value: "Cronograma AB" } });
    await vi.advanceTimersByTimeAsync(2999);
    expect(autosaveWritePendingMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(autosaveWritePendingMock).toHaveBeenCalledTimes(1);
    expect(autosaveWritePendingMock).toHaveBeenCalledWith("cronograma", "Cronograma AB", {
      title: "Cronograma AB",
    });
  });
});

describe("PLT-005: autosave do rascunho do título — limpa só depois de confirmar", () => {
  it("confirmar a mudança (blur) só limpa o rascunho depois que renamePage confirma o salvamento", async () => {
    let resolveRename: (row: PageRow) => void = () => undefined;
    renamePageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRename = resolve;
        }),
    );
    render(<PageWorkspace pageId="cronograma" />);

    const titleField = await screen.findByLabelText("Título da página");
    fireEvent.change(titleField, { target: { value: "Cronograma 2026" } });
    fireEvent.blur(titleField);

    expect(renamePageMock).toHaveBeenCalledWith("cronograma", "Cronograma 2026");
    // `rename` hasn't resolved yet — the draft has to stay on disk.
    expect(autosaveClearPendingMock).not.toHaveBeenCalled();

    resolveRename(row({ id: "cronograma", title: "Cronograma 2026" }));
    await waitFor(() => expect(autosaveClearPendingMock).toHaveBeenCalledWith("cronograma"));
  });

  it("uma falha ao renomear preserva o rascunho em vez de descartá-lo", async () => {
    renamePageMock.mockRejectedValue(new Error("sem conexão"));
    render(<PageWorkspace pageId="cronograma" />);

    const titleField = await screen.findByLabelText("Título da página");
    fireEvent.change(titleField, { target: { value: "Cronograma 2026" } });
    fireEvent.blur(titleField);

    await waitFor(() => expect(renamePageMock).toHaveBeenCalled());
    // Gives the rejection's `.then` branch a chance to run without ever
    // calling `clearDraft`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autosaveClearPendingMock).not.toHaveBeenCalled();
  });

  it("sair do campo sem mudar o título limpa qualquer rascunho pendente sem chamar renamePage", async () => {
    render(<PageWorkspace pageId="cronograma" />);

    const titleField = await screen.findByLabelText("Título da página");
    fireEvent.change(titleField, { target: { value: "Cronograma" } });
    fireEvent.blur(titleField);

    expect(renamePageMock).not.toHaveBeenCalled();
    await waitFor(() => expect(autosaveClearPendingMock).toHaveBeenCalledWith("cronograma"));
  });
});
