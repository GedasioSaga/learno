import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { criarNotaComOrigem } from "../../cartoes/criar-nota-com-origem";
import { useCartoesStore } from "../../cartoes/store";
import { buildChildrenIndex } from "../../cartoes/tree-utils";
import {
  abrirLivro,
  coletarPalavra,
  criarAnotacao,
  definirMarcacaoDaPalavra,
  listarAnotacoes,
  listarPalavrasDoLivro,
  listarPaginasDoLivro,
  registrarProgresso,
  type Anotacao,
  type DeckRow,
  type Livro,
  type LivroAberto,
  type NoteRow,
  type NoteTypeRow,
  type PalavraColetada,
  type ProgressoDeLeitura,
} from "../../../lib/ipc";
import { useBibliotecaStore } from "../store";
import type { NavegacaoDoLeitor, PropsDoLeitorDeFormato } from "./tipos";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    abrirLivro: vi.fn(),
    registrarProgresso: vi.fn(),
    listarAnotacoes: vi.fn(),
    criarAnotacao: vi.fn(),
    // `PainelDePaginas`/`PainelDeVocabulario` (montados nesta rodada) buscam
    // sozinhos ao abrir — sem mock aqui, cada um chamaria o `invoke` real do
    // `@tauri-apps/api/core` mockado logo abaixo (que nem exporta `invoke`) e
    // cairia em erro, escondendo a lista atrás de uma mensagem de erro em vez
    // do conteúdo que os testes desta rodada verificam.
    listarPaginasDoLivro: vi.fn(),
    criarPaginaDeLivro: vi.fn(),
    renomearPaginaDeLivro: vi.fn(),
    escreverConteudoDaPagina: vi.fn(),
    moverPaginaDeLivro: vi.fn(),
    removerPaginaDeLivro: vi.fn(),
    listarPalavrasDoLivro: vi.fn(),
    coletarPalavra: vi.fn(),
    atualizarPalavra: vi.fn(),
    definirMarcacaoDaPalavra: vi.fn(),
    removerPalavra: vi.fn(),
  };
});

