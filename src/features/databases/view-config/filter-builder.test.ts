/**
 * DBS-045 e a árvore composta que sustenta filtro mais elaborado depois.
 * Cada teste confere que o `ViewConfig` de ENTRADA não foi mutado — é o que
 * garante que aplicar filtro numa view não pode, por referência
 * compartilhada, vazar pra config de outra (DBS-053 na camada de builder;
 * `store.test.ts` prova o mesmo na camada de `DatabaseView`).
 */
import { describe, expect, it } from "vitest";
import { createEmptyViewConfig } from "./codec";
import {
  addConditionAt,
  applySimpleFilter,
  clearFilter,
  createCondition,
  createGroup,
  getFilterNodeAt,
  removeNodeAt,
  setFilter,
  setGroupConnectiveAt,
  updateConditionAt,
} from "./filter-builder";

describe("DBS-045 — filtro simples por propriedade", () => {
  it("applySimpleFilter grava uma condição só, substituindo qualquer filtro anterior", () => {
    const base = setFilter(createEmptyViewConfig(), createGroup("and", [createCondition("velho", "is", "x")]));
    const next = applySimpleFilter(base, "status", "is", "done");
    expect(next.filter).toEqual({ kind: "condition", propertyId: "status", operator: "is", value: "done" });
    // não mutou `base`
    expect(base.filter).toEqual({ kind: "group", connective: "and", children: [{ kind: "condition", propertyId: "velho", operator: "is", value: "x" }] });
  });

  it("operador sem valor (isEmpty) não grava a chave `value`", () => {
    const next = applySimpleFilter(createEmptyViewConfig(), "notas", "isEmpty");
    expect(next.filter && "value" in next.filter).toBe(false);
  });

  it("clearFilter zera o filtro sem tocar em nada mais do config", () => {
    const base = { ...createEmptyViewConfig(), sorts: [{ propertyId: "p1", direction: "asc" as const }] };
    const withFilter = applySimpleFilter(base, "p1", "is", "x");
    const cleared = clearFilter(withFilter);
    expect(cleared.filter).toBeNull();
    expect(cleared.sorts).toEqual(base.sorts);
  });
});

describe("Árvore composta — endereçamento por path", () => {
  it("addConditionAt envolve uma condição solta num grupo 'and' na primeira vez que uma segunda condição chega", () => {
    const withOne = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "a");
    const withTwo = addConditionAt(withOne, [], createCondition("p2", "is", "b"));
    expect(withTwo.filter).toEqual({
      kind: "group",
      connective: "and",
      children: [
        { kind: "condition", propertyId: "p1", operator: "is", value: "a" },
        { kind: "condition", propertyId: "p2", operator: "is", value: "b" },
      ],
    });
    // a versão anterior continua com uma condição só
    expect(withOne.filter).toEqual({ kind: "condition", propertyId: "p1", operator: "is", value: "a" });
  });

  it("addConditionAt num grupo existente (path []) acrescenta ao fim", () => {
    const base = setFilter(createEmptyViewConfig(), createGroup("or", [createCondition("p1", "is", "a")]));
    const next = addConditionAt(base, [], createCondition("p2", "is", "b"));
    expect(getFilterNodeAt(next, [])).toMatchObject({ connective: "or" });
    expect(next.filter && next.filter.kind === "group" ? next.filter.children : null).toHaveLength(2);
  });

  it("addConditionAt num sub-grupo endereçado por path aninha corretamente", () => {
    const base = setFilter(
      createEmptyViewConfig(),
      createGroup("and", [createCondition("p1", "is", "a"), createGroup("or", [createCondition("p2", "is", "b")])]),
    );
    const next = addConditionAt(base, [1], createCondition("p3", "is", "c"));
    const subgroup = getFilterNodeAt(next, [1]);
    expect(subgroup).toEqual({
      kind: "group",
      connective: "or",
      children: [
        { kind: "condition", propertyId: "p2", operator: "is", value: "b" },
        { kind: "condition", propertyId: "p3", operator: "is", value: "c" },
      ],
    });
    // o resto da árvore, fora do path tocado, não mudou
    expect(getFilterNodeAt(next, [0])).toEqual({ kind: "condition", propertyId: "p1", operator: "is", value: "a" });
  });

  it("removeNodeAt tira só o nó endereçado, deixando os irmãos intactos", () => {
    const base = setFilter(
      createEmptyViewConfig(),
      createGroup("and", [createCondition("p1", "is", "a"), createCondition("p2", "is", "b"), createCondition("p3", "is", "c")]),
    );
    const next = removeNodeAt(base, [1]);
    expect(next.filter).toEqual({
      kind: "group",
      connective: "and",
      children: [
        { kind: "condition", propertyId: "p1", operator: "is", value: "a" },
        { kind: "condition", propertyId: "p3", operator: "is", value: "c" },
      ],
    });
  });

  it("removeNodeAt na raiz (path []) zera o filtro inteiro", () => {
    const base = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "a");
    expect(removeNodeAt(base, []).filter).toBeNull();
  });

  it("updateConditionAt troca operador e valor sem afetar o propertyId", () => {
    const base = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "a");
    const next = updateConditionAt(base, [], { operator: "isNot", value: "z" });
    expect(next.filter).toEqual({ kind: "condition", propertyId: "p1", operator: "isNot", value: "z" });
  });

  it("updateConditionAt com value: undefined remove a chave `value` (não grava undefined explícito)", () => {
    const base = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "a");
    const next = updateConditionAt(base, [], { operator: "isEmpty", value: undefined });
    expect(next.filter && "value" in next.filter).toBe(false);
  });

  it("setGroupConnectiveAt troca and<->or só do grupo endereçado", () => {
    const base = setFilter(createEmptyViewConfig(), createGroup("and", [createCondition("p1", "is", "a")]));
    const next = setGroupConnectiveAt(base, [], "or");
    expect(next.filter).toMatchObject({ connective: "or" });
  });

  it("getFilterNodeAt com path obsoleto (fora da árvore) devolve null, nunca lança", () => {
    const base = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "a");
    expect(() => getFilterNodeAt(base, [0, 3, 9])).not.toThrow();
    expect(getFilterNodeAt(base, [0, 3, 9])).toBeNull();
  });
});
