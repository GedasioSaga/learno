/** DBS-049 — agrupamento por propriedade. */
import { describe, expect, it } from "vitest";
import { createEmptyViewConfig } from "./codec";
import { clearGroup, groupByProperty, setGroupHideEmpty, setGroupOrder } from "./group-builder";

describe("DBS-049 — agrupamento por propriedade", () => {
  it("groupByProperty com default: hideEmpty false, ordem crescente", () => {
    const next = groupByProperty(createEmptyViewConfig(), "materia");
    expect(next.group).toEqual({ propertyId: "materia", hideEmpty: false, order: "ascending" });
  });

  it("groupByProperty aceita overrides parciais sem perder o default do resto", () => {
    const next = groupByProperty(createEmptyViewConfig(), "materia", { hideEmpty: true });
    expect(next.group).toEqual({ propertyId: "materia", hideEmpty: true, order: "ascending" });
  });

  it("groupByProperty substitui um agrupamento anterior por completo (nunca funde os dois)", () => {
    const base = groupByProperty(createEmptyViewConfig(), "velho", { order: "manual", manualOrder: ["a", "b"] });
    const next = groupByProperty(base, "novo");
    expect(next.group).toEqual({ propertyId: "novo", hideEmpty: false, order: "ascending" });
    expect(next.group?.manualOrder).toBeUndefined();
  });

  it("clearGroup zera sem tocar no resto do config", () => {
    const base = { ...groupByProperty(createEmptyViewConfig(), "materia"), sorts: [{ propertyId: "p1", direction: "asc" as const }] };
    const next = clearGroup(base);
    expect(next.group).toBeNull();
    expect(next.sorts).toEqual(base.sorts);
  });

  it("setGroupHideEmpty é no-op quando não há agrupamento ativo", () => {
    const base = createEmptyViewConfig();
    expect(setGroupHideEmpty(base, true)).toBe(base);
  });

  it("setGroupOrder muda só a ordem (e manualOrder quando dado), preservando hideEmpty", () => {
    const base = groupByProperty(createEmptyViewConfig(), "materia", { hideEmpty: true });
    const next = setGroupOrder(base, "manual", ["x", "y"]);
    expect(next.group).toEqual({ propertyId: "materia", hideEmpty: true, order: "manual", manualOrder: ["x", "y"] });
  });
});