vi.mock("../../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

/**
 * Substitui `LeitorPdf` de verdade por um controle de teste: expõe o mesmo
 * `NavegacaoDoLeitor` no `ref` (é isto que prova que a casca sabe acionar
 * teclado/botões através do formato certo) e vira botões simples os três
 * callbacks que só a casca deveria reagir a — sem tocar em `pdfjs-dist`, que
 * é exatamente o que `LeitorPdf.test.tsx` já cobre sozinho.
 */
function LeitorPdfStub({
  ref,
  fonte,
  locatorInicial,
  hasTextLayer,
  onVirarPagina,
  onSelecaoDeTexto,
  onErro,
  termosMarcados,
}: PropsDoLeitorDeFormato) {
  useImperativeHandle(
    ref,
    (): NavegacaoDoLeitor => ({
      proximo: () => onVirarPagina({ locator: "2", fraction: 0.2 }),
      anterior: () => onVirarPagina({ locator: "0", fraction: 0 }),
      irParaLocator: (locator) => {
        const pagina = Number.parseInt(locator, 10);
        onVirarPagina({ locator: String(pagina), fraction: pagina / 10 });
      },
      aumentarZoom: () => {},
      diminuirZoom: () => {},
      limparSelecao: () => {},
    }),
  );

  return (
    <div data-testid="leitor-pdf-stub">
      <span data-testid="fonte">{fonte}</span>
      <span data-testid="termos-marcados">{termosMarcados.join("|")}</span>
      <span data-testid="locator-inicial">{locatorInicial ?? "nenhum"}</span>
      <span data-testid="has-text-layer">{String(hasTextLayer)}</span>
      <button type="button" onClick={() => onErro("o formato não conseguiu abrir a página")}>
        simular-erro-de-formato
      </button>
      <button
        type="button"
        onClick={() => onSelecaoDeTexto({ locatorStart: "3", locatorEnd: "3", fraction: 0.3, excerpt: "trecho selecionado" })}
      >
        simular-selecao
      </button>
      <button type="button" onClick={() => onSelecaoDeTexto(null)}>
        limpar-selecao
      </button>
    </div>
  );
}

vi.mock("./pdf/LeitorPdf", () => ({ LeitorPdf: LeitorPdfStub }));

/**
 * Mesmo espírito de `LeitorPdfStub`: prova que a casca roteia o formato
 * "epub" para este componente e aciona o `NavegacaoDoLeitor` certo — sem
 * puxar `epubjs` de verdade para dentro deste arquivo, que é exatamente o
 * que `epub/LeitorEpub.test.tsx` cobre sozinho.
 */
function LeitorEpubStub({
  ref,
  fonte,
  locatorInicial,
  hasTextLayer,
  onVirarPagina,
  onSelecaoDeTexto,
  onErro,
  termosMarcados,
}: PropsDoLeitorDeFormato) {
  useImperativeHandle(
    ref,
    (): NavegacaoDoLeitor => ({
      proximo: () => onVirarPagina({ locator: "epubcfi(/6/4!/4/2:5)", fraction: 0.5 }),
      anterior: () => onVirarPagina({ locator: "epubcfi(/6/2!/4/2:0)", fraction: 0 }),
      irParaLocator: (locator) => onVirarPagina({ locator, fraction: 0.6 }),
      aumentarZoom: () => {},
      diminuirZoom: () => {},
      limparSelecao: () => {},
    }),
  );

  return (
    <div data-testid="leitor-epub-stub">
      <span data-testid="fonte">{fonte}</span>
      <span data-testid="termos-marcados">{termosMarcados.join("|")}</span>
      <span data-testid="locator-inicial">{locatorInicial ?? "nenhum"}</span>
      <span data-testid="has-text-layer">{String(hasTextLayer)}</span>
      <button type="button" onClick={() => onErro("o formato não conseguiu abrir o epub")}>
        simular-erro-de-formato-epub
      </button>
      <button
        type="button"
        onClick={() =>
          onSelecaoDeTexto({ locatorStart: "epubcfi(/6/4!/4/2,/2/1:0,/4/2:9)", locatorEnd: null, fraction: 0.42, excerpt: "trecho do epub" })
        }
      >
        simular-selecao-epub
      </button>
    </div>
  );
}

vi.mock("./epub/LeitorEpub", () => ({ LeitorEpub: LeitorEpubStub }));

const { LeitorDeLivro } = await import("./LeitorDeLivro");

const abrirLivroMock = vi.mocked(abrirLivro);
const registrarProgressoMock = vi.mocked(registrarProgresso);
const listarAnotacoesMock = vi.mocked(listarAnotacoes);
const criarAnotacaoMock = vi.mocked(criarAnotacao);
const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);
const listarPaginasDoLivroMock = vi.mocked(listarPaginasDoLivro);
const listarPalavrasDoLivroMock = vi.mocked(listarPalavrasDoLivro);
const coletarPalavraMock = vi.mocked(coletarPalavra);
const definirMarcacaoDaPalavraMock = vi.mocked(definirMarcacaoDaPalavra);

