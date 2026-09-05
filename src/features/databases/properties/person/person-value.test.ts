/**
 * Duas camadas de prova, na ordem da lição de `docs/ACHADOS-FASE-2.md`
 * ("JSON fabricado não prova gatilho"): primeiro contra o fixture
 * COMPARTILHADO que `src-tauri/src/db/record_values.rs` já usa para provar o
 * espelho Rust (arquitetura §10 — um só lugar fabrica os casos, TS e Rust
 * são obrigados a concordar com ELE, não um com o outro por coincidência);
 * depois os casos de borda que o fixture não cobre (nome só espaço, e-mail
 * mal formado, objeto corrompido).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_PERSON_VALUE, formatPersonPlainText, isPersonValueEmpty, normalizePersonValue, parsePersonValue } from "./person-value";

const here = dirname(fileURLToPath(import.meta.url));

interface FixtureCase {
  id: string;
  propertyType: string;
  value: unknown;
  expectedPlainText: string;
  expectedIsEmpty: boolean;
}

function loadPersonFixtureCases(): FixtureCase[] {
  const raw = readFileSync(join(here, "../../../../../src-tauri/tests/fixtures/property_values.json"), "utf8");
  const fixture = JSON.parse(raw) as { cases: FixtureCase[] };
  return fixture.cases.filter((c) => c.propertyType === "person");
}

describe("person contra o fixture compartilhado (arquitetura §10)", () => {
  const cases = loadPersonFixtureCases();

  it("o fixture tem pelo menos um caso de 'person' (senão este teste prova vazio)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(loadPersonFixtureCases())("$id: isEmpty/toPlainText batem com o fixture", (fixtureCase) => {
    expect(isPersonValueEmpty(fixtureCase.value)).toBe(fixtureCase.expectedIsEmpty);
    const parsed = normalizePersonValue(fixtureCase.value);
    expect(formatPersonPlainText(parsed)).toBe(fixtureCase.expectedPlainText);
  });
});

describe("normalizePersonValue — I1 e bordas fora do fixture", () => {
  it("nome só espaço normaliza para null (I1: sem nome não é contato)", () => {
    expect(normalizePersonValue({ name: "   ", email: null })).toBeNull();
  });

  it("e-mail mal formado vira null, mas mantém o nome (não reprova o valor inteiro)", () => {
    expect(normalizePersonValue({ name: "Bia", email: "não é email" })).toEqual({ name: "Bia", email: null });
  });

  it("apara espaço nas pontas do nome e do e-mail", () => {
    expect(normalizePersonValue({ name: "  Duda  ", email: " duda@example.com " })).toEqual({
      name: "Duda",
      email: "duda@example.com",
    });
  });

  it("objeto sem campo `name`, array e `null` são vazios (I1 genérico)", () => {
    expect(normalizePersonValue({})).toBeNull();
    expect(normalizePersonValue([])).toBeNull();
    expect(normalizePersonValue(null)).toBeNull();
    expect(normalizePersonValue("Ana")).toBeNull();
  });

  it("o sentinela de apagar (`EMPTY_PERSON_VALUE`) normaliza para null", () => {
    expect(normalizePersonValue(EMPTY_PERSON_VALUE)).toBeNull();
  });
});

describe("parsePersonValue — TOTAL, nunca lança", () => {
  it("valor corrompido vira o sentinela vazio, não uma exceção", () => {
    expect(parsePersonValue(undefined)).toEqual({ name: "", email: null });
    expect(parsePersonValue(42)).toEqual({ name: "", email: null });
    expect(parsePersonValue({ email: "sem-nome@example.com" })).toEqual({ name: "", email: null });
  });

  it("valor válido faz round-trip", () => {
    expect(parsePersonValue({ name: "Ana Silva", email: "ana@example.com" })).toEqual({
      name: "Ana Silva",
      email: "ana@example.com",
    });
  });
});
