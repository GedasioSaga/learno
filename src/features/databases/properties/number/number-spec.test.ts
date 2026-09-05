/**
 * DBS-005 — o critério é literal: guarda `0.25` e MOSTRA "25%"; trocando
 * para moeda BRL, "R$ 0,25". O valor gravado nunca muda com o formato — é
 * exatamente o que os testes de `formatNumberValue` vs. `normalize` provam
 * lado a lado abaixo.
 *
 * Também confere `isEmpty`/`normalize`/`parse` contra
 * `src-tauri/tests/fixtures/property_values.json` (arquitetura §10): o mesmo
 * arquivo que `record_values.rs` lê do lado Rust, para as três
 * representações (TS, Rust, coluna gerada) nunca divergirem em silêncio.
 */
import { describe, expect, it } from "vitest";
import fixture from "../../../../../src-tauri/tests/fixtures/property_values.json";
import { formatNumberValue, numberPropertySpec } from "./number-spec";

describe("numberPropertySpec — I1 (0 nunca é vazio)", () => {
  it("normalize mantém 0 como valor, nunca apaga a linha", () => {
    expect(numberPropertySpec.normalize(0, { format: "plain" })).toBe(0);
  });

  it("isEmpty(0) é false — a armadilha que `if (!value)` erraria", () => {
    expect(numberPropertySpec.isEmpty(0, { format: "plain" })).toBe(false);
  });

  it("isEmpty(null/undefined) é true", () => {
    expect(numberPropertySpec.isEmpty(null, { format: "plain" })).toBe(true);
    expect(numberPropertySpec.isEmpty(undefined, { format: "plain" })).toBe(true);
  });

  it("normalize apaga null/undefined/string/NaN/Infinity", () => {
    expect(numberPropertySpec.normalize(null, { format: "plain" })).toBeNull();
    expect(numberPropertySpec.normalize(undefined, { format: "plain" })).toBeNull();
    expect(numberPropertySpec.normalize("42", { format: "plain" })).toBeNull();
    expect(numberPropertySpec.normalize(Number.NaN, { format: "plain" })).toBeNull();
    expect(numberPropertySpec.normalize(Number.POSITIVE_INFINITY, { format: "plain" })).toBeNull();
  });

  it("parse é TOTAL: nunca lança, valor corrompido vira null (vazio)", () => {
    expect(numberPropertySpec.parse("não é número")).toBeNull();
    expect(numberPropertySpec.parse(null)).toBeNull();
    expect(numberPropertySpec.parse(undefined)).toBeNull();
    expect(numberPropertySpec.parse(42.5)).toBe(42.5);
    expect(numberPropertySpec.parse(0)).toBe(0);
  });
});

describe("DBS-005 — formato muda a APRESENTAÇÃO, nunca o valor gravado", () => {
  it("0.25 em percent mostra 25%", () => {
    expect(formatNumberValue(0.25, "percent")).toBe("25%");
  });

  it("0.25 em moeda BRL mostra R$ 0,25 (literal do critério)", () => {
    expect(formatNumberValue(0.25, "currency_brl")).toBe("R$ 0,25");
  });

  it("0.25 em plain mostra 0,25", () => {
    expect(formatNumberValue(0.25, "plain")).toBe("0,25");
  });

  it("trocar o format nunca reescreve o que normalize grava", () => {
    const written = numberPropertySpec.normalize(0.25, { format: "plain" });
    // A mesma escrita, independente de qual format está configurado agora.
    expect(numberPropertySpec.normalize(0.25, { format: "percent" })).toBe(written);
    expect(numberPropertySpec.normalize(0.25, { format: "currency_brl" })).toBe(written);
  });
});

describe("toPlainText — determinística, nunca formatada (CSV/busca)", () => {
  it("não aplica % nem R$: é o número cru", () => {
    expect(numberPropertySpec.toPlainText(0.25, { format: "percent" })).toBe("0.25");
    expect(numberPropertySpec.toPlainText(0.25, { format: "currency_brl" })).toBe("0.25");
  });

  it("vazio (null) é string vazia", () => {
    expect(numberPropertySpec.toPlainText(null, { format: "plain" })).toBe("");
  });
});

describe("parsePlainText — import de CSV/colagem", () => {
  it("parseia um número válido", () => {
    expect(numberPropertySpec.parsePlainText?.("42.5", { format: "plain" })).toBe(42.5);
  });

  it("texto vazio ou não numérico devolve null", () => {
    expect(numberPropertySpec.parsePlainText?.("", { format: "plain" })).toBeNull();
    expect(numberPropertySpec.parsePlainText?.("abc", { format: "plain" })).toBeNull();
  });
});

interface FixtureCase {
  id: string;
  propertyType: string;
  config: Record<string, unknown>;
  value: unknown;
  expectedPlainText: string;
  expectedIsEmpty: boolean;
}

// `as`: TS infere `fixture.cases` como a união estrutural de TODAS as formas
// de caso do arquivo (texto, número, checkbox, select, ...) porque o import
// JSON não tem um único shape; o cast pega só o subconjunto de campos que
// este teste lê (todos presentes em todo caso, por contrato do próprio
// fixture) — não esconde um erro de tipo real, só nomeia o subtipo usado aqui.
const numberCases = (fixture.cases as FixtureCase[]).filter((c) => c.propertyType === "number");

describe("conformidade com o fixture compartilhado (arquitetura §10)", () => {
  it("o fixture tem ao menos um caso de number", () => {
    expect(numberCases.length).toBeGreaterThan(0);
  });

  it.each(numberCases)("$id: isEmpty/toPlainText batem com o esperado", (testCase) => {
    // `as const`: sem isso `format` infere como `string` (largo demais para
    // `NumberConfig`); o spread depois SOBRESCREVE com o `format` real do
    // fixture quando o caso declarar um — não é um valor inventado.
    const config = { format: "plain" as const, ...testCase.config };
    expect(numberPropertySpec.isEmpty(testCase.value, config)).toBe(testCase.expectedIsEmpty);
    const parsed = numberPropertySpec.parse(testCase.value);
    expect(numberPropertySpec.toPlainText(parsed, config)).toBe(testCase.expectedPlainText);
  });
});