/** Mesmo baralho/tipo de nota mínimo usado por `CriarCartaoDeOrigem.test.tsx` — o formulário exige os dois para não cair no aviso "crie um baralho". */
function deckFixture(overrides: Partial<DeckRow> & Pick<DeckRow, "id">): DeckRow {
  return {
    parentId: null,
    name: "",
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const TIPO_BASICO: NoteTypeRow = {
  id: "tipo-1",
  name: "Básico",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{Verso}}" }],
  kind: "standard",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function noteRowFixture(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-1",
    deckId: "ingles",
    fieldValues: { Frente: "trecho selecionado", Verso: "Verso do cartão" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: "trecho selecionado",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const PROGRESSO_PADRAO: ProgressoDeLeitura = {
  bookId: "livro-1",
  currentLocator: "4",
  currentFraction: 0.4,
  furthestLocator: "4",
  furthestFraction: 0.4,
  status: "reading",
  lastReadAt: "2026-09-01T00:00:00.000Z",
  finishedAt: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function livroFixture(overrides: Partial<Livro> = {}): Livro {
  return {
    id: "livro-1",
    pageId: "pagina-1",
    format: "pdf",
    contentHash: "hash",
    fileName: "livro-1.pdf",
    originalFileName: "Meu Livro.pdf",
    fileSize: 1024,
    coverFileName: null,
    metadataTitle: "Meu Livro",
    metadataAuthor: "Autora Teste",
    totalUnits: 10,
    hasTextLayer: true,
    // `position` (ordem da estante): contrato chegou em `lib/ipc.ts` depois
    // desta suíte existir — fixture fora do escopo da peça que adicionou o
    // campo (GRADE DE LIVROS), só corrigido aqui para o `tsc --noEmit` do
    // projeto voltar a fechar.
    position: "a0",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function palavraFixture(overrides: Partial<PalavraColetada> = {}): PalavraColetada {
  return {
    id: "palavra-1",
    bookId: "livro-1",
    term: "trecho selecionado",
    contextSnippet: "trecho selecionado",
    note: null,
    synonyms: [],
    antonyms: [],
    highlightInBook: true,
    locator: "3",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function livroAbertoFixture(overrides: Partial<LivroAberto> = {}): LivroAberto {
  return {
    livro: livroFixture(),
    progresso: PROGRESSO_PADRAO,
    caminhoAbsoluto: "C:\\dados\\media\\livro-1.pdf",
    ...overrides,
  };
}

function anotacaoFixture(overrides: Partial<Anotacao> = {}): Anotacao {
  return {
    id: "anotacao-1",
    bookId: "livro-1",
    kind: "highlight",
    locatorStart: "7",
    locatorEnd: "7",
    fraction: 0.7,
    excerpt: "um trecho grifado",
    note: null,
    color: "amber",
    blockId: null,
    noteId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listarAnotacoesMock.mockResolvedValue([]);
  listarPaginasDoLivroMock.mockResolvedValue([]);
  listarPalavrasDoLivroMock.mockResolvedValue([]);
  useBibliotecaStore.setState({
    status: "idle",
    errorMessage: null,
    livros: [],
    filtro: "todos",
    tela: "estante",
    livroSelecionadoId: null,
    importando: false,
  });
  // Estado mínimo para `CriarCartaoDeOrigem` (formulário compartilhado que
  // "criar cartão a partir de um trecho" abre) não cair no aviso "crie um
  // baralho antes" nos testes deste arquivo.
  const ingles = deckFixture({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
  });
});

describe("abertura do livro", () => {
  it("abre o livro e mostra o título no cabeçalho", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Meu Livro" })).toBeInTheDocument();
    expect(abrirLivroMock).toHaveBeenCalledWith("livro-1");
  });

  it("passa o currentLocator do progresso recebido para o formato — reabre onde parou", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture({ progresso: { ...PROGRESSO_PADRAO, currentLocator: "42" } }));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByTestId("locator-inicial")).toHaveTextContent("42");
  });

  it("campos opcionais ausentes (metadataTitle e currentLocator nulos — livro sem metadado, nunca aberto) não quebram: título cai para originalFileName, locator inicial vira 'nenhum'", async () => {
    abrirLivroMock.mockResolvedValue(
      livroAbertoFixture({
        livro: livroFixture({ metadataTitle: null, originalFileName: "arquivo-sem-titulo.pdf" }),
        progresso: { ...PROGRESSO_PADRAO, currentLocator: null, currentFraction: 0 },
      }),
    );

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "arquivo-sem-titulo.pdf" })).toBeInTheDocument();
    expect(await screen.findByTestId("locator-inicial")).toHaveTextContent("nenhum");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("erro ao abrir vira uma mensagem visível (role=alert), nunca tela branca", async () => {
    abrirLivroMock.mockRejectedValue(new Error("disco não encontrado"));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível abrir este livro.");
    expect(screen.queryByTestId("leitor-pdf-stub")).not.toBeInTheDocument();
  });

  it("'Voltar para a estante' chama onVoltar", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    const onVoltar = vi.fn();
    render(<LeitorDeLivro livroId="livro-1" onVoltar={onVoltar} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByRole("button", { name: /Voltar para a estante/ }));

    expect(onVoltar).toHaveBeenCalledTimes(1);
  });

  it("formato epub monta o LeitorEpub (fase 2), nunca o LeitorPdf", async () => {
    abrirLivroMock.mockResolvedValue(
      livroAbertoFixture({
        livro: livroFixture({ format: "epub" }),
        progresso: { ...PROGRESSO_PADRAO, currentLocator: "epubcfi(/6/4!/4/2:0)" },
      }),
    );

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByTestId("leitor-epub-stub")).toBeInTheDocument();
    expect(screen.getByTestId("locator-inicial")).toHaveTextContent("epubcfi(/6/4!/4/2:0)");
    expect(screen.queryByTestId("leitor-pdf-stub")).not.toBeInTheDocument();
  });

  it("clicar numa anotação de EPUB chama irParaLocator com o CFI salvo (não um número de página)", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture({ livro: livroFixture({ format: "epub" }) }));
    listarAnotacoesMock.mockResolvedValue([
      anotacaoFixture({ locatorStart: "epubcfi(/6/8!/4/2:12)", locatorEnd: null, excerpt: "trecho no capítulo 3" }),
    ]);
    registrarProgressoMock.mockResolvedValue(PROGRESSO_PADRAO);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByText("trecho no capítulo 3", { exact: false });

    fireEvent.click(screen.getByText("trecho no capítulo 3", { exact: false }));

    await waitFor(() =>
      expect(registrarProgressoMock).toHaveBeenCalledWith("livro-1", "epubcfi(/6/8!/4/2:12)", 0.6),
    );
  });
});

