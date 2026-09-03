import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  createPage,
  duplicatePage,
  listPageTree,
  movePage,
  renamePage,
  setPageFavorite,
  setPageIcon,
  trashPage,
  type PageRow,
} from "../../lib/ipc";
import { usePageTreeStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listPageTree: vi.fn(),
    createPage: vi.fn(),
    renamePage: vi.fn(),
    setPageFavorite: vi.fn(),
    setPageIcon: vi.fn(),
    movePage: vi.fn(),
    duplicatePage: vi.fn(),
    trashPage: vi.fn(),
  };
});

const listPageTreeMock = vi.mocked(listPageTree);
const createPageMock = vi.mocked(createPage);
const renamePageMock = vi.mocked(renamePage);
const setPageFavoriteMock = vi.mocked(setPageFavorite);
const setPageIconMock = vi.mocked(setPageIcon);
const movePageMock = vi.mocked(movePage);
const duplicatePageMock = vi.mocked(duplicatePage);
const trashPageMock = vi.mocked(trashPage);

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
  // Reseta só os dados — as ações continuam as mesmas closures, criadas uma
  // vez por `create()`; não há por que recriar a store inteira a cada teste.
  usePageTreeStore.setState({
    status: "idle",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
    pendingFocusId: null,
  });
});

describe("load", () => {
  it("FUN-001: povoa pagesById e childrenIndex a partir da árvore recebida", async () => {
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    listPageTreeMock.mockResolvedValue([a, b]);

    await usePageTreeStore.getState().load();

    const state = usePageTreeStore.getState();
    expect(state.status).toBe("ready");
    expect(state.pagesById.get("A")).toEqual(a);
    expect(state.childrenIndex.get("A")?.map((p) => p.id)).toEqual(["B"]);
  });

  it("guarda a mensagem do backend quando a carga falha, sem travar em 'loading'", async () => {
    listPageTreeMock.mockRejectedValue(new AppError({ kind: "database", message: "sem conexão" }));

    await usePageTreeStore.getState().load();

    const state = usePageTreeStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("sem conexão");
  });
});

describe("createChild", () => {
  it("FUN-002: cria, expande o pai e seleciona a página nova", async () => {
    const parent = row({ id: "parent", title: "Biologia" });
    usePageTreeStore.setState({ pagesById: new Map([["parent", parent]]) });
    const created = row({ id: "child", parent_id: "parent", title: "" });
    createPageMock.mockResolvedValue(created);

    const result = await usePageTreeStore.getState().createChild("parent");

    expect(createPageMock).toHaveBeenCalledWith("parent", undefined);
    expect(result).toEqual(created);
    const state = usePageTreeStore.getState();
    expect(state.pagesById.get("child")).toEqual(created);
    expect(state.expandedIds.has("parent")).toBe(true);
    expect(state.selectedPageId).toBe("child");
    // A parte do critério que a auditoria apontou como nunca verificada:
    // "nasce com foco no título" vira essa intenção guardada aqui —
    // `PageTreeItem` é quem a consome e entra em modo de edição de fato.
    expect(state.pendingFocusId).toBe("child");
  });

  it("propaga o erro para quem chamou, sem inserir uma página fantasma", async () => {
    createPageMock.mockRejectedValue(new AppError({ kind: "invalid", message: "pai inválido" }));

    await expect(usePageTreeStore.getState().createChild("parent")).rejects.toThrow("pai inválido");
    expect(usePageTreeStore.getState().pagesById.size).toBe(0);
  });
});

describe("consumePendingFocus", () => {
  it("limpa pendingFocusId quando o id bate", () => {
    usePageTreeStore.setState({ pendingFocusId: "child" });

    usePageTreeStore.getState().consumePendingFocus("child");

    expect(usePageTreeStore.getState().pendingFocusId).toBeNull();
  });

  it("ignora um id que não é o pendente — outra linha não pode apagar o pedido de foco alheio", () => {
    usePageTreeStore.setState({ pendingFocusId: "child" });

    usePageTreeStore.getState().consumePendingFocus("outra-pagina");

    expect(usePageTreeStore.getState().pendingFocusId).toBe("child");
  });
});

describe("selectPage", () => {
  it("FUN-019: selecionar uma página expande toda a cadeia de ancestrais dela", () => {
    const a = row({ id: "A" });
    const b = row({ id: "B", parent_id: "A" });
    const c = row({ id: "C", parent_id: "B" });
    usePageTreeStore.setState({
      pagesById: new Map([
        ["A", a],
        ["B", b],
        ["C", c],
      ]),
    });

    usePageTreeStore.getState().selectPage("C");

    const state = usePageTreeStore.getState();
    expect(state.selectedPageId).toBe("C");
    expect(state.expandedIds.has("A")).toBe(true);
    expect(state.expandedIds.has("B")).toBe(true);
  });

  it("selecionar null limpa a seleção sem tocar em quem está expandido", () => {
    usePageTreeStore.setState({ selectedPageId: "A", expandedIds: new Set(["A"]) });

    usePageTreeStore.getState().selectPage(null);

    const state = usePageTreeStore.getState();
    expect(state.selectedPageId).toBeNull();
    expect(state.expandedIds.has("A")).toBe(true);
  });
});

