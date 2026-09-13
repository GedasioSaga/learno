import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  listarCategorias,
  listarCategoriasPorLivro,
  listarLivros,
  removerLivro,
  type Categoria,
  type LivroNaEstante,
  type ProgressoDeLeitura,
} from "../../lib/ipc";
import { ConteudoDeBiblioteca } from "./ConteudoDeBiblioteca";
import { useBibliotecaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listarLivros: vi.fn(),
    importarLivro: vi.fn(),
    removerLivro: vi.fn(),
    // PARTE 2 (categorias) — sem wrapper real em `lib/ipc.ts` nesta rodada
    // (ver relatório da tarefa); mockados só para `load()` não quebrar.
    criarCategoria: vi.fn(),
    listarCategorias: vi.fn().mockResolvedValue([]),
    listarCategoriasDoLivro: vi.fn(),
    listarCategoriasPorLivro: vi.fn().mockResolvedValue([]),
    definirCategoriasDoLivro: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

/**
 * O leitor de verdade (`abrirLivro`, `pdfjs-dist`, teclado, anotações) tem
 * sua própria suíte em `leitor/LeitorDeLivro.test.tsx`. Aqui o que importa é
 * só a responsabilidade de `ConteudoDeBiblioteca`: decidir QUANDO mostrar a
 * estante e quando mostrar o leitor, e com qual `livroId` — por isso um
 * stub, não o componente real.
 */
vi.mock("./leitor/LeitorDeLivro", () => ({
  LeitorDeLivro: ({ livroId, onVoltar }: { livroId: string; onVoltar: () => void }) => (
    <div>
      <p>Leitor aberto para {livroId}</p>
      <button type="button" onClick={onVoltar}>
        ← Voltar para a estante
      </button>
    </div>
  ),
}));

const listarLivrosMock = vi.mocked(listarLivros);
const removerLivroMock = vi.mocked(removerLivro);
const listarCategoriasMock = vi.mocked(listarCategorias);
const listarCategoriasPorLivroMock = vi.mocked(listarCategoriasPorLivro);

/**
 * `progresso` entra como PARCIAL de propósito: cada teste diz só o que lhe
 * interessa (a fração, o status) e o resto vem do padrão.
 *
 * Fixture que exige o objeto inteiro obriga a repetir campo em cada chamada,
 * e foi assim que a divergência de contrato deste projeto sobreviveu tanto
 * tempo — o teste fabricava a forma que ele mesmo esperava, nunca a forma que
 * o Rust manda. Com o padrão num lugar só, um campo novo no contrato é uma
 * linha aqui, e nenhuma no resto do arquivo.
 */
const PROGRESSO_PADRAO: ProgressoDeLeitura = {
  bookId: "00000000-0000-0000-0000-000000000000",
  currentLocator: "0",
  currentFraction: 0,
  furthestLocator: "0",
  furthestFraction: 0,
  status: "unread",
  lastReadAt: null,
  finishedAt: null,
  updatedAt: "2026-09-05T10:00:00.000Z",
};

function livroNaEstante(
  overrides: Omit<Partial<LivroNaEstante>, "progresso"> & {
    id: string;
    progresso?: Partial<ProgressoDeLeitura>;
  },
): LivroNaEstante {
  const { id, progresso, ...resto } = overrides;
  return {
    // `position` (índice fracionário da ordem da estante): contrato chegou
    // em `lib/ipc.ts` durante esta peça — valor fixo, nenhum teste deste
    // arquivo depende de ordem entre livros (isso é `GradeDeLivros.test.tsx`).
    livro: { id, pageId: "00000000-0000-0000-0000-000000000001", format: "pdf", fileName: `${id}.pdf`, coverFileName: null, totalUnits: 100, contentHash: "sha-teste", originalFileName: "original.pdf", fileSize: 1024, metadataTitle: null, metadataAuthor: null, hasTextLayer: true, position: "a0", createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" },
    progresso: { ...PROGRESSO_PADRAO, bookId: id, ...progresso },
    titulo: `Título ${id}`,
    autor: "Autor Teste",
    ...resto,
  };
}

/** Mesmo helper de `filtro.test.ts` — categoria mínima, `parentId: null` por padrão (raiz). */
function categoria(id: string, name: string, parentId: string | null = null): Categoria {
  return { id, name, parentId, position: "a0", createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConteudoDeBiblioteca", () => {
  it("estante vazia: mostra o convite para importar com a ação em evidência", async () => {
    listarLivrosMock.mockResolvedValue([]);

    render(<ConteudoDeBiblioteca />);

    expect(await screen.findByText("A estante está vazia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Importar livro…" })).toBeInTheDocument();
  });

  it("erro ao carregar mostra alerta", async () => {
    listarLivrosMock.mockRejectedValue(new Error("disco não encontrado"));

    render(<ConteudoDeBiblioteca />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a biblioteca.");
  });

  it("a barra de progresso usa furthestFraction, não currentFraction — não anda para trás quando o usuário voltou uma página", async () => {
    listarLivrosMock.mockResolvedValue([
      livroNaEstante({
        id: "a",
        progresso: {
          currentLocator: "10",
          // O usuário está lendo a página 10 de novo (voltou), mas o ponto
          // mais distante que já alcançou foi a página 80 (80%). A barra
          // tem que mostrar 80%, nunca os 10% de `currentFraction`.
          currentFraction: 0.1,
          furthestLocator: "80",
          furthestFraction: 0.8,
          status: "reading",
          lastReadAt: "2026-09-01T00:00:00Z",
        },
      }),
    ]);

    render(<ConteudoDeBiblioteca />);

    const barra = await screen.findByRole("progressbar", { name: /Título a/ });
    expect(barra).toHaveValue(80);
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.queryByText("10%")).not.toBeInTheDocument();
  });

  it("filtra a grade pelo `filtro` da store", async () => {
    listarLivrosMock.mockResolvedValue([
      livroNaEstante({ id: "a", titulo: "Não lido", progresso: { currentLocator: "0", currentFraction: 0, furthestLocator: "0", furthestFraction: 0, status: "unread", lastReadAt: null } }),
      livroNaEstante({ id: "b", titulo: "Lendo agora", progresso: { currentLocator: "0", currentFraction: 0.3, furthestLocator: "0", furthestFraction: 0.3, status: "reading", lastReadAt: "2026-09-01T00:00:00Z" } }),
    ]);
    useBibliotecaStore.setState({ filtro: "reading" });

    render(<ConteudoDeBiblioteca />);

    expect(await screen.findByText("Lendo agora")).toBeInTheDocument();
    expect(screen.queryByText("Não lido")).not.toBeInTheDocument();
  });

  it("D1: filtrar pelo AVÔ mostra o livro que só está atribuído ao NETO (categoria mais funda) — livro fora da árvore não aparece", async () => {
    const fantasia = { id: "cat-fantasia", name: "Fantasia", parentId: null, position: "a0", createdAt: "", updatedAt: "" };
    const epico = { id: "cat-epico", name: "Épico", parentId: "cat-fantasia", position: "a0", createdAt: "", updatedAt: "" };
    const alta = { id: "cat-alta", name: "Alta Fantasia", parentId: "cat-epico", position: "a0", createdAt: "", updatedAt: "" };
    listarCategoriasMock.mockResolvedValue([fantasia, epico, alta]);
    const soNoNeto = livroNaEstante({ id: "neto", titulo: "Só no neto" });
    const foraDaArvore = livroNaEstante({ id: "fora", titulo: "Fora da árvore" });
    listarLivrosMock.mockResolvedValue([soNoNeto, foraDaArvore]);
    // O livro só tem a categoria mais FUNDA (o neto de "Fantasia") — nenhuma
    // categoria intermediária foi atribuída a ele.
    listarCategoriasPorLivroMock.mockResolvedValue([{ livroId: "neto", categorias: [alta] }]);
    useBibliotecaStore.setState({ filtroCategoriaId: "cat-fantasia" });

    render(<ConteudoDeBiblioteca />);

    expect(await screen.findByText("Só no neto")).toBeInTheDocument();
    expect(screen.queryByText("Fora da árvore")).not.toBeInTheDocument();
  });

  it("abrir um livro monta o leitor de verdade com o livroId certo, não uma maquete", async () => {
    listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Meu Livro" })]);

    render(<ConteudoDeBiblioteca />);
    const capa = await screen.findByText("Meu Livro");
    fireEvent.click(capa);

    expect(await screen.findByText("Leitor aberto para a")).toBeInTheDocument();
    expect(screen.queryByText("Meu Livro")).not.toBeInTheDocument();
  });

  it("'Voltar para a estante' sai do leitor e volta para a grade", async () => {
    listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Meu Livro" })]);
    render(<ConteudoDeBiblioteca />);
    fireEvent.click(await screen.findByText("Meu Livro"));
    await screen.findByText("Leitor aberto para a");

    fireEvent.click(screen.getByRole("button", { name: /Voltar para a estante/ }));

    expect(await screen.findByText("Meu Livro")).toBeInTheDocument();
    expect(screen.queryByText("Leitor aberto para a")).not.toBeInTheDocument();
  });

  it("remover pede confirmação INLINE (nunca window.confirm — trava a WebView do Tauri) e só chama removerLivro se confirmado", async () => {
    listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Meu Livro" })]);
    removerLivroMock.mockResolvedValue(undefined);
    render(<ConteudoDeBiblioteca />);
    await screen.findByText("Meu Livro");

    fireEvent.click(screen.getByRole("button", { name: "Remover Meu Livro" }));
    expect(removerLivroMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog", { name: "Remover Meu Livro?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(removerLivroMock).toHaveBeenCalledWith("a"));
  });

  it("cancelar a confirmação de remover não chama removerLivro", async () => {
    listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Meu Livro" })]);
    render(<ConteudoDeBiblioteca />);
    await screen.findByText("Meu Livro");

    fireEvent.click(screen.getByRole("button", { name: "Remover Meu Livro" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));

    expect(removerLivroMock).not.toHaveBeenCalled();
  });

  /**
   * `agruparEstantePorCategoria` já tem cobertura exaustiva em
   * `filtro.test.ts` — o que falta é provar que `ConteudoDeBiblioteca`
   * (por volta da linha 110) REALMENTE traduz aquele resultado em cabeçalhos
   * na tela. Cada `<section aria-labelledby>` (raiz, e "Sem categoria") tem
   * nome acessível pelo `<h2>` associado, então a role ARIA é "region" — é
   * por isso que os testes abaixo localizam grupo por
   * `getByRole("region", { name: ... })` em vez de vasculhar o DOM inteiro:
   * isso prova que o livro está DENTRO daquela seção, não só em algum lugar
   * da página. Sempre com 2+ livros por grupo — com um só, um agrupamento
   * errado (livro no balde vizinho) ainda pareceria certo.
   */
  describe("agrupamento por categoria/subcategoria na tela (integração)", () => {
    it("1. duas categorias-raiz com livros: os dois cabeçalhos aparecem, cada um só com os livros da sua categoria", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      const poesia = categoria("cat-poesia", "Poesia");
      listarCategoriasMock.mockResolvedValue([fantasia, poesia]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "a", titulo: "Livro A" }),
        livroNaEstante({ id: "b", titulo: "Livro B" }),
        livroNaEstante({ id: "c", titulo: "Livro C" }),
        livroNaEstante({ id: "d", titulo: "Livro D" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([
        { livroId: "a", categorias: [fantasia] },
        { livroId: "b", categorias: [fantasia] },
        { livroId: "c", categorias: [poesia] },
        { livroId: "d", categorias: [poesia] },
      ]);

      render(<ConteudoDeBiblioteca />);

      const regiaoFantasia = await screen.findByRole("region", { name: "Fantasia" });
      expect(within(regiaoFantasia).getByText("Livro A")).toBeInTheDocument();
      expect(within(regiaoFantasia).getByText("Livro B")).toBeInTheDocument();
      expect(within(regiaoFantasia).queryByText("Livro C")).not.toBeInTheDocument();
      expect(within(regiaoFantasia).queryByText("Livro D")).not.toBeInTheDocument();

      const regiaoPoesia = screen.getByRole("region", { name: "Poesia" });
      expect(within(regiaoPoesia).getByText("Livro C")).toBeInTheDocument();
      expect(within(regiaoPoesia).getByText("Livro D")).toBeInTheDocument();
      expect(within(regiaoPoesia).queryByText("Livro A")).not.toBeInTheDocument();
      expect(within(regiaoPoesia).queryByText("Livro B")).not.toBeInTheDocument();
    });

    it("2. subcategoria dentro de uma raiz: o sub-cabeçalho aparece DENTRO da seção da raiz, não solto na tela", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      const epico = categoria("cat-epico", "Épico", "cat-fantasia");
      listarCategoriasMock.mockResolvedValue([fantasia, epico]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "raiz", titulo: "Só na raiz" }),
        livroNaEstante({ id: "epico-a", titulo: "Épico A" }),
        livroNaEstante({ id: "epico-b", titulo: "Épico B" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([
        { livroId: "raiz", categorias: [fantasia] },
        { livroId: "epico-a", categorias: [epico] },
        { livroId: "epico-b", categorias: [epico] },
      ]);

      render(<ConteudoDeBiblioteca />);

      const regiaoFantasia = await screen.findByRole("region", { name: "Fantasia" });
      expect(within(regiaoFantasia).getByRole("heading", { level: 3, name: "Épico" })).toBeInTheDocument();
      expect(within(regiaoFantasia).getByText("Épico A")).toBeInTheDocument();
      expect(within(regiaoFantasia).getByText("Épico B")).toBeInTheDocument();
      expect(within(regiaoFantasia).getByText("Só na raiz")).toBeInTheDocument();
      // A subcategoria nunca vira sua própria região de nível superior — só
      // um <h3> dentro da região da raiz, nunca uma segunda <section>.
      expect(screen.queryByRole("region", { name: "Épico" })).not.toBeInTheDocument();
    });

    it("3. livro sem categoria nenhuma aparece na seção 'Sem categoria' — nunca some", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      listarCategoriasMock.mockResolvedValue([fantasia]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "com-cat", titulo: "Com categoria" }),
        livroNaEstante({ id: "sem-a", titulo: "Sem categoria A" }),
        livroNaEstante({ id: "sem-b", titulo: "Sem categoria B" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([{ livroId: "com-cat", categorias: [fantasia] }]);

      render(<ConteudoDeBiblioteca />);

      await screen.findByRole("region", { name: "Fantasia" });
      const regiaoSemCategoria = screen.getByRole("region", { name: "Sem categoria" });
      expect(within(regiaoSemCategoria).getByText("Sem categoria A")).toBeInTheDocument();
      expect(within(regiaoSemCategoria).getByText("Sem categoria B")).toBeInTheDocument();
      expect(within(regiaoSemCategoria).queryByText("Com categoria")).not.toBeInTheDocument();
    });

    it("4. livro atribuído tanto à raiz (o PAI) quanto a uma subcategoria dela (o FILHO) aparece DUAS VEZES na mesma seção — no balde direto e no balde da subcategoria (comportamento atual, ver item 3 do comentário de `agruparEstantePorCategoria` em filtro.ts)", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      const epico = categoria("cat-epico", "Épico", "cat-fantasia");
      const poesia = categoria("cat-poesia", "Poesia");
      listarCategoriasMock.mockResolvedValue([fantasia, epico, poesia]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "duplo", titulo: "Livro Duplicado" }),
        livroNaEstante({ id: "distrator", titulo: "Livro Distrator" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([
        { livroId: "duplo", categorias: [fantasia, epico] },
        { livroId: "distrator", categorias: [poesia] },
      ]);

      render(<ConteudoDeBiblioteca />);

      const regiaoFantasia = await screen.findByRole("region", { name: "Fantasia" });
      // Uma ocorrência no balde "sem subcategoria" (atribuição direta à
      // raiz) e outra no balde "Épico" — duas aparições, não uma.
      expect(within(regiaoFantasia).getAllByText("Livro Duplicado")).toHaveLength(2);
      expect(within(regiaoFantasia).getByRole("heading", { level: 3, name: "Épico" })).toBeInTheDocument();

      const regiaoPoesia = screen.getByRole("region", { name: "Poesia" });
      expect(within(regiaoPoesia).getByText("Livro Distrator")).toBeInTheDocument();
      expect(within(regiaoPoesia).queryByText("Livro Duplicado")).not.toBeInTheDocument();
    });

    it("5. categoria sem nenhum livro atribuído (grupo que ficaria vazio) não vira cabeçalho fantasma na tela", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      const vazia = categoria("cat-vazia", "Categoria Vazia");
      listarCategoriasMock.mockResolvedValue([fantasia, vazia]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "a", titulo: "Livro A" }),
        livroNaEstante({ id: "b", titulo: "Livro B" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([
        { livroId: "a", categorias: [fantasia] },
        { livroId: "b", categorias: [fantasia] },
      ]);

      render(<ConteudoDeBiblioteca />);

      await screen.findByRole("region", { name: "Fantasia" });
      expect(screen.queryByRole("region", { name: "Categoria Vazia" })).not.toBeInTheDocument();
      // "Categoria Vazia" ainda aparece como opção de checkbox dentro de cada
      // `LivroCard` (a lista de TODAS as categorias existentes, para marcar
      // um livro) — isso é esperado e outra funcionalidade. O que não pode
      // existir é um CABEÇALHO (h2/h3) fantasma para ela na estante.
      expect(screen.queryByRole("heading", { name: "Categoria Vazia" })).not.toBeInTheDocument();
    });

    it("6. com um filtro de categoria ESPECÍFICO ativo no painel, o agrupamento por categoria/subcategoria fica desligado — a estante volta para a grade lisa (D, comentário na linha 97-108 de ConteudoDeBiblioteca.tsx)", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      const epico = categoria("cat-epico", "Épico", "cat-fantasia");
      const poesia = categoria("cat-poesia", "Poesia");
      listarCategoriasMock.mockResolvedValue([fantasia, epico, poesia]);
      listarLivrosMock.mockResolvedValue([
        livroNaEstante({ id: "f", titulo: "Livro Fantasia" }),
        livroNaEstante({ id: "e", titulo: "Livro Épico" }),
        livroNaEstante({ id: "p", titulo: "Livro Poesia" }),
      ]);
      listarCategoriasPorLivroMock.mockResolvedValue([
        { livroId: "f", categorias: [fantasia] },
        { livroId: "e", categorias: [epico] },
        { livroId: "p", categorias: [poesia] },
      ]);
      useBibliotecaStore.setState({ filtroCategoriaId: "cat-fantasia" });

      render(<ConteudoDeBiblioteca />);

      // Filtro de categoria (D1: alcança o descendente Épico) continua ativo
      // — só o AGRUPAMENTO em cabeçalhos é que desliga.
      expect(await screen.findByText("Livro Fantasia")).toBeInTheDocument();
      expect(screen.getByText("Livro Épico")).toBeInTheDocument();
      expect(screen.queryByText("Livro Poesia")).not.toBeInTheDocument();
      // Grade lisa: nenhuma <section>/região, nenhum cabeçalho de categoria.
      expect(screen.queryAllByRole("region")).toHaveLength(0);
      expect(screen.queryByRole("heading", { name: "Fantasia" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Épico" })).not.toBeInTheDocument();
      expect(screen.queryByText(/ordem vale para a estante inteira/)).not.toBeInTheDocument();
    });

    it("7a. o aviso 'a ordem vale para a estante inteira' aparece quando a estante está agrupada por categoria", async () => {
      const fantasia = categoria("cat-fantasia", "Fantasia");
      listarCategoriasMock.mockResolvedValue([fantasia]);
      listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Livro A" })]);
      listarCategoriasPorLivroMock.mockResolvedValue([{ livroId: "a", categorias: [fantasia] }]);

      render(<ConteudoDeBiblioteca />);

      await screen.findByRole("region", { name: "Fantasia" });
      expect(screen.getByText(/ordem vale para a estante inteira/)).toBeInTheDocument();
    });

    it("7b. o aviso NÃO aparece na grade lisa (nenhuma categoria criada ainda) — só existe quando o agrupamento está ligado", async () => {
      listarCategoriasMock.mockResolvedValue([]);
      listarLivrosMock.mockResolvedValue([livroNaEstante({ id: "a", titulo: "Livro A" })]);
      listarCategoriasPorLivroMock.mockResolvedValue([]);

      render(<ConteudoDeBiblioteca />);

      expect(await screen.findByText("Livro A")).toBeInTheDocument();
      expect(screen.queryByText(/ordem vale para a estante inteira/)).not.toBeInTheDocument();
    });
  });
});
