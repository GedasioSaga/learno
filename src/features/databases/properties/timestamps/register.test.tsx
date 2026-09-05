/**
 * Prova de DBS-024/026 na camada TS: o spec registrado é o `PropertySpec`
 * certo (`renderEditor` ausente == somente-leitura), lê a coluna certa de
 * `RecordRow` (não `record.values`, que nunca tem entrada para este tipo —
 * ver `timestamp-spec.tsx`) e nunca aceita escrita. O gatilho em si
 * (`touch_record_from_value`, `0017_database_value_invariants.sql`) é
 * provado contra Postgres real por `src-tauri/tests/db_timestamps.rs`
 * (cargo-test, conforme `docs/CHECKLIST.md`) — este arquivo prova só o lado
 * que este spec controla.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RecordRow } from "../../contract";
import { specForPropertyType, type PropertyDescriptor } from "../../core/property-spec";
// Efeito colateral: registra "created_time"/"last_edited_time" uma vez, no
// carregamento deste módulo — mesmo padrão de `discover-extensions.ts`. Não
// há `resetPropertySpecRegistryForTests()` aqui: nenhum teste deste arquivo
// registra nada por cima, então não há estado para limpar entre eles.
import "./register";

function record(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: "rec-1",
    title: "Registro de teste",
    icon: null,
    parentId: null,
    position: "a0",
    createdAt: "2026-03-15T13:00:00Z",
    updatedAt: "2026-03-20T09:45:00Z",
    values: {},
    matchedColorRuleIds: [],
    ...overrides,
  };
}

function descriptor(type: string): PropertyDescriptor<{ includeTime: boolean }> {
  return { id: "prop-1", databaseId: "db-1", name: type === "created_time" ? "Criado em" : "Editado em", type, config: { includeTime: true }, position: "a0" };
}

describe("created_time (DBS-024)", () => {
  it("registra com valueShape 'timestamp' e sem renderEditor — somente-leitura por construção", () => {
    const spec = specForPropertyType("created_time");
    expect(spec).toBeDefined();
    expect(spec?.valueShape).toBe("timestamp");
    expect(spec?.renderEditor).toBeUndefined();
  });

  it("mostra o timestamp de `record.createdAt`, hora local, DBS-024", () => {
    const spec = specForPropertyType("created_time");
    const rec = record({ createdAt: new Date(2026, 2, 15, 10, 0).toISOString() });
    render(
      <>
        {spec?.renderValue({
          value: { start: "" },
          property: descriptor("created_time"),
          record: rec,
          density: "grid",
          readOnly: true,
        })}
      </>,
    );
    expect(screen.getByText("15/03/2026 10:00")).toBeInTheDocument();
  });

  it("nunca é vazio, mesmo com um valor de célula corrompido", () => {
    const spec = specForPropertyType("created_time");
    expect(spec?.isEmpty(undefined, { includeTime: true })).toBe(false);
    expect(spec?.isEmpty(null, { includeTime: true })).toBe(false);
  });

  it("normalize nunca grava — I4 nunca vê uma linha para este tipo (arquitetura §6)", () => {
    const spec = specForPropertyType("created_time");
    expect(spec?.normalize("qualquer coisa", { includeTime: true })).toBeNull();
  });
});

describe("last_edited_time (DBS-026)", () => {
  it("mostra `record.updatedAt`, não `record.createdAt` — são instantes diferentes na mesma página", () => {
    const spec = specForPropertyType("last_edited_time");
    const rec = record({
      createdAt: new Date(2026, 2, 15, 10, 0).toISOString(),
      updatedAt: new Date(2026, 2, 20, 9, 45).toISOString(),
    });
    render(
      <>
        {spec?.renderValue({
          value: { start: "" },
          property: descriptor("last_edited_time"),
          record: rec,
          density: "grid",
          readOnly: true,
        })}
      </>,
    );
    expect(screen.getByText("20/03/2026 09:45")).toBeInTheDocument();
    expect(screen.queryByText("15/03/2026 10:00")).not.toBeInTheDocument();
  });

  it("sem renderEditor — a célula é somente-leitura como a de created_time", () => {
    expect(specForPropertyType("last_edited_time")?.renderEditor).toBeUndefined();
  });
});
