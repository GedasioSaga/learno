import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavegacaoDoLeitor, SelecaoDeTexto } from "../tipos";

/**
 * `pdfjs-dist` de verdade não roda no jsdom (Web Worker real, canvas 2D sem
 * `canvas` nativo instalado, `fetch` de PDF de verdade) — exatamente o que a
 * tarefa avisa: "renderização de PDF de verdade é trabalho de e2e". O que
 * este arquivo prova é a lógica AO REDOR disso: que a página inicial vem do
 * locator recebido, que virar página chama `onVirarPagina` com o locator e a
 * fração certos (e não chama nas bordas), que um erro ao abrir vira
 * `onErro` em vez de uma exceção não tratada, e que sem camada de texto a
 * seleção nunca é tentada.
 */
class RenderingCancelledExceptionFake extends Error {}

const getDocumentMock = vi.fn();
const textLayerRenderMock = vi.fn().mockResolvedValue(undefined);

// Precisa ser uma `class` de verdade, não um `vi.fn()` com implementação em
// arrow function: `LeitorPdf.tsx` instancia com `new TextLayer(...)`, e uma
// arrow function não é "constructible" — `new` sobre ela lança silenciosamente
// dentro do `.catch()` do render, e o teste veria 0 chamadas sem entender por quê.
class TextLayerFake {
  render() {
    return textLayerRenderMock();
  }
}

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
  TextLayer: TextLayerFake,
  RenderingCancelledException: RenderingCancelledExceptionFake,
}));

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "worker-url-de-teste" }));

const { LeitorPdf } = await import("./LeitorPdf");

interface PaginaFakeOptions {
  falharAoRenderizar?: boolean;
}

function criarPaginaFake({ falharAoRenderizar = false }: PaginaFakeOptions = {}) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale, scale }),
    render: () => ({
      promise: falharAoRenderizar ? Promise.reject(new Error("canvas explodiu")) : Promise.resolve(),
      cancel: vi.fn(),
    }),
    getTextContent: async () => ({ items: [], styles: {}, lang: null }),
  };
}

/**
 * `getPage` sempre devolve a MESMA instância de página (não uma nova a cada
 * chamada) — de propósito: é o que permite `vi.spyOn(doc.pagina, ...)`
 * observar exatamente o objeto que o componente usa, em vez de espiar um
 * clone que ninguém chama.
 */
function criarDocumentoFake(numPages: number, opcoesPagina: PaginaFakeOptions = {}) {
  const pagina = criarPaginaFake(opcoesPagina);
  const getPage = vi.fn(async (_numero: number) => pagina);
  return { numPages, getPage, pagina };
}

function resolverGetDocumentCom(doc: ReturnType<typeof criarDocumentoFake>) {
  getDocumentMock.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn().mockResolvedValue(undefined) });
}

function rejeitarGetDocument(erro: unknown) {
  getDocumentMock.mockReturnValue({ promise: Promise.reject(erro), destroy: vi.fn().mockResolvedValue(undefined) });
}

function renderizarLeitor(
  overrides: Partial<{
    locatorInicial: string | null;
    hasTextLayer: boolean | null;
    onVirarPagina: (info: { locator: string; fraction: number }) => void;
    onSelecaoDeTexto: (selecao: SelecaoDeTexto | null) => void;
    onErro: (mensagem: string) => void;
  }> = {},
) {
  const ref = createRef<NavegacaoDoLeitor>();
  const props = {
    fonte: "asset://localhost/livro.pdf",
    locatorInicial: overrides.locatorInicial ?? null,
    hasTextLayer: overrides.hasTextLayer ?? true,
    onVirarPagina: overrides.onVirarPagina ?? vi.fn(),
    onSelecaoDeTexto: overrides.onSelecaoDeTexto ?? vi.fn(),
    onErro: overrides.onErro ?? vi.fn(),
  };
  render(<LeitorPdf ref={ref} {...props} />);
  return { ref, ...props };
}

