import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createPage,
  duplicatePage,
  listPageTree,
  movePage,
  renamePage,
  setPageFavorite,
  trashPage,
  type PageRow,
} from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { PageTree } from "./PageTree";

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
    getPageBreadcrumb: vi.fn(),
    trashPage: vi.fn(),
    // `TrashDialog` (rodapé "Lixeira") só busca ao abrir, mas fica montado
    // (fechado) em toda renderização de `PageTree` — sem valor default aqui
    // um teste que não a abre nunca depende disto, então basta existir.
    listTrashedPages: vi.fn(),
  };
});

const listPageTreeMock = vi.mocked(listPageTree);
const createPageMock = vi.mocked(createPage);
const renamePageMock = vi.mocked(renamePage);
const setPageFavoriteMock = vi.mocked(setPageFavorite);
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

// A>B (FUN-001 exemplo do checklist) mais uma raiz irmã C, para ter o que
// reordenar/expandir/colapsar.
// jsdom traz de fábrica a regra CSS `[popover]:not(:popover-open) { display: none }`
// do WHATWG (ver node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css)
// sem implementar o resto da Popover API — então todo painel de
// `EmojiIconPicker`/`PageContextMenu` fica permanentemente `display: none`
// aqui, mesmo depois do clique no gatilho. O conteúdo continua no DOM (é só
// CSS, não desmontagem), então `{ hidden: true }` no `getByRole` o encontra
// mesmo assim, e `fireEvent.click` (que não checa visibilidade, ao contrário
// de `userEvent.click`) consegue interagir com ele. No WebView2 real isso
// abre visualmente; o gatilho continua clicado antes, por realismo.
const biologia = row({ id: "biologia", title: "Biologia", position: "1" });
const celulas = row({ id: "celulas", parent_id: "biologia", title: "Células", position: "1" });
const quimica = row({ id: "quimica", title: "Química", position: "2" });

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
  listPageTreeMock.mockResolvedValue([biologia, celulas, quimica]);
});

