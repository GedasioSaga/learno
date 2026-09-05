/**
 * `parseViewConfig` é TOTAL (nunca lança) e cada campo se valida sozinho —
 * este arquivo prova as duas coisas separadamente, porque um "não lança"
 * genérico não prova "não descarta o config inteiro por causa de UM campo
 * ruim" (a armadilha real: um construtor futuro grava `sorts` corrompido e
 * isso não pode arrastar `filter`, que estava correto, pro limbo).
 */
import { describe, expect, it } from "vitest";
import { createEmptyViewConfig, parseViewConfig, serializeViewConfig } from "./codec";

describe("parseViewConfig — TOTAL, nunca lança", () => {
  it("blob vazio (nascimento da view, 0008: config JSONB DEFAULT '{}') vira o config vazio", () => {
    expect(parseViewConfig({})).toEqual(createEmptyViewConfig());
  });

  it("lixo que não é nem objeto (string, número, array, null, undefined) vira o config vazio, sem lançar", () => {
    for (const garbage of ["não é config", 42, [1, 2, 3], null, undefined]) {
      expect(() => parseViewConfig(garbage)).not.toThrow();
      expect(parseViewConfig(garbage)).toEqual(createEmptyViewConfig());
    }
  });

  it("um campo corrompido não arrasta os campos vizinhos que estavam corretos", () => {
    const raw = {
      filter: { kind: "condition", propertyId: "p1", operator: "is", value: "x" },
      sorts: "isso deveria ser um array", // corrompido
      group: { propertyId: "p2", hideEmpty: true, order: "descending" },
    };
    const config = parseViewConfig(raw);
    expect(config.filter).toEqual({ kind: "condition", propertyId: "p1", operator: "is", value: "x" });
    expect(config.sorts).toEqual([]); // campo ruim -> default daquele campo, não do config inteiro
    expect(config.group).toEqual({ propertyId: "p2", hideEmpty: true, order: "descending" });
  });

  it("condição de filtro com operador desconhecido é descartada (spec futura que este build não entende)", () => {
    const config = parseViewConfig({ filter: { kind: "condition", propertyId: "p1", operator: "operador_do_futuro" } });
    expect(config.filter).toBeNull();
  });

  it("grupo de filtro descarta filhos inválidos mas preserva os válidos", () => {
    const config = parseViewConfig({
      filter: {
        kind: "group",
        connective: "and",
        children: [
          { kind: "condition", propertyId: "p1", operator: "is", value: "x" },
          { kind: "condition" /* sem propertyId */ },
          { kind: "condition", propertyId: "p2", operator: "isEmpty" },
        ],
      },
    });
    expect(config.filter).toEqual({
      kind: "group",
      connective: "and",
      children: [
        { kind: "condition", propertyId: "p1", operator: "is", value: "x" },
        { kind: "condition", propertyId: "p2", operator: "isEmpty" },
      ],
    });
  });

  it("condição sem 'value' não ganha a chave (fica ausente, não `undefined` explícito) — importa pra isEmpty/isNotEmpty", () => {
    const config = parseViewConfig({ filter: { kind: "condition", propertyId: "p1", operator: "isEmpty" } });
    expect(config.filter).not.toBeNull();
    expect(config.filter && "value" in config.filter).toBe(false);
  });

  it("columnWidths descarta valor não-numérico por chave, mantendo as demais", () => {
    const config = parseViewConfig({ columnWidths: { p1: 200, p2: "duzentos", p3: 150 } });
    expect(config.columnWidths).toEqual({ p1: 200, p3: 150 });
  });

  it("columnVisibility descarta modo desconhecido por chave", () => {
    const config = parseViewConfig({ columnVisibility: { p1: "always", p2: "modo_invalido", p3: "never" } });
    expect(config.columnVisibility).toEqual({ p1: "always", p3: "never" });
  });

  it("footers aceita `null` (aggregation desligada) e descarta valor desconhecido", () => {
    const config = parseViewConfig({ footers: { p1: "sum", p2: null, p3: "isso_nao_existe" } });
    expect(config.footers).toEqual({ p1: "sum", p2: null });
  });

  it("colorRule sem 'when' de kind group é descartada inteira", () => {
    const config = parseViewConfig({
      colorRules: [{ id: "r1", when: { kind: "condition", propertyId: "p1", operator: "is" }, target: { kind: "row" }, color: "mint" }],
    });
    expect(config.colorRules).toEqual([]);
  });

  it("colorRule válida (alvo linha inteira) é preservada", () => {
    const raw = {
      colorRules: [
        {
          id: "r1",
          when: { kind: "group", connective: "and", children: [{ kind: "condition", propertyId: "p1", operator: "isChecked" }] },
          target: { kind: "row" },
          color: "mint",
        },
      ],
    };
    expect(parseViewConfig(raw).colorRules).toEqual(raw.colorRules);
  });
});

describe("serializeViewConfig — o caminho de volta pro jsonb", () => {
  it("round trip: parse(serialize(config)) === config para um config totalmente preenchido", () => {
    const config = parseViewConfig({
      filter: { kind: "condition", propertyId: "p1", operator: "gt", value: 10 },
      sorts: [{ propertyId: "p2", direction: "desc" }],
      group: { propertyId: "p3", hideEmpty: true, order: "manual", manualOrder: ["a", "b"] },
      colorRules: [],
      columnOrder: ["p1", "p2"],
      columnWidths: { p1: 120 },
      columnVisibility: { p2: "hide_when_empty" },
      footers: { p1: "sum" },
      frozenUpTo: "p1",
      defaultTemplateId: "t1",
      interactionFilter: "parentsOnly",
      subItemDisplay: "nestedToggle",
      layout: { boardBackground: "amber" },
    });

    expect(parseViewConfig(serializeViewConfig(config))).toEqual(config);
  });

  it("campos opcionais ausentes não viram `undefined` explícito no blob serializado", () => {
    const serialized = serializeViewConfig(createEmptyViewConfig());
    expect("defaultTemplateId" in serialized).toBe(false);
    expect("interactionFilter" in serialized).toBe(false);
    expect("layout" in serialized).toBe(false);
  });
});
