import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  criarCategoria,
  definirCategoriasDoLivro,
  // GRADE DE LIVROS (título/autor/ordem): contrato chegou em `lib/ipc.ts`
  // nesta mesma sessão, depois de esta suíte ter começado a escrever contra ele.
  definirMetadadosDoLivro,
  importarLivro,
  listarCategorias,
  listarCategoriasDoLivro,
  listarCategoriasPorLivro,
  listarLivros,
  // Mesma situação de `moverCategoria` no mock acima: ainda não existe em
  // `lib/ipc.ts` nesta rodada — `tsc` falha SÓ aqui até o contrato chegar.
  moverCategoria,
  moverLivro,
  removerCategoria,
  removerLivro,
  renomearCategoria,
  type Categoria,
  type LivroNaEstante,
} from "../../lib/ipc";
import { useBibliotecaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listarLivros: vi.fn(),
    importarLivro: vi.fn(),
    removerLivro: vi.fn(),
    // PARTE 2 (categorias) — ainda sem wrapper real em `lib/ipc.ts` nesta
    // rodada (ver relatório desta tarefa); mockados aqui do mesmo jeito que
    // os três de cima, só para o `load()` não quebrar em `Promise.all`.
    criarCategoria: vi.fn(),
    listarCategorias: vi.fn(),
    listarCategoriasDoLivro: vi.fn(),
    listarCategoriasPorLivro: vi.fn(),
    definirCategoriasDoLivro: vi.fn(),
    renomearCategoria: vi.fn(),
    // `moverCategoria` (árvore de categorias): comando novo, mesma situação
    // dos de cima — ainda sem wrapper real em `lib/ipc.ts` nesta rodada.
    moverCategoria: vi.fn(),
    removerCategoria: vi.fn(),
    // GRADE DE LIVROS (título/autor/ordem) — mockados pelo mesmo motivo dos
    // de cima: isolar o teste do IPC real, não porque falte contrato.
    definirMetadadosDoLivro: vi.fn(),
    moverLivro: vi.fn(),
  };
});

// `gerarCapaDoLivro` real (`capa.ts`) já não lança mesmo sob falha (suíte
// própria em `capa.test.ts`), mas aqui ele rodaria contra o `abrirLivro` real
// sem Tauri por trás — mockado para tornar "extração falhando" determinístico
// em vez de depender de uma rejeição de rede incidental.
vi.mock("./capa", () => ({ gerarCapaDoLivro: vi.fn().mockResolvedValue(null) }));

const listarLivrosMock = vi.mocked(listarLivros);
const importarLivroMock = vi.mocked(importarLivro);
const removerLivroMock = vi.mocked(removerLivro);
const criarCategoriaMock = vi.mocked(criarCategoria);
const listarCategoriasMock = vi.mocked(listarCategorias);
const listarCategoriasDoLivroMock = vi.mocked(listarCategoriasDoLivro);
const listarCategoriasPorLivroMock = vi.mocked(listarCategoriasPorLivro);
const definirCategoriasDoLivroMock = vi.mocked(definirCategoriasDoLivro);
const renomearCategoriaMock = vi.mocked(renomearCategoria);
const moverCategoriaMock = vi.mocked(moverCategoria);
const removerCategoriaMock = vi.mocked(removerCategoria);
const definirMetadadosDoLivroMock = vi.mocked(definirMetadadosDoLivro);
const moverLivroMock = vi.mocked(moverLivro);

function categoria(overrides: Partial<Categoria> & { id: string }): Categoria {
  return {
    name: `Categoria ${overrides.id}`,
    // `parentId` ainda não existe em `Categoria` nesta rodada (mesma nota do
    // topo do arquivo) — `null` (raiz) é o padrão do helper.
    parentId: null,
    position: "a0",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
    ...overrides,
  };
}

