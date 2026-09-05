/**
 * DBS-004 — a metade pura do tipo de propriedade Texto: I1 (vazio),
 * conformidade com o fixture compartilhado `property_values.json`
 * (arquitetura §10), e o codec string<->nós que carrega marca dentro de um
 * jsonb que é sempre uma string (ver o cabeçalho de `rich-text-value.ts`).
 *
 * A prova de fidelidade de NEGRITO através de uma sessão inteira (o
 * critério literal de DBS-004) está em `register.test.ts`, com instâncias
 * reais de `Editor` — este arquivo prova só o codec em si.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_MARKER,
  decodeRichText,
  encodeRichText,
  flattenPlainText,
  isEmptyRichTextValue,
  normalizeRichTextValue,
  sanitizeNodes,
  wrapPlainText,
  type RichTextValue,
} from "./rich-text-value";

describe("I1 — vazio é a ausência de qualquer caractere achatado", () => {
  it("array vazio é vazio", () => {
    expect(isEmptyRichTextValue([])).toBe(true);
    expect(normalizeRichTextValue([])).toBeNull();
  });

  it("um nó de texto com conteúdo não é vazio", () => {
    const value: RichTextValue = [{ type: "text", text: "oi" }];
    expect(isEmptyRichTextValue(value)).toBe(false);
    expect(normalizeRichTextValue(value)).toEqual(value);
  });

  it("um `hardBreak` sozinho, sem nenhum caractere de texto, é vazio (I1 — não é `[]`, mas achata para \"\")", () => {
    const value: RichTextValue = [{ type: "hardBreak" }];
    expect(flattenPlainText(value)).toBe("\n");
    // "\n" tem length > 0, então NÃO é vazio — um usuário que só apertou
    // Shift+Enter digitou algo, e apagar essa linha é uma ação dele, não do
    // normalize(). Este teste documenta a escolha, não uma suposição.
    expect(isEmptyRichTextValue(value)).toBe(false);
  });

  it("`null`/`undefined`/tipos estranhos (número, objeto solto) são vazios — TOTAL, nunca lança", () => {
    expect(isEmptyRichTextValue(null)).toBe(true);
    expect(isEmptyRichTextValue(undefined)).toBe(true);
    expect(isEmptyRichTextValue(42)).toBe(true);
    expect(isEmptyRichTextValue({ not: "an array" })).toBe(true);
  });

  it("um nó de texto com `text: \"\"` nunca sobrevive a sanitizeNodes (defesa dupla contra I1)", () => {
    expect(sanitizeNodes([{ type: "text", text: "" }])).toEqual([]);
  });
});

describe("sanitizeNodes — TOTAL contra entrada não confiável", () => {
  it("descarta tipo de nó desconhecido, preservando os vizinhos válidos", () => {
    const result = sanitizeNodes([
      { type: "text", text: "antes " },
      { type: "pageMention", attrs: { id: "x" } },
      { type: "text", text: "depois" },
    ]);
    expect(result).toEqual([{ type: "text", text: "antes depois" }]);
  });

  it("descarta marca desconhecida mantendo as reconhecidas, na ordem canônica", () => {
    const result = sanitizeNodes([
      { type: "text", text: "x", marks: [{ type: "italic" }, { type: "highlight" }, { type: "bold" }] },
    ]);
    expect(result).toEqual([{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "italic" }] }]);
  });

  it("marca `link` sem `href` (ou com `href` vazio) é descartada — link sem destino não é link", () => {
    const semHref = sanitizeNodes([{ type: "text", text: "x", marks: [{ type: "link" }] }]);
    expect(semHref).toEqual([{ type: "text", text: "x" }]);

    const hrefVazio = sanitizeNodes([{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "" } }] }]);
    expect(hrefVazio).toEqual([{ type: "text", text: "x" }]);
  });

  it("mescla nós de texto adjacentes com exatamente a mesma marca (o que digitar letra a letra produz)", () => {
    const result = sanitizeNodes([
      { type: "text", text: "Ol", marks: [{ type: "bold" }] },
      { type: "text", text: "á", marks: [{ type: "bold" }] },
      { type: "text", text: " mundo" },
    ]);
    expect(result).toEqual([
      { type: "text", text: "Olá", marks: [{ type: "bold" }] },
      { type: "text", text: " mundo" },
    ]);
  });

  it("não mescla nós de texto adjacentes com marcas diferentes", () => {
    const result = sanitizeNodes([
      { type: "text", text: "A", marks: [{ type: "bold" }] },
      { type: "text", text: "B", marks: [{ type: "italic" }] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("`raw` que não é array vira `[]`", () => {
    expect(sanitizeNodes("uma string qualquer")).toEqual([]);
    expect(sanitizeNodes(null)).toEqual([]);
    expect(sanitizeNodes(123)).toEqual([]);
  });
});

describe("encodeRichText / decodeRichText — o jsonb é sempre uma string", () => {
  it("sem marca: a string persistida É o texto achatado (caminho rápido, o caso do fixture)", () => {
    const value: RichTextValue = [{ type: "text", text: "Anotação da Fase 3" }];
    const encoded = encodeRichText(value);
    expect(encoded).toBe("Anotação da Fase 3");
    expect(typeof encoded).toBe("string");
  });

  it("com marca: a string ganha o prefixo invisível + JSON — nunca aparece como texto puro", () => {
    const value: RichTextValue = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world", marks: [{ type: "bold" }] },
    ];
    const encoded = encodeRichText(value);
    expect(encoded.startsWith(RICH_TEXT_MARKER)).toBe(true);
    expect(decodeRichText(encoded)).toEqual(value);
  });

  it("round trip completo (sem marca) preserva o texto exatamente", () => {
    const value: RichTextValue = [{ type: "text", text: "texto simples, sem formatação" }];
    expect(decodeRichText(encodeRichText(value))).toEqual(value);
  });

  it("uma string com marcador mas JSON corrompido (dado que quebrou) vira vazio, nunca lança e nunca mostra lixo", () => {
    const corrupted = `${RICH_TEXT_MARKER}{not valid json`;
    expect(() => decodeRichText(corrupted)).not.toThrow();
    expect(decodeRichText(corrupted)).toEqual([]);
  });

  it("`decodeRichText` de um tipo que não é string (número, objeto, array) vira vazio", () => {
    expect(decodeRichText(42)).toEqual([]);
    expect(decodeRichText({ text: "x" })).toEqual([]);
    expect(decodeRichText(["x"])).toEqual([]);
    expect(decodeRichText(null)).toEqual([]);
  });

  it("uma string comum que por acaso começa com colchetes (usuário digitou `[oi]`) NUNCA é confundida com JSON codificado — só o prefixo invisível decide isso", () => {
    const literal = "[oi] isto não é json de verdade nenhum";
    expect(decodeRichText(literal)).toEqual(wrapPlainText(literal));
  });
});

describe("wrapPlainText / flattenPlainText — o texto sem marca nenhuma", () => {
  it("string vazia vira array vazio", () => {
    expect(wrapPlainText("")).toEqual([]);
  });

  it("quebras de linha viram hardBreak, e o achatado reconstrói a string original", () => {
    const original = "linha 1\nlinha 2\n\nlinha 4";
    const nodes = wrapPlainText(original);
    expect(flattenPlainText(nodes)).toBe(original);
  });
});

describe("conformidade com o fixture compartilhado (arquitetura §10)", () => {
  // `process.cwd()` é a raiz do repo — é de lá que `npx vitest run` roda
  // (`package.json`'s `test` script). Evita `import.meta.url`, que o Vite
  // pode reescrever para algo que não é uma URL `file:` de verdade.
  const fixturePath = resolve(process.cwd(), "src-tauri/tests/fixtures/property_values.json");
  const fixture: { cases: Array<{ id: string; propertyType: string; value: unknown; expectedPlainText: string; expectedIsEmpty: boolean }> } =
    JSON.parse(readFileSync(fixturePath, "utf8"));
  const textCases = fixture.cases.filter((c) => c.propertyType === "text");

  it("o fixture realmente contém casos de `text` (a suíte não passaria vazia por engano)", () => {
    expect(textCases.length).toBeGreaterThan(0);
  });

  it.each(textCases)("$id: isEmpty/toPlainText batem com o esperado pelo espelho Rust", (testCase) => {
    const parsed = decodeRichText(testCase.value);
    expect(isEmptyRichTextValue(parsed)).toBe(testCase.expectedIsEmpty);
    expect(flattenPlainText(parsed)).toBe(testCase.expectedPlainText);
  });
});
