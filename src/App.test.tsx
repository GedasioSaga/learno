import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { useNavegacaoStore } from "./features/navegacao/store";
import { usePageTreeStore } from "./features/pages/store";
import { useTrilhaStore } from "./features/trilha/store";
import {
  autosaveClearPending,
  autosaveListRecoverable,
  autosaveMergeWithSaved,
  autosaveWritePending,
  getPageBreadcrumb,
  listPageTree,
  listPageVersions,
  openWorkspace,
  renamePage,
  type AutosaveJournalEntry,
  type PageRow,
} from "./lib/ipc";
import { useThemeStore } from "./lib/theme-store";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    openWorkspace: vi.fn(),
    listPageTree: vi.fn(),
    getPageBreadcrumb: vi.fn(),
    listPageVersions: vi.fn(),
    renamePage: vi.fn(),
    // PLT-005: both autosave halves cross the IPC boundary — without
    // mocking these, those calls would hit the real Tauri `invoke` (absent
    // in jsdom).
    autosaveWritePending: vi.fn(),
    autosaveClearPending: vi.fn(),
    autosaveListRecoverable: vi.fn(),
    autosaveMergeWithSaved: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const openWorkspaceMock = vi.mocked(openWorkspace);
const listPageTreeMock = vi.mocked(listPageTree);
const getPageBreadcrumbMock = vi.mocked(getPageBreadcrumb);
const listPageVersionsMock = vi.mocked(listPageVersions);
const renamePageMock = vi.mocked(renamePage);
const autosaveWritePendingMock = vi.mocked(autosaveWritePending);
const autosaveClearPendingMock = vi.mocked(autosaveClearPending);
const autosaveListRecoverableMock = vi.mocked(autosaveListRecoverable);
const autosaveMergeWithSavedMock = vi.mocked(autosaveMergeWithSaved);

// Depois da migração para SQLite, `AppConfig` só guarda a pasta de trabalho —
// não há mais host/porta/usuário/senha a espelhar aqui.
const savedConfig = { data_dir: "C:\\Users\\fixture\\AppData\\Roaming\\Learno" };

beforeEach(() => {
  openWorkspaceMock.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({ preferencia: "papel", temaEfetivo: "papel", ultimoEscuro: "ambar-noturno" });
  useNavegacaoStore.setState({ secaoAtiva: "notas", painelRecolhido: false, ultimaTrocaPor: null });
  // Sem isto, uma Trilha "criada" (ponteiro em localStorage) ou um erro de um
  // teste anterior sobreviveria para o próximo `it` — o store do zustand é um
  // módulo, não algo que `render(<App/>)` recria a cada teste.
  useTrilhaStore.setState({ status: "carregando", viewId: null, trilha: null, errorMessage: null });
});

