/**
 * O lado de registro + renderização/edição de `person` que
 * `person-value.test.ts` não cobre (aquele é só a metade pura). Cobre o
 * caminho "remover" (`EMPTY_PERSON_VALUE` via `commit()`) porque `commit()`
 * nunca aceita `null` (contrato de `CellEditContext`) — é o ponto mais fácil
 * de errar nesta peça.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PersonValue, RecordRow } from "../../contract";
import { specForPropertyType, type PropertyDescriptor } from "../../core/property-spec";
import "./register";

function record(): RecordRow {
  return {
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
}

function descriptor(): PropertyDescriptor<Record<string, never>> {
  return { id: "prop-1", databaseId: "db-1", name: "Responsável", type: "person", config: {}, position: "a0" };
}

describe("person — registro (DBS-082/083/120 consomem este spec)", () => {
  it("registra com valueShape 'person' e um editor (não é somente-leitura como timestamp)", () => {
    const spec = specForPropertyType("person");
    expect(spec).toBeDefined();
    expect(spec?.valueShape).toBe("person");
    expect(spec?.renderEditor).toBeDefined();
  });

  it("renderValue mostra 'Nome <email>' quando a célula tem valor", () => {
    const spec = specForPropertyType("person");
    render(
      <>
        {spec?.renderValue({
          value: { name: "Ana Silva", email: "ana@example.com" },
          property: descriptor(),
          record: record(),
          density: "grid",
          readOnly: false,
        })}
      </>,
    );
    expect(screen.getByText("Ana Silva <ana@example.com>")).toBeInTheDocument();
  });

  it("renderValue não mostra nada para uma célula vazia (I1: sem chip vazio)", () => {
    const spec = specForPropertyType("person");
    const { container } = render(
      <>
        {spec?.renderValue({
          value: { name: "", email: null },
          property: descriptor(),
          record: record(),
          density: "grid",
          readOnly: false,
        })}
      </>,
    );
    expect(container).toHaveTextContent("");
  });

  it("renderEditor: salvar chama commit() com o valor canonizado e fecha", async () => {
    const user = userEvent.setup();
    const spec = specForPropertyType("person");
    const commit = vi.fn();
    const close = vi.fn();
    render(
      <>
        {spec?.renderEditor?.({
          value: { name: "", email: null },
          property: descriptor(),
          record: record(),
          commit: commit as (next: PersonValue) => void,
          close,
          targetCount: 1,
        })}
      </>,
    );

    await user.type(screen.getByLabelText("Nome da pessoa"), "Carlos");
    await user.type(screen.getByLabelText("Email da pessoa"), "carlos@example.com");
    await user.click(screen.getByLabelText("Salvar pessoa"));

    expect(commit).toHaveBeenCalledWith({ name: "Carlos", email: "carlos@example.com" });
    expect(close).toHaveBeenCalled();
  });

  it("renderEditor: remover manda o sentinela vazio, nunca `null` (commit() não aceita null)", async () => {
    const user = userEvent.setup();
    const spec = specForPropertyType("person");
    const commit = vi.fn();
    const close = vi.fn();
    render(
      <>
        {spec?.renderEditor?.({
          value: { name: "Ana", email: null },
          property: descriptor(),
          record: record(),
          commit: commit as (next: PersonValue) => void,
          close,
          targetCount: 1,
        })}
      </>,
    );

    await user.click(screen.getByLabelText("Remover pessoa"));

    expect(commit).toHaveBeenCalledWith({ name: "", email: null });
    expect(close).toHaveBeenCalled();
  });
});
