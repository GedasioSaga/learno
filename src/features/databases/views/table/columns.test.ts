import { describe, expect, it } from "vitest";
import type { PropertyDescriptor } from "../../core/property-spec";
import { createEmptyViewConfig } from "../../view-config";
import { columnWidth, DEFAULT_COLUMN_WIDTH, MIN_COLUMN_WIDTH, orderVisibleColumns } from "./columns";

function property(id: string, position: string): PropertyDescriptor {
  return { id, databaseId: "db", name: id, type: "text", config: {}, position };
}

const a = property("a", "a0");
const b = property("b", "a1");
const c = property("c", "a2");

describe("orderVisibleColumns", () => {
  it("sem config: ordem da database", () => {
    expect(orderVisibleColumns(createEmptyViewConfig(), [a, b, c]).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("columnOrder manda; o que a view nunca ordenou vem depois; id apagado é tolerado", () => {
    const config = { ...createEmptyViewConfig(), columnOrder: ["c", "apagada", "a"] };
    expect(orderVisibleColumns(config, [a, b, c]).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("'never' some; 'hide_when_empty' fica (é decidido por registro, não por coluna)", () => {
    const config = { ...createEmptyViewConfig(), columnVisibility: { a: "never" as const, b: "hide_when_empty" as const } };
    expect(orderVisibleColumns(config, [a, b, c]).map((p) => p.id)).toEqual(["b", "c"]);
  });
});

describe("columnWidth", () => {
  it("usa a largura salva, com piso; sem largura salva usa o padrão", () => {
    const config = { ...createEmptyViewConfig(), columnWidths: { a: 300, b: 10 } };
    expect(columnWidth(config, "a")).toBe(300);
    expect(columnWidth(config, "b")).toBe(MIN_COLUMN_WIDTH);
    expect(columnWidth(config, "c")).toBe(DEFAULT_COLUMN_WIDTH);
  });
});
