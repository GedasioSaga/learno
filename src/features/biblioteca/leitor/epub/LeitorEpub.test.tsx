import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarMarcacao } from "../marcacao-de-vocabulario";
import type { NavegacaoDoLeitor, SelecaoDeTexto } from "../tipos";

// O jsdom não tem `CSS.highlights` (a marcação de verdade seria no-op aqui, e
// `marcacao-de-vocabulario.test.ts` já cobre o que ela faz); o que este
// arquivo prova é a FIAÇÃO — em qual documento e com qual lista ela é chamada.
vi.mock("../marcacao-de-vocabulario", () => ({ aplicarMarcacao: vi.fn() }));
const aplicarMarcacaoMock = vi.mocked(aplicarMarcacao);

/**
 * `epubjs` de verdade não roda bem no jsdom (XHR real buscando um arquivo,
 * iframe de conteúdo com seu próprio `document`) — mesma razão de
 * `LeitorPdf.test.tsx` mockar `pdfjs-dist` inteiro. O que este arquivo prova
 * é a lógica ao redor: reabrir no locator certo, o par de armadilhas
 * VERIFICADAS em `node_modules/epubjs/lib/` (ver cabeçalho de
 * `LeitorEpub.tsx`) — `book.ready` que nunca rejeita e `rendition.display()`
 * que nunca rejeita por erro do manager — e que `percentageFromCfi`
 * devolvendo `null` (não o `number` que o `.d.ts` promete) não quebra o
 * contrato de `fraction: number`.
 */
type Ouvinte = (...args: unknown[]) => void;

function criarEmissor() {
  const porTipo = new Map<string, Set<Ouvinte>>();
  return {
    on: (tipo: string, fn: Ouvinte) => {
      const conjunto = porTipo.get(tipo) ?? new Set<Ouvinte>();
      conjunto.add(fn);
      porTipo.set(tipo, conjunto);
    },
    off: (tipo: string, fn: Ouvinte) => {
      porTipo.get(tipo)?.delete(fn);
    },
    emit: (tipo: string, ...args: unknown[]) => {
      porTipo.get(tipo)?.forEach((fn) => fn(...args));
    },
  };
}

interface RenditionFakeOptions {
  /** `undefined` = a promise de `display()` nunca resolve nem rejeita (não testado aqui); passe uma função para controlar por chamada. */
  aoChamarDisplay?: (target: string | undefined, chamada: number) => Promise<void>;
  percentualAtual?: number;
}

function criarRenditionFake({ aoChamarDisplay, percentualAtual }: RenditionFakeOptions = {}) {
  const emissor = criarEmissor();
  let chamadasDeDisplay = 0;
  const registerMock = vi.fn();
  const rendition = {
    // Uma LISTA por padrão, como o `lib/rendition.js` instalado devolve; o `.d.ts`
    // diz um `Contents` só, e o componente aceita as duas formas — daí o `unknown`.
    getContents: vi.fn((): unknown => []),
    on: emissor.on,
    off: emissor.off,
    emit: emissor.emit,
    hooks: { content: { register: registerMock } },
    themes: { fontSize: vi.fn() },
    location: percentualAtual === undefined ? undefined : { start: { percentage: percentualAtual } },
    display: vi.fn((target?: string) => {
      chamadasDeDisplay += 1;
      return aoChamarDisplay ? aoChamarDisplay(target, chamadasDeDisplay) : Promise.resolve();
    }),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  return rendition;
}

interface BookFakeOptions {
  ready?: Promise<void>;
  toc?: Array<{ id: string; href: string; label: string; subitems?: never[] }>;
  percentageFromCfi?: (cfi: string) => number | null;
  rendition: ReturnType<typeof criarRenditionFake>;
}

function criarBookFake({ ready, toc = [], percentageFromCfi, rendition }: BookFakeOptions) {
  const emissor = criarEmissor();
  return {
    on: emissor.on,
    off: emissor.off,
    emit: emissor.emit,
    ready: ready ?? Promise.resolve(undefined),
    navigation: { toc },
    locations: {
      generate: vi.fn().mockResolvedValue([]),
      percentageFromCfi: vi.fn(percentageFromCfi ?? (() => null)),
    },
    renderTo: vi.fn(() => rendition),
    destroy: vi.fn(),
  };
}

const EpubFactoryMock = vi.fn();

vi.mock("epubjs", () => ({
  default: (...args: unknown[]) => EpubFactoryMock(...args),
}));

/**
 * O componente sob teste agora faz `fetch(fonte)` e passa o `ArrayBuffer`
 * resultante para `Epub()` — é a mudança investigada no bug reportado (ver
 * nota 4 do cabeçalho de `LeitorEpub.tsx`). Sem mockar `fetch`, todo teste
 * ficaria preso esperando uma requisição de rede real que o jsdom não sabe
 * fazer para `asset://localhost/...`.
 */
function mockarFetchComSucesso() {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes) }),
  );
  return bytes;
}

