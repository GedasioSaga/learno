/** DBS-047 — ordenação simples, mais os utilitários de desempate que a §8 já prevê em `SortSpec[]`. */
import { describe, expect, it } from "vitest";
import { createEmptyViewConfig } from "./codec";
import { addSort, clearSorts, removeSort, reorderSorts, setSingleSort, toggleSortDirection } from "./sort-builder";

describe("DBS-047 — ordenação simples", () => {
  it("setSingleSort substitui a lista inteira por um único SortSpec", () => {
    const base = { ...createEmptyViewConfig(), sorts: [{ propertyId: "velho", direction: "asc" as const }] };
    const next = setSingleSort(base, "prioridade", "desc");
    expect(next.sorts).toEqual([{ propertyId: "prioridade", direction: "desc" }]);
    // não mutou a config anterior
    expect(base.sorts).toEqual([{ propertyId: "velho", direction: "asc" }]);
  });

  it("propertyId null significa ordem manual — SortSpec aceita explicitamente", () => {
    const next = setSingleSort(createEmptyViewConfig(), null, "asc");
    expect(next.sorts).toEqual([{ propertyId: null, direction: "asc" }]);
  });

  it("clearSorts esvazia a lista sem tocar no resto do config", () => {
    const base = { ...setSingleSort(createEmptyViewConfig(), "p1", "asc"), filter: null };
    expect(clearSorts(base).sorts).toEqual([]);
  });
});

describe("Desempate — sorts como lista", () => {
  it("addSort acrescenta ao fim; repetir o mesmo propertyId substitui em vez de duplicar", () => {
    const withFirst = addSort(createEmptyViewConfig(), { propertyId: "p1", direction: "asc" });
    const withSecond = addSort(withFirst, { propertyId: "p2", direction: "desc" });
    expect(withSecond.sorts).toEqual([
      { propertyId: "p1", direction: "asc" },
      { propertyId: "p2", direction: "desc" },
    ]);
    const replaced = addSort(withSecond, { propertyId: "p1", direction: "desc" });
    expect(replaced.sorts).toEqual([
      { propertyId: "p2", direction: "desc" },
      { propertyId: "p1", direction: "desc" },
    ]);
  });

  it("removeSort tira só o propertyId pedido", () => {
    const base = addSort(addSort(createEmptyViewConfig(), { propertyId: "p1", direction: "asc" }), { propertyId: "p2", direction: "asc" });
    expect(removeSort(base, "p1").sorts).toEqual([{ propertyId: "p2", direction: "asc" }]);
  });

  it("toggleSortDirection inverte só a direção do propertyId pedido", () => {
    const base = addSort(addSort(createEmptyViewConfig(), { propertyId: "p1", direction: "asc" }), { propertyId: "p2", direction: "asc" });
    const next = toggleSortDirection(base, "p1");
    expect(next.sorts).toEqual([
      { propertyId: "p1", direction: "desc" },
      { propertyId: "p2", direction: "asc" },
    ]);
  });

  it("reorderSorts move a prioridade de desempate sem mudar direção de nenhum", () => {
    const base = { ...createEmptyViewConfig(), sorts: [{ propertyId: "p1", direction: "asc" as const }, { propertyId: "p2", direction: "desc" as const }, { propertyId: "p3", direction: "asc" as const }] };
    const next = reorderSorts(base, 2, 0);
    expect(next.sorts.map((sort) => sort.propertyId)).toEqual(["p3", "p1", "p2"]);
    expect(next.sorts.map((sort) => sort.direction)).toEqual(["asc", "asc", "desc"]);
  });

  it("reorderSorts com índice fora da faixa devolve o config inalterado, nunca lança", () => {
    const base = { ...createEmptyViewConfig(), sorts: [{ propertyId: "p1", direction: "asc" as const }] };
    expect(() => reorderSorts(base, 0, 5)).not.toThrow();
    expect(reorderSorts(base, 0, 5)).toBe(base);
  });
});
