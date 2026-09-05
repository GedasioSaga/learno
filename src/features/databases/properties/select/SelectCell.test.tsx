/**
 * Monta o editor de verdade (não chama `commit` fabricado à mão) — a lição
 * da Fase 2 sobre teste que não atravessa a fronteira que a feature
 * atravessa (`docs/ACHADOS-FASE-2.md`). Cobre o critério LITERAL de DBS-007
 * ("selecionar outra substitui a anterior") e o invariante de valor órfão da
 * arquitetura §6.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { SelectPropertyConfig } from "./option-model";
import { renderSelectEditor, renderSelectValue } from "./SelectCell";
import { configWith, optionByLabel, propertyFixture, recordFixture } from "./test-fixtures";

describe("DBS-007 — renderValue mostra a tag da opção escolhida", () => {
  it("mostra o RÓTULO da opção (nunca o id cru)", () => {
    const config = configWith("Matemática", "Física");
    const id = optionByLabel(config, "Matemática").id;
    const ctx: CellRenderContext<string, SelectPropertyConfig> = {
      value: id,
      property: propertyFixture(config),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    render(<>{renderSelectValue(ctx)}</>);

    expect(screen.getByText("Matemática")).toBeInTheDocument();
    expect(screen.queryByText(id)).not.toBeInTheDocument();
  });

  it("célula vazia (sem valor) não renderiza chip nenhum", () => {
    const config = configWith("Matemática");
    const ctx: CellRenderContext<string, SelectPropertyConfig> = {
      value: "",
      property: propertyFixture(config),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    const { container } = render(<>{renderSelectValue(ctx)}</>);
    expect(container).toBeEmptyDOMElement();
  });

  it("valor órfão (opção apagada) renderiza chip 'apagado' visível — nunca some, nunca explode", () => {
    const configOriginal = configWith("Matemática");
    const id = optionByLabel(configOriginal, "Matemática").id;
    const configSemAOpcao: SelectPropertyConfig = { options: [] }; // a opção sumiu de `config.options`
    const ctx: CellRenderContext<string, SelectPropertyConfig> = {
      value: id,
      property: propertyFixture(configSemAOpcao),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    render(<>{renderSelectValue(ctx)}</>);

    expect(screen.getByText("Opção apagada")).toBeInTheDocument();
  });
});

describe("DBS-007 — critério literal: escolher outra opção SUBSTITUI a anterior", () => {
  it("Matemática escolhida mostra a tag; escolher Física substitui — não soma as duas", async () => {
    const user = userEvent.setup();
    const config = configWith("Matemática", "Física");
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<string, SelectPropertyConfig> = {
      value: optionByLabel(config, "Matemática").id, // já com "Matemática" escolhida
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close,
      targetCount: 1,
    };

    render(<>{renderSelectEditor(ctx)}</>);

    await user.click(screen.getByRole("option", { name: "Física" }));

    // O NOVO valor proposto é só "Física" — nunca um array, nunca os dois.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(optionByLabel(config, "Física").id);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a opção atualmente escolhida aparece marcada (aria-selected) no seletor", () => {
    const config = configWith("Matemática", "Física");
    const ctx: CellEditContext<string, SelectPropertyConfig> = {
      value: optionByLabel(config, "Matemática").id,
      property: propertyFixture(config),
      record: recordFixture(),
      commit: vi.fn(),
      close: vi.fn(),
      targetCount: 1,
    };

    render(<>{renderSelectEditor(ctx)}</>);

    expect(screen.getByRole("option", { name: "Matemática" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Física" })).toHaveAttribute("aria-selected", "false");
  });

  it("remover a seleção atual (botão × na tag) grava string vazia — I1 apaga a linha", async () => {
    const user = userEvent.setup();
    const config = configWith("Matemática");
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<string, SelectPropertyConfig> = {
      value: optionByLabel(config, "Matemática").id,
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close,
      targetCount: 1,
    };

    render(<>{renderSelectEditor(ctx)}</>);

    await user.click(screen.getByRole("button", { name: "Remover Matemática" }));

    expect(commit).toHaveBeenCalledWith("");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
