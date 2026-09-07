import { describe, expect, it } from "vitest";
import type { DatabasePropertyRow, DatabaseRecord, DatabaseRow, DatabaseViewRow, PageRow } from "../../../lib/ipc";
import { resolveRecords, resolveSchema, toRecordRow } from "./resolve-schema";

function page(id: string, title: string, position: string): PageRow {
  return {
    id,
    parent_id: null,
    database_id: "db-1",
    title,
    icon: null,
    position,
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
  };
}

const database: DatabaseRow = {
  id: "db-1",
  containerPageId: "page-1",
  name: "Estudos",
  isLocked: false,
  config: "lixo que não é objeto",
  dataVersion: 3,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
};

function property(id: string, position: string, propertyType: DatabasePropertyRow["propertyType"] = "text"): DatabasePropertyRow {
  return { id, databaseId: "db-1", name: id, propertyType, config: null, position, createdAt: "", updatedAt: "" };
}

const tableView: DatabaseViewRow = { id: "v-1", databaseId: "db-1", name: "Tabela", viewType: "table", config: { columnOrder: [] }, position: "a0", createdAt: "", updatedAt: "" };

describe("resolveSchema", () => {
  it("traduz linha crua em descritor tipado, ordena por position e blinda config que não é objeto", () => {
    const schema = resolveSchema(database, [property("b", "a1"), property("a", "a0", "number")], [tableView]);
    expect(schema.database.config).toEqual({});
    expect(schema.properties.map((p) => p.id)).toEqual(["a", "b"]);
    expect(schema.properties[0]).toMatchObject({ type: "number", config: {} });
    expect(schema.views[0]).toMatchObject({ id: "v-1", type: "table", config: { columnOrder: [] } });
  });
});

describe("toRecordRow", () => {
  it("I1: propriedade sem linha fica AUSENTE do mapa — nunca null explícito", () => {
    const record: DatabaseRecord = {
      page: page("r1", "Aula", "a0"),
      values: [{ recordId: "r1", propertyId: "p-nota", value: 0, sortNum: 0, sortText: null, updatedAt: "" }],
    };
    const row = toRecordRow(record);
    expect(row.values).toEqual({ "p-nota": 0 });
    expect("p-outra" in row.values).toBe(false);
    expect(row).toMatchObject({ id: "r1", title: "Aula", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z" });
  });

  it("I1 na leitura: linha com value null (fora do caminho Rust) vira AUSÊNCIA, igual à escrita otimista", () => {
    const row = toRecordRow({
      page: page("r1", "Aula", "a0"),
      values: [
        { recordId: "r1", propertyId: "p-nula", value: null, sortNum: null, sortText: null, updatedAt: "" },
        { recordId: "r1", propertyId: "p-zero", value: 0, sortNum: 0, sortText: null, updatedAt: "" },
      ],
    });
    expect("p-nula" in row.values).toBe(false);
    expect(row.values["p-zero"]).toBe(0); // 0 continua sendo valor
  });

  it("resolveRecords ordena pela position da página", () => {
    const rows = resolveRecords([
      { page: page("r2", "Segunda", "a1"), values: [] },
      { page: page("r1", "Primeira", "a0"), values: [] },
    ]);
    expect(rows.map((row) => row.title)).toEqual(["Primeira", "Segunda"]);
  });
});