describe("barra de progresso", () => {
  it("usa a fração de abertura (currentFraction) antes de qualquer virada", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture({ progresso: { ...PROGRESSO_PADRAO, currentFraction: 0.4 } }));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    const barra = await screen.findByRole("progressbar", { name: /Progresso de leitura de Meu Livro/ });
    expect(barra).toHaveValue(40);
    expect(screen.getByText("40%")).toBeInTheDocument();
  });
});

describe("virar página", () => {
  it("clicar em 'Próxima página' aciona o formato, grava progresso e atualiza a barra", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    registrarProgressoMock.mockResolvedValue({ ...PROGRESSO_PADRAO, currentLocator: "2", currentFraction: 0.2 });

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));

    expect(registrarProgressoMock).toHaveBeenCalledWith("livro-1", "2", 0.2);
    expect(await screen.findByText("20%")).toBeInTheDocument();
  });

  it("atualiza a store da estante (atualizarProgressoNaEstante) para o card não ficar com a barra velha", async () => {
    useBibliotecaStore.setState({
      livros: [{ livro: livroFixture(), progresso: PROGRESSO_PADRAO, titulo: "Meu Livro", autor: "Autora Teste" }],
    });
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    const progressoNovo: ProgressoDeLeitura = { ...PROGRESSO_PADRAO, currentLocator: "2", currentFraction: 0.2, furthestFraction: 0.4 };
    registrarProgressoMock.mockResolvedValue(progressoNovo);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");
    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));

    await waitFor(() => expect(useBibliotecaStore.getState().livros[0].progresso).toEqual(progressoNovo));
  });

  it("setas de teclado viram página (ArrowRight -> próximo, ArrowLeft -> anterior)", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    registrarProgressoMock.mockResolvedValue(PROGRESSO_PADRAO);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(registrarProgressoMock).toHaveBeenCalledWith("livro-1", "2", 0.2);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(registrarProgressoMock).toHaveBeenCalledWith("livro-1", "0", 0);

    fireEvent.keyDown(window, { key: "PageDown" });
    expect(registrarProgressoMock).toHaveBeenCalledTimes(3);
  });

  it("setas de teclado são ignoradas quando o foco está num campo de texto", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    const campoDeNota = document.createElement("input");
    document.body.appendChild(campoDeNota);
    campoDeNota.focus();

    fireEvent.keyDown(campoDeNota, { key: "ArrowRight" });

    expect(registrarProgressoMock).not.toHaveBeenCalled();
    document.body.removeChild(campoDeNota);
  });

  it("erro ao gravar progresso mostra um aviso visível SEM esconder o leitor (não é um erro de abertura)", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    registrarProgressoMock.mockRejectedValue(new Error("banco ocupado"));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");
    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar seu progresso agora.");
    expect(screen.getByTestId("leitor-pdf-stub")).toBeInTheDocument();
  });
});

