import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LivroNaEstante } from "../../lib/ipc";
import { GradeDeLivros } from "./GradeDeLivros";
import { useBibliotecaStore } from "./store";

/**
 * jsdom nao calcula layout: `getBoundingClientRect()` devolve tudo zero, e a
 * decisao "metade esquerda ou direita" ficaria sempre no mesmo lado. Forjar o
 * retangulo e a mesma tecnica de `features/pages/use-posicao-ancorada.test.ts`.
 */
const BORDA_ESQUERDA = 100;
const LARGURA_DO_CARTAO = 200;
const LADO_ESQUERDO = BORDA_ESQUERDA + 10;
const LADO_DIREITO = BORDA_ESQUERDA + LARGURA_DO_CARTAO - 10;

function forjarLargura(elemento: Element) {
  vi.spyOn(elemento, "getBoundingClientRect").mockReturnValue({
    left: BORDA_ESQUERDA,
    width: LARGURA_DO_CARTAO,
    right: BORDA_ESQUERDA + LARGURA_DO_CARTAO,
    top: 0,
    height: 300,
    bottom: 300,
    x: BORDA_ESQUERDA,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * `fireEvent.drop(el, { clientX })` NAO leva o `clientX`: o jsdom nao implementa
 * `DragEvent`, entao a testing-library cai num `Event` generico, que descarta
 * as propriedades de mouse. Sem isto, todo teste de "metade esquerda" media a
 * metade direita — e passaria com o defeito de volta no lugar.
 */
function soltarEm(elemento: Element, dataTransfer: unknown, clientX: number) {
  const evento = createEvent.drop(elemento, { dataTransfer });
  Object.defineProperty(evento, "clientX", { value: clientX });
  fireEvent(elemento, evento);
}

function arrastarSobre(elemento: Element, dataTransfer: unknown, clientX: number) {
  const evento = createEvent.dragOver(elemento, { dataTransfer });
  Object.defineProperty(evento, "clientX", { value: clientX });
  fireEvent(elemento, evento);
}

function livro(id: string, titulo: string): LivroNaEstante {
  return {
    livro: {
      id,
      pageId: "00000000-0000-0000-0000-000000000001",
      format: "pdf",
      contentHash: "sha-teste",
      fileName: `${id}.pdf`,
      originalFileName: "original.pdf",
      fileSize: 1024,
      coverFileName: null,
      metadataTitle: null,
      metadataAuthor: null,
      totalUnits: 100,
      hasTextLayer: true,
      // Índice fracionário — a estante inteira já tem `position` desde
      // que `lib/ipc.ts` ganhou o contrato desta peça; o valor exato não
      // importa aqui (`GradeDeLivros` decide ordem por ARRAY, não relendo
      // este campo — ver o comentário do componente), só precisa existir.
      position: "a0",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:00.000Z",
    },
    progresso: {
      bookId: id,
      currentLocator: "0",
      currentFraction: 0,
      furthestLocator: "0",
      furthestFraction: 0,
      status: "unread",
      lastReadAt: null,
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
    },
    titulo,
    autor: null,
  };
}

/**
 * `GradeDeLivros` lê `moverLivro` direto da store (mesmo padrão de
 * `LivroCard` lendo `categorias`/`atribuirCategorias`) — sobrescrever o
 * campo via `setState` isola o teste sem precisar mockar `lib/ipc.ts` e o
 * `Promise.all` de `load()` inteiro.
 */
describe("GradeDeLivros — reordenar", () => {
  let moverLivroMock: Mock<(livroId: string, aposLivroId: string | null) => Promise<void>>;

  beforeEach(() => {
    moverLivroMock = vi.fn(async (_livroId: string, _aposLivroId: string | null) => {});
    useBibliotecaStore.setState({ moverLivro: moverLivroMock });
  });

  it("teclado — 'mover para cima' no MEIO da lista chama moverLivro(id, vizinho-de-dois-acima): nunca o mouse é o único caminho", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    const c = livro("c", "Livro C");
    render(<GradeDeLivros livros={[a, b, c]} onAbrir={vi.fn()} onRemover={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mover Livro C para cima" }));

    expect(moverLivroMock).toHaveBeenCalledWith("c", "a");
  });

  it("teclado — 'mover para cima' no SEGUNDO item (só um vizinho acima) manda para o INÍCIO: aposLivroId `null`, não `undefined`", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mover Livro B para cima" }));

    expect(moverLivroMock).toHaveBeenCalledWith("b", null);
  });

  it("teclado — 'mover para baixo' chama moverLivro(id, vizinho-de-baixo): pousa logo depois dele", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mover Livro A para baixo" }));

    expect(moverLivroMock).toHaveBeenCalledWith("a", "b");
  });

  it("teclado — primeiro item: 'para cima' desabilitado; último item: 'para baixo' desabilitado", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Mover Livro A para cima" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover Livro B para baixo" })).toBeDisabled();
    // Os OUTROS dois — meio da lista de dois itens — continuam habilitados.
    expect(screen.getByRole("button", { name: "Mover Livro A para baixo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mover Livro B para cima" })).toBeEnabled();
  });

  // Mouse: exercita o MESMO handler (`handleDrop`) que um arraste de
  // verdade dispara — não é o gesto de mouse real (isso só se confere com o
  // app aberto, ver relatório da tarefa), mas prova que soltar sobre um
  // cartão chama `moverLivro` com o par certo, igual ao caminho de teclado.
  it("mouse — soltar um livro arrastado sobre outro chama moverLivro(arrastado, alvo)", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaA = screen.getByRole("button", { name: "Livro A" }).closest("li");
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    if (!linhaA || !linhaB) throw new Error("linha da grade (<li draggable>) não encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaA, { dataTransfer });
    forjarLargura(linhaB);
    arrastarSobre(linhaB, dataTransfer, LADO_DIREITO);
    soltarEm(linhaB, dataTransfer, LADO_DIREITO);

    expect(moverLivroMock).toHaveBeenCalledWith("a", "b");
  });

  // O relato do usuario, ao pe da letra: "se eu trocar o vermelho com azul ele
  // nao deixa mas se eu tentar trocar o azul e o vermelho ele deixa".
  //
  // Nao era recusa: soltar sobre um cartao significava SEMPRE "pousa logo
  // depois dele". Arrastar o SEGUNDO sobre o PRIMEIRO pedia "poe o segundo
  // depois do primeiro" — exatamente onde ele ja estava. O backend nao mudava
  // nada, a tela nao mexia, e o gesto parecia rejeitado. Metade dos arrastes
  // de um par eram inuteis por construcao.
  it("arrastar o SEGUNDO sobre a metade ESQUERDA do primeiro o poe em primeiro (o gesto que parecia recusado)", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaA = screen.getByRole("button", { name: "Livro A" }).closest("li");
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    if (!linhaA || !linhaB) throw new Error("linha da grade (<li draggable>) nao encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaB, { dataTransfer });
    forjarLargura(linhaA);
    soltarEm(linhaA, dataTransfer, LADO_ESQUERDO);

    // `null` = primeiro lugar. Antes disto, este gesto chamava
    // `moverLivro("b", "a")` — "b depois de a", que ja era a ordem.
    expect(moverLivroMock).toHaveBeenCalledWith("b", null);
  });

  it("soltar na metade DIREITA de um cartao pousa depois dele", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    const c = livro("c", "Livro C");
    render(<GradeDeLivros livros={[a, b, c]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    const linhaC = screen.getByRole("button", { name: "Livro C" }).closest("li");
    if (!linhaB || !linhaC) throw new Error("linha da grade (<li draggable>) nao encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaC, { dataTransfer });
    forjarLargura(linhaB);
    soltarEm(linhaB, dataTransfer, LADO_DIREITO);

    expect(moverLivroMock).toHaveBeenCalledWith("c", "b");
  });

  it("soltar na metade ESQUERDA de um cartao do meio pousa depois do vizinho anterior", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    const c = livro("c", "Livro C");
    render(<GradeDeLivros livros={[a, b, c]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    const linhaC = screen.getByRole("button", { name: "Livro C" }).closest("li");
    if (!linhaB || !linhaC) throw new Error("linha da grade (<li draggable>) nao encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaC, { dataTransfer });
    forjarLargura(linhaB);
    soltarEm(linhaB, dataTransfer, LADO_ESQUERDO);

    // Antes de "b" e o mesmo que depois de "a".
    expect(moverLivroMock).toHaveBeenCalledWith("c", "a");
  });

  it("soltar onde o livro ja esta nao chama o backend (pedido sem efeito, nao recusa)", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaA = screen.getByRole("button", { name: "Livro A" }).closest("li");
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    if (!linhaA || !linhaB) throw new Error("linha da grade (<li draggable>) nao encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaA, { dataTransfer });
    forjarLargura(linhaB);
    // Metade esquerda de "b" = depois de "a" = onde "a" ja esta.
    soltarEm(linhaB, dataTransfer, LADO_ESQUERDO);

    expect(moverLivroMock).not.toHaveBeenCalled();
  });

  it("mouse — soltar sobre SI MESMO não chama moverLivro (arrastar sem mover não tem efeito)", () => {
    const a = livro("a", "Livro A");
    render(<GradeDeLivros livros={[a]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaA = screen.getByRole("button", { name: "Livro A" }).closest("li");
    if (!linhaA) throw new Error("linha da grade (<li draggable>) não encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(linhaA, { dataTransfer });
    fireEvent.drop(linhaA, { dataTransfer });

    expect(moverLivroMock).not.toHaveBeenCalled();
  });

  // O sintoma que o usuario relatou: "nao da para trocar, fica o sinal de
  // negacao". No HTML5, o alvo so aceita um drop se o handler de
  // `dragover`/`dragenter` chamar `preventDefault()`; sem isso o navegador
  // desenha o cursor de proibido e o `drop` nunca acontece.
  //
  // O guarda ficava ANTES do `preventDefault`, e lia `arrastandoId` — estado
  // do React escrito em `dragstart`. Os primeiros eventos chegam antes de o
  // React re-renderizar, entao o guarda lia `null` e saia sem autorizar: o
  // gesto nascia proibido. Este teste simula exatamente essa janela, com um
  // `dragover` que chega SEM `dragstart` anterior.
  it("dragover autoriza o drop mesmo antes de o estado do arraste existir (o sinal de proibido)", () => {
    const a = livro("a", "Livro A");
    const b = livro("b", "Livro B");
    render(<GradeDeLivros livros={[a, b]} onAbrir={vi.fn()} onRemover={vi.fn()} />);
    const linhaB = screen.getByRole("button", { name: "Livro B" }).closest("li");
    if (!linhaB) throw new Error("linha da grade (<li draggable>) nao encontrada");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    // `fireEvent` devolve `false` quando o handler chamou `preventDefault()`.
    const naoAutorizou = fireEvent.dragOver(linhaB, { dataTransfer });
    expect(naoAutorizou, "dragover PRECISA chamar preventDefault, senao o cursor vira o sinal de proibido").toBe(false);

    const entradaNaoAutorizou = fireEvent.dragEnter(linhaB, { dataTransfer });
    expect(entradaNaoAutorizou, "dragenter tambem: alguns navegadores decidem na entrada").toBe(false);
  });

});
