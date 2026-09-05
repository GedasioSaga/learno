import { describe, expect, it, vi } from "vitest";
import { hostnameOf, isPrivateOrLoopbackHost, parseSafeUrl, renderBookmarkCard } from "./bookmark-card";

describe("parseSafeUrl", () => {
  it("EDT-028: aceita http/https e recusa javascript:/data: como esquema hostil", () => {
    expect(parseSafeUrl("https://exemplo.test/pagina")?.href).toBe("https://exemplo.test/pagina");
    expect(parseSafeUrl("http://exemplo.test")).not.toBeNull();
    expect(parseSafeUrl("javascript:alert(1)")).toBeNull();
    expect(parseSafeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(parseSafeUrl("não é url")).toBeNull();
  });
});

describe("hostnameOf", () => {
  it("EDT-028: extrai o hostname de uma URL válida e cai para o texto bruto quando não é URL", () => {
    expect(hostnameOf("https://exemplo.test/pagina?x=1")).toBe("exemplo.test");
    expect(hostnameOf("texto qualquer")).toBe("texto qualquer");
  });
});

describe("isPrivateOrLoopbackHost", () => {
  it("barra localhost e todo o range de loopback IPv4, não só 127.0.0.1", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.2")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.255.255.255")).toBe(true);
  });

  it("barra os três blocos RFC1918 inteiros, não só um IP de exemplo", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.255.255")).toBe(true);
  });

  it("172.15.x e 172.32.x ficam fora do range RFC1918 e não são bloqueados", () => {
    expect(isPrivateOrLoopbackHost("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("172.32.0.1")).toBe(false);
  });

  it("barra link-local, incluindo o endpoint de metadado de nuvem 169.254.169.254", () => {
    expect(isPrivateOrLoopbackHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.0.1")).toBe(true);
  });

  it("barra 0.0.0.0/8 e o range CGNAT 100.64.0.0/10", () => {
    expect(isPrivateOrLoopbackHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.100.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.127.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("100.63.0.1")).toBe(false);
  });

  it("barra IPv6 loopback, link-local e unique-local, e o mapeamento ::ffff:<ipv4>", () => {
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fe80::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fd12::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::ffff:192.168.1.1]")).toBe(true);
  });

  it("hosts públicos comuns não são bloqueados", () => {
    expect(isPrivateOrLoopbackHost("exemplo.test")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("93.184.216.34")).toBe(false);
  });
});

describe("renderBookmarkCard", () => {
  it("EDT-028: cria um cartão com título, descrição, favicon e URL, e é clicável", () => {
    const container = document.createElement("div");
    const onOpen = vi.fn();

    renderBookmarkCard(
      container,
      { url: "https://exemplo.test/pagina", title: "Página de exemplo", description: "Uma descrição", favicon: "https://exemplo.test/favicon.ico" },
      onOpen,
    );

    const link = container.querySelector<HTMLElement>(".ed-bookmark__link");
    expect(link).not.toBeNull();
    expect(container.querySelector(".ed-bookmark__title")?.textContent).toBe("Página de exemplo");
    expect(container.querySelector(".ed-bookmark__description")?.textContent).toBe("Uma descrição");
    expect(container.querySelector(".ed-bookmark__url")?.textContent).toBe("exemplo.test");
    expect(container.querySelector<HTMLImageElement>(".ed-bookmark__favicon")?.src).toBe("https://exemplo.test/favicon.ico");

    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("EDT-028: sem título nem descrição, cai para o hostname e omite o parágrafo de descrição", () => {
    const container = document.createElement("div");
    renderBookmarkCard(container, { url: "https://exemplo.test", title: "", description: "", favicon: null }, vi.fn());

    expect(container.querySelector(".ed-bookmark__title")?.textContent).toBe("exemplo.test");
    expect(container.querySelector(".ed-bookmark__description")).toBeNull();
    expect(container.querySelector(".ed-bookmark__favicon")).toBeNull();
  });

  it("nunca escapa para HTML: um título hostil vira texto literal, não markup", () => {
    const container = document.createElement("div");
    renderBookmarkCard(container, { url: "https://exemplo.test", title: "<img src=x onerror=alert(1)>", description: "", favicon: null }, vi.fn());

    expect(container.querySelector(".ed-bookmark__title")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img.ed-bookmark__title img")).toBeNull();
  });

  it("uma URL com esquema javascript: renderiza o cartão, mas o clique não abre nada", () => {
    const container = document.createElement("div");
    const onOpen = vi.fn();
    renderBookmarkCard(container, { url: "javascript:alert(1)", title: "Malicioso", description: "", favicon: null }, onOpen);

    container.querySelector<HTMLElement>(".ed-bookmark__link")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("chamar de novo substitui o conteúdo em vez de duplicar (NodeView.update)", () => {
    const container = document.createElement("div");
    renderBookmarkCard(container, { url: "https://a.test", title: "A", description: "", favicon: null }, vi.fn());
    renderBookmarkCard(container, { url: "https://b.test", title: "B", description: "", favicon: null }, vi.fn());

    expect(container.querySelectorAll(".ed-bookmark__link")).toHaveLength(1);
    expect(container.querySelector(".ed-bookmark__title")?.textContent).toBe("B");
  });
});