beforeEach(() => {
  getDocumentMock.mockReset();
  textLayerRenderMock.mockClear();
});

describe("abrir o documento", () => {
  it("abre na página do locatorInicial recebido, não sempre na primeira", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);

    renderizarLeitor({ locatorInicial: "5" });

    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(5));
    expect(await screen.findByDisplayValue("5")).toBeInTheDocument();
    expect(screen.getByText("de 10")).toBeInTheDocument();
  });

  it("locatorInicial nulo (livro nunca aberto) começa na primeira página", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);

    renderizarLeitor({ locatorInicial: null });

    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));
  });

  it("locatorInicial inválido (não numérico) também cai na primeira página, sem travar", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);

    renderizarLeitor({ locatorInicial: "não-é-um-número" });

    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));
  });

  it("getDocument rejeitando (ex.: escopo do asset protocol não cobre mais o arquivo) vira onErro, nunca uma exceção não tratada", async () => {
    rejeitarGetDocument(new Error("recusado pelo protocolo asset://"));
    const onErro = vi.fn();

    renderizarLeitor({ onErro });

    await waitFor(() => expect(onErro).toHaveBeenCalledTimes(1));
    expect(onErro.mock.calls[0][0]).toMatch(/Não foi possível abrir o arquivo deste livro/);
    // A tela não fica em branco: a mensagem de abertura desaparece e nada quebra o restante do teste.
    await waitFor(() => expect(screen.queryByText("Abrindo o PDF…")).not.toBeInTheDocument());
  });
});

describe("virar página", () => {
  it("proximo() chama onVirarPagina com o locator e a fração certos", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    const { ref } = renderizarLeitor({ locatorInicial: "4", onVirarPagina });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(4));

    act(() => ref.current?.proximo());

    expect(onVirarPagina).toHaveBeenCalledWith({ locator: "5", fraction: 0.5 });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(5));
  });

  it("anterior() na primeira página é no-op: não chama onVirarPagina nem grava progresso à toa", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    const { ref } = renderizarLeitor({ locatorInicial: "1", onVirarPagina });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    act(() => ref.current?.anterior());

    expect(onVirarPagina).not.toHaveBeenCalled();
  });

  it("proximo() na última página é no-op — a barra da estante não pode achar que ainda avançou", async () => {
    const doc = criarDocumentoFake(3);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    const { ref } = renderizarLeitor({ locatorInicial: "3", onVirarPagina });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(3));

    act(() => ref.current?.proximo());

    expect(onVirarPagina).not.toHaveBeenCalled();
  });

  it("irParaLocator salta direto (usado ao clicar numa anotação) e grava o locator de destino", async () => {
    const doc = criarDocumentoFake(20);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    const { ref } = renderizarLeitor({ locatorInicial: "1", onVirarPagina });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    act(() => ref.current?.irParaLocator("15"));

    expect(onVirarPagina).toHaveBeenCalledWith({ locator: "15", fraction: 0.75 });
  });

  it("irParaLocator com um locator não numérico é no-op, sem lançar", async () => {
    const doc = criarDocumentoFake(20);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    const { ref } = renderizarLeitor({ locatorInicial: "1", onVirarPagina });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    act(() => ref.current?.irParaLocator("epubcfi(/6/4!/4/2:0)"));

    expect(onVirarPagina).not.toHaveBeenCalled();
  });

  it("digitar um número no campo de página e confirmar com Enter também vira uma navegação de verdade", async () => {
    const doc = criarDocumentoFake(10);
    resolverGetDocumentCom(doc);
    const onVirarPagina = vi.fn();

    renderizarLeitor({ locatorInicial: "1", onVirarPagina });
    const campo = await screen.findByLabelText("Página");
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    fireEvent.change(campo, { target: { value: "7" } });
    fireEvent.keyDown(campo, { key: "Enter" });

    expect(onVirarPagina).toHaveBeenCalledWith({ locator: "7", fraction: 0.7 });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(7));
  });
});

