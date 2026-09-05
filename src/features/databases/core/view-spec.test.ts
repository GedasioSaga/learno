/**
 * O contrato do registro de views, mesmo padrão de `property-spec.test.ts`:
 * um spec de teste registrado de fora resolve nos dois sentidos, e um
 * `view_type` que nada reivindica devolve `undefined` em vez de lançar.
 */
import { describe, expect, it } from "vitest";
import { collectViewSpecs, registerViewSpec, specForViewType, type ViewSpec } from "./view-spec";

interface TableConfig {
  frozenUpTo: string | null;
}

const tableSpec: ViewSpec<TableConfig> = {
  type: "spec_test_table",
  label: "Tabela (teste)",
  icon: "▦",
  defaultConfig: { frozenUpTo: null },
  render: () => null,
};

describe("ViewSpec registry", () => {
  it("registra e resolve um tipo pelo view_type persistido", () => {
    registerViewSpec(tableSpec);
    expect(specForViewType("spec_test_table")?.label).toBe("Tabela (teste)");
    expect(collectViewSpecs().some((spec) => spec.type === "spec_test_table")).toBe(true);
  });

  it("um view_type que nenhum spec reivindica devolve undefined", () => {
    expect(specForViewType("view_type_de_uma_versao_futura")).toBeUndefined();
  });

  it("re-registrar o mesmo type (hot reload) é aceito", () => {
    registerViewSpec(tableSpec);
    expect(() => registerViewSpec(tableSpec)).not.toThrow();
  });
});
