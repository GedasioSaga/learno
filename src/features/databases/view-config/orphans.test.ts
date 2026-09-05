/**
 * TOLERÂNCIA A CHAVE ÓRFÃ: uma propriedade apagada da database pode
 * continuar citada no `ViewConfig` de uma view. `findOrphanPropertyRefs`
 * relata sem tocar em nada; `cleanOrphanPropertyRefs` remove de fato — os
 * dois têm que concordar em quais referências existem.
 */
import { describe, expect, it } from "vitest";
import { createEmptyViewConfig } from "./codec";
import { applySimpleFilter, createCondition, createGroup, setFilter } from "./filter-builder";
import { setSingleSort } from "./sort-builder";
import { groupByProperty } from "./group-builder";
import { cleanOrphanPropertyRefs, findOrphanPropertyRefs } from "./orphans";
import type { ViewConfig } from "./contract";

const LIVE = new Set(["p1", "p2"]);

describe("findOrphanPropertyRefs — só relata, nunca muta", () => {
  it("config sem referência nenhuma a propriedade morta não acusa órfã", () => {
    const config = applySimpleFilter(createEmptyViewConfig(), "p1", "is", "x");
    expect(findOrphanPropertyRefs(config, LIVE)).toEqual([]);
  });

  it("condição de filtro citando propriedade apagada é encontrada, com o path até ela", () => {
    const config = applySimpleFilter(createEmptyViewConfig(), "apagada", "is", "x");
    expect(findOrphanPropertyRefs(config, LIVE)).toEqual([{ where: "filter", propertyId: "apagada", path: [] }]);
  });

  it("condição órfã DENTRO de um grupo aninhado carrega o path completo até ela", () => {
    const config = setFilter(
      createEmptyViewConfig(),
      createGroup("and", [createCondition("p1", "is", "x"), createGroup("or", [createCondition("apagada", "is", "y")])]),
    );
    expect(findOrphanPropertyRefs(config, LIVE)).toEqual([{ where: "filter", propertyId: "apagada", path: [1, 0] }]);
  });

  it("sort/group/columnOrder/columnWidths/columnVisibility/footers/frozenUpTo órfãos são todos reportados", () => {
    const config: ViewConfig = {
      ...createEmptyViewConfig(),
      sorts: [{ propertyId: "apagada", direction: "asc" }],
      group: { propertyId: "apagada", hideEmpty: false, order: "ascending" },
      columnOrder: ["p1", "apagada"],
      columnWidths: { apagada: 100 },
      columnVisibility: { apagada: "never" },
      footers: { apagada: "sum" },
      frozenUpTo: "apagada",
    };
    const refs = findOrphanPropertyRefs(config, LIVE);
    const wheres = refs.map((ref) => ref.where).sort();
    expect(wheres).toEqual(["columnOrder", "columnVisibility", "columnWidths", "footers", "frozenUpTo", "group", "sort"]);
    expect(refs.every((ref) => ref.propertyId === "apagada")).toBe(true);
  });

  it("colorRule cujo alvo (target de propriedade) foi apagado é reportada", () => {
    const config: ViewConfig = {
      ...createEmptyViewConfig(),
      colorRules: [
        {
          id: "r1",
          when: createGroup("and", [createCondition("p1", "isChecked")]),
          target: { kind: "property", propertyId: "apagada" },
          color: "mint",
        },
      ],
    };
    expect(findOrphanPropertyRefs(config, LIVE)).toEqual([{ where: "colorRule", propertyId: "apagada", path: [0] }]);
  });
});

describe("cleanOrphanPropertyRefs — remove de fato, sem quebrar o resto", () => {
  it("depois de limpar, findOrphanPropertyRefs não acha mais nada (idempotência do par find/clean)", () => {
    const config: ViewConfig = {
      ...createEmptyViewConfig(),
      filter: createGroup("and", [createCondition("p1", "is", "x"), createCondition("apagada", "is", "y")]),
      sorts: [{ propertyId: "apagada", direction: "asc" }, { propertyId: "p2", direction: "desc" }],
      group: { propertyId: "apagada", hideEmpty: false, order: "ascending" },
      columnOrder: ["p1", "apagada", "p2"],
      columnWidths: { p1: 100, apagada: 100 },
      columnVisibility: { apagada: "never", p2: "always" },
      footers: { apagada: "sum", p1: "count_all" },
      frozenUpTo: "apagada",
    };
    const cleaned = cleanOrphanPropertyRefs(config, LIVE);
    expect(findOrphanPropertyRefs(cleaned, LIVE)).toEqual([]);
  });

  it("propriedade viva sobrevive à limpeza intacta em todo campo", () => {
    const config = applySimpleFilter(setSingleSort(groupByProperty(createEmptyViewConfig(), "p1"), "p2", "desc"), "p1", "is", "x");
    const cleaned = cleanOrphanPropertyRefs(config, LIVE);
    expect(cleaned).toEqual(config);
  });

  it("condição órfã sozinha na raiz zera o filtro (não sobra grupo vazio)", () => {
    const config = applySimpleFilter(createEmptyViewConfig(), "apagada", "is", "x");
    expect(cleanOrphanPropertyRefs(config, LIVE).filter).toBeNull();
  });

  it("grupo com uma condição órfã e uma viva colapsa pra só a condição viva (sem aninhamento morto sobrando)", () => {
    const config = setFilter(createEmptyViewConfig(), createGroup("and", [createCondition("p1", "is", "x"), createCondition("apagada", "is", "y")]));
    expect(cleanOrphanPropertyRefs(config, LIVE).filter).toEqual({ kind: "condition", propertyId: "p1", operator: "is", value: "x" });
  });

  it("colorRule sem condição viva nenhuma sobrando é removida inteira, não deixada com `when` vazio", () => {
    const config: ViewConfig = {
      ...createEmptyViewConfig(),
      colorRules: [{ id: "r1", when: createGroup("and", [createCondition("apagada", "isChecked")]), target: { kind: "row" }, color: "mint" }],
    };
    expect(cleanOrphanPropertyRefs(config, LIVE).colorRules).toEqual([]);
  });

  it("findOrphanPropertyRefs e cleanOrphanPropertyRefs nunca mutam o config recebido", () => {
    const config = applySimpleFilter(createEmptyViewConfig(), "apagada", "is", "x");
    const before = JSON.stringify(config);
    cleanOrphanPropertyRefs(config, LIVE);
    findOrphanPropertyRefs(config, LIVE);
    expect(JSON.stringify(config)).toBe(before);
  });
});
