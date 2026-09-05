/**
 * DBS-054 — o teste central da armadilha I1: "oculta se vazia" NUNCA pode
 * confundir falsy com vazio. Número `0` e Checkbox `false` (valor legítimo
 * de fórmula, arquitetura §2) têm que continuar visíveis. Os specs de teste
 * abaixo são test doubles, mesmo espírito de `core/property-spec.test.ts` —
 * não são o Número/Checkbox de verdade (isso é de P1..P7), só provam que
 * `visibility.ts` respeita `PropertySpec.isEmpty()` corretamente.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { registerPropertySpec, resetPropertySpecRegistryForTests, type PropertyDescriptor, type PropertySpec } from "../core/property-spec";
import type { RecordRow } from "../contract";
import { createEmptyViewConfig } from "./codec";
import { getColumnVisibilityMode, isPropertyVisibleForRecord, resolveVisibleProperties, setColumnVisibility } from "./visibility";

const numberSpec: PropertySpec<number, Record<string, never>> = {
  type: "vc_test_number",
  label: "Número (teste)",
  icon: "#",
  valueShape: "number",
  defaultConfig: {},
  isEmpty: (value) => value === null || value === undefined,
  normalize: (value) => (typeof value === "number" ? value : null),
  parse: (raw) => (typeof raw === "number" ? raw : 0),
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  sort: "num",
  toPlainText: (value) => (value === null ? "" : String(value)),
};

const checkboxSpec: PropertySpec<boolean, Record<string, never>> = {
  type: "vc_test_checkbox",
  label: "Checkbox (teste)",
  icon: "☑",
  valueShape: "boolean",
  defaultConfig: {},
  isEmpty: (value) => value === null || value === undefined,
  normalize: (value) => (value === true ? true : null),
  parse: (raw) => raw === true,
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["isChecked", "isNotChecked"],
  sort: "none",
  toPlainText: (value) => (value ? "sim" : "não"),
};

function property(overrides: Partial<PropertyDescriptor> & Pick<PropertyDescriptor, "id" | "type">): PropertyDescriptor {
  return { databaseId: "db1", name: overrides.id, config: {}, position: "1", ...overrides };
}

function record(values: RecordRow["values"]): RecordRow {
  return {
    id: "r1",
    title: "Registro",
    icon: null,
    parentId: null,
    position: "1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    values,
    matchedColorRuleIds: [],
  };
}

beforeEach(() => {
  resetPropertySpecRegistryForTests();
  registerPropertySpec(numberSpec);
  registerPropertySpec(checkboxSpec);
});

describe("getColumnVisibilityMode", () => {
  it("propriedade nunca configurada é 'always' por padrão", () => {
    expect(getColumnVisibilityMode(createEmptyViewConfig(), "facilidade")).toBe("always");
  });

  it("setColumnVisibility grava só a chave pedida, sem tocar nas demais", () => {
    const base = setColumnVisibility(createEmptyViewConfig(), "p1", "never");
    const next = setColumnVisibility(base, "p2", "hide_when_empty");
    expect(next.columnVisibility).toEqual({ p1: "never", p2: "hide_when_empty" });
  });
});

describe("DBS-054 — 'sempre visível' e 'sempre oculta' não olham o valor", () => {
  it("'always' mostra mesmo com a propriedade ausente do registro", () => {
    const config = createEmptyViewConfig(); // default = always
    const prop = property({ id: "facilidade", type: "vc_test_number" });
    expect(isPropertyVisibleForRecord(config, prop, record({}))).toBe(true);
  });

  it("'never' esconde mesmo com um valor presente e não-vazio", () => {
    const config = setColumnVisibility(createEmptyViewConfig(), "facilidade", "never");
    const prop = property({ id: "facilidade", type: "vc_test_number" });
    expect(isPropertyVisibleForRecord(config, prop, record({ facilidade: 5 }))).toBe(false);
  });
});

describe("DBS-054 + I1 — 'oculta se vazia' nunca confunde falsy com vazio", () => {
  const config = setColumnVisibility(createEmptyViewConfig(), "facilidade", "hide_when_empty");

  it("Número 0 PRESENTE no registro continua visível — não é vazio", () => {
    const prop = property({ id: "facilidade", type: "vc_test_number" });
    expect(isPropertyVisibleForRecord(config, prop, record({ facilidade: 0 }))).toBe(true);
  });

  it("Checkbox false PRESENTE (valor legítimo de fórmula) continua visível — não é vazio", () => {
    const boolConfig = setColumnVisibility(createEmptyViewConfig(), "aprovado", "hide_when_empty");
    const prop = property({ id: "aprovado", type: "vc_test_checkbox" });
    expect(isPropertyVisibleForRecord(boolConfig, prop, record({ aprovado: false }))).toBe(true);
  });

  it("propriedade AUSENTE do mapa de valores é vazia (I1) — some da view", () => {
    const prop = property({ id: "facilidade", type: "vc_test_number" });
    expect(isPropertyVisibleForRecord(config, prop, record({}))).toBe(false);
  });

  it("uma implementação ingênua com `!value` erraria os dois casos acima — é exatamente o que este teste está travando", () => {
    const naiveHideWhenEmpty = (value: unknown) => !value; // `hide` quando isto é `true`
    expect(naiveHideWhenEmpty(0)).toBe(true); // errado: esconderia o 0
    expect(naiveHideWhenEmpty(false)).toBe(true); // errado: esconderia o false de fórmula
    // A implementação real, ao contrário, mostra os dois:
    const numberProp = property({ id: "facilidade", type: "vc_test_number" });
    expect(isPropertyVisibleForRecord(config, numberProp, record({ facilidade: 0 }))).toBe(true);
  });

  it("propriedade de tipo não registrado (build futuro) é mostrada por padrão em vez de escondida às cegas", () => {
    const unknownTypeConfig = setColumnVisibility(createEmptyViewConfig(), "campo_novo", "hide_when_empty");
    const prop = property({ id: "campo_novo", type: "tipo_de_uma_versao_futura" });
    expect(isPropertyVisibleForRecord(unknownTypeConfig, prop, record({ campo_novo: "qualquer coisa" }))).toBe(true);
  });
});

describe("resolveVisibleProperties", () => {
  it("filtra a lista de propriedades preservando a ordem recebida", () => {
    const config = setColumnVisibility(createEmptyViewConfig(), "p2", "never");
    const properties = [
      property({ id: "p1", type: "vc_test_number" }),
      property({ id: "p2", type: "vc_test_number" }),
      property({ id: "p3", type: "vc_test_number" }),
    ];
    const visible = resolveVisibleProperties(config, properties, record({ p1: 1, p2: 2, p3: 3 }));
    expect(visible.map((p) => p.id)).toEqual(["p1", "p3"]);
  });
});