function livroNaEstante(overrides: Partial<LivroNaEstante> & { id: string }): LivroNaEstante {
  const { id, ...resto } = overrides;
  return {
    // `position` (índice fracionário da ordem da estante): contrato chegou
    // em `lib/ipc.ts` durante esta peça — valor fixo aqui, os testes de
    // `moverLivro` que precisam de ORDEM real (`percy-1`/`percy-2`) afirmam
    // sobre o array `livros` que `listarLivrosMock` devolve, não sobre este
    // campo.
    livro: { id, pageId: "00000000-0000-0000-0000-000000000001", format: "pdf", fileName: `${id}.pdf`, coverFileName: null, totalUnits: 100, contentHash: "sha-teste", originalFileName: "original.pdf", fileSize: 1024, metadataTitle: null, metadataAuthor: null, hasTextLayer: true, position: "a0", createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" },
    progresso: {
      bookId: "00000000-0000-0000-0000-000000000000",
      currentLocator: "0",
      currentFraction: 0,
      furthestLocator: "0",
      furthestFraction: 0,
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
      status: "unread",
      lastReadAt: null,
    },
    titulo: `Título ${id}`,
    autor: null,
    ...resto,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Padrão "sem categoria nenhuma ainda" — cada teste de categoria sobrescreve.
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

describe("load", () => {
  it("carrega a estante", async () => {
    const alvo = livroNaEstante({ id: "a" });
    listarLivrosMock.mockResolvedValue([alvo]);

    await useBibliotecaStore.getState().load();

    const state = useBibliotecaStore.getState();
    expect(state.status).toBe("ready");
    expect(state.livros).toEqual([alvo]);
  });

  it("chamada concorrente enquanto já está carregando não dispara uma segunda rodada de listarLivros", async () => {
    listarLivrosMock.mockResolvedValue([]);

    const primeira = useBibliotecaStore.getState().load();
    const segunda = useBibliotecaStore.getState().load();
    await Promise.all([primeira, segunda]);

    expect(listarLivrosMock).toHaveBeenCalledTimes(1);
  });

  it("erro vira status 'error' com mensagem", async () => {
    listarLivrosMock.mockRejectedValue(new Error("rede caiu"));

    await useBibliotecaStore.getState().load();

    const state = useBibliotecaStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar a biblioteca.");
  });

  it("carrega categorias e o mapa categoria-por-livro junto com a estante", async () => {
    const alvo = livroNaEstante({ id: "a" });
    const ficcao = categoria({ id: "cat-ficcao", name: "Ficção" });
    listarLivrosMock.mockResolvedValue([alvo]);
    listarCategoriasMock.mockResolvedValue([ficcao]);
    listarCategoriasPorLivroMock.mockResolvedValue([{ livroId: "a", categorias: [ficcao] }]);

    await useBibliotecaStore.getState().load();

    const state = useBibliotecaStore.getState();
    expect(state.categorias).toEqual([ficcao]);
    expect(state.categoriasPorLivro.get("a")).toEqual([ficcao]);
  });

  it("um livro cuja extração de capa falha continua na estante — a falha nunca esconde nem remove o livro, nem vira erro visível", async () => {
    // `gerarCapaDoLivro` está mockado no topo do arquivo resolvendo `null`
    // sempre — é exatamente o que `capa.ts` devolve quando a extração falha
    // (PDF corrompido, EPUB sem capa, canvas que não exporta), nunca lança.
    const semCapa = livroNaEstante({ id: "sem-capa" });
    listarLivrosMock.mockResolvedValue([semCapa]);

    await useBibliotecaStore.getState().load();

    const state = useBibliotecaStore.getState();
    expect(state.status).toBe("ready");
    expect(state.errorMessage).toBeNull();
    expect(state.livros).toEqual([semCapa]);
  });
});

describe("categorias", () => {
  it("criarCategoria acrescenta a categoria criada à lista", async () => {
    const nova = categoria({ id: "cat-nova", name: "Ficção Científica" });
    criarCategoriaMock.mockResolvedValue(nova);

    await useBibliotecaStore.getState().criarCategoria("Ficção Científica");

    expect(useBibliotecaStore.getState().categorias).toEqual([nova]);
    // `parentId` ausente na chamada da store vira `null` explícito no IPC
    // (nunca `undefined`) — coberto de novo, mais embaixo, por
    // "criarCategoria sem parentId (formulário raiz) manda `null` ao IPC".
    expect(criarCategoriaMock).toHaveBeenCalledWith("Ficção Científica", null);
  });

  it("criarCategoria com erro do backend (nome duplicado) vira errorMessage e a promise rejeita, sem tocar na lista", async () => {
    // `messageFor` só extrai `.message` de um `AppError` (o que `call()` em
    // `lib/ipc.ts` sempre lança) — um `Error` comum cairia no fallback
    // genérico, então o dublê precisa ser o mesmo tipo que o backend lança.
    useBibliotecaStore.setState({ categorias: [categoria({ id: "existente" })] });
    criarCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: 'categoria "Ficção" já existe' }));

    await expect(useBibliotecaStore.getState().criarCategoria("Ficção")).rejects.toThrow();

    const state = useBibliotecaStore.getState();
    expect(state.errorMessage).toBe('categoria "Ficção" já existe');
    expect(state.categorias).toEqual([categoria({ id: "existente" })]);
  });

  it("criarCategoria(nome, parentId) passa o parentId certo ao IPC — DUAS categorias de ids distintos, criando dentro da SEGUNDA", async () => {
    // Duas categorias existentes de ids distintos, agindo (criando a filha)
    // dentro da segunda: com uma só, um parentId errado (ex.: sempre o
    // primeiro id que existe) ainda passaria despercebido.
    const primeira = categoria({ id: "cat-1", name: "Ficção" });
    const segunda = categoria({ id: "cat-2", name: "Poesia" });
    useBibliotecaStore.setState({ categorias: [primeira, segunda] });
    const filha = categoria({ id: "cat-filha", name: "Sonetos", parentId: "cat-2" });
    criarCategoriaMock.mockResolvedValue(filha);

    await useBibliotecaStore.getState().criarCategoria("Sonetos", "cat-2");

    expect(criarCategoriaMock).toHaveBeenCalledWith("Sonetos", "cat-2");
    expect(useBibliotecaStore.getState().categorias).toContainEqual(filha);
  });

  it("criarCategoria sem parentId (formulário raiz) manda `null` ao IPC — nunca `undefined`", async () => {
    criarCategoriaMock.mockResolvedValue(categoria({ id: "cat-raiz", name: "Raiz" }));

    await useBibliotecaStore.getState().criarCategoria("Raiz");

    expect(criarCategoriaMock).toHaveBeenCalledWith("Raiz", null);
  });

  it("atribuirCategorias chama definirCategoriasDoLivro e atualiza o mapa com o que listarCategoriasDoLivro devolveu", async () => {
    const ficcao = categoria({ id: "cat-ficcao" });
    definirCategoriasDoLivroMock.mockResolvedValue(undefined);
    listarCategoriasDoLivroMock.mockResolvedValue([ficcao]);

    await useBibliotecaStore.getState().atribuirCategorias("livro-1", ["cat-ficcao"]);

    expect(definirCategoriasDoLivroMock).toHaveBeenCalledWith("livro-1", ["cat-ficcao"]);
    expect(useBibliotecaStore.getState().categoriasPorLivro.get("livro-1")).toEqual([ficcao]);
  });

  it("atribuirCategorias com erro do backend (livro desconhecido) vira errorMessage e a promise rejeita", async () => {
    definirCategoriasDoLivroMock.mockRejectedValue(new AppError({ kind: "invalid", message: "livro não encontrado" }));

    await expect(useBibliotecaStore.getState().atribuirCategorias("livro-fantasma", ["cat-1"])).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("livro não encontrado");
    expect(listarCategoriasDoLivroMock).not.toHaveBeenCalled();
  });

  it("setFiltroCategoria troca `filtroCategoriaId`", () => {
    useBibliotecaStore.getState().setFiltroCategoria("cat-ficcao");
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBe("cat-ficcao");

    useBibliotecaStore.getState().setFiltroCategoria(null);
    expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull();
  });

  it("renomearCategoria chama o IPC com o id e o nome certos, e substitui a categoria na lista pela devolvida", async () => {
    // DUAS categorias, agindo na segunda: com uma só, um id errado ainda passaria.
    const primeira = categoria({ id: "cat-1", name: "Ficção" });
    const segunda = categoria({ id: "cat-2", name: "Poesia" });
    const renomeada = categoria({ id: "cat-2", name: "Poemas" });
    useBibliotecaStore.setState({ categorias: [primeira, segunda] });
    renomearCategoriaMock.mockResolvedValue(renomeada);

    await useBibliotecaStore.getState().renomearCategoria("cat-2", "Poemas");

    expect(renomearCategoriaMock).toHaveBeenCalledWith("cat-2", "Poemas");
    expect(useBibliotecaStore.getState().categorias).toEqual([primeira, renomeada]);
  });

  it("renomearCategoria com nome duplicado vira errorMessage com a mensagem do backend, e a promise rejeita", async () => {
    renomearCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: 'já existe uma categoria chamada "Ficção"' }));

    await expect(useBibliotecaStore.getState().renomearCategoria("cat-2", "Ficção")).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe('já existe uma categoria chamada "Ficção"');
  });

  it("moverCategoria chama o IPC com o id e o novo pai certos, e substitui a categoria na lista pela devolvida", async () => {
    // DUAS categorias, movendo a segunda: com uma só, um id errado ainda passaria.
    const primeira = categoria({ id: "cat-1", name: "Ficção" });
    const segunda = categoria({ id: "cat-2", name: "Épico", parentId: null });
    const movida = categoria({ id: "cat-2", name: "Épico", parentId: "cat-1" });
    useBibliotecaStore.setState({ categorias: [primeira, segunda] });
    moverCategoriaMock.mockResolvedValue(movida);

    await useBibliotecaStore.getState().moverCategoria("cat-2", "cat-1");

    expect(moverCategoriaMock).toHaveBeenCalledWith("cat-2", "cat-1");
    expect(useBibliotecaStore.getState().categorias).toEqual([primeira, movida]);
  });

  it("moverCategoria com erro do backend (ciclo) vira errorMessage e a promise rejeita, sem tocar na lista", async () => {
    const alvo = categoria({ id: "cat-1" });
    useBibliotecaStore.setState({ categorias: [alvo] });
    moverCategoriaMock.mockRejectedValue(new AppError({ kind: "invalid", message: "não é possível mover uma categoria para dentro dela mesma" }));

    await expect(useBibliotecaStore.getState().moverCategoria("cat-1", "cat-1")).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("não é possível mover uma categoria para dentro dela mesma");
    expect(useBibliotecaStore.getState().categorias).toEqual([alvo]);
  });

  it("removerCategoria tira a categoria da lista", async () => {
    const alvo = categoria({ id: "cat-1" });
    useBibliotecaStore.setState({ categorias: [alvo] });
    removerCategoriaMock.mockResolvedValue(undefined);

    await useBibliotecaStore.getState().removerCategoria("cat-1");

    expect(removerCategoriaMock).toHaveBeenCalledWith("cat-1");
    expect(useBibliotecaStore.getState().categorias).toEqual([]);
  });

  it("removerCategoria da categoria que está filtrando a estante agora volta o filtro para 'todas' (estado, não só a chamada ao IPC)", async () => {
    const alvo = categoria({ id: "cat-1" });
    useBibliotecaStore.setState({ categorias: [alvo], filtroCategoriaId: "cat-1" });
    removerCategoriaMock.mockResolvedValue(undefined);

    await useBibliotecaStore.getState().removerCategoria("cat-1");

    expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull();
  });

  it("removerCategoria de uma ANCESTRAL da que está filtrando também volta o filtro para 'todas' — o filtro pode estar vários níveis abaixo do que foi removido", async () => {
    const fantasia = categoria({ id: "cat-fantasia", name: "Fantasia", parentId: null });
    const epico = categoria({ id: "cat-epico", name: "Épico", parentId: "cat-fantasia" });
    useBibliotecaStore.setState({ categorias: [fantasia, epico], filtroCategoriaId: "cat-epico" });
    removerCategoriaMock.mockResolvedValue(undefined);

    // Remove o ANCESTRAL ("Fantasia"), não a própria categoria que filtra.
    await useBibliotecaStore.getState().removerCategoria("cat-fantasia");

    expect(useBibliotecaStore.getState().filtroCategoriaId).toBeNull();
  });

  it("removerCategoria de uma categoria que NÃO está filtrando não mexe no filtro atual", async () => {
    const alvo = categoria({ id: "cat-1" });
    useBibliotecaStore.setState({ categorias: [alvo], filtroCategoriaId: "cat-2" });
    removerCategoriaMock.mockResolvedValue(undefined);

    await useBibliotecaStore.getState().removerCategoria("cat-1");

    expect(useBibliotecaStore.getState().filtroCategoriaId).toBe("cat-2");
  });

  it("removerCategoria com erro do backend vira errorMessage e a promise rejeita, sem tocar na lista", async () => {
    const alvo = categoria({ id: "cat-1" });
    useBibliotecaStore.setState({ categorias: [alvo] });
    removerCategoriaMock.mockRejectedValue(new Error("categoria em uso"));

    await expect(useBibliotecaStore.getState().removerCategoria("cat-1")).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("Não foi possível remover a categoria.");
    expect(useBibliotecaStore.getState().categorias).toEqual([alvo]);
  });
});

