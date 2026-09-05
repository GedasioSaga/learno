/**
 * DBS-017 + I1: a asserção central desta suíte é sobre ZERO LINHAS, não
 * "valor false" — o mesmo cuidado que `record_values.rs`'s
 * `checkbox_false_is_the_named_exception_that_erases` prova do lado Rust.
 * `normalize(false) === null` É a prova de zero linhas no lado TS: `null` é
 * o sinal (arquitetura §6, `PropertySpec.normalize`) para "apague a linha em
 * vez de escrever".
 */
import { describe, expect, it } from "vitest";
import fixture from "../../../../../src-tauri/tests/fixtures/property_values.json";
import { checkboxPropertySpec } from "./checkbox-spec";

describe("checkboxPropertySpec — I1 (desmarcado é ausência da linha)", () => {
  it("normalize(false) apaga a linha — não grava `false`", () => {
    expect(checkboxPropertySpec.normalize(false, {})).toBeNull();
  });

  it("50.000 cards desmarcados são 0 linhas: normalize(false) é sempre null, nunca `false`", () => {
    const desmarcados = Array.from({ length: 50_000 }, () => checkboxPropertySpec.normalize(false, {}));
    const linhasGravadas = desmarcados.filter((row) => row !== null);
    expect(linhasGravadas).toHaveLength(0);
  });

  it("normalize(true) mantém a linha com o valor true", () => {
    expect(checkboxPropertySpec.normalize(true, {})).toBe(true);
  });

  it("isEmpty(false) é true — ao contrário da fórmula booleana, checkbox NÃO é a exceção nomeada de I1", () => {
    expect(checkboxPropertySpec.isEmpty(false, {})).toBe(true);
  });

  it("isEmpty(true) é false", () => {
    expect(checkboxPropertySpec.isEmpty(true, {})).toBe(false);
  });

  it("isEmpty(null/undefined) é true — propriedade AUSENTE do mapa (I1)", () => {
    expect(checkboxPropertySpec.isEmpty(null, {})).toBe(true);
    expect(checkboxPropertySpec.isEmpty(undefined, {})).toBe(true);
  });

  it("parse é TOTAL: só `true` literal mostra marcado, tudo mais mostra desmarcado", () => {
    expect(checkboxPropertySpec.parse(true)).toBe(true);
    expect(checkboxPropertySpec.parse(false)).toBe(false);
    expect(checkboxPropertySpec.parse(undefined)).toBe(false);
    expect(checkboxPropertySpec.parse(null)).toBe(false);
    expect(checkboxPropertySpec.parse("true")).toBe(false); // string, não boolean
  });

  it("toPlainText: Sim quando marcado, string vazia quando vazio", () => {
    expect(checkboxPropertySpec.toPlainText(true, {})).toBe("Sim");
    expect(checkboxPropertySpec.toPlainText(null, {})).toBe("");
    expect(checkboxPropertySpec.toPlainText(false, {})).toBe("");
  });
});

interface FixtureCase {
  id: string;
  propertyType: string;
  value: unknown;
  expectedPlainText: string;
  expectedIsEmpty: boolean;
}

// `as unknown as`: mesmo motivo de `number-spec.test.ts` — a união
// estrutural que TS infere do JSON do fixture (formas bem diferentes por
// caso) não converte direto para o subconjunto de campos que este arquivo
// lê; o `unknown` intermediário é exigido pelo TS quando as duas formas não
// se sobrepõem o bastante para um `as` direto, não para calar um erro real.
const checkboxCases = (fixture.cases as unknown as FixtureCase[]).filter((c) => c.propertyType === "checkbox");

describe("conformidade com o fixture compartilhado (arquitetura §10)", () => {
  it("o fixture tem os dois casos canônicos (true e false)", () => {
    expect(checkboxCases.length).toBeGreaterThanOrEqual(2);
  });

  it.each(checkboxCases)("$id: isEmpty/toPlainText batem com o esperado", (testCase) => {
    expect(checkboxPropertySpec.isEmpty(testCase.value, {})).toBe(testCase.expectedIsEmpty);
    const parsed = checkboxPropertySpec.parse(testCase.value);
    expect(checkboxPropertySpec.toPlainText(parsed, {})).toBe(testCase.expectedPlainText);
  });
});
