/**
 * O carregador contra o IPC mockado — mesmo padrão de
 * `features/cartoes/OpcoesDoBaralho.test.tsx`. Prova as três fases, a
 * escrita otimista com o retorno do Rust vencendo o rascunho, e a
 * recarga em erro (o banco é a verdade).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  applyRecordValueChanges,
  createProperty,
  createRecord,
  evaluateFormulaColumn,
  validateFormula,
  getDatabase,
  listProperties,
  listRecords,
  listViews,
  renamePage,
  type DatabaseRow,
  type PageRow,
} from "../../../lib/ipc";
import { useDatabase } from "./use-database";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    getDatabase: vi.fn(),
    listProperties: vi.fn(),
    listViews: vi.fn(),
    listRecords: vi.fn(),
    applyRecordValueChanges: vi.fn(),
    renamePage: vi.fn(),
    createRecord: vi.fn(),
    createProperty: vi.fn(),
    evaluateFormulaColumn: vi.fn(),
    validateFormula: vi.fn(),
  };
});

const database: DatabaseRow = {
  id: "db-1",
  containerPageId: "page-1",
  name: "Estudos",
  isLocked: false,
  config: {},
  dataVersion: 1,
  createdAt: "",
  updatedAt: "",
};

function page(id: string, title: string): PageRow {
  return { id, parent_id: null, database_id: "db-1", title, icon: null, position: id, is_favorite: false, deleted_at: null, created_at: "", updated_at: "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDatabase).mockResolvedValue(database);
  vi.mocked(listProperties).mockResolvedValue([
    { id: "p-nota", databaseId: "db-1", name: "Nota", propertyType: "number", config: {}, position: "a0", createdAt: "", updatedAt: "" },
  ]);
  vi.mocked(listViews).mockResolvedValue([
    { id: "v-1", databaseId: "db-1", name: "Tabela", viewType: "table", config: {}, position: "a0", createdAt: "", updatedAt: "" },
  ]);
  vi.mocked(listRecords).mockResolvedValue([{ page: page("r1", "Aula 1"), values: [] }]);
});

describe("useDatabase: carregamento", () => {
  it("compõe get_database + list_properties + list_views + list_records e fica pronto", async () => {
    const { result } = renderHook(() => useDatabase("db-1"));
    expect(result.current.state.status).toBe("loading");
    expect(result.current.mutations).toBeNull();

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.schema.database.name).toBe("Estudos");
    expect(state.schema.properties.map((p) => p.id)).toEqual(["p-nota"]);
    expect(state.records.map((r) => r.title)).toEqual(["Aula 1"]);
    expect(result.current.mutations).not.toBeNull();
    expect(getDatabase).toHaveBeenCalledWith("db-1");
  });

  it("sem databaseId: erro explicado, nenhum IPC", async () => {
    const { result } = renderHook(() => useDatabase(null));
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("IPC falhando vira status error com a mensagem do backend", async () => {
    vi.mocked(getDatabase).mockRejectedValue(new AppError({ kind: "not_found", message: "database não existe" }));
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state).toEqual({ status: "error", message: "database não existe" }));
  });
});

describe("useDatabase: escrita", () => {
  it("applyValueChanges grava otimista e depois adota o que o Rust devolveu (null = linha apagada, I1)", async () => {
    vi.mocked(applyRecordValueChanges).mockResolvedValue({
      results: [{ recordId: "r1", propertyId: "p-nota", value: null }],
    });
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: "" }]);
    });

    expect(applyRecordValueChanges).toHaveBeenCalledWith([{ recordId: "r1", propertyId: "p-nota", value: "" }]);
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    // O Rust disse que a linha não existe: a propriedade SOME do mapa.
    expect("p-nota" in state.records[0].values).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it("valor devolvido pelo Rust substitui o rascunho otimista", async () => {
    vi.mocked(applyRecordValueChanges).mockResolvedValue({
      results: [{ recordId: "r1", propertyId: "p-nota", value: { recordId: "r1", propertyId: "p-nota", value: 42, sortNum: 42, sortText: null, updatedAt: "" } }],
    });
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 42 }]);
    });
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-nota"]).toBe(42);
  });

  it("erro de escrita: recarrega do banco (a verdade) e expõe a mensagem", async () => {
    vi.mocked(applyRecordValueChanges).mockRejectedValue(new AppError({ kind: "database", message: "disco cheio" }));
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(listRecords).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 5 }]);
    });

    expect(result.current.errorMessage).toBe("disco cheio");
    expect(listRecords).toHaveBeenCalledTimes(2);
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect("p-nota" in state.records[0].values).toBe(false); // o rascunho otimista foi descartado
  });

  it("renameRecord chama rename_page e atualiza o título local", async () => {
    vi.mocked(renamePage).mockResolvedValue(page("r1", "Novo"));
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.mutations?.renameRecord("r1", "Novo");
    });
    expect(renamePage).toHaveBeenCalledWith("r1", "Novo");
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].title).toBe("Novo");
  });

  it("createRecord cria a página-registro, acrescenta a linha e devolve o id", async () => {
    vi.mocked(createRecord).mockResolvedValue(page("r2", ""));
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let id: string | undefined;
    await act(async () => {
      id = await result.current.mutations?.createRecord();
    });
    expect(id).toBe("r2");
    expect(createRecord).toHaveBeenCalledWith("db-1", "");
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("useDatabase: escritas concorrentes na mesma célula", () => {
  it("a resposta de uma escrita SUPERADA por outra mais nova não sobrescreve a célula (ordem invertida no fio)", async () => {
    // Duas respostas em voo: a primeira (valor 1) chega DEPOIS da segunda
    // (valor 2). Sem guarda de sequência, o callback da primeira vence e a
    // célula mostra 1 — que não é o que o usuário digitou por último.
    let resolveFirst: (value: { results: { recordId: string; propertyId: string; value: null | { recordId: string; propertyId: string; value: unknown; sortNum: number | null; sortText: string | null; updatedAt: string } }[] }) => void = () => undefined;
    let resolveSecond: typeof resolveFirst = () => undefined;
    vi.mocked(applyRecordValueChanges)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 1 }]);
      second = result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 2 }]);
    });

    const row = (value: number) => ({ recordId: "r1", propertyId: "p-nota", value, sortNum: value, sortText: null, updatedAt: "" });
    await act(async () => {
      resolveSecond({ results: [{ recordId: "r1", propertyId: "p-nota", value: row(2) }] });
      await second;
    });
    await act(async () => {
      resolveFirst({ results: [{ recordId: "r1", propertyId: "p-nota", value: row(1) }] });
      await first;
    });

    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-nota"]).toBe(2);
  });
});

describe("useDatabase: colunas de fórmula", () => {
  const formulaProperty = { id: "p-dobro", databaseId: "db-1", name: "Dobro", propertyType: "formula" as const, config: { expression: 'prop("Nota") * 2' }, position: "a1", createdAt: "", updatedAt: "" };

  beforeEach(() => {
    vi.mocked(listProperties).mockResolvedValue([
      { id: "p-nota", databaseId: "db-1", name: "Nota", propertyType: "number", config: {}, position: "a0", createdAt: "", updatedAt: "" },
      formulaProperty,
    ]);
    vi.mocked(listRecords).mockResolvedValue([
      { page: page("r1", "Aula 1"), values: [] },
      { page: page("r2", "Aula 2"), values: [] },
    ]);
    vi.mocked(validateFormula).mockResolvedValue({ valid: true, returnType: "número", diagnostics: [], dependsOn: ["p-nota"] });
    vi.mocked(evaluateFormulaColumn).mockResolvedValue([
      { recordId: "r1", value: 85 },
      { recordId: "r2", value: null },
    ]);
  });

  it("uma chamada de evaluate_formula_column POR COLUNA (nunca por linha), com o valor injetado em cada registro e null ausente (I1)", async () => {
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    expect(evaluateFormulaColumn).toHaveBeenCalledTimes(1);
    expect(evaluateFormulaColumn).toHaveBeenCalledWith("db-1", "p-dobro");
    expect(validateFormula).toHaveBeenCalledWith("db-1", "p-dobro", 'prop("Nota") * 2');
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-dobro"]).toBe(85);
    expect("p-dobro" in state.records[1].values).toBe(false);
  });

  it("expressão que não compila: a coluna mostra o erro do Rust em todo registro, não um vazio", async () => {
    vi.mocked(validateFormula).mockResolvedValue({
      valid: false,
      returnType: null,
      diagnostics: [{ message: "propriedade não encontrada: Outra", start: 0, end: 5 }],
      dependsOn: [],
    });
    vi.mocked(evaluateFormulaColumn).mockResolvedValue([
      { recordId: "r1", value: null },
      { recordId: "r2", value: null },
    ]);
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-dobro"]).toEqual({ formulaError: "propriedade não encontrada: Outra" });
    expect(state.records[1].values["p-dobro"]).toEqual({ formulaError: "propriedade não encontrada: Outra" });
  });

  it("uma coluna que falha no IPC não derruba a database: só ela vira erro", async () => {
    vi.mocked(evaluateFormulaColumn).mockRejectedValue(new AppError({ kind: "invalid", message: "propriedade sem expression" }));
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-dobro"]).toEqual({ formulaError: "propriedade sem expression" });
  });

  it("depois de gravar uma célula, as colunas de fórmula são recalculadas (uma chamada por coluna)", async () => {
    vi.mocked(applyRecordValueChanges).mockResolvedValue({
      results: [{ recordId: "r1", propertyId: "p-nota", value: { recordId: "r1", propertyId: "p-nota", value: 50, sortNum: 50, sortText: null, updatedAt: "" } }],
    });
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    vi.mocked(evaluateFormulaColumn).mockResolvedValue([
      { recordId: "r1", value: 100 },
      { recordId: "r2", value: null },
    ]);

    await act(async () => {
      await result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 50 }]);
    });

    expect(evaluateFormulaColumn).toHaveBeenCalledTimes(2);
    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-nota"]).toBe(50);
    expect(state.records[0].values["p-dobro"]).toBe(100);
  });

  it("addProperty passa a config inicial (a expressão) ao create_property", async () => {
    vi.mocked(createProperty).mockResolvedValue(formulaProperty);
    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      await result.current.addProperty("formula", "Dobro", { expression: "1 + 1" });
    });
    expect(createProperty).toHaveBeenCalledWith("db-1", "Dobro", "formula", { expression: "1 + 1" });
  });
});

describe("useDatabase: recálculos de fórmula concorrentes", () => {
  it("um recálculo SUPERADO por outro mais novo não sobrescreve a coluna (respostas em ordem invertida)", async () => {
    vi.mocked(listProperties).mockResolvedValue([
      { id: "p-nota", databaseId: "db-1", name: "Nota", propertyType: "number", config: {}, position: "a0", createdAt: "", updatedAt: "" },
      { id: "p-dobro", databaseId: "db-1", name: "Dobro", propertyType: "formula", config: { expression: 'prop("Nota") * 2' }, position: "a1", createdAt: "", updatedAt: "" },
    ]);
    vi.mocked(validateFormula).mockResolvedValue({ valid: true, returnType: "número", diagnostics: [], dependsOn: ["p-nota"] });
    vi.mocked(evaluateFormulaColumn).mockResolvedValueOnce([{ recordId: "r1", value: 0 }]);
    const row = (value: number) => ({ recordId: "r1", propertyId: "p-nota", value, sortNum: value, sortText: null, updatedAt: "" });
    vi.mocked(applyRecordValueChanges)
      .mockResolvedValueOnce({ results: [{ recordId: "r1", propertyId: "p-nota", value: row(1) }] })
      .mockResolvedValueOnce({ results: [{ recordId: "r1", propertyId: "p-nota", value: row(2) }] });

    const { result } = renderHook(() => useDatabase("db-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    // Dois recálculos em voo: o da PRIMEIRA escrita (Dobro=2) resolve
    // DEPOIS do da segunda (Dobro=4). Sem guarda, o primeiro vence e a
    // coluna mostra a conta do estado anterior.
    let resolveFirst: (value: { recordId: string; value: unknown }[]) => void = () => undefined;
    let resolveSecond: typeof resolveFirst = () => undefined;
    vi.mocked(evaluateFormulaColumn)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 1 }]);
    });
    await waitFor(() => expect(evaluateFormulaColumn).toHaveBeenCalledTimes(2));
    act(() => {
      second = result.current.mutations?.applyValueChanges([{ recordId: "r1", propertyId: "p-nota", value: 2 }]);
    });
    await waitFor(() => expect(evaluateFormulaColumn).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveSecond([{ recordId: "r1", value: 4 }]);
      await second;
    });
    await act(async () => {
      resolveFirst([{ recordId: "r1", value: 2 }]);
      await first;
    });

    const state = result.current.state;
    if (state.status !== "ready") throw new Error("esperava ready");
    expect(state.records[0].values["p-nota"]).toBe(2);
    expect(state.records[0].values["p-dobro"]).toBe(4);
  });
});
