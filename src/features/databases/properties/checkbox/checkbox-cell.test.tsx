/**
 * Atravessa a fronteira que DBS-017 atravessa de verdade: um clique real no
 * DOM (`fireEvent.click`, não uma chamada direta a `normalize`) até a
 * DECISÃO de gravar ou apagar a linha — não só a lógica pura de
 * `checkbox-spec.test.ts`. É a lição de `docs/ACHADOS-FASE-2.md`: "teste que
 * não atravessa a fronteira que a feature atravessa não é prova".
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { checkboxPropertySpec } from "./checkbox-spec";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { CheckboxConfig } from "./checkbox-spec";
import type { RecordRow } from "../../contract";

afterEach(cleanup);

const property = { id: "prop-1", databaseId: "db-1", name: "Concluído", type: "checkbox", config: {}, position: "a0" };

const record: RecordRow = {
  id: "rec-1",
  title: "Registro de teste",
  icon: null,
  parentId: null,
  position: "a0",
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
  values: {},
  matchedColorRuleIds: [],
};

describe("DBS-017 — clicar numa checkbox desmarcada alterna para marcada", () => {
  it("dado desmarcada, quando clicada, o commit recebe true e a célula fecha", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<boolean, CheckboxConfig> = { value: false, property, record, commit, close, targetCount: 1 };

    render(<>{checkboxPropertySpec.renderEditor?.(ctx)}</>);
    const input = screen.getByRole("checkbox", { name: "Concluído" });
    expect(input).not.toBeChecked();

    fireEvent.click(input);

    expect(commit).toHaveBeenCalledWith(true);
    expect(close).toHaveBeenCalledTimes(1);
    // O valor que o commit recebeu é exatamente o que `normalize` mantém —
    // não o que `normalize` apagaria.
    expect(checkboxPropertySpec.normalize(commit.mock.calls[0][0], {})).toBe(true);
  });

  it("dado marcada, quando clicada, o commit recebe false e normalize decide apagar a linha (I1)", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<boolean, CheckboxConfig> = { value: true, property, record, commit, close, targetCount: 1 };

    render(<>{checkboxPropertySpec.renderEditor?.(ctx)}</>);
    const input = screen.getByRole("checkbox", { name: "Concluído" });
    expect(input).toBeChecked();

    fireEvent.click(input);

    expect(commit).toHaveBeenCalledWith(false);
    // A ASSERÇÃO que I1 exige: o valor que o commit devolveu, passado por
    // `normalize`, resulta em ZERO LINHAS (`null`) — nunca em "gravar false".
    expect(checkboxPropertySpec.normalize(commit.mock.calls[0][0], {})).toBeNull();
  });
});

describe("renderValue — somente leitura quando a propriedade é derivada", () => {
  it("não alterna ao clicar quando readOnly é true", () => {
    const ctx: CellRenderContext<boolean, CheckboxConfig> = { value: true, property, record, density: "grid", readOnly: true };
    render(<>{checkboxPropertySpec.renderValue(ctx)}</>);
    const input = screen.getByRole("checkbox", { name: "Concluído" });
    expect(input).toBeDisabled();
  });
});