describe("importar", () => {
  it("acrescenta o livro importado no topo da estante e libera o guard ao terminar", async () => {
    const novo = livroNaEstante({ id: "novo" });
    importarLivroMock.mockResolvedValue(novo);

    await useBibliotecaStore.getState().importar("C:\\livro.pdf");

    const state = useBibliotecaStore.getState();
    expect(state.livros[0]).toEqual(novo);
    expect(state.importando).toBe(false);
    expect(importarLivroMock).toHaveBeenCalledWith("C:\\livro.pdf");
  });

  it("uma segunda chamada enquanto a primeira ainda está em voo não dispara um segundo import_livro", async () => {
    let resolvePrimeira: (value: LivroNaEstante) => void = () => {};
    importarLivroMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePrimeira = resolve;
      }),
    );

    const primeira = useBibliotecaStore.getState().importar("C:\\livro.pdf");
    // Ainda em voo: `importando` já está true, então esta segunda chamada
    // precisa ser um no-op sem chamar `importarLivro` de novo — é o guard
    // contra o duplo clique que a tarefa pede.
    expect(useBibliotecaStore.getState().importando).toBe(true);
    await useBibliotecaStore.getState().importar("C:\\livro.pdf");

    expect(importarLivroMock).toHaveBeenCalledTimes(1);

    resolvePrimeira(livroNaEstante({ id: "novo" }));
    await primeira;
  });

  it("erro do backend vira errorMessage, libera o guard e a promise rejeita", async () => {
    importarLivroMock.mockRejectedValue(new Error("arquivo já importado"));

    await expect(useBibliotecaStore.getState().importar("C:\\dup.pdf")).rejects.toThrow();

    const state = useBibliotecaStore.getState();
    expect(state.errorMessage).toBe("Não foi possível importar o arquivo.");
    expect(state.importando).toBe(false);
  });
});

