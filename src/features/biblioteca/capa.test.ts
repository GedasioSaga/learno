import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LivroAberto } from "../../lib/ipc";

/**
 * `pdfjs-dist`/`epubjs` de verdade não rodam no jsdom (Web Worker real,
 * canvas 2D sem `canvas` nativo instalado, XHR de arquivo) — mesma razão de
 * `leitor/pdf/LeitorPdf.test.tsx` e `leitor/epub/LeitorEpub.test.tsx`
 * mockarem as duas libs inteiras. `storeMediaFile` é a exceção: ela roda de
 * verdade (fora do Tauri, mesmo modo de `media-storage.test.ts`), só
 * envolvida num `vi.fn` para poder inspecionar o valor que ela devolveu de
 * verdade e comparar com o argumento que chegou em `definirCapaDoLivro` —
 * "afirme o ARGUMENTO", não um valor forjado à parte.
 */
const getDocumentMock = vi.fn();
const EpubFactoryMock = vi.fn();
const abrirLivroMock = vi.fn();
const definirCapaDoLivroMock = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "worker-url-de-teste" }));
vi.mock("epubjs", () => ({ default: (...args: unknown[]) => EpubFactoryMock(...args) }));
// `isTauri: () => false` porque `storeMediaFile` roda de verdade neste
// arquivo: fora do Tauri ela guarda em memória em vez de escrever em disco
// (o mesmo modo de `media-storage.test.ts`), e ainda assim devolve o NOME
// derivado do hash — que é exatamente o valor que este teste compara com o
// argumento recebido por `definirCapaDoLivro`.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  isTauri: () => false,
}));

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    abrirLivro: (...args: [string]) => abrirLivroMock(...args),
    definirCapaDoLivro: (...args: [string, string | null]) => definirCapaDoLivroMock(...args),
  };
});

vi.mock("../editor/blocks/media/media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/blocks/media/media-storage")>();
  return { ...actual, storeMediaFile: vi.fn(actual.storeMediaFile) };
});

const { extrairCapaDoLivro, gerarCapaDoLivro } = await import("./capa");
const { storeMediaFile } = await import("../editor/blocks/media/media-storage");
const storeMediaFileMock = vi.mocked(storeMediaFile);

function livroAbertoFake(overrides: Partial<LivroAberto["livro"]> & { format: "pdf" | "epub" }): LivroAberto {
  return {
    livro: {
      id: "livro-1",
      pageId: "00000000-0000-0000-0000-000000000001",
      contentHash: "sha-teste",
      fileName: `livro-1.${overrides.format}`,
      originalFileName: `original.${overrides.format}`,
      fileSize: 1024,
      coverFileName: null,
      metadataTitle: null,
      metadataAuthor: null,
      totalUnits: 10,
      hasTextLayer: true,
      // `position` (ordem da estante): contrato chegou em `lib/ipc.ts`
      // depois desta suíte existir — fixture fora do escopo da peça que
      // adicionou o campo (GRADE DE LIVROS), só corrigido aqui para o
      // `tsc --noEmit` do projeto voltar a fechar.
      position: "a0",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:00.000Z",
      ...overrides,
    },
    progresso: {
      bookId: "livro-1",
      currentLocator: null,
      currentFraction: 0,
      furthestLocator: null,
      furthestFraction: 0,
      status: "unread",
      lastReadAt: null,
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
    },
    caminhoAbsoluto: `C:\\media\\livro-1.${overrides.format}`,
  };
}

/** Substitui `HTMLCanvasElement.prototype.toBlob` — o jsdom deste projeto não tem o pacote `canvas` nativo instalado, então o método real nunca chama o callback (ver `HTMLCanvasElement-impl.js` do jsdom: cai no ramo "not implemented" e para por aí). */
function stubCanvasToBlob(blob: Blob | null) {
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
    callback(blob);
  });
}

