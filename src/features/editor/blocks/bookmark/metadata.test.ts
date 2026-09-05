import { describe, expect, it } from "vitest";
import { fetchBookmarkMetadata, parseBookmarkHtml } from "./metadata";

describe("fetchBookmarkMetadata", () => {
  it("EDT-028: fora do Tauri (isTauri()===false, o real em jsdom) não há busca remota - cai para hostname como título e sem descrição/favicon", async () => {
    const metadata = await fetchBookmarkMetadata("https://exemplo.test/artigo/123");
    expect(metadata).toEqual({ title: "exemplo.test", description: "", favicon: null });
  });

  it("nunca inventa metadado: uma URL malformada não vira um título qualquer", async () => {
    const metadata = await fetchBookmarkMetadata("não é url");
    // hostnameOf cai para o texto bruto quando não consegue parsear - o
    // fallback é honesto sobre o que sabe, nunca inventa um título "bonito".
    expect(metadata.title).toBe("não é url");
    expect(metadata.description).toBe("");
    expect(metadata.favicon).toBeNull();
  });
});

describe("parseBookmarkHtml (puro, sem rede) - o que o parser extrai/rejeita de um HTML já em mãos", () => {
  it("lê <title>, meta description e favicon relativo, resolvido contra a URL da página", () => {
    const html = `<!doctype html><html><head>
      <title>  Um Artigo Ótimo  </title>
      <meta name="description" content="Resumo do artigo.">
      <link rel="icon" href="/favicon.png">
    </head><body></body></html>`;

    const metadata = parseBookmarkHtml(html, new URL("https://exemplo.test/artigo/123"));

    expect(metadata).toEqual({
      title: "Um Artigo Ótimo",
      description: "Resumo do artigo.",
      favicon: "https://exemplo.test/favicon.png",
    });
  });

  it("cai para og:description quando não há meta description simples", () => {
    const html = `<html><head><title>T</title><meta property="og:description" content="Via OG."></head></html>`;
    const metadata = parseBookmarkHtml(html, new URL("https://exemplo.test/"));
    expect(metadata.description).toBe("Via OG.");
  });

  it("sem <title>, cai para o hostname da própria URL - nunca inventa um título", () => {
    const metadata = parseBookmarkHtml("<html><head></head></html>", new URL("https://exemplo.test/x"));
    expect(metadata.title).toBe("exemplo.test");
    expect(metadata.description).toBe("");
    expect(metadata.favicon).toBeNull();
  });

  it("um favicon com esquema javascript:/data: nunca passa - parseSafeUrl rejeita, então o card não recebe nada para renderizar", () => {
    const html = `<html><head><title>T</title><link rel="icon" href="javascript:alert(1)"></head></html>`;
    const metadata = parseBookmarkHtml(html, new URL("https://exemplo.test/"));
    expect(metadata.favicon).toBeNull();
  });

  it("um favicon absoluto para outro host passa normalmente (nada obriga o favicon a ser same-origin)", () => {
    const html = `<html><head><title>T</title><link rel="icon" href="https://cdn.exemplo.test/f.ico"></head></html>`;
    const metadata = parseBookmarkHtml(html, new URL("https://exemplo.test/"));
    expect(metadata.favicon).toBe("https://cdn.exemplo.test/f.ico");
  });

  it("HTML com script/markup hostil nunca executa nada - DOMParser em modo text/html não roda script, e só texto sai daqui", () => {
    const html = `<html><head>
      <title>&lt;img src=x onerror=alert(1)&gt;</title>
      <script>window.__pwned__ = true;</script>
    </head></html>`;
    const metadata = parseBookmarkHtml(html, new URL("https://exemplo.test/"));
    expect(metadata.title).toBe("<img src=x onerror=alert(1)>");
    expect((globalThis as Record<string, unknown>).__pwned__).toBeUndefined();
  });
});
