import { describe, expect, it } from "vitest";
import { parseLinkUrl } from "./link-url";

describe("EDT-043: validação da URL antes de virar link", () => {
  it("EDT-043: aceita http/https e normaliza a URL", () => {
    expect(parseLinkUrl("https://exemplo.com/pagina")).toBe("https://exemplo.com/pagina");
    expect(parseLinkUrl("  http://exemplo.com  ")).toBe("http://exemplo.com/");
  });

  it("EDT-043: aceita mailto", () => {
    expect(parseLinkUrl("mailto:pessoa@exemplo.com")).toBe("mailto:pessoa@exemplo.com");
  });

  it("EDT-043: entrada vazia não vira link", () => {
    expect(parseLinkUrl("")).toBeNull();
    expect(parseLinkUrl("   ")).toBeNull();
  });

  it("EDT-043: sem esquema reconhecido não vira link", () => {
    expect(parseLinkUrl("exemplo.com")).toBeNull();
    expect(parseLinkUrl("não é uma url")).toBeNull();
  });

  it("EDT-043: javascript: nunca vira link - vetor de XSS", () => {
    expect(parseLinkUrl("javascript:alert(1)")).toBeNull();
    expect(parseLinkUrl("  JavaScript:alert(1)  ")).toBeNull();
  });
});
