/**
 * Atravessa o DOM de verdade (não só `formatNumberValue` isolado): digitar
 * num input real, sair do campo (blur) e conferir o que `commit` recebeu —
 * a mesma lição de `docs/ACHADOS-FASE-2.md` sobre não provar só a lógica pura.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { numberPropertySpec } from "./number-spec";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { NumberConfig, NumberValue } from "./number-spec";
import type { RecordRow } from "../../contract";

afterEach(cleanup);

// `as const`: sem isso `format` infere como `string`, largo demais para
// `NumberConfig["format"]` — não esconde nada, só nomeia o literal.
const property = { id: "prop-1", databaseId: "db-1", name: "Facilidade", type: "number", config: { format: "plain" as const }, position: "a0" };

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

describe("DBS-005 — renderValue mostra 0 (não some, não vira vazio)", () => {
  it("Facilidade 0 aparece na célula, não desaparece", () => {
    const ctx: CellRenderContext<NumberValue, NumberConfig> = { value: 0, property, record, density: "grid", readOnly: false };
    render(<>{numberPropertySpec.renderValue(ctx)}</>);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("percent formata 0.25 como 25% na tela", () => {
    // `as const`: mesmo motivo da declaração de `property` acima.
    const percentProperty = { ...property, config: { format: "percent" as const } };
    const ctx: CellRenderContext<NumberValue, NumberConfig> = { value: 0.25, property: percentProperty, record, density: "grid", readOnly: false };
    render(<>{numberPropertySpec.renderValue(ctx)}</>);
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("célula vazia (null) não renderiza nada", () => {
    const ctx: CellRenderContext<NumberValue, NumberConfig> = { value: null, property, record, density: "grid", readOnly: false };
    const { container } = render(<>{numberPropertySpec.renderValue(ctx)}</>);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * `renderEditor` usa `useState` (rascunho do input) — chamá-lo como função
 * pura fora de um componente ("`{spec.renderEditor(ctx)}` direto num JSX
 * literal") quebra as Rules of Hooks porque o React ainda não está
 * renderizando nada nesse instante. Este componente é o stand-in do que a
 * grade de verdade (Tabela/Board, outra peça) já faz: chamar
 * `property.renderEditor(ctx)` de DENTRO do corpo de renderização do PRÓPRIO
 * componente da célula — é aí que o hook tem um dispatcher React ativo.
 */
function EditorHarness({ ctx }: { ctx: CellEditContext<NumberValue, NumberConfig> }) {
  return <>{numberPropertySpec.renderEditor?.(ctx)}</>;
}

describe("renderEditor — digitar e sair do campo grava, campo vazio apaga (I1)", () => {
  it("digitar 42 e dar blur chama commit(42)", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<NumberValue, NumberConfig> = { value: null, property, record, commit, close, targetCount: 1 };
    render(<EditorHarness ctx={ctx} />);

    const input = screen.getByRole("spinbutton", { name: "Editar Facilidade" });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);

    expect(commit).toHaveBeenCalledWith(42);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("apagar o campo (string vazia) e dar blur chama commit(null) — I1, não commit(0)", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<NumberValue, NumberConfig> = { value: 5, property, record, commit, close, targetCount: 1 };
    render(<EditorHarness ctx={ctx} />);

    const input = screen.getByRole("spinbutton", { name: "Editar Facilidade" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(commit).toHaveBeenCalledWith(null);
    expect(commit).not.toHaveBeenCalledWith(0);
  });

  it("digitar 0 e dar blur chama commit(0), nunca commit(null) — a armadilha de I1", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<NumberValue, NumberConfig> = { value: null, property, record, commit, close, targetCount: 1 };
    render(<EditorHarness ctx={ctx} />);

    const input = screen.getByRole("spinbutton", { name: "Editar Facilidade" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(commit).toHaveBeenCalledWith(0);
  });

  it("Enter grava e fecha sem esperar o blur", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<NumberValue, NumberConfig> = { value: null, property, record, commit, close, targetCount: 1 };
    render(<EditorHarness ctx={ctx} />);

    const input = screen.getByRole("spinbutton", { name: "Editar Facilidade" });
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(commit).toHaveBeenCalledWith(7);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Escape fecha sem gravar", () => {
    const commit = vi.fn();
    const close = vi.fn();
    const ctx: CellEditContext<NumberValue, NumberConfig> = { value: null, property, record, commit, close, targetCount: 1 };
    render(<EditorHarness ctx={ctx} />);

    const input = screen.getByRole("spinbutton", { name: "Editar Facilidade" });
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(commit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