describe("mutações de uma página só (rename/favorite/icon/move)", () => {
  it("rename substitui a linha no mapa pela resposta do backend", async () => {
    const original = row({ id: "A", title: "Rascunho" });
    usePageTreeStore.setState({ pagesById: new Map([["A", original]]) });
    const renamed = { ...original, title: "Aula 1" };
    renamePageMock.mockResolvedValue(renamed);

    await usePageTreeStore.getState().rename("A", "Aula 1");

    expect(usePageTreeStore.getState().pagesById.get("A")?.title).toBe("Aula 1");
  });

  it("FUN-008: setFavorite reflete is_favorite sem recarregar a árvore inteira", async () => {
    const original = row({ id: "A", is_favorite: false });
    usePageTreeStore.setState({ pagesById: new Map([["A", original]]) });
    setPageFavoriteMock.mockResolvedValue({ ...original, is_favorite: true });

    await usePageTreeStore.getState().setFavorite("A", true);

    expect(usePageTreeStore.getState().pagesById.get("A")?.is_favorite).toBe(true);
    expect(listPageTreeMock).not.toHaveBeenCalled();
  });

  it("FUN-011: setIcon aceita null para voltar ao ícone padrão", async () => {
    const original = row({ id: "A", icon: "📚" });
    usePageTreeStore.setState({ pagesById: new Map([["A", original]]) });
    setPageIconMock.mockResolvedValue({ ...original, icon: null });

    await usePageTreeStore.getState().setIcon("A", null);

    expect(setPageIconMock).toHaveBeenCalledWith("A", null);
    expect(usePageTreeStore.getState().pagesById.get("A")?.icon).toBeNull();
  });

  it("FUN-004/005/006/022: move troca parent_id e position sem afastar as outras páginas do mapa", async () => {
    const moved = row({ id: "A" });
    const untouched = row({ id: "B" });
    usePageTreeStore.setState({
      pagesById: new Map([
        ["A", moved],
        ["B", untouched],
      ]),
    });
    movePageMock.mockResolvedValue({ ...moved, parent_id: "new-parent", position: "2" });

    await usePageTreeStore.getState().move("A", "new-parent", { type: "end" });

    const state = usePageTreeStore.getState();
    expect(state.pagesById.get("A")?.parent_id).toBe("new-parent");
    expect(state.pagesById.get("B")).toEqual(untouched);
  });
});

describe("duplicate", () => {
  it("FUN-020: recarrega a árvore (para trazer as filhas duplicadas) e seleciona a nova raiz", async () => {
    const originalRoot = row({ id: "original", title: "Módulo 1" });
    const newRoot = row({ id: "copy", title: "Módulo 1 (cópia)" });
    const newChild = row({ id: "copy-child", parent_id: "copy", title: "Aula 1" });
    duplicatePageMock.mockResolvedValue(newRoot);
    listPageTreeMock.mockResolvedValue([originalRoot, newRoot, newChild]);

    const result = await usePageTreeStore.getState().duplicate("original");

    expect(result).toEqual(newRoot);
    const state = usePageTreeStore.getState();
    expect(state.pagesById.get("copy-child")).toEqual(newChild);
    expect(state.selectedPageId).toBe("copy");
  });
});

describe("trash", () => {
  it("FUN-027: recarrega a árvore e limpa a seleção quando a página trashed era a selecionada", async () => {
    const page = row({ id: "A", title: "Rascunho" });
    usePageTreeStore.setState({ pagesById: new Map([["A", page]]), selectedPageId: "A" });
    trashPageMock.mockResolvedValue({ ...page, deleted_at: "2026-01-01T00:00:00Z" });
    // Depois de ir para a lixeira, a página some da listagem ativa — a
    // store não remove a entrada na mão, ela confia no próximo `load()`.
    listPageTreeMock.mockResolvedValue([]);

    await usePageTreeStore.getState().trash("A");

    expect(trashPageMock).toHaveBeenCalledWith("A");
    const state = usePageTreeStore.getState();
    expect(state.pagesById.has("A")).toBe(false);
    expect(state.selectedPageId).toBeNull();
  });

  it("não mexe na seleção quando a página trashed não era a página aberta", async () => {
    const trashed = row({ id: "A" });
    const open = row({ id: "B" });
    usePageTreeStore.setState({
      pagesById: new Map([
        ["A", trashed],
        ["B", open],
      ]),
      selectedPageId: "B",
    });
    trashPageMock.mockResolvedValue({ ...trashed, deleted_at: "2026-01-01T00:00:00Z" });
    listPageTreeMock.mockResolvedValue([open]);

    await usePageTreeStore.getState().trash("A");

    expect(usePageTreeStore.getState().selectedPageId).toBe("B");
  });

  it("propaga o erro sem tocar na seleção", async () => {
    usePageTreeStore.setState({ selectedPageId: "A" });
    trashPageMock.mockRejectedValue(new AppError({ kind: "invalid", message: "já está na lixeira" }));

    await expect(usePageTreeStore.getState().trash("A")).rejects.toThrow("já está na lixeira");
    expect(usePageTreeStore.getState().selectedPageId).toBe("A");
  });
});