describe("erro do formato (ex.: getDocument falhou)", () => {
  it("substitui a área de leitura por uma mensagem, e ESCONDE o leitor (não há página para desenhar por baixo)", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-erro-de-formato"));

    expect(await screen.findByRole("alert")).toHaveTextContent("o formato não conseguiu abrir a página");
    expect(screen.queryByTestId("leitor-pdf-stub")).not.toBeInTheDocument();
  });
});

// Esta rodada troca `PainelDeResumos` (lista automática de capítulos) por
// `PainelDePaginas` (páginas que o usuário cria) na mesma barra lateral. O
// pedido foi explícito: "ainda deixe a parte de anotações" — este bloco prova
// que a troca não desmontou nem quebrou `PainelDeAnotacoes`, que continua ao
// lado de `PainelDePaginas` na mesma árvore. A cobertura funcional de cada
// painel por si (listar, criar, editar, erro) já vive nos testes deles
// próprios (`PainelDeAnotacoes` é exercitado nos blocos "anotações" logo
// abaixo; `PainelDePaginas.test.tsx` cobre o painel novo).
describe("painéis da barra lateral coexistem depois da troca de PainelDeResumos por PainelDePaginas", () => {
  it("anotações e páginas aparecem juntas, cada uma dirigida pelo próprio estado", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    listarAnotacoesMock.mockResolvedValue([anotacaoFixture({ locatorStart: "7", excerpt: "trecho grifado" })]);
    listarPaginasDoLivroMock.mockResolvedValue([]);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByText("trecho grifado", { exact: false })).toBeInTheDocument();
    expect(
      await screen.findByText("Nenhuma página ainda. Crie uma para escrever o que quiser sobre este livro."),
    ).toBeInTheDocument();
  });
});

describe("anotações", () => {
  it("lista as anotações existentes e clicar numa delas pula para o locator certo", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    listarAnotacoesMock.mockResolvedValue([anotacaoFixture({ locatorStart: "7", excerpt: "trecho da página 7" })]);
    registrarProgressoMock.mockResolvedValue(PROGRESSO_PADRAO);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    // A lista envolve o excerto em aspas curvas (“…”) na própria célula de
    // texto — `exact: false` casa a substring sem precisar repetir o glifo.
    await screen.findByText("trecho da página 7", { exact: false });

    fireEvent.click(screen.getByText("trecho da página 7", { exact: false }));

    // `irParaLocator("7")` no stub chama `onVirarPagina({ locator: "7", fraction: 0.7 })`.
    await waitFor(() => expect(registrarProgressoMock).toHaveBeenCalledWith("livro-1", "7", 0.7));
  });

  it("erro ao carregar anotações mostra mensagem, sem quebrar o resto do leitor", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    listarAnotacoesMock.mockRejectedValue(new Error("timeout"));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);

    expect(await screen.findByText("Não foi possível carregar as anotações.")).toBeInTheDocument();
    expect(await screen.findByTestId("leitor-pdf-stub")).toBeInTheDocument();
  });

  it("selecionar um trecho abre o formulário de destaque; salvar chama criarAnotacao e insere no topo da lista", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    const novaAnotacao = anotacaoFixture({ id: "nova", excerpt: "trecho selecionado" });
    criarAnotacaoMock.mockResolvedValue(novaAnotacao);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));
    expect(await screen.findByText("Novo destaque")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar destaque" }));

    await waitFor(() =>
      expect(criarAnotacaoMock).toHaveBeenCalledWith({
        livroId: "livro-1",
        kind: "highlight",
        locatorStart: "3",
        locatorEnd: "3",
        fraction: 0.3,
        excerpt: "trecho selecionado",
        note: null,
        color: "amber",
      }),
    );
    expect(await screen.findByText("“trecho selecionado”")).toBeInTheDocument();
  });

  it("cancelar o formulário de destaque fecha sem chamar criarAnotacao", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));
    await screen.findByText("Novo destaque");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByText("Novo destaque")).not.toBeInTheDocument();
    expect(criarAnotacaoMock).not.toHaveBeenCalled();
  });

  it("o formato limpando a seleção (onSelecaoDeTexto(null)) fecha o formulário sozinho", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));
    await screen.findByText("Novo destaque");
    act(() => fireEvent.click(screen.getByText("limpar-selecao")));

    expect(screen.queryByText("Novo destaque")).not.toBeInTheDocument();
  });
});