const { LeitorEpub } = await import("./LeitorEpub");

function renderizarLeitor(
  overrides: Partial<{
    locatorInicial: string | null;
    onVirarPagina: (info: { locator: string; fraction: number }) => void;
    onSelecaoDeTexto: (selecao: SelecaoDeTexto | null) => void;
    onErro: (mensagem: string) => void;
    termosMarcados: readonly string[];
  }> = {},
) {
  const ref = createRef<NavegacaoDoLeitor>();
  const props = {
    fonte: "asset://localhost/livro.epub",
    locatorInicial: overrides.locatorInicial ?? null,
    hasTextLayer: null,
    onVirarPagina: overrides.onVirarPagina ?? vi.fn(),
    onSelecaoDeTexto: overrides.onSelecaoDeTexto ?? vi.fn(),
    onErro: overrides.onErro ?? vi.fn(),
    termosMarcados: overrides.termosMarcados ?? [],
  };
  const { rerender } = render(<LeitorEpub ref={ref} {...props} />);
  return { ref, ...props, rerender };
}

beforeEach(() => {
  EpubFactoryMock.mockReset();
  aplicarMarcacaoMock.mockReset();
  // Sucesso por padrão — os poucos testes que exercitam a falha do `fetch`
  // chamam `vi.stubGlobal("fetch", ...)` de novo com o próprio mock.
  mockarFetchComSucesso();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("abrir o livro", () => {
  it("passa um ArrayBuffer para Epub(), nunca a URL de `fonte` crua — a diferença entre o caminho que atravessa blob:/CSP e o que não", async () => {
    const bufferEsperado = mockarFetchComSucesso();
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    renderizarLeitor();

    await waitFor(() => expect(EpubFactoryMock).toHaveBeenCalledTimes(1));
    const [argumentoRecebido] = EpubFactoryMock.mock.calls[0];
    expect(argumentoRecebido).toBeInstanceOf(ArrayBuffer);
    expect(argumentoRecebido).toBe(bufferEsperado);
    expect(typeof argumentoRecebido).not.toBe("string");
  });

  it("campo opcional ausente — fetch(fonte) falha (arquivo movido, escopo do assetProtocol não cobre mais) — onErro chamado, Epub() nunca chega a ser chamado", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ onErro });

    await waitFor(() => expect(onErro).toHaveBeenCalledTimes(1));
    expect(onErro.mock.calls[0][0]).toMatch(/Não foi possível abrir o arquivo deste livro/);
    expect(EpubFactoryMock).not.toHaveBeenCalled();
  });

  it("fetch resolve mas com status HTTP de erro (ex.: arquivo não existe mais no caminho) — mesmo onErro, sem exceção não tratada", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, arrayBuffer: () => Promise.reject(new Error("não deveria ser chamado")) }));
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ onErro });

    await waitFor(() => expect(onErro).toHaveBeenCalledTimes(1));
    expect(EpubFactoryMock).not.toHaveBeenCalled();
  });

  it("chama rendition.display com o locatorInicial recebido (reabre onde parou)", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    renderizarLeitor({ locatorInicial: "epubcfi(/6/4!/4/2:10)" });

    await waitFor(() => expect(rendition.display).toHaveBeenCalledWith("epubcfi(/6/4!/4/2:10)"));
  });

  it("locatorInicial nulo (livro nunca aberto) chama display sem alvo — começa do início", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    renderizarLeitor({ locatorInicial: null });

    await waitFor(() => expect(rendition.display).toHaveBeenCalledWith(undefined));
  });

  it("locatorInicial que não existe mais no arquivo (display rejeita) degrada para o início, sem travar", async () => {
    const rendition = criarRenditionFake({
      aoChamarDisplay: (target) => (target ? Promise.reject(new Error("No Section Found")) : Promise.resolve()),
    });
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ locatorInicial: "epubcfi(/99/99!/4/2:0)", onErro });

    // Fallback chamado SEM argumento (vai para o início) — diferente do
    // primeiro `display(locatorInicialRef.current ?? undefined)`, que passa
    // `undefined` explícito.
    await waitFor(() => expect(rendition.display).toHaveBeenNthCalledWith(2));
    expect(onErro).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Abrindo o EPUB…")).not.toBeInTheDocument());
  });

  it("display falha até no fallback (sem alvo) vira onErro, nunca uma exceção não tratada", async () => {
    const rendition = criarRenditionFake({ aoChamarDisplay: () => Promise.reject(new Error("arquivo corrompido")) });
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ onErro });

    await waitFor(() => expect(onErro).toHaveBeenCalledWith("Não foi possível abrir este EPUB."));
  });

  it("VERIFICADO EM lib/book.js: quando `open()` falha, o Book só emite \"openFailed\" — book.ready nunca resolve nem rejeita. onErro precisa vir do evento, não de um catch em `book.ready`", async () => {
    const rendition = criarRenditionFake();
    // A promise nunca resolve nem rejeita — exatamente o comportamento real
    // verificado no código-fonte da lib para um `open()` que falhou.
    const readyQueNuncaAssenta = new Promise<void>(() => {});
    const book = criarBookFake({ rendition, ready: readyQueNuncaAssenta });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ onErro });
    // Só depois do `fetch` (mockado) resolver é que o componente chama
    // `Epub()` e registra o listener em `book.on("openFailed", ...)` — emitir
    // antes disso emitiria no vazio, sem ninguém ouvindo.
    await waitFor(() => expect(EpubFactoryMock).toHaveBeenCalled());
    act(() => book.emit("openFailed", new Error("zip inválido")));

    await waitFor(() => expect(onErro).toHaveBeenCalledTimes(1));
    expect(onErro.mock.calls[0][0]).toMatch(/Não foi possível abrir o arquivo deste livro/);
    // `rendition.display` nunca chega a ser chamado: o livro nunca terminou de abrir.
    expect(rendition.display).not.toHaveBeenCalled();
  });

  it("VERIFICADO EM lib/rendition.js: um erro do manager ao desenhar só emite \"displayerror\" — a Promise de display() nunca rejeita por isso", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onErro = vi.fn();

    renderizarLeitor({ onErro });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    act(() => rendition.emit("displayerror", new Error("seção não renderizou")));

    await waitFor(() => expect(onErro).toHaveBeenCalledWith("Não foi possível abrir esta parte do livro. Feche e abra o livro de novo."));
  });
});

