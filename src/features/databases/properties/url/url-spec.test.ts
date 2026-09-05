import { describe, expect, it } from "vitest";
import { urlPropertySpec } from "./url-spec";

describe("urlPropertySpec — I1", () => {
  it("normalize apaga string vazia, só espaços, e não-string", () => {
    expect(urlPropertySpec.normalize("", {})).toBeNull();
    expect(urlPropertySpec.normalize("   ", {})).toBeNull();
    expect(urlPropertySpec.normalize(null, {})).toBeNull();
    expect(urlPropertySpec.normalize(undefined, {})).toBeNull();
    expect(urlPropertySpec.normalize(42, {})).toBeNull();
  });

  it("normalize apara espaço nas pontas mas mantém a URL", () => {
    expect(urlPropertySpec.normalize("  https://example.com  ", {})).toBe("https://example.com");
  });

  it("isEmpty concorda com normalize", () => {
    expect(urlPropertySpec.isEmpty("", {})).toBe(true);
    expect(urlPropertySpec.isEmpty(null, {})).toBe(true);
    expect(urlPropertySpec.isEmpty("https://example.com", {})).toBe(false);
  });

  it("parse é TOTAL: nunca lança, e não-string vira vazio", () => {
    expect(urlPropertySpec.parse("https://example.com")).toBe("https://example.com");
    expect(urlPropertySpec.parse(null)).toBeNull();
    expect(urlPropertySpec.parse(undefined)).toBeNull();
    expect(urlPropertySpec.parse(42)).toBeNull();
  });

  it("toPlainText devolve a URL crua ou string vazia", () => {
    expect(urlPropertySpec.toPlainText("https://example.com", {})).toBe("https://example.com");
    expect(urlPropertySpec.toPlainText(null, {})).toBe("");
  });

  it("parsePlainText (import de CSV) apara espaço e apaga vazio", () => {
    expect(urlPropertySpec.parsePlainText?.("  https://example.com  ", {})).toBe("https://example.com");
    expect(urlPropertySpec.parsePlainText?.("   ", {})).toBeNull();
  });

  it("NÃO recusa esquema hostil na escrita — a recusa é só no clique (ver url-cell.test.tsx)", () => {
    // Uma URL digitada pela metade, ou com um esquema que o clique vai
    // recusar depois, ainda é um texto legítimo para guardar enquanto o
    // usuário digita — I1 só cuida de vazio, não de "hostil".
    expect(urlPropertySpec.normalize("javascript:alert(1)", {})).toBe("javascript:alert(1)");
  });
});