describe("App", () => {
  it("mostra a tela de carregamento enquanto o workspace ainda está abrindo", async () => {
    // Uma promise que nunca resolve dentro do teste mantém o app parado em
    // "loading" — é exatamente esse estado intermediário que este teste prova.
    openWorkspaceMock.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(await screen.findByText("Carregando…")).toBeInTheDocument();
  });

  it("libera a casca do app assim que o workspace abre", async () => {
    openWorkspaceMock.mockResolvedValue(savedConfig);

    render(<App />);

    expect(await screen.findByText("Bem-vindo ao Learno")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Páginas" })).toBeInTheDocument();
    expect(openWorkspaceMock).toHaveBeenCalledWith();
  });

  it("mostra um erro claro quando o banco de dados não pôde ser aberto", async () => {
    openWorkspaceMock.mockRejectedValue(new Error("disco cheio"));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("disco cheio");
  });

  it("o rail tem as oito seções, na ordem certa, e trocar de seção troca o conteúdo", async () => {
    openWorkspaceMock.mockResolvedValue(savedConfig);
    listPageTreeMock.mockResolvedValue([]);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText("Bem-vindo ao Learno");

    const rail = screen.getByRole("navigation", { name: "Seções" });
    expect(
      within(rail)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Hoje", "Notas", "Cartões", "Mapa mental", "Trilha", "Cronograma", "Finanças", "Biblioteca"]);
    expect(within(rail).getByRole("button", { name: "Configurações" })).toBeInTheDocument();

    // Trilha abre sem IPC (ver `features/trilha/`) — sem
    // ponteiro de Trilha salvo (o `localStorage.clear()` do `beforeEach`
    // cuida disso), o convite de criar aparece sem chamada de IPC nenhuma.
    await user.click(within(rail).getByRole("button", { name: "Trilha" }));

    expect(screen.getByRole("heading", { level: 2, name: "Nenhuma trilha ainda" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar minha primeira trilha" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Páginas" })).not.toBeInTheDocument();

    // Voltar a Notas devolve a árvore, sem recarregar nada.
    await user.click(within(rail).getByRole("button", { name: "Notas" }));
    expect(screen.getByRole("navigation", { name: "Páginas" })).toBeInTheDocument();
  });
});

describe("PLT-005: o rascunho de uma edição não confirmada sobrevive a uma queda de verdade", () => {
  const pageId = "cronograma";
  const originalTitle = "Cronograma";
  const draftedTitle = "Cronograma revisado durante a queda";

  function pageRow(title: string): PageRow {
    return {
      id: pageId,
      parent_id: null,
      database_id: null,
      title,
      icon: null,
      position: "1",
      is_favorite: false,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  // Stands in for `backup::autosave`'s on-disk journal — the
  // `autosaveWritePending`/`autosaveClearPending`/`autosaveListRecoverable`
  // calls read and write here, exactly like `AutosaveJournal` does with the
  // real `<page_id>.json` file (write replaces, clear erases, list only
  // returns what's still unconfirmed). It's a module-level `let`, not reset
  // between the two simulated sessions below — that's the only way it
  // actually survives the "crash" instead of just pretending to.
  let journalDisk: AutosaveJournalEntry | null = null;

  beforeEach(() => {
    journalDisk = null;

    openWorkspaceMock.mockReset().mockResolvedValue(savedConfig);
    listPageTreeMock.mockReset().mockResolvedValue([pageRow(originalTitle)]);
    getPageBreadcrumbMock.mockReset().mockResolvedValue([pageRow(originalTitle)]);
    listPageVersionsMock.mockReset().mockResolvedValue([]);
    renamePageMock.mockReset();

    autosaveWritePendingMock.mockReset().mockImplementation(async (id, title, content) => {
      journalDisk = { page_id: id, title, content, captured_at: new Date().toISOString() };
    });
    autosaveClearPendingMock.mockReset().mockImplementation(async (id) => {
      if (journalDisk?.page_id === id) journalDisk = null;
    });
    autosaveListRecoverableMock.mockReset().mockImplementation(async () => (journalDisk ? [journalDisk] : []));
    // Simulates `merge_after_crash` always deciding "newer than the last
    // save": no confirmed save ever happens in this story, so there's no
    // baseline to compare against (see `autosave.rs::merge_after_crash`).
    autosaveMergeWithSavedMock.mockReset().mockImplementation(async (entry) => entry);
  });

  it("edição no título sem confirmar, queda do processo, reabertura: o conteúdo volta sozinho", async () => {
    const user = userEvent.setup();

    // --- Session 1: the user edits the title and the process dies before
    // the blur (and therefore `renamePage`) ever happens. ---
    const { unmount } = render(<App />);

    // Not `getByRole("treeitem", { name })`: the treeitem's accessible name
    // concatenates the neighboring buttons' `aria-label`s (icon, "Add
    // subpage to..."), so it's never just the bare title (same reason
    // `PageTree.test.tsx` uses a regex instead of an exact string on that
    // role). The title button itself has only the bare text — `getByText`
    // isolates it without that ambiguity. Scoped to the page tree because
    // "Cronograma" is also the label of a section in the rail — an unscoped
    // `findByText` resolves on the rail (rendered synchronously) before the
    // tree finishes loading, and clicks the wrong thing.
    const arvore = await screen.findByRole("navigation", { name: "Páginas" });
    await user.click(await within(arvore).findByText(originalTitle));

    const titleField = await screen.findByLabelText("Título da página");
    expect(titleField).toHaveValue(originalTitle);

    vi.useFakeTimers();
    fireEvent.change(titleField, { target: { value: draftedTitle } });
    // PLT-005's 3s debounce (`AUTOSAVE_DEBOUNCE_MS` in useAutosaveDraft.ts).
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();

    expect(autosaveWritePendingMock).toHaveBeenCalledWith(pageId, draftedTitle, { title: draftedTitle });
    expect(journalDisk).not.toBeNull();
    // The crash happens right here: no blur, no `renamePage`.
    expect(renamePageMock).not.toHaveBeenCalled();

    unmount();

    // --- "Reopens": a new process — the in-memory Zustand store resets (it's
    // RAM), the on-disk journal (`journalDisk`) stays intact. ---
    usePageTreeStore.setState({
      status: "idle",
      errorMessage: null,
      pagesById: new Map(),
      childrenIndex: new Map(),
      expandedIds: new Set(),
      selectedPageId: null,
    });
    renamePageMock.mockResolvedValue(pageRow(draftedTitle));

    render(<App />);

    // The database never got the edit — the tree still shows the old title.
    const arvoreReaberta = await screen.findByRole("navigation", { name: "Páginas" });
    expect(await within(arvoreReaberta).findByText(originalTitle)).toBeInTheDocument();

    // The banner shows up on its own (no click caused this), displaying
    // exactly what was typed before the crash, not a fixed test value.
    expect(await screen.findByText(draftedTitle)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recuperar" }));

    // The final proof: the effect, not just the mock call. Both the open
    // page's title field and the sidebar tree row show the recovered content.
    expect(await screen.findByLabelText("Título da página")).toHaveValue(draftedTitle);
    expect(await screen.findAllByText(draftedTitle)).not.toHaveLength(0);

    expect(renamePageMock).toHaveBeenCalledWith(pageId, draftedTitle);
    await waitFor(() => expect(autosaveClearPendingMock).toHaveBeenCalledWith(pageId));
  });
});