describe("criar cartão a partir de um trecho selecionado (a terceira origem)", () => {
  it("sem seleção a ação não aparece; com um trecho selecionado, 'Criar cartão' aparece", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("simular-selecao"));

    expect(await screen.findByRole("button", { name: "Criar cartão" })).toBeInTheDocument();
  });

  it("cria o cartão com o TRECHO certo e sem bloco de origem (um trecho de livro não é um bloco)", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    criarNotaComOrigemMock.mockResolvedValue(noteRowFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarCartaoDeOrigem não montou");

    // A frente já vem preenchida com o trecho selecionado, exatamente como
    // a origem do editor e a do mapa mental fazem.
    expect(await screen.findByLabelText("Frente")).toHaveValue("trecho selecionado");
    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Verso do cartão" } });
    // `within(dialog)`: o botão "Criar cartão" da barra lateral que abriu o
    // formulário continua montado (a seleção não mudou) — sem escopo, a
    // consulta por papel/nome seria ambígua com o botão de submit do diálogo.
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cartão", hidden: true }));

    // Argumentos, não só a ocorrência: o trecho certo na frente E como texto
    // congelado, e `sourceBlockId` nulo — nunca um id de bloco inventado.
    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "trecho selecionado", Verso: "Verso do cartão" },
        [],
        null,
        "trecho selecionado",
      ),
    );
  });

  /**
   * O MESMO fluxo, pelo mecanismo do EPUB — e a razao de existir e concreta.
   *
   * pdfjs e epub.js selecionam texto de jeitos genuinamente diferentes: o
   * primeiro escuta `selectionchange` no documento da propria pagina, o
   * segundo escuta `rendition.on("selected")` DENTRO do iframe do epub.js,
   * com debounce da propria biblioteca. A casca (`aoSelecionarTexto`) e
   * agnostica de formato por contrato — mas contrato garante que os tipos
   * casam, nao que a integracao funciona.
   *
   * Um revisor notou que o stub do EPUB tinha um botao de simular selecao que
   * NENHUM teste clicava: os tres testes desta secao exercitavam so o PDF. A
   * cobertura parecia completa e cobria metade.
   */
  it("a mesma criação funciona pelo caminho do EPUB, com o CFI como posição e o rótulo certo", async () => {
    abrirLivroMock.mockResolvedValue(
      livroAbertoFixture({
        livro: livroFixture({ format: "epub" }),
        progresso: { ...PROGRESSO_PADRAO, currentLocator: "epubcfi(/6/4!/4/2:0)" },
      }),
    );
    criarNotaComOrigemMock.mockResolvedValue(noteRowFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-epub-stub");

    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("simular-selecao-epub"));

    expect(await screen.findByRole("button", { name: "Criar cartão" })).toBeInTheDocument();

    // "Posição", nunca "Página": o EPUB endereça por CFI, e chamar isso de
    // página seria inventar uma unidade que o formato não tem.
    expect(screen.getByText(/Posição/)).toBeInTheDocument();
    expect(screen.queryByText(/Página/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarCartaoDeOrigem não montou");

    expect(await screen.findByLabelText("Frente")).toHaveValue("trecho do epub");
    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Verso vindo do epub" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "trecho do epub", Verso: "Verso vindo do epub" },
        [],
        null,
        "trecho do epub",
      ),
    );
  });

  it("mostra a procedência (título do livro e posição) como TEXTO simples — nunca um link ou botão 'ir para a origem'", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));

    // `simular-selecao` do stub usa locatorStart "3" (ver `LeitorPdfStub` no
    // topo deste arquivo) e o livro se chama "Meu Livro" (`livroFixture`).
    const procedencia = await screen.findByText("de: Meu Livro — Página 3");
    expect(procedencia.tagName).toBe("P");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ir para a origem/i })).not.toBeInTheDocument();
  });

  it("criar o cartão não perde a posição de leitura — o usuário continua na mesma página depois", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    registrarProgressoMock.mockResolvedValue({ ...PROGRESSO_PADRAO, currentLocator: "2", currentFraction: 0.2 });
    criarNotaComOrigemMock.mockResolvedValue(noteRowFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    expect(await screen.findByText("20%")).toBeInTheDocument();
    expect(registrarProgressoMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("simular-selecao"));
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));
    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarCartaoDeOrigem não montou");
    fireEvent.change(await screen.findByLabelText("Verso"), { target: { value: "Verso" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() => expect(criarNotaComOrigemMock).toHaveBeenCalled());
    // Nem a página (20%) nem o número de chamadas de `registrarProgresso`
    // mudam por causa da criação do cartão — nenhuma navegação aconteceu.
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(registrarProgressoMock).toHaveBeenCalledTimes(1);
  });
});

