import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { RecordRow } from "../../contract";
import { DateCellEditor, DateCellValue } from "./date-cell";
import { DEFAULT_DATE_CONFIG, type DateConfig, type DateFieldValue } from "./date-value";

const RECORD: RecordRow = {
  id: "rec-1",
  title: "Registro de teste",
  icon: null,
  parentId: null,
  position: "a0",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  values: {},
  matchedColorRuleIds: [],
};

function renderContext(value: DateFieldValue, config: DateConfig = DEFAULT_DATE_CONFIG): CellRenderContext<DateFieldValue, DateConfig> {
  return {
    value,
    property: { id: "prop-1", databaseId: "db-1", name: "Data", type: "date", config, position: "a0" },
    record: RECORD,
    density: "grid",
    readOnly: false,
  };
}

function editContext(
  value: DateFieldValue,
  config: DateConfig,
  overrides: Partial<Pick<CellEditContext<DateFieldValue, DateConfig>, "commit" | "close">> = {},
): CellEditContext<DateFieldValue, DateConfig> {
  return {
    value,
    property: { id: "prop-1", databaseId: "db-1", name: "Data", type: "date", config, position: "a0" },
    record: RECORD,
    commit: overrides.commit ?? vi.fn(),
    close: overrides.close ?? vi.fn(),
    targetCount: 1,
  };
}

describe("DateCellValue", () => {
  it("vazio não renderiza nada (a camada compartilhada decide o placeholder)", () => {
    const { container } = render(<>{DateCellValue(renderContext(null))}</>);
    expect(container.textContent).toBe("");
  });

  it("mostra o texto pt-BR por extenso (DBS-010)", () => {
    render(<>{DateCellValue(renderContext({ start: "2026-03-15" }))}</>);
    expect(screen.getByText("15 de março de 2026")).toBeInTheDocument();
  });
});

describe("DateCellEditor", () => {
  it('sem "End date" ativado, mostra um único input rotulado "Data" com o valor atual e nenhum "Fim"', () => {
    render(<>{DateCellEditor(editContext({ start: "2026-03-15" }, { includeTime: false, hasEnd: false }))}</>);
    const dateInput = screen.getByLabelText("Data") as HTMLInputElement;
    expect(dateInput.value).toBe("2026-03-15");
    expect(screen.queryByLabelText("Fim")).not.toBeInTheDocument();
  });

  it("digitar uma nova data comita {start} (I1: sem end nenhum, o objeto não carrega a chave)", async () => {
    const commit = vi.fn();
    render(<>{DateCellEditor(editContext(null, { includeTime: false, hasEnd: false }, { commit }))}</>);
    const input = screen.getByLabelText("Data") as HTMLInputElement;
    await userEvent.type(input, "2026-04-01");
    expect(commit).toHaveBeenCalledWith({ start: "2026-04-01" });
  });

  it('com "End date" ativado, mostra "Início" e "Fim" e comita o intervalo preservando o início já existente', async () => {
    const commit = vi.fn();
    render(
      <>{DateCellEditor(editContext({ start: "2026-03-01" }, { includeTime: false, hasEnd: true }, { commit }))}</>,
    );
    expect(screen.getByLabelText("Início")).toBeInTheDocument();
    const endInput = screen.getByLabelText("Fim") as HTMLInputElement;
    await userEvent.type(endInput, "2026-03-05");
    expect(commit).toHaveBeenCalledWith({ start: "2026-03-01", end: "2026-03-05" });
  });

  it("limpar o campo de início apaga a célula inteira (I1: commit(null))", () => {
    const commit = vi.fn();
    render(<>{DateCellEditor(editContext({ start: "2026-03-15" }, { includeTime: false, hasEnd: false }, { commit }))}</>);
    const input = screen.getByLabelText("Data") as HTMLInputElement;
    // `fireEvent`-like via userEvent.clear, que dispara o mesmo onChange nativo do <input type="date">.
    input.focus();
    Object.defineProperty(input, "value", { writable: true, value: "" });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commit).toHaveBeenCalledWith(null);
  });
});
