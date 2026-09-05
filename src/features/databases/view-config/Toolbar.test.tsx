/**
 * Prova de ponta a ponta, na fronteira que ESTA peça atravessa (clique real
 * -> `ViewConfig` novo -> painel reabre já refletindo o config atualizado):
 * DBS-045 (filtro), DBS-047 (ordenação), DBS-049 (agrupamento), DBS-054
 * (visibilidade) e a tolerância a chave órfã, todos através da barra de
 * ferramentas de verdade, nunca chamando os builders direto. A prova de que
 * o RESULTADO filtrado/ordenado/agrupado é o que o Postgres devolve fica com
 * a peça dona do pipeline de consulta (`query/contract.ts`, ainda
 * inexistente — ver `divergencias_da_arquitetura`); aqui a fronteira é
 * "usuário clica" -> "config correto sai da barra de ferramentas".
 */
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { registerPropertySpec, resetPropertySpecRegistryForTests, type PropertyDescriptor, type PropertySpec } from "../core/property-spec";
import { createEmptyViewConfig } from "./codec";
import { cleanOrphanPropertyRefs } from "./orphans";
import { createCondition, setFilter } from "./filter-builder";
import type { ViewConfig } from "./contract";
import { ViewToolbar } from "./Toolbar";

const statusSpec: PropertySpec<string, { options: { id: string; name: string }[] }> = {
  type: "vc_toolbar_status",
  label: "Seleção (teste)",
  icon: "●",
  valueShape: "option",
  defaultConfig: { options: [] },
  isEmpty: (value) => value === null || value === undefined,
  normalize: (value) => (typeof value === "string" ? value : null),
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["is", "isNot", "isEmpty", "isNotEmpty"],
  sort: "configOrder",
  grouping: { strategy: "option" },
  toPlainText: (value) => value ?? "",
};

const numberSpec: PropertySpec<number, Record<string, never>> = {
  type: "vc_toolbar_number",
  label: "Número (teste)",
  icon: "#",
  valueShape: "number",
  defaultConfig: {},
  isEmpty: (value) => value === null || value === undefined,
  normalize: (value) => (typeof value === "number" ? value : null),
  parse: (raw) => (typeof raw === "number" ? raw : 0),
  serialize: (value) => value,
  renderValue: () => null,
  filterOperators: ["gt", "isEmpty", "isNotEmpty"],
  sort: "num",
  toPlainText: (value) => (value === null ? "" : String(value)),
};

const properties: PropertyDescriptor[] = [
  {
    id: "status",
    databaseId: "db1",
    name: "Status",
    type: "vc_toolbar_status",
    config: {
      options: [
        { id: "todo", name: "A Fazer" },
        { id: "done", name: "Feito" },
      ],
    },
    position: "1",
  },
  { id: "pontos", databaseId: "db1", name: "Pontos", type: "vc_toolbar_number", config: {}, position: "2" },
];

/** Wrapper controlado — como a tela real da database usaria a barra: estado sobe, config volta, painel reabre já refletindo o novo estado. */
function ControlledToolbar({ initial, onChange }: { initial: ViewConfig; onChange?(next: ViewConfig): void }) {
  const [config, setConfig] = useState(initial);
  return (
    <ViewToolbar
      properties={properties}
      config={config}
      onConfigChange={(next) => {
        setConfig(next);
        onChange?.(next);
      }}
    />
  );
}

beforeEach(() => {
  resetPropertySpecRegistryForTests();
  registerPropertySpec(statusSpec);
  registerPropertySpec(numberSpec);
});

describe("DBS-045 — filtro simples pela barra de ferramentas", () => {
  it("escolher propriedade + condição + valor e aplicar grava a condição no config", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledToolbar initial={createEmptyViewConfig()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Filtro" }));
    await user.selectOptions(screen.getByLabelText("Propriedade"), "status");
    await user.selectOptions(screen.getByLabelText("Condição"), "is");
    await user.selectOptions(screen.getByLabelText("Valor do filtro"), "done");
    await user.click(screen.getByRole("button", { name: "Aplicar filtro" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filter: { kind: "condition", propertyId: "status", operator: "is", value: "done" } }));
    expect(screen.getByRole("button", { name: "Filtro •" })).toBeInTheDocument();
  });
});

describe("DBS-047 — ordenação simples pela barra de ferramentas", () => {
  it("escolher propriedade + direção e aplicar grava um SortSpec único", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledToolbar initial={createEmptyViewConfig()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Ordenar" }));
    await user.selectOptions(screen.getByLabelText("Ordenar por"), "pontos");
    await user.click(screen.getByRole("radio", { name: "Decrescente" }));
    await user.click(screen.getByRole("button", { name: "Aplicar ordenação" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sorts: [{ propertyId: "pontos", direction: "desc" }] }));
  });
});

describe("DBS-049 — agrupamento pela barra de ferramentas", () => {
  it("só oferece propriedade com `grouping` declarado, e aplicar grava o GroupSpec", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledToolbar initial={createEmptyViewConfig()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Agrupar" }));
    const propertySelect = screen.getByLabelText("Agrupar por");
    // "Pontos" (número, sem `grouping`) não pode aparecer como opção — só "Status".
    expect(propertySelect.textContent).not.toContain("Pontos");
    await user.selectOptions(propertySelect, "status");
    await user.click(screen.getByRole("button", { name: "Aplicar agrupamento" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ group: { propertyId: "status", hideEmpty: false, order: "ascending" } }));
  });
});

describe("DBS-054 — visibilidade de propriedade pela barra de ferramentas", () => {
  it("trocar pra 'Ocultar se vazia' grava o modo por propriedade, sem afetar as outras", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledToolbar initial={createEmptyViewConfig()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Propriedades" }));
    await user.selectOptions(screen.getByLabelText("Visibilidade de Status"), "hide_when_empty");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ columnVisibility: { status: "hide_when_empty" } }));
  });
});

describe("Tolerância a chave órfã", () => {
  it("config citando uma propriedade apagada mostra o aviso de limpeza, e limpar remove a referência sem quebrar a barra", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withOrphan = setFilter(createEmptyViewConfig(), createCondition("apagada", "is", "x"));
    render(<ControlledToolbar initial={withOrphan} onChange={onChange} />);

    const cleanupButton = screen.getByRole("button", { name: "1 referência a uma propriedade apagada — Limpar" });
    await user.click(cleanupButton);

    const expectedCleaned = cleanOrphanPropertyRefs(withOrphan, new Set(properties.map((property) => property.id)));
    expect(onChange).toHaveBeenCalledWith(expectedCleaned);
    expect(screen.queryByRole("button", { name: /Limpar$/ })).not.toBeInTheDocument();
  });

  it("sem referência órfã nenhuma, o aviso de limpeza não aparece", () => {
    render(<ControlledToolbar initial={createEmptyViewConfig()} />);
    expect(screen.queryByRole("button", { name: /propriedades apagadas/ })).not.toBeInTheDocument();
  });
});