// O defeito que esta rodada existe para corrigir originalmente: `PainelDeResumos`
// (hoje `PainelDePaginas`) e `PainelDeVocabulario` já existiam prontos e
// testados, mas ninguém os montava no leitor. Este bloco prova que
// `PainelDeVocabulario` está alcançável — não repete a cobertura interna de
// cada painel (`PainelDePaginas.test.tsx`, `PainelDeVocabulario.test.tsx`),
// só a FIAÇÃO: o dado certo do formato certo chega no painel certo.
//
// O equivalente para `PainelDePaginas` some daqui: o painel não recebe mais
// nada do formato (nem `capitulos`, nem `capituloAtual` — ver ponto 6 do
// pedido desta rodada), só `livroId`; não há fiação de dado a testar aqui,
// só a montagem, coberta abaixo em "painéis da barra lateral".
describe("seleção de texto chega em PainelDeVocabulario", () => {
  it("selecionar um trecho alimenta o painel com termo, contexto E locator — os três", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    coletarPalavraMock.mockResolvedValue(palavraFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(screen.getByText("simular-selecao"));
    // `simular-selecao` usa excerpt "trecho selecionado" e locatorStart "3"
    // (ver `LeitorPdfStub` no topo deste arquivo) — reusar a MESMA captura
    // que já abre "Novo destaque", nunca uma segunda.
    const botaoColher = await screen.findByRole("button", { name: "Colher palavra" });
    fireEvent.click(botaoColher);

    await waitFor(() =>
      expect(coletarPalavraMock).toHaveBeenCalledWith("livro-1", "trecho selecionado", "trecho selecionado", null, [], [], "3"),
    );
  });

  it("sem seleção, o painel lista o que já foi colhido — nunca o formulário de coleta", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture({ term: "palavra antiga" })]);

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    // Dentro da lista: o stub do leitor também escreve "palavra antiga" (é um termo marcado).
    const lista = await screen.findByRole("list", { name: "Palavras colhidas" });
    expect(within(lista).getByText("palavra antiga")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Colher palavra" })).not.toBeInTheDocument();
  });
});