describe("limparSelecao", () => {
  it("limpa a seleção do window da própria página, sem lançar mesmo sem seleção ativa", async () => {
    const doc = criarDocumentoFake(5);
    resolverGetDocumentCom(doc);

    const { ref } = renderizarLeitor({ locatorInicial: "1" });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));

    // `Window.getSelection()` é tipado `Selection | null` (navegador antigo
    // sem suporte), mas o jsdom deste projeto sempre devolve uma `Selection`
    // real — falhar alto aqui é melhor que um `as` escondendo a suposição.
    const selecaoDoJsdom = window.getSelection();
    if (!selecaoDoJsdom) throw new Error("jsdom deveria sempre expor uma Selection");
    const removeAllRangesSpy = vi.spyOn(selecaoDoJsdom, "removeAllRanges");

    expect(() => ref.current?.limparSelecao()).not.toThrow();
    expect(removeAllRangesSpy).toHaveBeenCalledTimes(1);
  });
});

describe("zoom", () => {
  it("aumentarZoom/diminuirZoom mudam o percentual mostrado", async () => {
    const doc = criarDocumentoFake(5);
    resolverGetDocumentCom(doc);

    const { ref } = renderizarLeitor({ locatorInicial: "1" });
    await waitFor(() => expect(doc.getPage).toHaveBeenCalledWith(1));
    expect(await screen.findByText("120%")).toBeInTheDocument();

    act(() => ref.current?.aumentarZoom());
    expect(await screen.findByText("140%")).toBeInTheDocument();

    act(() => ref.current?.diminuirZoom());
    act(() => ref.current?.diminuirZoom());
    expect(await screen.findByText("100%")).toBeInTheDocument();
  });
});

describe("camada de texto (seleção/anotação)", () => {
  it("hasTextLayer=false: mostra o aviso e nunca chama getTextContent nem TextLayer", async () => {
    const doc = criarDocumentoFake(5);
    resolverGetDocumentCom(doc);
    const getTextContentSpy = vi.spyOn(doc.pagina, "getTextContent");

    renderizarLeitor({ locatorInicial: "1", hasTextLayer: false });

    expect(await screen.findByText(/não tem texto reconhecível/)).toBeInTheDocument();
    await waitFor(() => expect(doc.getPage).toHaveBeenCalled());
    expect(getTextContentSpy).not.toHaveBeenCalled();
    expect(textLayerRenderMock).not.toHaveBeenCalled();
  });

  it("hasTextLayer=true: a camada de texto é montada (TextLayer.render chamado)", async () => {
    const doc = criarDocumentoFake(5);
    resolverGetDocumentCom(doc);

    renderizarLeitor({ locatorInicial: "1", hasTextLayer: true });

    await waitFor(() => expect(textLayerRenderMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/não tem texto reconhecível/)).not.toBeInTheDocument();
  });

  it("hasTextLayer=null (campo opcional ausente — livro nunca checado) tenta a camada de texto como se fosse true", async () => {
    const doc = criarDocumentoFake(5);
    resolverGetDocumentCom(doc);

    renderizarLeitor({ locatorInicial: "1", hasTextLayer: null });

    await waitFor(() => expect(textLayerRenderMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/não tem texto reconhecível/)).not.toBeInTheDocument();
  });
});

describe("erro ao desenhar a página (distinto de erro ao abrir o documento)", () => {
  it("uma falha no render da página chama onErro com mensagem própria, sem lançar", async () => {
    const doc = criarDocumentoFake(5, { falharAoRenderizar: true });
    resolverGetDocumentCom(doc);
    const onErro = vi.fn();

    renderizarLeitor({ locatorInicial: "1", onErro });

    await waitFor(() => expect(onErro).toHaveBeenCalledWith(expect.stringMatching(/desenhar esta página/)));
  });
});