function paginaPdfFake({ falharAoRenderizar = false }: { falharAoRenderizar?: boolean } = {}) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale, scale }),
    render: () => ({
      promise: falharAoRenderizar ? Promise.reject(new Error("canvas explodiu")) : Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
}

function documentoPdfFake(opcoesPagina: { falharAoRenderizar?: boolean } = {}) {
  const pagina = paginaPdfFake(opcoesPagina);
  return { getPage: vi.fn(async () => pagina), destroy: vi.fn().mockResolvedValue(undefined) };
}

/**
 * `getDocument()` devolve uma TAREFA de carregamento, não o documento — e é a
 * tarefa que tem `destroy()` (o documento resolvido não tem, nesta versão do
 * pdfjs). O fixture precisa ter as duas coisas, senão o teste falha na
 * limpeza por uma diferença que só existe no dublê.
 */
function resolverGetDocumentCom(doc: ReturnType<typeof documentoPdfFake>) {
  getDocumentMock.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn().mockResolvedValue(undefined) });
}

interface BookFakeOptions {
  /** `false` simula `open()` falhando: `book.ready` nunca assenta (nem resolve nem rejeita — a armadilha verificada em `LeitorEpub.tsx`) e `"openFailed"` dispara assim que alguém escuta. */
  abreComSucesso?: boolean;
  coverUrl?: string | null;
}

function bookEpubFake({ abreComSucesso = true, coverUrl = null }: BookFakeOptions = {}) {
  return {
    ready: abreComSucesso ? Promise.resolve(undefined) : new Promise<void>(() => {}),
    once: (tipo: string, fn: () => void) => {
      // Dispara na hora: o extrator registra o listener e entra na corrida
      // `Promise.race` imediatamente depois — não precisa de um emissor de
      // eventos completo só para simular "a abertura já tinha falhado".
      if (tipo === "openFailed" && !abreComSucesso) fn();
    },
    coverUrl: vi.fn().mockResolvedValue(coverUrl),
    destroy: vi.fn(),
  };
}

/** Dublê de `Response` com só o que `capa.ts` usa — ver o comentário no teste da capa de EPUB. */
function respostaComBlob(blob: Blob) {
  return { ok: true, blob: () => Promise.resolve(blob) } as unknown as Response;
}

/**
 * O EPUB passa por DOIS `fetch`: o primeiro baixa o arquivo `.epub` inteiro
 * (`capa.ts` passa o `ArrayBuffer` para a lib em vez da URL, igual ao leitor),
 * e o segundo busca a `blob:` da capa que a lib devolve. Um dublê que responde
 * só uma vez faria o teste medir o passo errado.
 */
function fetchDeEpubEDepoisCapa(blobDaCapa: Blob | null) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("asset://")) return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as unknown as Response;
    if (!blobDaCapa) return { ok: false, status: 404 } as unknown as Response;
    return respostaComBlob(blobDaCapa);
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("extrairCapaDoLivro — PDF", () => {
  it("primeira página vira PNG", async () => {
    resolverGetDocumentCom(documentoPdfFake());
    stubCanvasToBlob(new Blob(["png-fake"], { type: "image/png" }));

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "pdf" }));

    expect(arquivo).not.toBeNull();
    expect(arquivo?.type).toBe("image/png");
  });

  it("getDocument rejeitando (arquivo corrompido) vira null, nunca lança", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.reject(new Error("pdf corrompido")),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "pdf" }));

    expect(arquivo).toBeNull();
  });

  it("falha ao renderizar a página vira null, nunca lança", async () => {
    resolverGetDocumentCom(documentoPdfFake({ falharAoRenderizar: true }));

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "pdf" }));

    expect(arquivo).toBeNull();
  });

  it("canvas que não exporta (toBlob devolve null) vira null, nunca lança", async () => {
    resolverGetDocumentCom(documentoPdfFake());
    stubCanvasToBlob(null);

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "pdf" }));

    expect(arquivo).toBeNull();
  });
});

