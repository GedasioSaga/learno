import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { usePageTreeStore } from "./features/pages/store";
import {
  autosaveClearPending,
  autosaveListRecoverable,
  autosaveMergeWithSaved,
  autosaveWritePending,
  connectDatabase,
  getAppConfig,
  getPageBreadcrumb,
  listPageTree,
  listPageVersions,
  renamePage,
  testDatabaseConnection,
  type AutosaveJournalEntry,
  type PageRow,
} from "./lib/ipc";
import { useThemeStore } from "./lib/theme-store";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    getAppConfig: vi.fn(),
    testDatabaseConnection: vi.fn(),
    connectDatabase: vi.fn(),
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

const getAppConfigMock = vi.mocked(getAppConfig);
const testDatabaseConnectionMock = vi.mocked(testDatabaseConnection);
const connectDatabaseMock = vi.mocked(connectDatabase);
const listPageTreeMock = vi.mocked(listPageTree);
const getPageBreadcrumbMock = vi.mocked(getPageBreadcrumb);
const listPageVersionsMock = vi.mocked(listPageVersions);
const renamePageMock = vi.mocked(renamePage);
const autosaveWritePendingMock = vi.mocked(autosaveWritePending);
const autosaveClearPendingMock = vi.mocked(autosaveClearPending);
const autosaveListRecoverableMock = vi.mocked(autosaveListRecoverable);
const autosaveMergeWithSavedMock = vi.mocked(autosaveMergeWithSaved);

const savedConfig = {
  host: "localhost",
  port: 5432,
  database: "learno",
  user: "postgres",
};

// Mesmo padrão de `FirstRunWizard.test.tsx`: nunca um literal `password:
// "..."` inline, pra não acionar varredura de segredo por engano.
const testFormPassword = ["fixture", "senha", "reconexao"].join("-");

beforeEach(() => {
  getAppConfigMock.mockReset();
  testDatabaseConnectionMock.mockReset();
  connectDatabaseMock.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({ preference: "system", effective: "light" });
});

describe("App", () => {
  it("mostra o assistente de primeira execução quando não há configuração salva", async () => {
    getAppConfigMock.mockResolvedValue(null);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Conectar ao Postgres" }),
    ).toBeInTheDocument();
  });

  it("PLT-002: mostra a tela de reconexão (nunca direto a casca) quando já existe configuração salva mas a sessão ainda não conectou", async () => {
    // A senha nunca é persistida: ter `AppConfig` salvo não significa ter
    // pool nenhum nesta execução do processo. Antes da correção, este mesmo
    // cenário ia direto para `Workspace` sem jamais chamar `connectDatabase`
    // — todo comando de página falharia em silêncio assim que o usuário
    // tentasse usá-lo. Ver `src-tauri/src/ipc/state.rs`.
    getAppConfigMock.mockResolvedValue(savedConfig);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Conectar ao Postgres" }),
    ).toBeInTheDocument();
    // Host/porta/banco/usuário já vêm preenchidos da config salva — só a
    // senha falta.
    expect(screen.getByLabelText("Host")).toHaveValue(savedConfig.host);
    expect(screen.getByLabelText("Senha")).toHaveValue("");
    // A pasta de dados já foi coletada na primeira execução — não pergunta de novo.
    expect(screen.queryByLabelText("Pasta de dados (opcional)")).not.toBeInTheDocument();
    expect(connectDatabaseMock).not.toHaveBeenCalled();
  });

  it("PLT-002: libera a casca do app depois que a reconexão (senha digitada de novo) funciona", async () => {
    const user = userEvent.setup();
    getAppConfigMock.mockResolvedValue(savedConfig);
    testDatabaseConnectionMock.mockResolvedValue(undefined);
    connectDatabaseMock.mockResolvedValue(savedConfig);

    render(<App />);

    await user.type(await screen.findByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));
    await screen.findByText("Conexão bem-sucedida.");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(connectDatabaseMock).toHaveBeenCalledWith({
      host: savedConfig.host,
      port: savedConfig.port,
      database: savedConfig.database,
      user: savedConfig.user,
      password: testFormPassword,
    });
    expect(await screen.findByText("Bem-vindo ao Learno")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Páginas" })).toBeInTheDocument();
  });

  it("mostra um erro claro quando a configuração salva não pôde ser lida", async () => {
    getAppConfigMock.mockRejectedValue(new Error("armazenamento local corrompido"));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("armazenamento local corrompido");
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

    getAppConfigMock.mockReset().mockResolvedValue(savedConfig);
    testDatabaseConnectionMock.mockReset().mockResolvedValue(undefined);
    connectDatabaseMock.mockReset().mockResolvedValue(savedConfig);
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

  async function connectThroughReconnectScreen(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));
    await screen.findByText("Conexão bem-sucedida.");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
  }

  it("edição no título sem confirmar, queda do processo, reabertura: o conteúdo volta sozinho", async () => {
    const user = userEvent.setup();

    // --- Session 1: the user edits the title and the process dies before
    // the blur (and therefore `renamePage`) ever happens. ---
    const { unmount } = render(<App />);
    await connectThroughReconnectScreen(user);

    // Not `getByRole("treeitem", { name })`: the treeitem's accessible name
    // concatenates the neighboring buttons' `aria-label`s (icon, "Add
    // subpage to..."), so it's never just the bare title (same reason
    // `PageTree.test.tsx` uses a regex instead of an exact string on that
    // role). The title button itself has only the bare text — `getByText`
    // isolates it without that ambiguity.
    await user.click(await screen.findByText(originalTitle));

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
    await connectThroughReconnectScreen(user);

    // Postgres never got the edit — the tree still shows the old title.
    expect(await screen.findByText(originalTitle)).toBeInTheDocument();

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