describe("remover", () => {
  it("some da estante", async () => {
    const alvo = livroNaEstante({ id: "alvo" });
    useBibliotecaStore.setState({ livros: [alvo] });
    removerLivroMock.mockResolvedValue(undefined);

    await useBibliotecaStore.getState().remover("alvo");

    expect(useBibliotecaStore.getState().livros).toEqual([]);
  });

  it("removendo o livro que estava aberto para leitura volta para a estante", async () => {
    useBibliotecaStore.setState({ livros: [livroNaEstante({ id: "alvo" })], tela: "leitura", livroSelecionadoId: "alvo" });
    removerLivroMock.mockResolvedValue(undefined);

    await useBibliotecaStore.getState().remover("alvo");

    const state = useBibliotecaStore.getState();
    expect(state.tela).toBe("estante");
    expect(state.livroSelecionadoId).toBeNull();
  });

  it("erro ao remover não mexe na lista e a promise rejeita", async () => {
    const alvo = livroNaEstante({ id: "alvo" });
    useBibliotecaStore.setState({ livros: [alvo] });
    removerLivroMock.mockRejectedValue(new Error("arquivo em uso"));

    await expect(useBibliotecaStore.getState().remover("alvo")).rejects.toThrow();

    expect(useBibliotecaStore.getState().livros).toEqual([alvo]);
    expect(useBibliotecaStore.getState().errorMessage).toBe("Não foi possível remover o livro.");
  });
});

