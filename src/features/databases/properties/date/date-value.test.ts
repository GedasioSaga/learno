import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_CONFIG, dateSortKey, isEmptyDateValue, normalizeDateValue, parseDateValue, toPlainTextDateValue } from "./date-value";

describe("DEFAULT_DATE_CONFIG", () => {
  it("nasce com include time e end date desligados — dia solto é o caso mais comum (DBS-010)", () => {
    expect(DEFAULT_DATE_CONFIG).toEqual({ includeTime: false, hasEnd: false });
  });
});

describe("I1 — isEmptyDateValue: o único vazio é a ausência de um start válido", () => {
  it("null/undefined são vazios", () => {
    expect(isEmptyDateValue(null)).toBe(true);
    expect(isEmptyDateValue(undefined)).toBe(true);
  });

  it("objeto sem start, com start vazio, ou com start fora da forma ISO, é vazio", () => {
    expect(isEmptyDateValue({})).toBe(true);
    expect(isEmptyDateValue({ start: "" })).toBe(true);
    expect(isEmptyDateValue({ start: "15/03/2026" })).toBe(true); // dd/mm/aaaa não é a forma de I5
    expect(isEmptyDateValue({ end: "2026-03-15" })).toBe(true); // end sem start não é um DateValue válido
  });

  it("um DateValue válido, com ou sem end, nunca é vazio", () => {
    expect(isEmptyDateValue({ start: "2026-03-15" })).toBe(false);
    expect(isEmptyDateValue({ start: "2026-03-15", end: "2026-03-20" })).toBe(false);
  });
});

describe("parseDateValue / normalizeDateValue — caminho de escrita (I1)", () => {
  it("um start fora da forma NUNCA chega ao Postgres como {start:''}: devolve null (apaga a linha)", () => {
    // É isto que impede `chk_drv_iso_date_shape` de estourar como erro de SQL cru na tela do usuário.
    expect(parseDateValue({ start: "não é data" })).toBeNull();
    expect(parseDateValue("2026-03-15")).toBeNull(); // string nua não é o shape { start }
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue([])).toBeNull();
  });

  it("um end fora da forma é descartado sozinho — mantém o start, não derruba o registro inteiro", () => {
    expect(parseDateValue({ start: "2026-03-15", end: "lixo" })).toEqual({ start: "2026-03-15" });
  });

  it("start e end válidos preservam os dois", () => {
    expect(parseDateValue({ start: "2026-03-01", end: "2026-03-05" })).toEqual({
      start: "2026-03-01",
      end: "2026-03-05",
    });
  });

  it("normalizeDateValue concorda byte a byte com parseDateValue — a config não muda o que é canônico para Data", () => {
    const inputs: unknown[] = [{ start: "2026-03-15" }, { start: "2026-03-15", end: "lixo" }, null, "2026-03-15"];
    for (const input of inputs) {
      expect(normalizeDateValue(input)).toEqual(parseDateValue(input));
    }
  });
});

describe("toPlainTextDateValue — determinística, sem locale (arquitetura §6), espelhada em record_values.rs", () => {
  it("vazio é string vazia", () => {
    expect(toPlainTextDateValue(null)).toBe("");
  });

  it("só início: o próprio ISO, sem formatação pt-BR", () => {
    expect(toPlainTextDateValue({ start: "2026-02-01" })).toBe("2026-02-01");
  });

  it('intervalo: "início – fim" com travessão (U+2013), ISO dos dois lados', () => {
    expect(toPlainTextDateValue({ start: "2026-01-01", end: "2026-01-02" })).toBe("2026-01-01 – 2026-01-02");
  });
});