describe("extrairCapaDoLivro — EPUB", () => {
  it("book.coverUrl() com capa vira arquivo buscado por fetch", async () => {
    EpubFactoryMock.mockReturnValue(bookEpubFake({ coverUrl: "blob:capa-do-epub" }));
    // Resposta mínima em vez de `new Response(blob)`: o `Blob` do jsdom não
    // tem `.stream()`, e o construtor de `Response` chama exatamente isso ao
    // montar o corpo. O código só usa `ok` e `blob()`, então é o que o dublê
    // precisa ter.
    const fetchDuplo = fetchDeEpubEDepoisCapa(new Blob(["jpeg-fake"], { type: "image/jpeg" }));
    vi.stubGlobal("fetch", fetchDuplo);

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "epub" }));

    expect(arquivo).not.toBeNull();
    expect(fetchDuplo).toHaveBeenCalledWith("blob:capa-do-epub");
    expect(EpubFactoryMock).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it("EPUB sem capa embutida (coverUrl null) vira null, nunca lança", async () => {
    EpubFactoryMock.mockReturnValue(bookEpubFake({ coverUrl: null }));
    const fetchDuplo = fetchDeEpubEDepoisCapa(null);
    vi.stubGlobal("fetch", fetchDuplo);

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "epub" }));

    expect(arquivo).toBeNull();
    // O arquivo `.epub` FOI buscado (é o primeiro passo agora); o que não
    // pode acontecer é um segundo `fetch` de capa que não existe.
    expect(fetchDuplo).toHaveBeenCalledTimes(1);
  });

  it("VERIFICADO EM LeitorEpub.tsx: open() falhando nunca faz book.ready assentar — só \"openFailed\" avisa, e isto vira null sem travar", async () => {
    EpubFactoryMock.mockReturnValue(bookEpubFake({ abreComSucesso: false }));
    vi.stubGlobal("fetch", fetchDeEpubEDepoisCapa(null));

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "epub" }));

    expect(arquivo).toBeNull();
  });

  it("fetch da capa falhando (resposta não-ok) vira null, nunca lança", async () => {
    EpubFactoryMock.mockReturnValue(bookEpubFake({ coverUrl: "blob:capa-quebrada" }));
    vi.stubGlobal("fetch", fetchDeEpubEDepoisCapa(null));

    const arquivo = await extrairCapaDoLivro(livroAbertoFake({ format: "epub" }));

    expect(arquivo).toBeNull();
  });
});

describe("gerarCapaDoLivro", () => {
  it("extração com sucesso: o NOME passado a definirCapaDoLivro é exatamente o que storeMediaFile devolveu", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFake({ format: "pdf" }));
    resolverGetDocumentCom(documentoPdfFake());
    stubCanvasToBlob(new Blob(["png-fake"], { type: "image/png" }));
    definirCapaDoLivroMock.mockResolvedValue(undefined);

    const resultado = await gerarCapaDoLivro("livro-1");

    expect(storeMediaFileMock).toHaveBeenCalledTimes(1);
    const armazenada = await storeMediaFileMock.mock.results[0].value;
    expect(definirCapaDoLivroMock).toHaveBeenCalledWith("livro-1", armazenada.src);
    expect(resultado).toBe(armazenada.src);
  });

  it("extração que falha (getDocument rejeita) devolve null e NUNCA chama storeMediaFile nem definirCapaDoLivro — o livro já está na estante e continua lá", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFake({ format: "pdf" }));
    getDocumentMock.mockReturnValue({
      promise: Promise.reject(new Error("pdf corrompido")),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const resultado = await gerarCapaDoLivro("livro-1");

    expect(resultado).toBeNull();
    expect(storeMediaFileMock).not.toHaveBeenCalled();
    expect(definirCapaDoLivroMock).not.toHaveBeenCalled();
  });

  it("abrirLivro rejeitando (arquivo sumiu de media/) devolve null, nunca lança", async () => {
    abrirLivroMock.mockRejectedValue(new Error("arquivo não está mais na pasta de mídia"));

    await expect(gerarCapaDoLivro("livro-1")).resolves.toBeNull();
  });

  it("definirCapaDoLivro rejeitando (erro do backend) devolve null, nunca lança — a capa é um extra, não um requisito", async () => {
    abrirLivroMock.mockResolvedValue(livroAbertoFake({ format: "pdf" }));
    resolverGetDocumentCom(documentoPdfFake());
    stubCanvasToBlob(new Blob(["png-fake"], { type: "image/png" }));
    definirCapaDoLivroMock.mockRejectedValue(new Error("livro não encontrado"));

    await expect(gerarCapaDoLivro("livro-1")).resolves.toBeNull();
  });
});