describe("editarTituloDoLivro / editarAutorDoLivro", () => {
  it("editarTituloDoLivro chama definirMetadadosDoLivro(id, titulo, null) e rebusca a estante — DOIS livros de ids distintos, agindo no SEGUNDO", async () => {
    const primeiro = livroNaEstante({ id: "livro-1" });
    const segundoAntigo = livroNaEstante({ id: "livro-2" });
    const segundoAtualizado = livroNaEstante({ id: "livro-2", titulo: "Título Corrigido" });
    useBibliotecaStore.setState({ livros: [primeiro, segundoAntigo] });
    definirMetadadosDoLivroMock.mockResolvedValue(segundoAtualizado.livro);
    listarLivrosMock.mockResolvedValue([primeiro, segundoAtualizado]);

    await useBibliotecaStore.getState().editarTituloDoLivro("livro-2", "Título Corrigido");

    expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-2", "Título Corrigido", null);
    // Nunca chamado para o PRIMEIRO livro — um id errado (sempre o
    // primeiro) ainda passaria despercebido com um livro só na store.
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalledWith("livro-1", expect.anything(), expect.anything());
    expect(useBibliotecaStore.getState().livros).toEqual([primeiro, segundoAtualizado]);
  });

  it("editarTituloDoLivro com erro do backend vira errorMessage e a promise rejeita, sem rebuscar a estante", async () => {
    definirMetadadosDoLivroMock.mockRejectedValue(new AppError({ kind: "invalid", message: "título muito longo" }));

    await expect(useBibliotecaStore.getState().editarTituloDoLivro("livro-1", "x".repeat(500))).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("título muito longo");
    expect(listarLivrosMock).not.toHaveBeenCalled();
  });

  it("editarAutorDoLivro chama definirMetadadosDoLivro(id, null, autor) — título fica intocado (`null`) — DOIS livros de ids distintos, agindo no SEGUNDO", async () => {
    const primeiro = livroNaEstante({ id: "livro-1" });
    const segundoAntigo = livroNaEstante({ id: "livro-2", autor: null });
    const segundoAtualizado = livroNaEstante({ id: "livro-2", autor: "Rick Riordan" });
    useBibliotecaStore.setState({ livros: [primeiro, segundoAntigo] });
    definirMetadadosDoLivroMock.mockResolvedValue(segundoAtualizado.livro);
    listarLivrosMock.mockResolvedValue([primeiro, segundoAtualizado]);

    await useBibliotecaStore.getState().editarAutorDoLivro("livro-2", "Rick Riordan");

    expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-2", null, "Rick Riordan");
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalledWith("livro-1", expect.anything(), expect.anything());
    expect(useBibliotecaStore.getState().livros).toEqual([primeiro, segundoAtualizado]);
  });

  it("editarAutorDoLivro com erro do backend vira errorMessage e a promise rejeita", async () => {
    definirMetadadosDoLivroMock.mockRejectedValue(new AppError({ kind: "invalid", message: "autor muito longo" }));

    await expect(useBibliotecaStore.getState().editarAutorDoLivro("livro-1", "x".repeat(500))).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("autor muito longo");
  });
});

