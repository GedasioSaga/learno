/**
 * O contrato do registro em si — e o trava-armadilha da fase (arquitetura
 * I1): `isEmpty` NUNCA pode ser implementado (nem chamado) como `!value`,
 * porque isso come o `0` do Número e o `false` do Checkbox. Um card com
 * Facilidade `0` sumindo do filtro "não vazio" é o bug mais provável desta
 * fase segundo a própria arquitetura, e a célula continua mostrando `0`,
 * então ninguém nota — por isso este teste existe antes de qualquer P1..P7
 * registrar um tipo de verdade.
 *
 * Os specs abaixo são test doubles (prefixo `spec_test_`), no mesmo espírito
 * de `core/block-spec.test.ts` da Fase 2: não implementam Número nem
 * Checkbox de verdade (isso é das peças P1..P7), só provam que a interface
 * `PropertySpec` permite — e o registro respeita — uma implementação
 * correta de `isEmpty`.
 */
import { describe, expect, it } from "vitest";
import {
  collectPropertySpecs,
  registerPropertySpec,
  resetPropertySpecRegistryForTests,
  specForPropertyType,
  type PropertySpec,
} from "./property-spec";

interface NumberConfig {
  format: "plain" | "percent";
}

const numberSpec: PropertySpec<number, NumberConfig> = {
  type: "spec_test_number",
  label: "Número (teste)",
  icon: "#",
  valueShape: "number",
  defaultConfig: { format: "plain" },
  // Implementação CORRETA: vazio é ausência de valor, nunca falsy.
  isEmpty: (value) => value === null || value === undefined,
  normalize: (value) => (typeof value === "number" ? value : null),
  parse: (raw) => (typeof raw === "number" ? raw : 0),
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  sort: "num",
  aggregations: ["sum", "average", "min", "max"],
  toPlainText: (value) => (value === null ? "" : String(value)),
};

interface CheckboxConfig {
  color: string;
}

const checkboxSpec: PropertySpec<boolean, CheckboxConfig> = {
  type: "spec_test_checkbox",
  label: "Checkbox (teste)",
  icon: "☑",
  valueShape: "boolean",
  defaultConfig: { color: "gray" },
  isEmpty: (value) => value === null || value === undefined,
  // `false` normaliza para `null` (apaga a linha) — é ISSO que I1 exige no
  // caminho de ESCRITA. `isEmpty`, abaixo, opera sobre o valor em memória
  // (inclusive o `false` legítimo de uma fórmula booleana) e não pode
  // confundir os dois papéis.
  normalize: (value) => (value === true ? true : null),
  parse: (raw) => raw === true,
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["isChecked", "isNotChecked"],
  sort: "none",
  toPlainText: (value) => (value ? "sim" : "não"),
};

describe("PropertySpec registry", () => {
  it("registra e resolve um tipo pelo property_type persistido", () => {
    registerPropertySpec(numberSpec);
    expect(specForPropertyType("spec_test_number")?.label).toBe("Número (teste)");
    expect(collectPropertySpecs().some((spec) => spec.type === "spec_test_number")).toBe(true);
  });

  it("um property_type que nenhum spec reivindica devolve undefined", () => {
    expect(specForPropertyType("tipo_de_uma_versao_futura")).toBeUndefined();
  });

  it("recusa registrar o mesmo type com valueShape diferente", () => {
    registerPropertySpec({ ...numberSpec, type: "spec_test_clash" });
    expect(() => registerPropertySpec({ ...checkboxSpec, type: "spec_test_clash" })).toThrow(/valueShape/);
  });

  it("re-registrar o mesmo type com o mesmo valueShape (hot reload) é aceito", () => {
    registerPropertySpec(numberSpec);
    expect(() => registerPropertySpec(numberSpec)).not.toThrow();
  });
});

describe("I1 — isEmpty não pode confundir falsy com vazio", () => {
  it("Número 0 não é vazio", () => {
    registerPropertySpec(numberSpec);
    const spec = specForPropertyType("spec_test_number");
    expect(spec?.isEmpty(0, { format: "plain" })).toBe(false);
  });

  it("Checkbox false não é vazio (é o valor legítimo de uma fórmula booleana)", () => {
    registerPropertySpec(checkboxSpec);
    const spec = specForPropertyType("spec_test_checkbox");
    expect(spec?.isEmpty(false, { color: "gray" })).toBe(false);
  });

  it("null e undefined são vazios para os dois tipos", () => {
    registerPropertySpec(numberSpec);
    registerPropertySpec(checkboxSpec);
    expect(specForPropertyType("spec_test_number")?.isEmpty(null, { format: "plain" })).toBe(true);
    expect(specForPropertyType("spec_test_number")?.isEmpty(undefined, { format: "plain" })).toBe(true);
    expect(specForPropertyType("spec_test_checkbox")?.isEmpty(null, { color: "gray" })).toBe(true);
  });

  it("uma implementação ingênua com `!value` erraria os dois casos acima — é exatamente o que este teste está travando", () => {
    const naiveIsEmpty = (value: unknown): boolean => !value;
    expect(naiveIsEmpty(0)).toBe(true); // errado: 0 é valor legítimo
    expect(naiveIsEmpty(false)).toBe(true); // errado: false de fórmula é valor legítimo
    // O spec registrado, ao contrário, acerta os dois:
    expect(specForPropertyType("spec_test_number")?.isEmpty(0, { format: "plain" })).toBe(false);
    expect(specForPropertyType("spec_test_checkbox")?.isEmpty(false, { color: "gray" })).toBe(false);
  });

  it("checkbox: normalize() apaga false (I1 no caminho de escrita), mas o false já lido de uma fórmula não é vazio", () => {
    registerPropertySpec(checkboxSpec);
    const spec = specForPropertyType("spec_test_checkbox");
    expect(spec?.normalize(false, { color: "gray" })).toBeNull();
    expect(spec?.isEmpty(false, { color: "gray" })).toBe(false);
  });
});

describe("resetPropertySpecRegistryForTests", () => {
  it("limpa o registro (test-only)", () => {
    registerPropertySpec(numberSpec);
    resetPropertySpecRegistryForTests();
    expect(specForPropertyType("spec_test_number")).toBeUndefined();
    // Devolve o estado para as outras suítes deste arquivo, que rodam no
    // mesmo módulo (registros são globais de propósito - ver comentário em
    // property-spec.ts).
    registerPropertySpec(numberSpec);
    registerPropertySpec(checkboxSpec);
  });
});
