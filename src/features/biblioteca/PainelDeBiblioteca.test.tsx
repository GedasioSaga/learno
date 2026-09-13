import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppError,
  criarCategoria,
  importarLivro,
  listarCategorias,
  listarCategoriasPorLivro,
  listarLivros,
  moverCategoria,
  removerCategoria,
  renomearCategoria,
  type Categoria,
  type LivroNaEstante,
} from "../../lib/ipc";
import { PainelDeBiblioteca } from "./PainelDeBiblioteca";
import { useBibliotecaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listarLivros: vi.fn(),
    importarLivro: vi.fn(),
    removerLivro: vi.fn(),
    criarCategoria: vi.fn(),
    listarCategorias: vi.fn(),
    listarCategoriasDoLivro: vi.fn(),
    listarCategoriasPorLivro: vi.fn(),
    definirCategoriasDoLivro: vi.fn(),
    renomearCategoria: vi.fn(),
    moverCategoria: vi.fn(),
    removerCategoria: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const listarLivrosMock = vi.mocked(listarLivros);
const importarLivroMock = vi.mocked(importarLivro);
const openMock = vi.mocked(open);
const criarCategoriaMock = vi.mocked(criarCategoria);
const listarCategoriasMock = vi.mocked(listarCategorias);
const listarCategoriasPorLivroMock = vi.mocked(listarCategoriasPorLivro);
const renomearCategoriaMock = vi.mocked(renomearCategoria);
const moverCategoriaMock = vi.mocked(moverCategoria);
const removerCategoriaMock = vi.mocked(removerCategoria);

function livroNaEstante(overrides: Partial<LivroNaEstante> & { id: string; status?: LivroNaEstante["progresso"]["status"] }): LivroNaEstante {
  const { id, status = "unread", ...resto } = overrides;
  return {
    // `position` (ordem da estante): contrato chegou em `lib/ipc.ts` depois
    // desta suíte existir — fixture fora do escopo da peça que adicionou o
    // campo (GRADE DE LIVROS), só corrigido aqui para o `tsc --noEmit` do
    // projeto voltar a fechar.
    livro: { id, pageId: "00000000-0000-0000-0000-000000000001", format: "pdf", fileName: `${id}.pdf`, coverFileName: null, totalUnits: 100, contentHash: "sha-teste", originalFileName: "original.pdf", fileSize: 1024, metadataTitle: null, metadataAuthor: null, hasTextLayer: true, position: "a0", createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" },
    progresso: {
      bookId: "00000000-0000-0000-0000-000000000000",
      currentLocator: "0",
      currentFraction: 0,
      furthestLocator: "0",
      furthestFraction: 0,
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
      status,
      lastReadAt: null,
    },
    titulo: `Título ${id}`,
    autor: null,
    ...resto,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` limpa o histórico, não a implementação: um
  // `mockResolvedValue` de um teste vazaria para o seguinte sem isto.
  listarCategoriasMock.mockResolvedValue([]);
  listarCategoriasPorLivroMock.mockResolvedValue([]);
  useBibliotecaStore.setState({
    status: "idle",
    errorMessage: null,
    livros: [],
    filtro: "todos",
    categorias: [],
    categoriasPorLivro: new Map(),
    filtroCategoriaId: null,
    tela: "estante",
    livroSelecionadoId: null,
    importando: false,
  });
});

describe("PainelDeBiblioteca", () => {
  it("mostra os quatro filtros com a contagem de cada um", async () => {
    listarLivrosMock.mockResolvedValue([
      livroNaEstante({ id: "a", status: "unread" }),
      livroNaEstante({ id: "b", status: "reading" }),
      livroNaEstante({ id: "c", status: "reading" }),
    ]);

    render(<PainelDeBiblioteca />);

    expect(await screen.findByText("Todos os livros")).toBeInTheDocument();
    const linhaLendo = screen.getByRole("button", { name: /Lendo/ });
    expect(linhaLendo).toHaveTextContent("2");
  });

  it("clicar num filtro troca `filtro` na store", async () => {
    listarLivrosMock.mockResolvedValue([]);
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: /Lido/ }));

    expect(useBibliotecaStore.getState().filtro).toBe("finished");
  });

  it("importar: abre o diálogo filtrado por pdf/epub e chama importarLivro com o caminho escolhido", async () => {
    listarLivrosMock.mockResolvedValue([]);
    openMock.mockResolvedValue("C:\\estudante\\livro.pdf");
    importarLivroMock.mockResolvedValue(livroNaEstante({ id: "novo" }));
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: /Importar livro/ }));

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "PDF e EPUB", extensions: ["pdf", "epub"] }] }),
    );
    await waitFor(() => expect(importarLivroMock).toHaveBeenCalledWith("C:\\estudante\\livro.pdf"));
  });

  it("usuário cancela o diálogo: não chama importarLivro", async () => {
    listarLivrosMock.mockResolvedValue([]);
    openMock.mockResolvedValue(null);
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: /Importar livro/ }));

    expect(importarLivroMock).not.toHaveBeenCalled();
  });

  it("botão de importar trava (rótulo muda e fica desabilitado) enquanto o import está em voo, sem travar o resto do painel", async () => {
    listarLivrosMock.mockResolvedValue([]);
    openMock.mockResolvedValue("C:\\grande.pdf");
    let resolveImport: (value: LivroNaEstante) => void = () => {};
    importarLivroMock.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: /Importar livro/ }));

    const botaoImportando = await screen.findByRole("button", { name: /Importando/ });
    expect(botaoImportando).toBeDisabled();
    // O resto do painel continua respondendo — trocar de filtro não trava.
    fireEvent.click(screen.getByRole("button", { name: /Lendo/ }));
    expect(useBibliotecaStore.getState().filtro).toBe("reading");

    resolveImport(livroNaEstante({ id: "novo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Importar livro/ })).not.toBeDisabled());
  });

  it("erro ao carregar a estante mostra alerta em vez dos filtros", async () => {
    listarLivrosMock.mockRejectedValue(new Error("banco fechado"));

    render(<PainelDeBiblioteca />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a biblioteca.");
  });

  // ---- Categorias ---------------------------------------------------------
  //
  // O nome acessível de cada linha é "Poesia, 0 livros" (nome visível + a
  // contagem em `sr-only`), daí `/^Poesia/` em vez do nome exato — a âncora
  // `^` impede "Renomear Poesia"/"Expandir Poesia" de casarem também.
  //
  // Menu "⋯" e diálogo "Mover para…": o jsdom traz a regra
  // `[popover]:not(:popover-open) { display: none }` sem implementar a Popover
  // API, e não implementa `showModal` — painel e diálogo ficam `display: none`
  // mas continuam no DOM. `{ hidden: true }` os encontra e `fireEvent.click`
  // (que não checa visibilidade) interage com eles. Mesma nota de
  // `PageTree.test.tsx`; no WebView2 real os dois abrem de verdade.

  function categoria(overrides: Partial<Categoria> & { id: string; name: string }): Categoria {
    return { parentId: null, position: "a0", createdAt: "", updatedAt: "", ...overrides };
  }

  // Duas categorias de ids distintos, agindo sempre na SEGUNDA: com uma só,
  // um id errado (ex. sempre mandar o primeiro da lista) ainda passaria.
  function duasCategorias() {
    listarCategoriasMock.mockResolvedValue([
      categoria({ id: "cat-1", name: "Ficção", position: "a0" }),
      categoria({ id: "cat-2", name: "Poesia", position: "a1" }),
    ]);
  }

  function fantasiaComEpico() {
    listarCategoriasMock.mockResolvedValue([
      categoria({ id: "cat-fantasia", name: "Fantasia" }),
      categoria({ id: "cat-epico", name: "Épico", parentId: "cat-fantasia" }),
    ]);
  }

  function botaoDoNome(nome: string) {
    return screen.getByRole("button", { name: new RegExp(`^${nome}`) });
  }

  /** O `<li>` da categoria — as ações, o campo inline, o cartão e o erro dela moram todos ali. */
  function linhaDe(nome: string): HTMLElement {
    const linha = botaoDoNome(nome).closest("li");
    if (!linha) throw new Error(`linha de "${nome}" não encontrada`);
    return linha;
  }

  /** Abre o "⋯" da linha e escolhe um item; devolve a linha para as asserções seguintes. */
  function escolherNoMenu(nome: string, item: string): HTMLElement {
    const linha = linhaDe(nome);
    fireEvent.click(within(linha).getByRole("button", { name: `Mais ações para ${nome}` }));
    fireEvent.click(within(linha).getByRole("menuitem", { name: item, hidden: true }));
    return linha;
  }

  function teclarEnter(campo: HTMLElement) {
    fireEvent.keyDown(campo, { key: "Enter" });
  }

  it("clicar numa categoria troca `filtroCategoriaId`, e 'Todas as categorias' volta a null", async () => {
    listarLivrosMock.mockResolvedValue([]);
    // Via `listarCategoriasMock`, não `setState` direto: `load()` roda no
    // `useEffect` de montagem e sobrescreveria um `setState` anterior com o
    // que a mock de `listarCategorias` devolver.
    listarCategoriasMock.mockResolvedValue([categoria({ id: "cat-1", name: "Ficção" })]);
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");
    await screen.findByRole("button", { name: /^Ficção/ });

    fireEvent.click(botaoDoNome("Ficção"));
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBe("cat-1");
    expect(botaoDoNome("Ficção")).toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByRole("button", { name: /^Todas as categorias/ }));
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull();
    expect(screen.getByRole("button", { name: /^Todas as categorias/ })).toHaveAttribute("aria-current", "true");
  });

  it("criar categoria na raiz: a linha-fantasma vira campo, Enter envia o nome com parentId null e o campo fecha", async () => {
    listarLivrosMock.mockResolvedValue([]);
    criarCategoriaMock.mockResolvedValue(categoria({ id: "cat-nova", name: "Não-ficção" }));
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: "Nova categoria" }));
    const campo = screen.getByLabelText("Nome da nova categoria");
    fireEvent.change(campo, { target: { value: "Não-ficção" } });
    teclarEnter(campo);

    // Linha-fantasma: sem parentId próprio, a store manda `null` explícito
    // ao IPC (nunca `undefined`) — cria na raiz.
    await waitFor(() => expect(criarCategoriaMock).toHaveBeenCalledWith("Não-ficção", null));
    await waitFor(() => expect(screen.queryByLabelText("Nome da nova categoria")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Nova categoria" })).toBeInTheDocument();
  });

  it("criar categoria com nome vazio só fecha o campo, sem chamar criarCategoria", async () => {
    listarLivrosMock.mockResolvedValue([]);
    render(<PainelDeBiblioteca />);
    await screen.findByText("Todos os livros");

    fireEvent.click(screen.getByRole("button", { name: "Nova categoria" }));
    teclarEnter(screen.getByLabelText("Nome da nova categoria"));

    await waitFor(() => expect(screen.queryByLabelText("Nome da nova categoria")).not.toBeInTheDocument());
    expect(criarCategoriaMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("criar na raiz com nome já usado mostra a mensagem do backend e mantém o campo aberto com o que foi digitado", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    criarCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: 'já existe uma categoria chamada "Ficção"' }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    fireEvent.click(screen.getByRole("button", { name: "Nova categoria" }));
    const campo = screen.getByLabelText("Nome da nova categoria");
    fireEvent.change(campo, { target: { value: "ficção" } });
    teclarEnter(campo);

    // Dois alertas de propósito: o local do campo e o `errorMessage` da
    // store no rodapé do painel — o que importa é o do campo existir.
    const alertas = await screen.findAllByRole("alert");
    expect(alertas.some((alerta) => alerta.textContent?.includes('já existe uma categoria chamada "Ficção"'))).toBe(true);
    expect(screen.getByLabelText("Nome da nova categoria")).toHaveValue("ficção");
  });

  it("renomear pelo menu '⋯': o campo substitui o nome na linha e Enter chama o IPC com o id e o nome certos", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    renomearCategoriaMock.mockResolvedValue(categoria({ id: "cat-2", name: "Poemas", position: "a1" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Renomear");
    const campo = within(linha).getByLabelText("Nome da categoria Poesia");
    fireEvent.change(campo, { target: { value: "Poemas" } });
    teclarEnter(campo);

    await waitFor(() => expect(renomearCategoriaMock).toHaveBeenCalledWith("cat-2", "Poemas"));
    await waitFor(() => expect(within(linha).queryByLabelText("Nome da categoria Poesia")).not.toBeInTheDocument());
  });

  it("renomear por duplo clique no nome (atalho das outras árvores) e confirmar por blur chama o mesmo IPC", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    renomearCategoriaMock.mockResolvedValue(categoria({ id: "cat-2", name: "Poemas", position: "a1" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    fireEvent.doubleClick(botaoDoNome("Poesia"));
    const campo = screen.getByLabelText("Nome da categoria Poesia");
    fireEvent.change(campo, { target: { value: "Poemas" } });
    fireEvent.blur(campo);

    await waitFor(() => expect(renomearCategoriaMock).toHaveBeenCalledWith("cat-2", "Poemas"));
  });

  it("renomear categoria com nome vazio não chama o IPC", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Renomear");
    const campo = within(linha).getByLabelText("Nome da categoria Poesia");
    fireEvent.change(campo, { target: { value: "   " } });
    teclarEnter(campo);

    await waitFor(() => expect(within(linha).queryByLabelText("Nome da categoria Poesia")).not.toBeInTheDocument());
    expect(renomearCategoriaMock).not.toHaveBeenCalled();
  });

  it("Escape no campo de renomear cancela sem chamar o IPC e devolve o nome à linha", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Renomear");
    const campo = within(linha).getByLabelText("Nome da categoria Poesia");
    fireEvent.change(campo, { target: { value: "Poemas" } });
    fireEvent.keyDown(campo, { key: "Escape" });

    expect(within(linha).queryByLabelText("Nome da categoria Poesia")).not.toBeInTheDocument();
    expect(within(linha).getByRole("button", { name: /^Poesia/ })).toBeInTheDocument();
    expect(renomearCategoriaMock).not.toHaveBeenCalled();
  });

  it("renomear para um nome já usado mostra a mensagem do backend, nomeando a categoria conflitante, sem perder o que foi digitado", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    renomearCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: 'já existe uma categoria chamada "Ficção"' }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Renomear");
    const campo = within(linha).getByLabelText("Nome da categoria Poesia");
    fireEvent.change(campo, { target: { value: "Ficção" } });
    teclarEnter(campo);

    expect(await within(linha).findByRole("alert")).toHaveTextContent('já existe uma categoria chamada "Ficção"');
    expect(within(linha).getByLabelText("Nome da categoria Poesia")).toHaveValue("Ficção");
  });

  it("remover categoria: só chama o IPC depois de confirmar no cartão do próprio painel, que diz que nenhum livro é apagado", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    removerCategoriaMock.mockResolvedValue(undefined);
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Remover…");
    const cartao = within(linha).getByRole("alertdialog", { name: "Remover Poesia?" });
    expect(cartao).toHaveTextContent("Os livros dela não são apagados — só perdem essa categoria.");
    expect(removerCategoriaMock).not.toHaveBeenCalled();
    // Foco entra em "Cancelar": Enter por reflexo não remove.
    expect(within(cartao).getByRole("button", { name: "Cancelar" })).toHaveFocus();

    fireEvent.click(within(cartao).getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(removerCategoriaMock).toHaveBeenCalledWith("cat-2"));
  });

  it("Escape no cartão de remoção fecha sem chamar o IPC", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Remover…");
    fireEvent.keyDown(within(linha).getByRole("alertdialog", { name: "Remover Poesia?" }), { key: "Escape" });

    expect(within(linha).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(removerCategoriaMock).not.toHaveBeenCalled();
  });

  it("remover a categoria que está filtrando a estante volta o filtro para 'todas as categorias'", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    removerCategoriaMock.mockResolvedValue(undefined);
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    fireEvent.click(botaoDoNome("Poesia"));
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBe("cat-2");

    const linha = escolherNoMenu("Poesia", "Remover…");
    fireEvent.click(within(linha).getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull());
  });

  it("remover uma ANCESTRAL da categoria que filtra também volta o filtro para 'todas as categorias'", async () => {
    listarLivrosMock.mockResolvedValue([]);
    fantasiaComEpico();
    removerCategoriaMock.mockResolvedValue(undefined);
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Épico/ });

    fireEvent.click(botaoDoNome("Épico"));
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBe("cat-epico");

    const linha = escolherNoMenu("Fantasia", "Remover…");
    fireEvent.click(within(linha).getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(removerCategoriaMock).toHaveBeenCalledWith("cat-fantasia"));
    await waitFor(() => expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull());
  });

  it("uma árvore de três níveis desenha uma guia de nível por profundidade (0, 1, 2), e só quem tem filhos ganha chevron", async () => {
    listarLivrosMock.mockResolvedValue([]);
    listarCategoriasMock.mockResolvedValue([
      categoria({ id: "cat-fantasia", name: "Fantasia" }),
      categoria({ id: "cat-epico", name: "Épico", parentId: "cat-fantasia" }),
      categoria({ id: "cat-alta", name: "Alta Fantasia", parentId: "cat-epico" }),
    ]);
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Alta Fantasia/ });

    const guiasDe = (nome: string) => botaoDoNome(nome).parentElement?.querySelectorAll('[data-slot="guia-de-nivel"]').length;
    expect(guiasDe("Fantasia")).toBe(0);
    expect(guiasDe("Épico")).toBe(1);
    expect(guiasDe("Alta Fantasia")).toBe(2);

    expect(screen.getByRole("button", { name: "Recolher Fantasia" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Recolher Épico" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Recolher Alta Fantasia|Expandir Alta Fantasia/ })).not.toBeInTheDocument();
  });

  it("criar categoria DENTRO de um pai pelo '+' da linha passa o parentId certo (duas categorias de ids distintos, criando dentro da SEGUNDA)", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    criarCategoriaMock.mockResolvedValue(categoria({ id: "cat-filha", name: "Sonetos", parentId: "cat-2" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    fireEvent.click(screen.getByRole("button", { name: "Nova categoria dentro de Poesia" }));
    const campo = screen.getByLabelText("Nome da nova categoria dentro de Poesia");
    fireEvent.change(campo, { target: { value: "Sonetos" } });
    teclarEnter(campo);

    // DUAS categorias de ids distintos, agindo na SEGUNDA ("cat-2"): com uma
    // só, um parentId errado (ex.: sempre o primeiro id que existe) ainda
    // passaria despercebido.
    await waitFor(() => expect(criarCategoriaMock).toHaveBeenCalledWith("Sonetos", "cat-2"));
    await waitFor(() => expect(screen.queryByLabelText("Nome da nova categoria dentro de Poesia")).not.toBeInTheDocument());
  });

  it("criar subcategoria pelo item 'Nova subcategoria' do menu (caminho por teclado) passa o mesmo parentId", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    criarCategoriaMock.mockResolvedValue(categoria({ id: "cat-filha", name: "Sonetos", parentId: "cat-2" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Nova subcategoria");
    const campo = within(linha).getByLabelText("Nome da nova categoria dentro de Poesia");
    fireEvent.change(campo, { target: { value: "Sonetos" } });
    teclarEnter(campo);

    await waitFor(() => expect(criarCategoriaMock).toHaveBeenCalledWith("Sonetos", "cat-2"));
  });

  it("D4: pedir para remover uma categoria com subcategoria avisa ANTES de confirmar (o backend recusa; nenhum livro some) — sem filhas, o aviso é o de sempre", async () => {
    listarLivrosMock.mockResolvedValue([]);
    fantasiaComEpico();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Épico/ });

    escolherNoMenu("Fantasia", "Remover…");
    expect(await screen.findByRole("alertdialog", { name: "Remover Fantasia?" })).toHaveTextContent(/tem subcategorias/);
    expect(removerCategoriaMock).not.toHaveBeenCalled();

    escolherNoMenu("Épico", "Remover…");
    expect(screen.getByRole("alertdialog", { name: "Remover Épico?" })).toHaveTextContent(
      "Os livros dela não são apagados — só perdem essa categoria.",
    );
  });

  it("recolher uma categoria some com a subárvore, e o estado de recolhido sobrevive a um re-render do painel (troca de filtro de status)", async () => {
    listarLivrosMock.mockResolvedValue([]);
    fantasiaComEpico();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Épico/ });

    fireEvent.click(screen.getByRole("button", { name: "Recolher Fantasia" }));
    expect(screen.queryByRole("button", { name: /^Épico/ })).not.toBeInTheDocument();

    // Re-render do painel NÃO relacionado à árvore de categorias — troca o
    // filtro de status, que é estado de outra parte da store.
    fireEvent.click(screen.getByRole("button", { name: /Lendo/ }));
    expect(useBibliotecaStore.getState().filtro).toBe("reading");

    // O recolhimento é estado local do componente (`useState`), não
    // recalculado a cada render — continua recolhido depois do re-render.
    expect(screen.queryByRole("button", { name: /^Épico/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expandir Fantasia" })).toHaveAttribute("aria-expanded", "false");
  });

  it("selecionar uma categoria escondida por um pai recolhido expande o pai; recolher de novo marca o pai como 'contém o filtro atual'", async () => {
    listarLivrosMock.mockResolvedValue([]);
    fantasiaComEpico();
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Épico/ });

    fireEvent.click(screen.getByRole("button", { name: "Recolher Fantasia" }));
    expect(screen.queryByRole("button", { name: /^Épico/ })).not.toBeInTheDocument();

    // O filtro muda por fora do painel (um `LivroCard`, por exemplo): o
    // estado ativo precisa ficar visível, então os ancestrais expandem.
    act(() => useBibliotecaStore.getState().setFiltroCategoria("cat-epico"));
    expect(await screen.findByRole("button", { name: /^Épico/ })).toHaveAttribute("aria-current", "true");
    expect(botaoDoNome("Fantasia")).not.toHaveTextContent(/contém o filtro atual/);

    fireEvent.click(screen.getByRole("button", { name: "Recolher Fantasia" }));
    expect(screen.queryByRole("button", { name: /^Épico/ })).not.toBeInTheDocument();
    expect(botaoDoNome("Fantasia")).toHaveTextContent(/contém o filtro atual/);
  });

  it("'Mover para…' abre o diálogo com a raiz e os alvos válidos, e escolher um alvo chama moverCategoria(id, novoParentId) nessa ordem", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    moverCategoriaMock.mockResolvedValue(categoria({ id: "cat-2", name: "Poesia", parentId: "cat-1", position: "a1" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    escolherNoMenu("Poesia", "Mover para…");

    // Aspas curvas (“ ”) de propósito no título — não são as retas do regex.
    expect(screen.getByRole("heading", { name: /Mover .Poesia. para/, hidden: true })).toBeInTheDocument();
    const lista = screen.getByRole("listbox", { name: "Categorias de destino", hidden: true });
    expect(within(lista).getByRole("option", { name: "Raiz (sem categoria-pai)", hidden: true })).toBeInTheDocument();
    expect(within(lista).getByRole("option", { name: "Ficção", hidden: true })).toBeInTheDocument();
    // A própria categoria nunca é alvo de si mesma.
    expect(within(lista).queryByRole("option", { name: "Poesia", hidden: true })).not.toBeInTheDocument();

    fireEvent.click(within(lista).getByRole("option", { name: "Ficção", hidden: true }));

    // (id, novoParentId) nesta ordem: invertidos, o IPC não reclama e a
    // árvore do usuário fica bagunçada.
    await waitFor(() => expect(moverCategoriaMock).toHaveBeenCalledWith("cat-2", "cat-1"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Mover .Poesia. para/, hidden: true })).not.toBeInTheDocument());
  });

  it("'Raiz (sem categoria-pai)' no diálogo move com novoParentId null, e o diálogo exclui os descendentes da categoria movida", async () => {
    listarLivrosMock.mockResolvedValue([]);
    fantasiaComEpico();
    moverCategoriaMock.mockResolvedValue(categoria({ id: "cat-epico", name: "Épico", parentId: null }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Épico/ });

    escolherNoMenu("Fantasia", "Mover para…");
    const listaDeFantasia = screen.getByRole("listbox", { name: "Categorias de destino", hidden: true });
    expect(within(listaDeFantasia).queryByRole("option", { name: /Épico/, hidden: true })).not.toBeInTheDocument();
    expect(within(listaDeFantasia).queryByRole("option", { name: /Fantasia/, hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("listbox", { hidden: true })).not.toBeInTheDocument());

    escolherNoMenu("Épico", "Mover para…");
    const listaDeEpico = screen.getByRole("listbox", { name: "Categorias de destino", hidden: true });
    fireEvent.click(within(listaDeEpico).getByRole("option", { name: "Raiz (sem categoria-pai)", hidden: true }));

    await waitFor(() => expect(moverCategoriaMock).toHaveBeenCalledWith("cat-epico", null));
  });

  it("mover recusado pelo backend mostra a mensagem dele abaixo da linha movida", async () => {
    listarLivrosMock.mockResolvedValue([]);
    duasCategorias();
    moverCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: "não dá para mover uma categoria para dentro de si mesma" }));
    render(<PainelDeBiblioteca />);
    await screen.findByRole("button", { name: /^Poesia/ });

    const linha = escolherNoMenu("Poesia", "Mover para…");
    fireEvent.click(screen.getByRole("option", { name: "Ficção", hidden: true }));

    expect(await within(linha).findByRole("alert")).toHaveTextContent("não dá para mover uma categoria para dentro de si mesma");
  });

  it("a contagem de cada categoria segue a semântica D1 do filtro: o pai conta os livros dos descendentes, sem duplicar livro em duas categorias", async () => {
    listarLivrosMock.mockResolvedValue([
      livroNaEstante({ id: "a" }),
      livroNaEstante({ id: "b" }),
      livroNaEstante({ id: "c" }),
    ]);
    const fantasia = categoria({ id: "cat-fantasia", name: "Fantasia" });
    const epico = categoria({ id: "cat-epico", name: "Épico", parentId: "cat-fantasia" });
    listarCategoriasMock.mockResolvedValue([fantasia, epico]);
    listarCategoriasPorLivroMock.mockResolvedValue([
      { livroId: "a", categorias: [epico] },
      { livroId: "b", categorias: [fantasia] },
      { livroId: "c", categorias: [fantasia, epico] },
    ]);
    render(<PainelDeBiblioteca />);

    // "c" está em Fantasia E em Épico: conta uma vez em cada, nunca duas no pai.
    expect(await screen.findByRole("button", { name: "Fantasia, 3 livros" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Épico, 2 livros" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas as categorias, 3 livros" })).toBeInTheDocument();
  });

  it("a contagem acompanha o filtro de STATUS: o numero e sempre o que aparece ao clicar", async () => {
    // O bug que este teste trava: a contagem era feita sobre a estante crua,
    // enquanto a estante compoe status E categoria por "E". Com o filtro em
    // "Lendo", "Fantasia" dizia 3 e clicar mostrava 1 — o painel mentia sobre
    // o proprio resultado.
    listarLivrosMock.mockResolvedValue([
      livroNaEstante({ id: "a", status: "reading" }),
      livroNaEstante({ id: "b", status: "unread" }),
      livroNaEstante({ id: "c", status: "finished" }),
    ]);
    const fantasia = categoria({ id: "cat-fantasia", name: "Fantasia" });
    listarCategoriasMock.mockResolvedValue([fantasia]);
    listarCategoriasPorLivroMock.mockResolvedValue([
      { livroId: "a", categorias: [fantasia] },
      { livroId: "b", categorias: [fantasia] },
      { livroId: "c", categorias: [fantasia] },
    ]);
    render(<PainelDeBiblioteca />);

    expect(await screen.findByRole("button", { name: "Fantasia, 3 livros" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Lendo/ }));

    expect(await screen.findByRole("button", { name: "Fantasia, 1 livro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas as categorias, 1 livro" })).toBeInTheDocument();
  });
});