describe("moverLivro", () => {
  it("chama moverLivro(livroId, aposLivroId) na ordem certa e rebusca a estante na ordem nova", async () => {
    const percy1 = livroNaEstante({ id: "percy-1", titulo: "Percy Jackson 1" });
    const percy2 = livroNaEstante({ id: "percy-2", titulo: "Percy Jackson 2" });
    useBibliotecaStore.setState({ livros: [percy2, percy1] });
    moverLivroMock.mockResolvedValue(percy2.livro);
    // Depois de mover "percy-2" para logo depois de "percy-1", a ordem
    // certa (a que `list_shelf` devolveria) é [percy1, percy2].
    listarLivrosMock.mockResolvedValue([percy1, percy2]);

    await useBibliotecaStore.getState().moverLivro("percy-2", "percy-1");

    expect(moverLivroMock).toHaveBeenCalledWith("percy-2", "percy-1");
    expect(useBibliotecaStore.getState().livros).toEqual([percy1, percy2]);
  });

  it("aposLivroId `null` (mover para o primeiro lugar) passa `null` ao IPC, não `undefined`", async () => {
    const alvo = livroNaEstante({ id: "livro-1" });
    moverLivroMock.mockResolvedValue(alvo.livro);
    listarLivrosMock.mockResolvedValue([alvo]);

    await useBibliotecaStore.getState().moverLivro("livro-1", null);

    expect(moverLivroMock).toHaveBeenCalledWith("livro-1", null);
  });

  it("erro do backend (livro de referência não é mais um irmão ativo) vira errorMessage e a promise rejeita", async () => {
    moverLivroMock.mockRejectedValue(new AppError({ kind: "invalid", message: "livro de referência não é um irmão ativo na estante" }));

    await expect(useBibliotecaStore.getState().moverLivro("livro-1", "livro-fantasma")).rejects.toThrow();

    expect(useBibliotecaStore.getState().errorMessage).toBe("livro de referência não é um irmão ativo na estante");
  });
});

describe("abrirLeitura / voltarParaEstante", () => {
  it("abrirLeitura troca a tela e marca o livro selecionado", () => {
    useBibliotecaStore.getState().abrirLeitura("x");

    const state = useBibliotecaStore.getState();
    expect(state.tela).toBe("leitura");
    expect(state.livroSelecionadoId).toBe("x");
  });

  it("voltarParaEstante limpa a seleção", () => {
    useBibliotecaStore.setState({ tela: "leitura", livroSelecionadoId: "x" });

    useBibliotecaStore.getState().voltarParaEstante();

    const state = useBibliotecaStore.getState();
    expect(state.tela).toBe("estante");
    expect(state.livroSelecionadoId).toBeNull();
  });
});