/**
 * Único `as` deste arquivo: o `typeof value === "object" && value !== null`
 * imediatamente antes já prova, em runtime, que é seguro indexar por
 * string. Duplica o helper privado de `date-value.ts` de propósito — é
 * teste, não produção, e importar um símbolo não-exportado do módulo sob
 * teste criaria acoplamento na direção errada.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

interface SharedFixtureCase {
  id: string;
  propertyType: string;
  value: unknown;
  expectedPlainText: string;
  expectedIsEmpty: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_FIXTURE_PATH = resolve(HERE, "../../../../../src-tauri/tests/fixtures/property_values.json");

/**
 * Lido do MESMO arquivo que `src-tauri/src/db/record_values.rs` embute via
 * `include_str!` (arquitetura §10: "o fixture é fabricado em UM lugar e as
 * três representações são obrigadas a concordar"). Esta pasta é dona de
 * `properties/date/`, não de `src-tauri/tests/fixtures/` — este teste só LÊ
 * o fixture compartilhado, nunca escreve nele.
 */
function readSharedDateFixtureCases(): SharedFixtureCase[] {
  const parsed = asRecord(JSON.parse(readFileSync(SHARED_FIXTURE_PATH, "utf8")));
  const rawCases = parsed?.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error('src-tauri/tests/fixtures/property_values.json: esperava um array em "cases"');
  }
  // O predicado confia no formato já verificado pelo próprio `cargo test`
  // deste fixture (`normalize_agrees_with_every_fixture_case_is_empty`) —
  // aqui só filtramos por propertyType, sem revalidar o arquivo inteiro.
  return rawCases.filter((entry): entry is SharedFixtureCase => asRecord(entry)?.propertyType === "date");
}

describe("conformidade com o fixture compartilhado (arquitetura §10)", () => {
  const dateCases = readSharedDateFixtureCases();

  it("o fixture compartilhado tem pelo menos um caso de date para este teste valer algo", () => {
    expect(dateCases.length).toBeGreaterThan(0);
  });

  it.each(dateCases.map((testCase) => [testCase.id, testCase] as const))(
    "%s: isEmpty e toPlainText batem com o espelho Rust",
    (_id, testCase) => {
      expect(isEmptyDateValue(testCase.value)).toBe(testCase.expectedIsEmpty);
      expect(toPlainTextDateValue(parseDateValue(testCase.value))).toBe(testCase.expectedPlainText);
    },
  );
});

describe("I2 — ordenar por dateSortKey (espelha sort_text = value->>'start') é cronológico mesmo com formas misturadas", () => {
  it("misturando registros só-início e início+fim na mesma propriedade, a ordem por dateSortKey é a cronológica", () => {
    const records = [
      { id: "d", value: { start: "2026-03-01", end: "2026-05-01" } },
      { id: "b", value: { start: "2026-01-10" } },
      { id: "a", value: { start: "2026-01-01", end: "2026-01-02" } },
      { id: "c", value: { start: "2026-02-01" } },
    ];
    const sorted = [...records].sort((x, y) => dateSortKey(x.value).localeCompare(dateSortKey(y.value)));
    expect(sorted.map((record) => record.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a armadilha que I2 nomeia: ordenar pelo NÚMERO DE CHAVES do valor (o que jsonb faz em ORDER BY value) inverte este par", () => {
    // Verificado na arquitetura (§2, I2):
    // '{"start":"2026-01-01","end":"2026-01-02"}'::jsonb > '{"start":"2026-02-01"}'::jsonb é `true`,
    // porque jsonb compara objeto por quantidade de chaves antes do conteúdo.
    const earlierWithEnd = { start: "2026-01-01", end: "2026-01-02" }; // 2 chaves, cronologicamente ANTES
    const laterAlone = { start: "2026-02-01" }; // 1 chave, cronologicamente DEPOIS

    const byKeyCountAscending = [laterAlone, earlierWithEnd].sort((a, b) => Object.keys(a).length - Object.keys(b).length);
    // A ordem que I2 descreve como ERRADA: o de 1 chave (fevereiro) vem antes do de 2 chaves (janeiro).
    expect(byKeyCountAscending).toEqual([laterAlone, earlierWithEnd]);

    // dateSortKey (o que sort_text de fato guarda) acerta os dois na ordem cronológica certa.
    const byDateSortKey = [laterAlone, earlierWithEnd].sort((a, b) => dateSortKey(a).localeCompare(dateSortKey(b)));
    expect(byDateSortKey).toEqual([earlierWithEnd, laterAlone]);
  });
});
