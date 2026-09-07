/**
 * O editor contra o IPC mockado — mesmo padrão de
 * `loader/use-database.test.tsx`. Prova as quatro promessas da bar:
 * a paleta vem do Rust e clicar insere; o erro mostrado é o do Rust, na
 * posição que ele devolveu; expressão inválida não é salvável; e a prévia
 * é avaliada contra um registro real.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listFormulaFunctions, previewFormula, validateFormula } from "../../../../lib/ipc";
import type { RecordRow } from "../../contract";
import type { PropertyConfigFormContext, PropertyDescriptor } from "../../core/property-spec";
import { FormulaConfigForm } from "./FormulaConfigForm";
import type { FormulaConfig } from "./formula-value";

vi.mock("../../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/ipc")>();
  return { ...actual, listFormulaFunctions: vi.fn(), validateFormula: vi.fn(), previewFormula: vi.fn() };
});

afterEach(cleanup);

function record(id: string, title: string): RecordRow {
  return { id, title, icon: null, parentId: null, position: id, createdAt: "", updatedAt: "", values: {}, matchedColorRuleIds: [] };
}

const draft: PropertyDescriptor<FormulaConfig> = { id: "", databaseId: "db-1", name: "Média", type: "formula", config: { expression: "" }, position: "" };
const nota: PropertyDescriptor = { id: "p-nota", databaseId: "db-1", name: "Nota", type: "number", config: {}, position: "a0" };

function renderForm(overrides: Partial<PropertyConfigFormContext<FormulaConfig>> = {}) {
  const commit = vi.fn();
  const ctx: PropertyConfigFormContext<FormulaConfig> = {
    config: { expression: "" },
    property: draft,
    properties: [nota],
    records: [record("r1", "Aula 1"), record("r2", "Aula 2")],
    commit,
    ...overrides,
  };
  render(<FormulaConfigForm ctx={ctx} />);
  return { commit };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFormulaFunctions).mockResolvedValue([
    { name: "round", category: "matemática", doc: "Arredonda para o inteiro mais próximo.", arity: "entre 1 e 2 argumentos" },
    { name: "length", category: "texto", doc: "Quantidade de caracteres.", arity: "exatamente 1 argumento" },
  ]);
  vi.mocked(validateFormula).mockResolvedValue({ valid: true, returnType: "número", diagnostics: [], dependsOn: [] });
  vi.mocked(previewFormula).mockResolvedValue({ value: 85, diagnostics: [] });
});

describe("a paleta", () => {
  it("lista as funções do Rust agrupadas pela categoria dele, com doc e aridade prontas", async () => {
    renderForm();
    expect(await screen.findByRole("heading", { name: "matemática" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "texto" })).toBeInTheDocument();
    expect(screen.getByText("Arredonda para o inteiro mais próximo.")).toBeInTheDocument();
    expect(screen.getByText("entre 1 e 2 argumentos")).toBeInTheDocument();
    expect(listFormulaFunctions).toHaveBeenCalledTimes(1);
  });

  it("clicar numa função insere `nome()` na expressão; clicar numa propriedade insere prop(\"Nome\")", async () => {
    renderForm();
    const textarea = screen.getByLabelText("Expressão") as HTMLTextAreaElement;
    // O nome acessível é o texto visível do item: nome, aridade e doc.
    fireEvent.click(await screen.findByRole("button", { name: /^round/ }));
    expect(textarea.value).toBe("round()");

    // O cursor está entre os parênteses (o `requestAnimationFrame` do foco
    // corre fora do teste); posicionamos à mão para provar a inserção.
    textarea.setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole("button", { name: /^prop\("Nota"\)/ }));
    expect(textarea.value).toBe('round(prop("Nota"))');
  });

  it("propriedades que o motor não lê (multi_select) não ganham botão", async () => {
    renderForm({ properties: [nota, { ...nota, id: "p-tags", name: "Tags", type: "multi_select" }] });
    await screen.findByRole("heading", { name: "matemática" });
    expect(screen.queryByRole("button", { name: /^prop\("Tags"\)/ })).not.toBeInTheDocument();
  });
});

describe("validação ao vivo", () => {
  it("expressão vazia: nada é validado e o botão fica desabilitado com o motivo", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Criar propriedade" })).toBeDisabled();
    expect(screen.getByText("Escreva uma expressão para habilitar.")).toBeInTheDocument();
    expect(validateFormula).not.toHaveBeenCalled();
  });

  it("expressão inválida: mostra a mensagem do Rust na linha/coluna que ele devolveu e não deixa salvar", async () => {
    vi.mocked(validateFormula).mockResolvedValue({
      valid: false,
      returnType: null,
      diagnostics: [{ message: "identificador desconhecido: naoexiste", start: 9, end: 18 }],
      dependsOn: [],
    });
    const { commit } = renderForm();
    fireEvent.change(screen.getByLabelText("Expressão"), { target: { value: '"café" + naoexiste' } });

    expect(await screen.findByText("identificador desconhecido: naoexiste")).toBeInTheDocument();
    // start=9 em UTF-16 (o "é" conta 1) => coluna 10.
    expect(screen.getByRole("button", { name: "linha 1, coluna 10" })).toBeInTheDocument();
    expect(validateFormula).toHaveBeenCalledWith("db-1", null, '"café" + naoexiste');
    expect(screen.getByLabelText("Expressão")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Criar propriedade" })).toBeDisabled();
    expect(previewFormula).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Criar propriedade" }));
    expect(commit).not.toHaveBeenCalled();
  });

  it("clicar em 'linha, coluna' seleciona o trecho do erro na caixa", async () => {
    vi.mocked(validateFormula).mockResolvedValue({
      valid: false,
      returnType: null,
      diagnostics: [{ message: "erro", start: 4, end: 7 }],
      dependsOn: [],
    });
    renderForm();
    const textarea = screen.getByLabelText("Expressão") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "1 + abc" } });
    fireEvent.click(await screen.findByRole("button", { name: "linha 1, coluna 5" }));
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.selectionEnd).toBe(7);
  });

  it("expressão válida: diz o tipo do resultado, calcula a prévia contra o registro escolhido e habilita salvar com a expressão aparada", async () => {
    const { commit } = renderForm();
    fireEvent.change(screen.getByLabelText("Expressão"), { target: { value: ' prop("Nota") * 2 ' } });

    expect(await screen.findByText("Válida. Resultado: número.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("85")).toBeInTheDocument());
    expect(previewFormula).toHaveBeenCalledWith("db-1", "r1", ' prop("Nota") * 2 ');

    fireEvent.click(screen.getByRole("button", { name: "Criar propriedade" }));
    expect(commit).toHaveBeenCalledWith({ expression: 'prop("Nota") * 2' });
  });

  it("trocar o registro da prévia recalcula contra o registro novo", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Expressão"), { target: { value: "1 + 1" } });
    await waitFor(() => expect(previewFormula).toHaveBeenCalledWith("db-1", "r1", "1 + 1"));

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Registro da prévia" }), { target: { value: "r2" } });
    });
    await waitFor(() => expect(previewFormula).toHaveBeenCalledWith("db-1", "r2", "1 + 1"));
  });

  it("sem registros: explica por que não há prévia, sem controle de escolha", () => {
    renderForm({ records: [] });
    expect(screen.getByText(/ainda não tem registros/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("propriedade já existente passa o próprio id ao validador (para o Rust recusar auto-referência)", async () => {
    renderForm({ property: { ...draft, id: "p-media" } });
    fireEvent.change(screen.getByLabelText("Expressão"), { target: { value: "1" } });
    await waitFor(() => expect(validateFormula).toHaveBeenCalledWith("db-1", "p-media", "1"));
    expect(screen.getByRole("button", { name: "Salvar fórmula" })).toBeInTheDocument();
  });
});