describe("virar página / navegação", () => {
  it("evento relocated chama onVirarPagina com o cfi e a fração de percentageFromCfi", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition, percentageFromCfi: () => 0.37 });
    EpubFactoryMock.mockReturnValue(book);
    const onVirarPagina = vi.fn();

    renderizarLeitor({ onVirarPagina });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    act(() => rendition.emit("relocated", { start: { cfi: "epubcfi(/6/6!/4/2:3)" } }));

    expect(onVirarPagina).toHaveBeenCalledWith({ locator: "epubcfi(/6/6!/4/2:3)", fraction: 0.37 });
  });

  it("campo opcional ausente — percentageFromCfi devolve null (locations.generate ainda não terminou) — cai para 0, nunca propaga null", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition, percentageFromCfi: () => null });
    EpubFactoryMock.mockReturnValue(book);
    const onVirarPagina = vi.fn();

    renderizarLeitor({ onVirarPagina });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    act(() => rendition.emit("relocated", { start: { cfi: "epubcfi(/6/2!/4/2:0)" } }));

    expect(onVirarPagina).toHaveBeenCalledWith({ locator: "epubcfi(/6/2!/4/2:0)", fraction: 0 });
  });

  it("proximo()/anterior() do ref chamam rendition.next()/prev()", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    const { ref } = renderizarLeitor();
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    act(() => ref.current?.proximo());
    expect(rendition.next).toHaveBeenCalledTimes(1);

    act(() => ref.current?.anterior());
    expect(rendition.prev).toHaveBeenCalledTimes(1);
  });

  it("irParaLocator (usado ao clicar numa anotação) chama rendition.display com o CFI salvo direto, sem tentar interpretar como número", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    const { ref } = renderizarLeitor();
    await waitFor(() => expect(rendition.display).toHaveBeenCalledTimes(1));

    act(() => ref.current?.irParaLocator("epubcfi(/6/10!/4/2,/2/1:0,/4/2:9)"));

    expect(rendition.display).toHaveBeenNthCalledWith(2, "epubcfi(/6/10!/4/2,/2/1:0,/4/2:9)");
  });
});

describe("zoom (tamanho da fonte)", () => {
  it("aumentarZoom/diminuirZoom chamam rendition.themes.fontSize com o percentual novo", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    const { ref } = renderizarLeitor();
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    act(() => ref.current?.aumentarZoom());
    await waitFor(() => expect(rendition.themes.fontSize).toHaveBeenCalledWith("110%"));

    act(() => ref.current?.diminuirZoom());
    act(() => ref.current?.diminuirZoom());
    await waitFor(() => expect(rendition.themes.fontSize).toHaveBeenCalledWith("90%"));
  });
});

