/**
 * The `isTauri()===true` branch of `fetchBookmarkMetadata` - the one
 * `metadata.test.ts` can't reach, because `vi.mock` is hoisted to the top
 * of its whole file and would flip every test in it onto the mocked
 * `isTauri`. Split into its own file for the same reason
 * `media-tauri.test.ts` is split from `media-storage.test.ts` in the media/
 * folder next door.
 *
 * Only the platform edges are mocked (`@tauri-apps/api/core`,
 * `@tauri-apps/plugin-http`) - `fetchBookmarkMetadata`, `fetchHtml`,
 * `readCappedText` and `parseBookmarkHtml` all run for real, so this proves
 * the Tauri branch calls the plugin correctly and degrades to the honest
 * fallback on every failure mode it needs to handle (non-2xx, wrong
 * Content-Type, an unsafe `response.url`, a timeout, a thrown error) -
 * without needing a live capability grant or real network. That capability
 * grant (`http:default` in `src-tauri/capabilities/default.json`) is
 * exercised for real by `cargo build` regenerating `gen/schemas/` instead
 * (see the report): a wrong URL scope there fails the Rust build, which is
 * the actual proof an ACL identifier/scope is well-formed - it isn't
 * something a vitest run can observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

const { fetchBookmarkMetadata } = await import("./metadata");

function htmlResponse(html: string, init: { url?: string; contentType?: string; ok?: boolean } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.ok === false ? 404 : 200,
    url: init.url ?? "https://exemplo.test/",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? (init.contentType ?? "text/html; charset=utf-8") : null),
    },
    body: null,
    text: async () => html,
  } as unknown as Response;
}

/**
 * O que `maxRedirections: 0` faz o plugin devolver: a própria resposta 3xx,
 * com o `Location`, sem tê-lo seguido. É essa forma que `fetchHtml` inspeciona
 * hop a hop — um mock que já entregasse o corpo do destino estaria testando o
 * comportamento que a correção de SSRF justamente removeu.
 */
