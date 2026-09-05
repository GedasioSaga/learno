/**
 * DBS-053 — cada view guarda seu próprio filtro/ordenação/agrupamento;
 * aplicar um filtro numa não pode afetar a outra. Na camada de `view-config`
 * (não a de query, que ainda não existe — ver divergência), o risco real não
 * é lógico (`{ ...config, filter }` já é imutável por construção), é de
 * REFERÊNCIA: duas `DatabaseView` que, por acidente de quem monta a tela,
 * apontam pro mesmo objeto de config na memória. Por isso o teste central
 * abaixo começa as duas views compartilhando a MESMA referência de config —
 * o cenário que um bug de aliasing de verdade produziria — e prova que
 * `updateViewConfig` ainda assim as separa.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseView } from "../contract";
import { applySimpleFilter } from "./filter-builder";
import { setSingleSort } from "./sort-builder";
import { readViewConfig, updateViewConfig, withViewConfig } from "./store";
import { createEmptyViewConfig } from "./codec";

function view(overrides: Partial<DatabaseView> & Pick<DatabaseView, "id" | "viewType">): DatabaseView {
  return {
    databaseId: "db1",
    name: overrides.viewType,
    config: {},
    position: "1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("DBS-053 — filtro/ordenação/agrupamento independentes por view", () => {
  it("filtrar a view Tabela não introduz o filtro na view Board da mesma database (critério literal do checklist)", () => {
    const sharedRawConfig = {}; // as duas views nascem do MESMO objeto vazio, de propósito — ver cabeçalho
    const tabela = view({ id: "v-tabela", viewType: "table", config: sharedRawConfig });
    const board = view({ id: "v-board", viewType: "board", config: sharedRawConfig });

    const tabelaFiltrada = updateViewConfig(tabela, (config) => applySimpleFilter(config, "status", "is", "done"));

    expect(readViewConfig(tabelaFiltrada).filter).toEqual({ kind: "condition", propertyId: "status", operator: "is", value: "done" });
    // o Board nunca foi tocado — nem o objeto `board`, nem (mais importante,
    // dado que começaram com o MESMO `sharedRawConfig`) o config que ele lê.
    expect(readViewConfig(board).filter).toBeNull();
    expect(board.config).toBe(sharedRawConfig);
  });

  it("ordenar uma view não muda a ordenação de outra que compartilhava a mesma config crua", () => {
    const sharedRawConfig = {};
    const a = view({ id: "va", viewType: "table", config: sharedRawConfig });
    const b = view({ id: "vb", viewType: "list", config: sharedRawConfig });

    const aOrdenada = updateViewConfig(a, (config) => setSingleSort(config, "prioridade", "desc"));

    expect(readViewConfig(aOrdenada).sorts).toEqual([{ propertyId: "prioridade", direction: "desc" }]);
    expect(readViewConfig(b).sorts).toEqual([]);
  });

  it("withViewConfig nunca muta o objeto `view` recebido — devolve um novo", () => {
    const original = view({ id: "v1", viewType: "table" });
    const next = withViewConfig(original, applySimpleFilter(createEmptyViewConfig(), "p1", "is", "x"));
    expect(next).not.toBe(original);
    expect(original.config).toEqual({}); // config original intocado
    expect(next.config).not.toEqual({});
  });

  it("updateViewConfig encadeado (filtro, depois ordenação) preserva o filtro já aplicado — não é reescrita do zero a cada chamada", () => {
    const v1 = view({ id: "v1", viewType: "table" });
    const filtrada = updateViewConfig(v1, (config) => applySimpleFilter(config, "status", "is", "done"));
    const filtradaEOrdenada = updateViewConfig(filtrada, (config) => setSingleSort(config, "prioridade", "asc"));

    const finalConfig = readViewConfig(filtradaEOrdenada);
    expect(finalConfig.filter).toEqual({ kind: "condition", propertyId: "status", operator: "is", value: "done" });
    expect(finalConfig.sorts).toEqual([{ propertyId: "prioridade", direction: "asc" }]);
  });

  it("readViewConfig de um blob corrompido não derruba a leitura da view (TOTAL) — a view abre com config vazio em vez de travar", () => {
    const corrompida = view({ id: "v1", viewType: "table", config: { sorts: "isso não é um array" } });
    expect(() => readViewConfig(corrompida)).not.toThrow();
    expect(readViewConfig(corrompida).sorts).toEqual([]);
  });
});
