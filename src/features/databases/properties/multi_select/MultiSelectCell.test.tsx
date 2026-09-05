/**
 * Monta o editor de verdade — critério LITERAL de DBS-008: "Álgebra" e
 * "Geometria" marcadas aparecem lado a lado, e cada uma é removível
 * ISOLADAMENTE (a outra permanece).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { MultiSelectPropertyConfig } from "../select/option-model";
import { configWith, optionByLabel, propertyFixture, recordFixture } from "../select/test-fixtures";
import { renderMultiSelectEditor, renderMultiSelectValue } from "./MultiSelectCell";

describe("DBS-008 — renderValue mostra as tags lado a lado", () => {
  it("as duas tags marcadas aparecem juntas", () => {
    const config = configWith("Álgebra", "Geometria", "Trigonometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const ctx: CellRenderContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, geometriaId],
      property: propertyFixture(config),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    render(<>{renderMultiSelectValue(ctx)}</>);

    expect(screen.getByText("Álgebra")).toBeInTheDocument();
    expect(screen.getByText("Geometria")).toBeInTheDocument();
    expect(screen.queryByText("Trigonometria")).not.toBeInTheDocument();
  });

  it("célula sem nenhuma tag não renderiza nada", () => {
    const config = configWith("Álgebra");
    const ctx: CellRenderContext<string[], MultiSelectPropertyConfig> = {
      value: [],
      property: propertyFixture(config),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    const { container } = render(<>{renderMultiSelectValue(ctx)}</>);
    expect(container).toBeEmptyDOMElement();
  });

  it("um id órfão entre tags vivas vira chip 'apagado', sem derrubar as outras (arquitetura §6)", () => {
    const config = configWith("Álgebra");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const ctx: CellRenderContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, "id-de-opcao-apagada"],
      property: propertyFixture(config),
      record: recordFixture(),
      density: "grid",
      readOnly: false,
    };

    render(<>{renderMultiSelectValue(ctx)}</>);

    expect(screen.getByText("Álgebra")).toBeInTheDocument();
    expect(screen.getByText("Opção apagada")).toBeInTheDocument();
  });
});

describe("DBS-008 — critério literal: cada tag é removível ISOLADAMENTE", () => {
  it("remover 'Álgebra' mantém 'Geometria' — não zera a seleção inteira", async () => {
    const user = userEvent.setup();
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const commit = vi.fn();
    const ctx: CellEditContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, geometriaId],
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close: vi.fn(),
      targetCount: 1,
    };

    render(<>{renderMultiSelectEditor(ctx)}</>);

    const chosen = screen.getByLabelText("Tags escolhidas de Matéria");
    await user.click(within(chosen).getByRole("button", { name: "Remover Álgebra" }));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([geometriaId]);
  });

  it("escolher uma terceira opção na lista ADICIONA, não substitui as já marcadas", async () => {
    const user = userEvent.setup();
    const config = configWith("Álgebra", "Geometria", "Trigonometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const trigonometriaId = optionByLabel(config, "Trigonometria").id;
    const commit = vi.fn();
    const ctx: CellEditContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, geometriaId],
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close: vi.fn(),
      targetCount: 1,
    };

    render(<>{renderMultiSelectEditor(ctx)}</>);

    await user.click(screen.getByRole("option", { name: "Trigonometria" }));

    expect(commit).toHaveBeenCalledWith([algebraId, geometriaId, trigonometriaId]);
  });

  it("clicar de novo numa opção já marcada na lista a remove (toggle)", async () => {
    const user = userEvent.setup();
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const commit = vi.fn();
    const ctx: CellEditContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, geometriaId],
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close: vi.fn(),
      targetCount: 1,
    };

    render(<>{renderMultiSelectEditor(ctx)}</>);

    await user.click(screen.getByRole("option", { name: "Geometria" }));

    expect(commit).toHaveBeenCalledWith([algebraId]);
  });

  it("removível isoladamente mesmo quando a outra tag está órfã: remover a viva preserva a órfã intocada", async () => {
    const user = userEvent.setup();
    const config = configWith("Álgebra");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const commit = vi.fn();
    const ctx: CellEditContext<string[], MultiSelectPropertyConfig> = {
      value: [algebraId, "id-de-opcao-apagada"],
      property: propertyFixture(config),
      record: recordFixture(),
      commit,
      close: vi.fn(),
      targetCount: 1,
    };

    render(<>{renderMultiSelectEditor(ctx)}</>);

    await user.click(screen.getByRole("button", { name: "Remover Álgebra" }));

    expect(commit).toHaveBeenCalledWith(["id-de-opcao-apagada"]);
  });
});