function redirectResponse(location: string, status = 302): Response {
  return {
    ok: false,
    status,
    url: "https://exemplo-publico.test/artigo",
    headers: {
      get: (name: string) => (name.toLowerCase() === "location" ? location : null),
    },
    body: null,
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchBookmarkMetadata dentro do Tauri (plugin-http mockado)", () => {
  it("busca de verdade: chama plugin-http fetch com a URL, GET, maxRedirections 0 e um AbortSignal, e devolve o metadado parseado", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse(`<html><head><title>Site Real</title><meta name="description" content="Descrição real."></head></html>`),
    );

    const metadata = await fetchBookmarkMetadata("https://exemplo.test/pagina");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit & { maxRedirections?: number }];
    expect(calledUrl).toBe("https://exemplo.test/pagina");
    expect(options.method).toBe("GET");
    // `0` vira `Policy::none()` no lado Rust do plugin: nenhum hop é seguido
    // por nós, para que cada um possa ser validado antes de ser discado.
    expect(options.maxRedirections).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(metadata).toEqual({ title: "Site Real", description: "Descrição real.", favicon: null });
  });

  it("status não-2xx cai para o fallback honesto (hostname), sem lançar", async () => {
    fetchMock.mockResolvedValue(htmlResponse("<html></html>", { ok: false }));
    const metadata = await fetchBookmarkMetadata("https://exemplo.test/404");
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("Content-Type que não é HTML (ex.: um PDF) cai para o fallback, nunca tenta parsear", async () => {
    fetchMock.mockResolvedValue(htmlResponse("%PDF-1.4 …", { contentType: "application/pdf" }));
    const metadata = await fetchBookmarkMetadata("https://exemplo.test/arquivo.pdf");
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("redirecionamento para fora de http(s) cai para o fallback em vez de discar o esquema não seguro", async () => {
    fetchMock.mockResolvedValue(redirectResponse("data:text/html,oi"));
    const metadata = await fetchBookmarkMetadata("https://exemplo.test/redireciona");
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // SSRF: a capability scope (http:default) só é checada uma vez, contra a
  // URL original — tauri-plugin-http nunca revalida um hop de redirect. Uma
  // URL pública que redireciona para um IP interno (rede local ou o endpoint
  // de metadado de nuvem) precisa ser barrada pelo app, porque a ACL já
  // deixou passar o request original.
  //
  // A asserção que importa é a segunda: `toHaveBeenCalledTimes(1)`, com a URL
  // pública. Barrar só o CONTEÚDO do host interno seria tarde demais — o
  // request já teria acontecido, com os efeitos colaterais que ele tiver
  // (`http://192.168.1.1/admin` não é um GET inócuo). O host interno não pode
  // ser discado nem uma vez.
  it.each([
    ["rede local RFC1918", "http://192.168.1.1/admin"],
    ["metadado de nuvem", "http://169.254.169.254/latest/meta-data/"],
    ["loopback fora da lista exata", "http://127.0.0.2/"],
    ["localhost via https no redirect", "https://localhost:8080/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["CGNAT (RFC6598)", "http://100.64.0.1/"],
    ["relativo que resolve para o mesmo host público", "/artigo-real"],
  ])("redirecionamento (302) para %s nunca é discado", async (_case, redirectedTo) => {
    fetchMock.mockResolvedValue(redirectResponse(redirectedTo));

    const metadata = await fetchBookmarkMetadata("https://exemplo-publico.test/artigo");

    const dialed = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(dialed[0]).toBe("https://exemplo-publico.test/artigo");
    const internalHostDialed = dialed.slice(1).some((url) => url !== "https://exemplo-publico.test/artigo-real");
    expect(internalHostDialed).toBe(false);
    // Um destino privado nunca produz card com metadado; o relativo público é
    // seguido e só falha depois, no loop de hops, por sempre devolver 302.
    expect(metadata).toEqual({ title: "exemplo-publico.test", description: "", favicon: null });
  });

  it("um redirecionamento legítimo (http para https no mesmo host) é seguido e o metadado do destino aparece", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://exemplo.test/pagina", 301))
      .mockResolvedValueOnce(htmlResponse("<html><head><title>Depois do redirect</title></head></html>"));

    const metadata = await fetchBookmarkMetadata("http://exemplo.test/pagina");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://exemplo.test/pagina",
      "https://exemplo.test/pagina",
    ]);
    expect(metadata.title).toBe("Depois do redirect");
  });

  it("uma cadeia de redirecionamentos que nunca termina desiste no limite de hops em vez de girar para sempre", async () => {
    fetchMock.mockResolvedValue(redirectResponse("https://exemplo.test/de-novo"));

    const metadata = await fetchBookmarkMetadata("https://exemplo.test/loop");

    // Limite declarado em `MAX_REDIRECT_HOPS` (5): a primeira chamada mais os
    // cinco hops permitidos, e nada além disso.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("uma URL alvo que já é um host privado (colada direto, sem depender de redirect) nunca chega a chamar o plugin-http", async () => {
    const metadata = await fetchBookmarkMetadata("http://192.168.0.10/painel");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.title).toBe("192.168.0.10");
  });

  it("o fetch demorando além do timeout aborta e cai para o fallback, em vez de travar o card em espera para sempre", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );

    const pending = fetchBookmarkMetadata("https://exemplo.test/lento");
    await vi.advanceTimersByTimeAsync(5000);
    const metadata = await pending;

    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("fetch rejeitando por qualquer outro motivo (rede caiu) também cai para o fallback, nunca propaga o erro para o chamador", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const metadata = await fetchBookmarkMetadata("https://exemplo.test/sem-rede");
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("uma URL insegura (javascript:) nunca chega a chamar o plugin-http", async () => {
    const metadata = await fetchBookmarkMetadata("javascript:alert(1)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.title).toBe("javascript:alert(1)");
  });
});
