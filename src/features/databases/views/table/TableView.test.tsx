/**
 * A view Tabela atravessando o DOM de verdade, com os specs REAIS de
 * propriedade (descobertos por `core/discover-extensions.ts`) — a célula
 * delega ao registro, então provar a tabela com um spec de mentira provaria
 * só a metade que ela não faz.
 *
 * O que vale mais aqui é I1 pelo caminho de escrita: apagar o conteúdo de
 * uma célula tem que chegar em `applyValueChanges` como `value: null`
 * (o Rust apaga a linha), nunca como `""`/`false`/`[]`; e `0` de Número
 * tem que chegar como `0`, nunca virar vazio.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RecordRow } from "../../contract";
import { ensureDatabaseExtensionsDiscovered } from "../../core/discover-extensions";
import { registerPropertySpec, type PropertyDescriptor } from "../../core/property-spec";
import type { ViewDescriptor, ViewMutations } from "../../core/view-spec";
import { TableView } from "./TableView";

beforeAll(() => ensureDatabaseExtensionsDiscovered());
afterEach(cleanup);

const DB = "22222222-2222-4222-8222-222222222222";

const view: ViewDescriptor = { id: "view-1", databaseId: DB, name: "Tabela", type: "table", config: {}, position: "a0" };

const nota: PropertyDescriptor = { id: "p-nota", databaseId: DB, name: "Nota", type: "number", config: { format: "plain" }, position: "a0" };
const feito: PropertyDescriptor = { id: "p-feito", databaseId: DB, name: "Feito", type: "checkbox", config: {}, position: "a1" };
const texto: PropertyDescriptor = { id: "p-texto", databaseId: DB, name: "Resumo", type: "text", config: {}, position: "a2" };
const criado: PropertyDescriptor = { id: "p-criado", databaseId: DB, name: "Criado em", type: "created_time", config: {}, position: "a3" };

function record(id: string, title: string, values: RecordRow["values"] = {}): RecordRow {
  return {
    id,
    title,
    icon: null,
    parentId: null,
    position: id,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    values,
    matchedColorRuleIds: [],
  };
}

function mutationsMock(): ViewMutations {
  return {
    applyValueChanges: vi.fn().mockResolvedValue(undefined),
    renameRecord: vi.fn().mockResolvedValue(undefined),
    createRecord: vi.fn().mockResolvedValue("rec-novo"),
  };
}

function renderTable(records: RecordRow[], mutations: ViewMutations | null, properties = [nota, feito, texto, criado]) {
  return render(<TableView ctx={{ view, properties, records, mutations }} />);
}

describe("estrutura: linha = registro, coluna = propriedade", () => {
  it("desenha o cabeçalho com 'Nome' mais uma coluna por propriedade, e uma linha por registro", () => {
    renderTable([record("r1", "Aula 1", { "p-nota": 7 }), record("r2", "Aula 2")], mutationsMock());

    const grid = screen.getByRole("grid", { name: "Tabela" });
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    const headers = within(grid).getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["AaNome", "#Nota", "☑Feito", "📝Resumo", expect.stringContaining("Criado em")]);
    expect(within(grid).getByText("Aula 1")).toBeInTheDocument();
    expect(within(grid).getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 registros");
  });

  it("título vazio mostra 'Sem título' como placeholder, nunca célula em branco", () => {
    renderTable([record("r1", "")], mutationsMock());
    expect(screen.getByText("Sem título")).toBeInTheDocument();
  });

  it("sem registros: estado vazio explicado + 'Nova linha' continua disponível", () => {
    renderTable([], mutationsMock());
    expect(screen.getByText(/Nenhum registro ainda/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nova linha" })).toBeInTheDocument();
  });

  it("somente-leitura (mutations null): nenhum controle de escrita aparece", () => {
    renderTable([record("r1", "Aula 1")], null);
    expect(screen.queryByRole("button", { name: "Nova linha" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Aula 1"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("coluna com columnVisibility 'never' some; columnOrder do config manda na ordem", () => {
    const configured: ViewDescriptor = {
      ...view,
      config: { columnOrder: ["p-texto", "p-nota"], columnVisibility: { "p-feito": "never" } },
    };
    render(<TableView ctx={{ view: configured, properties: [nota, feito, texto], records: [], mutations: null }} />);
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["AaNome", "📝Resumo", "#Nota"]);
  });
});

describe("editar célula no lugar", () => {
  it("clicar numa célula de Número abre o editor; Enter grava o valor serializado e fecha", async () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1", { "p-nota": 7 })], mutations);

    fireEvent.click(screen.getByText("7"));
    const input = screen.getByRole("spinbutton", { name: "Editar Nota" });
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutations.applyValueChanges).toHaveBeenCalledWith([{ recordId: "r1", propertyId: "p-nota", value: 9 }]);
    await waitFor(() => expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument());
  });

  it("I1: apagar o conteúdo manda value: null (o Rust apaga a linha), nunca ''", () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1", { "p-nota": 7 })], mutations);

    fireEvent.click(screen.getByText("7"));
    const input = screen.getByRole("spinbutton", { name: "Editar Nota" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutations.applyValueChanges).toHaveBeenCalledWith([{ recordId: "r1", propertyId: "p-nota", value: null }]);
  });

  it("I1, a armadilha: digitar 0 grava 0 — não é vazio", () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1", { "p-nota": 7 })], mutations);

    fireEvent.click(screen.getByText("7"));
    const input = screen.getByRole("spinbutton", { name: "Editar Nota" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutations.applyValueChanges).toHaveBeenCalledWith([{ recordId: "r1", propertyId: "p-nota", value: 0 }]);
  });

  it("fechar sem mudar nada não grava nada", () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1", { "p-nota": 7 })], mutations);

    fireEvent.click(screen.getByText("7"));
    const input = screen.getByRole("spinbutton", { name: "Editar Nota" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mutations.applyValueChanges).not.toHaveBeenCalled();
  });

  it("checkbox: UM clique alterna e persiste (DBS-017); desmarcar manda null, nunca false (I1)", () => {
    const mutations = mutationsMock();
    const { rerender } = renderTable([record("r1", "Aula 1")], mutations);

    fireEvent.click(screen.getByRole("checkbox", { name: "Feito" }));
    expect(mutations.applyValueChanges).toHaveBeenCalledWith([{ recordId: "r1", propertyId: "p-feito", value: true }]);

    rerender(<TableView ctx={{ view, properties: [nota, feito, texto, criado], records: [record("r1", "Aula 1", { "p-feito": true })], mutations }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Feito" }));
    expect(mutations.applyValueChanges).toHaveBeenLastCalledWith([{ recordId: "r1", propertyId: "p-feito", value: null }]);
  });

  it("propriedade derivada (created_time) não abre editor: clicar não mostra nada, e a célula se declara somente-leitura", () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1")], mutations);

    const cells = screen.getAllByRole("gridcell");
    const criadoCell = cells[cells.length - 1];
    expect(criadoCell).toHaveAttribute("aria-readonly", "true");
    fireEvent.click(criadoCell);
    expect(screen.queryByRole("group", { name: /Editar/ })).not.toBeInTheDocument();
    expect(mutations.applyValueChanges).not.toHaveBeenCalled();
  });

  it("Escape fecha o editor e devolve o foco à célula", async () => {
    renderTable([record("r1", "Aula 1", { "p-nota": 7 })], mutationsMock());
    const cell = screen.getByText("7").closest("td");
    if (!cell) throw new Error("célula não encontrada");

    fireEvent.click(cell);
    const input = screen.getByRole("spinbutton", { name: "Editar Nota" });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument());
    await waitFor(() => expect(cell).toHaveFocus());
  });
});

describe("título do registro é a página (rename_page)", () => {
  it("clicar no título abre um input; Enter renomeia; Escape cancela sem gravar", async () => {
    const mutations = mutationsMock();
    renderTable([record("r1", "Aula 1")], mutations);

    fireEvent.click(screen.getByText("Aula 1"));
    const input = screen.getByRole("textbox", { name: "Título do registro" });
    fireEvent.change(input, { target: { value: "Aula 1 — revisada" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mutations.renameRecord).toHaveBeenCalledWith("r1", "Aula 1 — revisada");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());

    fireEvent.click(screen.getByText("Aula 1"));
    const again = screen.getByRole("textbox", { name: "Título do registro" });
    fireEvent.change(again, { target: { value: "descartar" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(mutations.renameRecord).toHaveBeenCalledTimes(1);
  });
});

describe("Nova linha", () => {
  it("cria o registro e abre a célula de título dele para nomear", async () => {
    const mutations = mutationsMock();
    const { rerender } = renderTable([record("r1", "Aula 1")], mutations);

    fireEvent.click(screen.getByRole("button", { name: "Nova linha" }));
    await waitFor(() => expect(mutations.createRecord).toHaveBeenCalledOnce());
    // `createRecord` resolve num microtask; a tabela só decide "abrir o título" depois dele.
    await act(async () => {});

    // O carregador é quem acrescenta a linha; aqui simulamos a chegada dela.
    rerender(<TableView ctx={{ view, properties: [nota, feito, texto, criado], records: [record("r1", "Aula 1"), record("rec-novo", "")], mutations }} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Título do registro" })).toBeInTheDocument());
  });
});

describe("teclado: grade com foco rotativo", () => {
  it("só a célula ativa está na ordem de Tab; setas movem o foco; Enter abre a edição", async () => {
    renderTable([record("r1", "Aula 1", { "p-nota": 7 }), record("r2", "Aula 2")], mutationsMock());

    const cells = screen.getAllByRole("gridcell");
    const tabbable = cells.filter((cell) => cell.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveTextContent("Aula 1");

    fireEvent.keyDown(tabbable[0], { key: "ArrowRight" });
    const notaCell = screen.getByText("7").closest("td");
    await waitFor(() => expect(notaCell).toHaveFocus());

    fireEvent.keyDown(notaCell as HTMLElement, { key: "ArrowDown" });
    const cellsAfter = screen.getAllByRole("gridcell");
    const rowTwoNota = cellsAfter[cellsAfter.length / 2 + 1];
    await waitFor(() => expect(rowTwoNota).toHaveFocus());

    fireEvent.keyDown(rowTwoNota, { key: "Enter" });
    expect(screen.getByRole("spinbutton", { name: "Editar Nota" })).toBeInTheDocument();
  });
});

describe("uma célula que não consegue se desenhar não derruba a grade", () => {
  it("renderValue lançando vira 'valor ilegível' na própria célula; as vizinhas continuam", () => {
    registerPropertySpec<string, Record<string, never>>({
      type: "spec_test_explode",
      label: "Explode (teste)",
      icon: "!",
      valueShape: "text",
      defaultConfig: {},
      isEmpty: (value) => value === null || value === undefined,
      normalize: (value) => (typeof value === "string" ? value : null),
      parse: (raw) => (typeof raw === "string" ? raw : ""),
      serialize: (value) => value,
      renderValue: () => {
        throw new Error("valor corrompido");
      },
      filterOperators: [],
      sort: "none",
      toPlainText: (value) => value ?? "",
    });
    const explode: PropertyDescriptor = { id: "p-x", databaseId: DB, name: "Explode", type: "spec_test_explode", config: {}, position: "a9" };
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderTable([record("r1", "Aula 1", { "p-nota": 7, "p-x": "qualquer coisa" })], mutationsMock(), [nota, explode]);

    expect(screen.getByText("valor ilegível")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Aula 1")).toBeInTheDocument();
    silence.mockRestore();
  });
});
