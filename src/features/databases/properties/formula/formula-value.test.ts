/**
 * A forma em memória da coluna calculada: I1 aplicada (`0`, `false` e `""`
 * são VALORES), o sentinela de erro que o carregador grava quando a
 * expressão não compila, e a formatação por forma de `Value::to_json()`.
 */
import { describe, expect, it } from "vitest";
import {
  formatFormulaValue,
  formulaErrorValue,
  formulaValueToPlainText,
  isEmptyFormulaValue,
  isFormulaErrorValue,
  parseFormulaConfig,
  parseFormulaValue,
} from "./formula-value";

describe("I1 numa coluna de fórmula", () => {
  it("0, false e '' são valores; só null/undefined e o erro são vazios", () => {
    expect(isEmptyFormulaValue(0)).toBe(false);
    expect(isEmptyFormulaValue(false)).toBe(false);
    expect(isEmptyFormulaValue("")).toBe(false);
    expect(isEmptyFormulaValue(null)).toBe(true);
    expect(isEmptyFormulaValue(undefined)).toBe(true);
    expect(isEmptyFormulaValue(formulaErrorValue("não compila"))).toBe(true);
  });

  it("lista sem itens é vazia (convenção de multi_select/files); lista com item não é", () => {
    expect(isEmptyFormulaValue([])).toBe(true);
    expect(isEmptyFormulaValue([0])).toBe(false);
  });

  it("parse é total: undefined (propriedade ausente do mapa) vira null; o resto passa como veio", () => {
    expect(parseFormulaValue(undefined)).toBeNull();
    expect(parseFormulaValue(42)).toBe(42);
    expect(parseFormulaValue({ start: "2026-03-15" })).toEqual({ start: "2026-03-15" });
  });
});

describe("o sentinela de erro de coluna", () => {
  it("é reconhecido, e nenhuma forma do Rust (data, pessoa, lista) é confundida com ele", () => {
    expect(isFormulaErrorValue(formulaErrorValue("x"))).toBe(true);
    expect(isFormulaErrorValue({ start: "2026-03-15", end: null })).toBe(false);
    expect(isFormulaErrorValue({ name: "Ana", email: null })).toBe(false);
    expect(isFormulaErrorValue([1, 2])).toBe(false);
    expect(isFormulaErrorValue("formulaError")).toBe(false);
  });

  it("formata como vazio nos dois caminhos de texto — a célula é quem mostra o erro", () => {
    expect(formatFormulaValue(formulaErrorValue("x"))).toBe("");
    expect(formulaValueToPlainText(formulaErrorValue("x"))).toBe("");
  });
});

describe("formatação por forma de Value::to_json()", () => {
  it("número usa a formatação pt-BR da tela e String() no texto puro", () => {
    expect(formatFormulaValue(1234.5)).toBe("1.234,5");
    expect(formulaValueToPlainText(1234.5)).toBe("1234.5");
  });

  it("booleano vira Sim/Não na tela e sim/não no texto puro", () => {
    expect(formatFormulaValue(true)).toBe("Sim");
    expect(formulaValueToPlainText(false)).toBe("não");
  });

  it("data usa o formato longo pt-BR na tela e o ISO cru no texto puro", () => {
    expect(formatFormulaValue({ start: "2026-03-15", end: null })).toBe("15 de março de 2026");
    expect(formulaValueToPlainText({ start: "2026-03-01", end: "2026-03-05" })).toBe("2026-03-01 → 2026-03-05");
  });

  it("lista junta os itens por vírgula, pulando os vazios; pessoa mostra o nome", () => {
    expect(formatFormulaValue([1, null, "a"])).toBe("1, a");
    expect(formatFormulaValue({ name: "Ana", email: null })).toBe("Ana");
  });

  it("uma forma desconhecida vira o JSON dela em vez de lançar (uma célula não derruba a view)", () => {
    expect(formatFormulaValue({ x: 1 })).toBe('{"x":1}');
  });
});

describe("a config", () => {
  it("lê `expression` da config crua e cai para vazio quando ela não existe", () => {
    expect(parseFormulaConfig({ expression: "1 + 1" })).toEqual({ expression: "1 + 1" });
    expect(parseFormulaConfig({})).toEqual({ expression: "" });
    expect(parseFormulaConfig(null)).toEqual({ expression: "" });
  });
});