describe("PageTree", () => {
  it("FUN-001: carrega e mostra as páginas raiz, colapsadas por padrão", async () => {
    render(<PageTree />);

    expect(await screen.findByRole("treeitem", { name: /Biologia/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Química/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Células/ })).not.toBeInTheDocument();
  });

  it("§1: uma página raiz parece categoria (peso e ícone maior) — uma sub-página não", async () => {
    const user = userEvent.setup();
    render(<PageTree />);
    const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });
    expect(biologiaRow.querySelector("button.font-semibold")).toBeInTheDocument();
    expect(within(biologiaRow).getByLabelText("Ícone de Biologia")).toHaveClass("size-7", "text-lg");

    await user.click(within(biologiaRow).getByLabelText("Expandir"));
    const celulasRow = screen.getByRole("treeitem", { name: /Células/ });
    expect(celulasRow.querySelector("button.font-semibold")).not.toBeInTheDocument();
    expect(within(celulasRow).getByLabelText("Ícone de Células")).toHaveClass("size-6", "text-base");
  });

  it("expandir Biologia revela Células; colapsar esconde de novo", async () => {
    const user = userEvent.setup();
    render(<PageTree />);
    const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });

    await user.click(within(biologiaRow).getByLabelText("Expandir"));
    expect(screen.getByRole("treeitem", { name: /Células/ })).toBeInTheDocument();

    await user.click(within(biologiaRow).getByLabelText("Recolher"));
    expect(screen.queryByRole("treeitem", { name: /Células/ })).not.toBeInTheDocument();
  });

  it("FUN-002: o + da linha cria uma sub-página em branco sob aquele pai, com foco no título", async () => {
    const user = userEvent.setup();
    const newChild = row({ id: "nova", parent_id: "biologia", title: "" });
    createPageMock.mockResolvedValue(newChild);
    render(<PageTree />);
    const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });

    await user.click(within(biologiaRow).getByLabelText("Adicionar subpágina em Biologia"));

    expect(createPageMock).toHaveBeenCalledWith("biologia", undefined);
    // A página nova nasce selecionada, aninhada sob o pai (aria-level 2, um
    // a mais que a raiz) e já em modo de edição com o campo de título
    // focado — não só existindo na árvore como texto estático, que é tudo
    // que a versão anterior deste teste checava.
    const titleInput = await screen.findByLabelText("Título de Sem título");
    expect(titleInput).toHaveFocus();
    expect(titleInput.closest('[role="treeitem"]')).toHaveAttribute("aria-level", "2");
  });

  it("'Nova página' no rodapé cria uma página raiz (parent_id nulo)", async () => {
    const user = userEvent.setup();
    createPageMock.mockResolvedValue(row({ id: "raiz-nova", title: "" }));
    render(<PageTree />);
    await screen.findByRole("treeitem", { name: /Biologia/ });

    await user.click(screen.getByRole("button", { name: "Nova página" }));

    expect(createPageMock).toHaveBeenCalledWith(null, undefined);
    // Espera o `createChild` da store terminar (patch do mapa + seleção) antes
    // do teste acabar — sem isto o `set()` resolve depois que o teste encerrou
    // e o React acusa atualização de estado fora de `act()`.
    await waitFor(() => expect(usePageTreeStore.getState().selectedPageId).toBe("raiz-nova"));
  });

  it("renomear por duplo clique confirma com Enter e chama renamePage", async () => {
    const user = userEvent.setup();
    renamePageMock.mockResolvedValue({ ...quimica, title: "Química Orgânica" });
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    await user.dblClick(within(quimicaRow).getByText("Química"));
    const input = within(quimicaRow).getByLabelText("Título de Química");
    await user.clear(input);
    await user.type(input, "Química Orgânica{Enter}");

    expect(renamePageMock).toHaveBeenCalledWith("quimica", "Química Orgânica");
    // Espera o `rename` da store terminar e a linha refletir o novo título —
    // sem isto o `patchPage` resolve depois do teste, e o React acusa
    // atualização de estado fora de `act()`.
    await waitFor(() => expect(within(quimicaRow).getByText("Química Orgânica")).toBeInTheDocument());
  });

  it("Escape ao renomear cancela sem chamar o backend", async () => {
    const user = userEvent.setup();
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    await user.dblClick(within(quimicaRow).getByText("Química"));
    const input = within(quimicaRow).getByLabelText("Título de Química");
    await user.type(input, " mudança{Escape}");

    expect(renamePageMock).not.toHaveBeenCalled();
    expect(within(quimicaRow).getByText("Química")).toBeInTheDocument();
  });

  it("favoritar pelo menu de contexto (atalho equivalente à estrela do FUN-008) move a página para a seção Favoritos, sem sumir da árvore", async () => {
    const user = userEvent.setup();
    setPageFavoriteMock.mockResolvedValue({ ...quimica, is_favorite: true });
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    await user.click(within(quimicaRow).getByLabelText("Mais ações para Química"));
    fireEvent.click(within(quimicaRow).getByRole("menuitem", { name: "Favoritar", hidden: true }));

    expect(setPageFavoriteMock).toHaveBeenCalledWith("quimica", true);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Favoritos" })).toBeInTheDocument(),
    );
    // FUN-009: continua no local hierárquico original — a linha da árvore não sumiu.
    expect(screen.getByRole("treeitem", { name: /Química/ })).toBeInTheDocument();
  });

  it("FUN-009: 'Remover dos favoritos' no menu de contexto tira da seção sem apagar a página", async () => {
    const user = userEvent.setup();
    usePageTreeStore.setState({
      pagesById: new Map([
        ["biologia", biologia],
        ["celulas", celulas],
        ["quimica", { ...quimica, is_favorite: true }],
      ]),
      childrenIndex: usePageTreeStore.getState().childrenIndex,
      status: "ready",
    });
    listPageTreeMock.mockResolvedValue([biologia, celulas, { ...quimica, is_favorite: true }]);
    setPageFavoriteMock.mockResolvedValue({ ...quimica, is_favorite: false });
    render(<PageTree />);
    expect(await screen.findByRole("region", { name: "Favoritos" })).toBeInTheDocument();

    const quimicaRow = screen.getByRole("treeitem", { name: /Química/ });
    await user.click(within(quimicaRow).getByLabelText("Mais ações para Química"));
    fireEvent.click(within(quimicaRow).getByRole("menuitem", { name: "Remover dos favoritos", hidden: true }));

    expect(setPageFavoriteMock).toHaveBeenCalledWith("quimica", false);
    // "Tira da seção" é o próprio critério do teste — esperar por isto também
    // é o que flush a atualização assíncrona do `patchPage` dentro de `act()`,
    // em vez de deixá-la resolver depois que o teste já terminou.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Favoritos" })).not.toBeInTheDocument());
  });

  it("FUN-020: duplicar pelo menu de contexto chama duplicatePage", async () => {
    const user = userEvent.setup();
    duplicatePageMock.mockResolvedValue(row({ id: "copia", title: "Química (cópia)" }));
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    await user.click(within(quimicaRow).getByLabelText("Mais ações para Química"));
    fireEvent.click(within(quimicaRow).getByRole("menuitem", { name: "Duplicar", hidden: true }));

    expect(duplicatePageMock).toHaveBeenCalledWith("quimica");
    // `duplicate()` só termina depois de recarregar a árvore e selecionar a
    // cópia nova — esperar por isso é o que flush o `set()` assíncrono dentro
    // de `act()`, em vez de deixá-lo pender para depois do teste.
    await waitFor(() => expect(usePageTreeStore.getState().selectedPageId).toBe("copia"));
  });

  it("FUN-022: 'Mover para...' abre o diálogo de busca com Química já excluída dos alvos", async () => {
    const user = userEvent.setup();
    movePageMock.mockResolvedValue({ ...quimica, parent_id: "biologia" });
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    await user.click(within(quimicaRow).getByLabelText("Mais ações para Química"));
    fireEvent.click(within(quimicaRow).getByRole("menuitem", { name: "Mover para...", hidden: true }));

    // O `<dialog>` também começa fechado no jsdom (`showModal` é indisponível
    // lá, ver `MoveToDialog`) — mesma lógica de `hidden: true` de cima.
    // Aspas curvas (“ ”) de propósito no `MoveToDialog` — não são as retas do regex.
    expect(screen.getByRole("heading", { name: /Mover .Química. para/, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Biologia/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Química/, hidden: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Biologia/, hidden: true }));
    expect(movePageMock).toHaveBeenCalledWith("quimica", "biologia", { type: "end" });
    // Química vira filha de Biologia (colapsada) e some da raiz — esperar por
    // isto flush o `patchPage` assíncrono dentro de `act()`, em vez de deixá-lo
    // pender para depois do teste.
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /Química/ })).not.toBeInTheDocument());
  });

  it("FUN-027: 'Mover para lixeira' no menu de contexto chama trashPage e a página some da árvore", async () => {
    const user = userEvent.setup();
    trashPageMock.mockResolvedValue({ ...quimica, deleted_at: "2026-01-01T00:00:00Z" });
    render(<PageTree />);
    const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });

    // Só a partir daqui a árvore ativa "esquece" Química — é o recarregamento
    // disparado pelo próprio `trash()` (não uma remoção otimista) que faz o
    // critério "some da árvore" valer para quem usa o app de verdade.
    listPageTreeMock.mockResolvedValue([biologia, celulas]);
    await user.click(within(quimicaRow).getByLabelText("Mais ações para Química"));
    fireEvent.click(within(quimicaRow).getByRole("menuitem", { name: "Mover para lixeira", hidden: true }));

    expect(trashPageMock).toHaveBeenCalledWith("quimica");
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /Química/ })).not.toBeInTheDocument());
  });

  describe("navegação por teclado", () => {
    it("ArrowDown/ArrowUp movem o foco de uma linha raiz para a outra", async () => {
      const user = userEvent.setup();
      render(<PageTree />);
      const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });
      const quimicaRow = screen.getByRole("treeitem", { name: /Química/ });

      // `.focus()` imperativo dispara o `onFocus` de `PageTreeItem` (que
      // atualiza `focusedId` em `PageTree`) fora de qualquer wrapper do RTL —
      // ao contrário de `user.click`/`user.keyboard`, que já envolvem o
      // disparo em `act()` sozinhos. Sem este `act()` aqui, o React acusa
      // atualização de estado fora de `act()`.
      act(() => biologiaRow.focus());
      await user.keyboard("{ArrowDown}");
      expect(quimicaRow).toHaveFocus();

      await user.keyboard("{ArrowUp}");
      expect(biologiaRow).toHaveFocus();
    });

    it("ArrowRight expande um nó colapsado com filhos; ArrowLeft o recolhe de novo", async () => {
      const user = userEvent.setup();
      render(<PageTree />);
      const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });
      act(() => biologiaRow.focus());

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("treeitem", { name: /Células/ })).toBeInTheDocument();

      await user.keyboard("{ArrowLeft}");
      expect(screen.queryByRole("treeitem", { name: /Células/ })).not.toBeInTheDocument();
    });

    it("FUN-004 por teclado: Alt+ArrowDown reordena Biologia para depois de Química", async () => {
      const user = userEvent.setup();
      movePageMock.mockResolvedValue({ ...biologia, position: "3" });
      render(<PageTree />);
      const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });
      act(() => biologiaRow.focus());

      await user.keyboard("{Alt>}{ArrowDown}{/Alt}");

      expect(movePageMock).toHaveBeenCalledWith("biologia", null, { type: "after", value: "quimica" });
      // `handleKeyboardMove` só devolve o foco à linha (`focusRow`) depois que
      // `await move(...)` resolve — um "tick" de microtarefa depois do patch
      // da store. Esperar por isso (não só pelo patch) é o que flush os dois
      // updates dentro de `act()`, em vez de deixar o segundo pender para
      // depois do teste.
      await waitFor(() => expect(biologiaRow).toHaveFocus());
    });

    it("FUN-005 por teclado: Alt+ArrowRight aninha Química como filha de Biologia", async () => {
      const user = userEvent.setup();
      movePageMock.mockResolvedValue({ ...quimica, parent_id: "biologia" });
      render(<PageTree />);
      const quimicaRow = await screen.findByRole("treeitem", { name: /Química/ });
      act(() => quimicaRow.focus());

      await user.keyboard("{Alt>}{ArrowRight}{/Alt}");

      expect(movePageMock).toHaveBeenCalledWith("quimica", "biologia", { type: "end" });
      // Química vira filha de Biologia, que continua colapsada — a linha some
      // do DOM (não só recebe um novo `aria-level`). Esperar por isso é o que
      // flush o `patchPage` assíncrono dentro de `act()`, em vez de deixá-lo
      // pender para depois do teste. `focusRow` (chamado depois do `await
      // move(...)` em `handleKeyboardMove`) não tem mais linha pra focar
      // aqui — a árvore perde o foco de vez, diferente de FUN-004/006, que
      // reordenam sem esconder a linha movida.
      await waitFor(() => expect(screen.queryByRole("treeitem", { name: /Química/ })).not.toBeInTheDocument());
    });

    it("FUN-006 por teclado: Alt+ArrowLeft desaninha Células de volta para a raiz", async () => {
      const user = userEvent.setup();
      movePageMock.mockResolvedValue({ ...celulas, parent_id: null });
      render(<PageTree />);
      const biologiaRow = await screen.findByRole("treeitem", { name: /Biologia/ });
      await user.click(within(biologiaRow).getByLabelText("Expandir"));
      const celulasRow = screen.getByRole("treeitem", { name: /Células/ });
      act(() => celulasRow.focus());

      await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");

      expect(movePageMock).toHaveBeenCalledWith("celulas", null, { type: "after", value: "biologia" });
      // `handleKeyboardMove` só devolve o foco à linha (`focusRow`) depois que
      // `await move(...)` resolve — um "tick" de microtarefa depois do patch
      // da store. Esperar por isso (não só pelo patch) é o que flush os dois
      // updates dentro de `act()`, em vez de deixar o segundo pender para
      // depois do teste.
      await waitFor(() => expect(celulasRow).toHaveFocus());
    });
  });

  // FUN-004/005/006 via mouse (arrastar e soltar) ficam para o Playwright:
  // 1. Abrir o app com Biologia > Células e Química como raízes.
  // 2. Arrastar Química e soltar no terço de baixo de Biologia -> reordena
  //    (mesmo pai, posição depois).
  // 3. Arrastar Química e soltar no terço do meio de Biologia -> Química vira
  //    filha de Biologia (indicador de aninhar visível durante o arraste).
  // 4. Arrastar Células para a área vazia abaixo da árvore -> Células vira
  //    raiz, parent_id nulo.
  // 5. Em cada passo, assert visual do indicador de posição (linha entre
  //    irmãos vs. contorno de aninhar) e que uma página não pode ser solta
  //    dentro da própria subárvore (cursor "não permitido").
});