describe("seleção de texto", () => {
  function criarContentsFake(textoSelecionado: string | null) {
    const ouvintesDoDocumento: Ouvinte[] = [];
    return {
      window: {
        getSelection: () => ({
          isCollapsed: textoSelecionado === null,
          toString: () => textoSelecionado ?? "",
        }),
      },
      document: {
        addEventListener: (_tipo: string, fn: Ouvinte) => {
          ouvintesDoDocumento.push(fn);
        },
      },
      dispararSelectionchange: () => ouvintesDoDocumento.forEach((fn) => fn()),
    };
  }

  it("evento selected com texto não vazio chama onSelecaoDeTexto com o cfiRange e o excerto", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition, percentageFromCfi: () => 0.5 });
    EpubFactoryMock.mockReturnValue(book);
    const onSelecaoDeTexto = vi.fn();

    renderizarLeitor({ onSelecaoDeTexto });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    const contents = criarContentsFake("um trecho selecionado");
    act(() => rendition.emit("selected", "epubcfi(/6/4!/4/2,/2/1:0,/4/2:20)", contents));

    expect(onSelecaoDeTexto).toHaveBeenCalledWith({
      locatorStart: "epubcfi(/6/4!/4/2,/2/1:0,/4/2:20)",
      locatorEnd: null,
      fraction: 0.5,
      excerpt: "um trecho selecionado",
    });
  });

  it("evento selected com seleção vazia não chama onSelecaoDeTexto", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onSelecaoDeTexto = vi.fn();

    renderizarLeitor({ onSelecaoDeTexto });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    const contents = criarContentsFake("");
    act(() => rendition.emit("selected", "epubcfi(/6/4!/4/2:1)", contents));

    expect(onSelecaoDeTexto).not.toHaveBeenCalled();
  });

  it("a seleção esvaziando dentro do iframe (selectionchange) fecha o formulário — onSelecaoDeTexto(null)", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);
    const onSelecaoDeTexto = vi.fn();

    renderizarLeitor({ onSelecaoDeTexto });
    await waitFor(() => expect(rendition.hooks.content.register).toHaveBeenCalled());

    // Simula o epub.js injetando um novo `Contents` (uma seção/iframe) e o
    // usuário clicando fora do texto selecionado dentro dele.
    // `as` seguro aqui: `mock.calls[n][0]` é `unknown` por tipagem do vitest
    // (ele não sabe a assinatura de quem registrou), mas o único registrador
    // chamado neste teste é o próprio `rendition.hooks.content.register` do
    // componente sob teste — o mesmo arquivo controla os dois lados.
    const registrarHook = rendition.hooks.content.register.mock.calls[0][0] as (c: unknown) => void;
    const contents = criarContentsFake(null);
    act(() => registrarHook(contents));
    act(() => contents.dispararSelectionchange());

    expect(onSelecaoDeTexto).toHaveBeenCalledWith(null);
  });
});

describe("sumário", () => {
  it("lista os capítulos do book.navigation.toc e clicar num deles navega e fecha o painel", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({
      rendition,
      toc: [{ id: "cap-1", href: "capitulo1.xhtml", label: "Capítulo Um" }],
    });
    EpubFactoryMock.mockReturnValue(book);

    renderizarLeitor();
    await waitFor(() => expect(rendition.display).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Sumário" }));
    fireEvent.click(await screen.findByText("Capítulo Um"));

    expect(rendition.display).toHaveBeenNthCalledWith(2, "capitulo1.xhtml");
    expect(screen.queryByText("Capítulo Um")).not.toBeInTheDocument();
  });
});

describe("limpar seleção", () => {
  it("limparSelecao chama removeAllRanges no window do Contents da última seleção, não no window da página", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    const { ref } = renderizarLeitor();
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    const removeAllRanges = vi.fn();
    const contents = {
      window: { getSelection: () => ({ isCollapsed: false, toString: () => "trecho", removeAllRanges }) },
      document: { addEventListener: vi.fn() },
    };
    act(() => rendition.emit("selected", "epubcfi(/6/4!/4/2:1)", contents));

    act(() => ref.current?.limparSelecao());

    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });
});