// A lista do vocabulário subiu para a casca: o leitor de formato precisa dela
// para sublinhar as palavras no livro, e isso não pode depender do que o
// painel está mostrando. Este bloco prova a fiação nos dois sentidos.
describe("palavras marcadas chegam ao leitor do formato", () => {
  const PALAVRAS = [
    palavraFixture({ id: "p-voraz", term: "voraz", highlightInBook: true }),
    palavraFixture({ id: "p-austera", term: "austera", highlightInBook: false }),
    palavraFixture({ id: "p-leu", term: "ao léu", highlightInBook: true }),
  ];

  it("o leitor recebe só os termos com o marcador ligado — PDF e EPUB", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue(PALAVRAS);
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());

    const { unmount } = render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");
    await waitFor(() => expect(screen.getByTestId("termos-marcados")).toHaveTextContent("voraz|ao léu"));
    unmount();

    abrirLivroMock.mockResolvedValue(livroAbertoFixture({ livro: livroFixture({ format: "epub" }) }));
    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-epub-stub");
    await waitFor(() => expect(screen.getByTestId("termos-marcados")).toHaveTextContent("voraz|ao léu"));
  });

  it("com uma seleção ativa o painel troca a lista pelo formulário de colher, e os termos marcados continuam no leitor", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue(PALAVRAS);
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");
    await waitFor(() => expect(screen.getByTestId("termos-marcados")).toHaveTextContent("voraz|ao léu"));

    fireEvent.click(screen.getByText("simular-selecao"));

    expect(await screen.findByRole("button", { name: "Colher palavra" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Palavras colhidas" })).not.toBeInTheDocument();
    expect(screen.getByTestId("termos-marcados")).toHaveTextContent("voraz|ao léu");
  });

  it("desligar o marcador no painel tira a palavra do leitor na hora, sem recarregar a lista", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue(PALAVRAS);
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    definirMarcacaoDaPalavraMock.mockResolvedValue(palavraFixture({ id: "p-voraz", term: "voraz", highlightInBook: false }));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    fireEvent.click(await screen.findByRole("button", { name: "Marcar voraz no livro" }));

    expect(definirMarcacaoDaPalavraMock).toHaveBeenCalledWith("p-voraz", false);
    expect(screen.getByTestId("termos-marcados")).toHaveTextContent(/^ao léu$/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Marcar voraz no livro" })).toHaveAttribute("aria-pressed", "false"));
    expect(listarPalavrasDoLivroMock).toHaveBeenCalledTimes(1);
  });

  it("palavra colhida agora nasce marcada e já chega ao leitor", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([]);
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());
    coletarPalavraMock.mockResolvedValue(palavraFixture({ id: "p-nova", term: "trecho selecionado", highlightInBook: true }));

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");
    expect(screen.getByTestId("termos-marcados")).toHaveTextContent(/^$/);

    fireEvent.click(screen.getByText("simular-selecao"));
    fireEvent.click(await screen.findByRole("button", { name: "Colher palavra" }));

    await waitFor(() => expect(screen.getByTestId("termos-marcados")).toHaveTextContent("trecho selecionado"));
  });

  it("falha ao carregar as palavras: o leitor abre mesmo assim, sem nada marcado, e o painel mostra o erro", async () => {
    listarPalavrasDoLivroMock.mockRejectedValue(new Error("banco ocupado"));
    abrirLivroMock.mockResolvedValue(livroAbertoFixture());

    render(<LeitorDeLivro livroId="livro-1" onVoltar={vi.fn()} />);
    await screen.findByTestId("leitor-pdf-stub");

    expect(await screen.findByText("Não foi possível carregar as palavras colhidas.")).toBeInTheDocument();
    expect(screen.getByTestId("termos-marcados")).toHaveTextContent(/^$/);
  });
});
