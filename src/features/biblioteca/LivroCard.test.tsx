import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, definirMetadadosDoLivro, listarLivros, type LivroNaEstante } from "../../lib/ipc";
import { storeMediaFile } from "../editor/blocks/media/media-storage";
import { LivroCard } from "./LivroCard";
import { useBibliotecaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    // GRADE DE LIVROS (título/autor) — mockados para isolar o teste do IPC
    // real (contrato já existe em `lib/ipc.ts`, chegou nesta mesma sessão).
    definirMetadadosDoLivro: vi.fn(),
    moverLivro: vi.fn(),
    // `editarTituloDoLivro`/`editarAutorDoLivro` da store rebuscam a estante
    // inteira depois do IPC (mesma técnica de `atribuirCategorias`) — sem
    // isto, o `invoke()` real (sem Tauri no jsdom) rejeitaria e o teste
    // veria um erro que não tem nada a ver com o que está testando.
    listarLivros: vi.fn(),
  };
});

const definirMetadadosDoLivroMock = vi.mocked(definirMetadadosDoLivro);
const listarLivrosMock = vi.mocked(listarLivros);

/** Props de reordenar que a maioria dos testes deste arquivo não testa — sempre "pode mover nos dois sentidos", sobrescrito só nos testes de reordenar. */
function propsDeReordenarPadrao() {
  return {
    podeMoverParaCima: true,
    podeMoverParaBaixo: true,
    onMoverParaCima: vi.fn(),
    onMoverParaBaixo: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Redefinido aqui (não só no factory acima) porque um teste de erro usa
  // `mockRejectedValueOnce` na PRÓPRIA chamada — isto garante que o padrão
  // "sucesso" volta para o teste seguinte mesmo que `clearAllMocks` tivesse
  // apagado a implementação (mesma cautela de `store.test.ts`).
  listarLivrosMock.mockResolvedValue([]);
  useBibliotecaStore.setState({ errorMessage: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function livroNaEstante(overrides: Partial<LivroNaEstante["livro"]> = {}): LivroNaEstante {
  return {
    livro: {
      id: "livro-1",
      pageId: "00000000-0000-0000-0000-000000000001",
      format: "pdf",
      contentHash: "sha-teste",
      fileName: "livro-1.pdf",
      originalFileName: "original.pdf",
      fileSize: 1024,
      coverFileName: null,
      metadataTitle: null,
      metadataAuthor: null,
      totalUnits: 100,
      hasTextLayer: true,
      // Índice fracionário da ORDEM da estante — contrato chegou em
      // `lib/ipc.ts` durante esta peça; nenhum teste deste arquivo lê este
      // campo (`LivroCard` não usa `position`, só recebe as props de
      // reordenar já calculadas por `GradeDeLivros`).
      position: "a0",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:00.000Z",
      ...overrides,
    },
    progresso: {
      bookId: "livro-1",
      currentLocator: "0",
      currentFraction: 0.3,
      furthestLocator: "0",
      furthestFraction: 0.3,
      status: "reading",
      lastReadAt: "2026-09-05T10:00:00.000Z",
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
    },
    titulo: "Dom Casmurro",
    autor: "Machado de Assis",
  };
}

describe("LivroCard — capa", () => {
  it("sem coverFileName: nenhum <img>, o selo de formato de sempre continua ali, e nada quebra", () => {
    const item = livroNaEstante({ coverFileName: null });

    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("Dom Casmurro")).toBeInTheDocument();
  });

  it("com coverFileName: usa o src que resolveMediaSrc resolveu para aquele nome, e o alt é o título — nunca a palavra 'capa'", async () => {
    // Grava de verdade pelo mesmo armazenamento que `capa.ts` usa
    // (`storeMediaFile`, fora do Tauri — mesmo modo de `media-storage.test.ts`)
    // para o teste provar a resolução real, não um valor forjado à parte.
    const arquivo = new File(["conteúdo-da-capa"], "capa.png", { type: "image/png" });
    const armazenada = await storeMediaFile(arquivo);
    const item = livroNaEstante({ coverFileName: armazenada.src });

    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    const imagem = await screen.findByRole("img", { name: "Dom Casmurro" });
    await waitFor(() => expect(imagem).toHaveAttribute("src", armazenada.url));
  });

  it("a capa NAO e arrastavel por conta propria — senao ela rouba o gesto de reordenar", async () => {
    // Uma `<img>` e arrastavel por padrao no navegador. Como a capa e a maior
    // area clicavel do cartao, o usuario pega ali para reordenar e o navegador
    // tenta arrastar a IMAGEM em vez do cartao: o cursor vira o sinal de
    // proibido e o livro nao sai do lugar. Foi exatamente o que o usuario
    // relatou. Desligar aqui faz o gesto pertencer sempre ao `<li draggable>`.
    const arquivo = new File(["conteudo-da-capa"], "capa.png", { type: "image/png" });
    const armazenada = await storeMediaFile(arquivo);
    const item = livroNaEstante({ coverFileName: armazenada.src });

    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    const imagem = await screen.findByRole("img", { name: "Dom Casmurro" });
    expect(imagem).toHaveAttribute("draggable", "false");
  });
});

describe("LivroCard — editar título e autor", () => {
  it("duplo clique no título troca por um campo, e Enter chama editarTituloDoLivro com o valor novo — DOIS livros de ids distintos, agindo no SEGUNDO", async () => {
    const primeiro = livroNaEstante({ id: "livro-1" });
    const segundo = { ...livroNaEstante({ id: "livro-2" }), titulo: "Segundo Livro" };
    render(
      <>
        <LivroCard item={primeiro} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />
        <LivroCard item={segundo} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />
      </>,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "Segundo Livro" }));
    const campo = screen.getByLabelText("Título de Segundo Livro");
    fireEvent.change(campo, { target: { value: "Título Corrigido" } });
    fireEvent.keyDown(campo, { key: "Enter" });

    await waitFor(() => expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-2", "Título Corrigido", null));
    // Nunca chamado para o PRIMEIRO livro — um id errado (sempre o
    // primeiro) ainda passaria despercebido com um livro só na tela.
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalledWith("livro-1", expect.anything(), expect.anything());
  });

  it("confirmar o título sem mudar nada não chama o IPC — evita gravar o título derivado do arquivo como metadado", async () => {
    const item = livroNaEstante();
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Dom Casmurro" }));
    fireEvent.keyDown(screen.getByLabelText("Título de Dom Casmurro"), { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText("Título de Dom Casmurro")).not.toBeInTheDocument());
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalled();
  });

  it("limpar o título e confirmar chama o IPC com string vazia — apaga o metadado, a estante volta ao título do arquivo", async () => {
    const item = livroNaEstante();
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Dom Casmurro" }));
    const campo = screen.getByLabelText("Título de Dom Casmurro");
    fireEvent.change(campo, { target: { value: "" } });
    fireEvent.keyDown(campo, { key: "Enter" });

    await waitFor(() => expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-1", "", null));
  });

  it("Escape no campo de título cancela sem chamar o IPC", async () => {
    const item = livroNaEstante();
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Dom Casmurro" }));
    const campo = screen.getByLabelText("Título de Dom Casmurro");
    fireEvent.change(campo, { target: { value: "Rascunho" } });
    fireEvent.keyDown(campo, { key: "Escape" });

    expect(screen.queryByLabelText("Título de Dom Casmurro")).not.toBeInTheDocument();
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalled();
  });

  it("o lápis de título é um caminho de teclado (não só duplo clique) e chama o mesmo IPC", async () => {
    const item = livroNaEstante();
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.click(screen.getByRole("button", { name: "Editar título de Dom Casmurro" }));
    const campo = screen.getByLabelText("Título de Dom Casmurro");
    fireEvent.change(campo, { target: { value: "Novo Título" } });
    fireEvent.blur(campo);

    await waitFor(() => expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-1", "Novo Título", null));
  });

  it("erro do backend ao editar o título mostra a mensagem LOCAL, sem fechar o campo", async () => {
    definirMetadadosDoLivroMock.mockRejectedValueOnce(new AppError({ kind: "invalid", message: "título muito longo" }));
    const item = livroNaEstante();
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Dom Casmurro" }));
    const campo = screen.getByLabelText("Título de Dom Casmurro");
    fireEvent.change(campo, { target: { value: "x".repeat(500) } });
    fireEvent.keyDown(campo, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("título muito longo");
    expect(screen.getByLabelText("Título de Dom Casmurro")).toBeInTheDocument();
  });

  it("editar o autor manda `null` no lugar do título (o título fica intocado) — DOIS livros de ids distintos, agindo no SEGUNDO", async () => {
    const primeiro = livroNaEstante({ id: "livro-1" });
    const segundo = { ...livroNaEstante({ id: "livro-2" }), titulo: "Segundo Livro", autor: "Autor Antigo" };
    render(
      <>
        <LivroCard item={primeiro} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />
        <LivroCard item={segundo} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Editar autor de Segundo Livro" }));
    const campo = screen.getByLabelText("Autor de Segundo Livro");
    fireEvent.change(campo, { target: { value: "Autor Novo" } });
    fireEvent.keyDown(campo, { key: "Enter" });

    await waitFor(() => expect(definirMetadadosDoLivroMock).toHaveBeenCalledWith("livro-2", null, "Autor Novo"));
    expect(definirMetadadosDoLivroMock).not.toHaveBeenCalledWith("livro-1", expect.anything(), expect.anything());
  });

  it("autor sem valor salvo edita a partir de campo VAZIO, nunca do texto de fallback 'Autor desconhecido'", async () => {
    const item = { ...livroNaEstante(), autor: null };
    render(<LivroCard item={item} onAbrir={vi.fn()} onRemover={vi.fn()} {...propsDeReordenarPadrao()} />);

    fireEvent.click(screen.getByRole("button", { name: "Editar autor de Dom Casmurro" }));

    expect(screen.getByLabelText("Autor de Dom Casmurro")).toHaveValue("");
  });
});

describe("LivroCard — reordenar por teclado", () => {
  it("as setas cima/baixo chamam onMoverParaCima/onMoverParaBaixo — nunca o mouse é o único caminho", () => {
    const onMoverParaCima = vi.fn();
    const onMoverParaBaixo = vi.fn();
    const item = livroNaEstante();
    render(
      <LivroCard
        item={item}
        onAbrir={vi.fn()}
        onRemover={vi.fn()}
        podeMoverParaCima
        podeMoverParaBaixo
        onMoverParaCima={onMoverParaCima}
        onMoverParaBaixo={onMoverParaBaixo}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mover Dom Casmurro para cima" }));
    fireEvent.click(screen.getByRole("button", { name: "Mover Dom Casmurro para baixo" }));

    expect(onMoverParaCima).toHaveBeenCalledTimes(1);
    expect(onMoverParaBaixo).toHaveBeenCalledTimes(1);
  });

  it("primeiro da lista: 'para cima' vem desabilitado — não existe onde subir", () => {
    const item = livroNaEstante();
    render(
      <LivroCard
        item={item}
        onAbrir={vi.fn()}
        onRemover={vi.fn()}
        podeMoverParaCima={false}
        podeMoverParaBaixo
        onMoverParaCima={vi.fn()}
        onMoverParaBaixo={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Mover Dom Casmurro para cima" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover Dom Casmurro para baixo" })).toBeEnabled();
  });
});