describe("marcação do vocabulário no livro", () => {
  function criarContentsComCorpo() {
    const corpo = document.createElement("div");
    const contents = { window: { getSelection: () => null }, document: { addEventListener: vi.fn(), body: corpo } };
    return { corpo, contents };
  }

  it("cada seção que o epub.js desenha nasce marcada com a lista de agora; seção sem <body> não derruba o hook", async () => {
    const rendition = criarRenditionFake();
    EpubFactoryMock.mockReturnValue(criarBookFake({ rendition }));

    renderizarLeitor({ termosMarcados: ["voraz"] });
    await waitFor(() => expect(rendition.hooks.content.register).toHaveBeenCalled());

    const registrarHook = rendition.hooks.content.register.mock.calls[0][0] as (c: unknown) => void; // `as`: `mock.calls` é `unknown`, e o único registrador neste teste é o componente sob teste
    const { corpo, contents } = criarContentsComCorpo();
    act(() => registrarHook(contents));
    expect(aplicarMarcacaoMock).toHaveBeenCalledWith(corpo, ["voraz"]);

    const semCorpo = { window: { getSelection: () => null }, document: { addEventListener: vi.fn() } };
    expect(() => act(() => registrarHook(semCorpo))).not.toThrow();
    expect(aplicarMarcacaoMock).toHaveBeenCalledTimes(1);
  });

  it("seção desenhada DEPOIS de a lista mudar nasce com a lista nova, não com a da montagem", async () => {
    const rendition = criarRenditionFake();
    EpubFactoryMock.mockReturnValue(criarBookFake({ rendition }));

    const { rerender, ref, ...props } = renderizarLeitor({ termosMarcados: ["voraz"] });
    await waitFor(() => expect(rendition.hooks.content.register).toHaveBeenCalled());
    rerender(<LeitorEpub ref={ref} {...props} termosMarcados={["ao léu"]} />);

    const registrarHook = rendition.hooks.content.register.mock.calls[0][0] as (c: unknown) => void; // `as`: `mock.calls` é `unknown`, e o único registrador neste teste é o componente sob teste
    const { corpo, contents } = criarContentsComCorpo();
    act(() => registrarHook(contents));

    expect(aplicarMarcacaoMock).toHaveBeenCalledWith(corpo, ["ao léu"]);
    expect(aplicarMarcacaoMock).not.toHaveBeenCalledWith(corpo, ["voraz"]);
  });

  it("mudar a lista remarca o que já está desenhado, sem esperar a próxima seção", async () => {
    const rendition = criarRenditionFake();
    const { corpo, contents } = criarContentsComCorpo();
    rendition.getContents.mockReturnValue([contents]);
    EpubFactoryMock.mockReturnValue(criarBookFake({ rendition }));
    const props = {
      fonte: "asset://localhost/livro.epub",
      locatorInicial: null,
      hasTextLayer: null,
      onVirarPagina: vi.fn(),
      onSelecaoDeTexto: vi.fn(),
      onErro: vi.fn(),
    };

    const { rerender } = render(<LeitorEpub {...props} termosMarcados={["voraz"]} />);
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());
    aplicarMarcacaoMock.mockClear();

    rerender(<LeitorEpub {...props} termosMarcados={[]} />);

    expect(aplicarMarcacaoMock).toHaveBeenCalledWith(corpo, []);
  });

  it("getContents devolvendo um Contents só (a forma que o .d.ts declara), sem lista, também remarca", async () => {
    const rendition = criarRenditionFake();
    const { corpo, contents } = criarContentsComCorpo();
    rendition.getContents.mockReturnValue(contents);
    EpubFactoryMock.mockReturnValue(criarBookFake({ rendition }));

    const { rerender, ref, ...props } = renderizarLeitor({ termosMarcados: ["voraz"] });
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());
    aplicarMarcacaoMock.mockClear();

    rerender(<LeitorEpub ref={ref} {...props} termosMarcados={["ao léu"]} />);

    expect(aplicarMarcacaoMock).toHaveBeenCalledTimes(1);
    expect(aplicarMarcacaoMock).toHaveBeenCalledWith(corpo, ["ao léu"]);
  });
});

describe("desmontar", () => {
  it("destrói a rendition e o book ao desmontar", async () => {
    const rendition = criarRenditionFake();
    const book = criarBookFake({ rendition });
    EpubFactoryMock.mockReturnValue(book);

    const utils = render(
      <LeitorEpub
        fonte="asset://localhost/livro.epub"
        locatorInicial={null}
        hasTextLayer={null}
        onVirarPagina={vi.fn()}
        onSelecaoDeTexto={vi.fn()}
        onErro={vi.fn()}
        termosMarcados={[]}
      />,
    );
    await waitFor(() => expect(rendition.display).toHaveBeenCalled());

    utils.unmount();

    expect(rendition.destroy).toHaveBeenCalledTimes(1);
    expect(book.destroy).toHaveBeenCalledTimes(1);
  });
});
