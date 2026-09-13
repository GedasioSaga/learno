/**
 * O modo "editar" do diálogo de configuração — a metade que ninguém abria
 * até o menu de coluna existir. O que vale provar: o formulário recebe a
 * config PERSISTIDA (a expressão atual aparece), com um id de verdade
 * (`validate_formula` recebe o `propertyId`, não `null`), e "Salvar
 * fórmula" entrega a expressão nova a `onSave`. E a defesa: uma Fórmula
 * cujo `config` chegou `{}` do banco abre vazia em vez de derrubar o diálogo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listFormulaFunctions, previewFormula, validateFormula } from "../../../lib/ipc";
import type { PropertyDescriptor } from "../core/property-spec";
import { formulaPropertySpec } from "../properties/formula/formula-spec";
import { effectiveConfig, PropertyConfigDialog } from "./PropertyConfigDialog";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, listFormulaFunctions: vi.fn(), validateFormula: vi.fn(), previewFormula: vi.fn() };
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFormulaFunctions).mockResolvedValue([]);
  vi.mocked(validateFormula).mockResolvedValue({ valid: true, returnType: "número", diagnostics: [], dependsOn: [] });
  vi.mocked(previewFormula).mockResolvedValue({ value: 1, diagnostics: [] });
});

const media: PropertyDescriptor = { id: "p-media", databaseId: "db-1", name: "Média", type: "formula", config: { expression: 'prop("Nota") / 2' }, position: "a1" };

describe("effectiveConfig: a config persistida por cima do padrão do tipo", () => {
  it("preenche chave ausente com o defaultConfig, sem apagar o que está persistido", () => {
    expect(effectiveConfig(formulaPropertySpec, {})).toEqual({ expression: "" });
    expect(effectiveConfig(formulaPropertySpec, { expression: "1 + 1" })).toEqual({ expression: "1 + 1" });
    expect(effectiveConfig(formulaPropertySpec, { expression: "1", extra: true })).toEqual({ expression: "1", extra: true });
  });

  it("config que não é objeto (blob corrompido) cai no padrão", () => {
    expect(effectiveConfig(formulaPropertySpec, null)).toEqual({ expression: "" });
    expect(effectiveConfig(formulaPropertySpec, undefined)).toEqual({ expression: "" });
  });
});

describe("modo editar", () => {
  it("abre com a expressão atual, valida com o id da própria propriedade, e 'Salvar fórmula' entrega a expressão nova a onSave", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PropertyConfigDialog mode="edit" spec={formulaPropertySpec} property={media} databaseId="db-1" properties={[media]} records={[]} onCancel={vi.fn()} onSave={onSave} />,
    );

    const dialog = screen.getByRole("dialog", { name: "Editar fórmula: Média" });
    // Renomear não é aqui — é no menu de coluna.
    expect(within(dialog).queryByLabelText("Nome")).not.toBeInTheDocument();
    const textarea = within(dialog).getByLabelText("Expressão");
    expect(textarea).toHaveValue('prop("Nota") / 2');
    await waitFor(() => expect(validateFormula).toHaveBeenCalledWith("db-1", "p-media", 'prop("Nota") / 2'));

    fireEvent.change(textarea, { target: { value: 'prop("Nota") * 2' } });
    const save = await within(dialog).findByRole("button", { name: "Salvar fórmula" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ expression: 'prop("Nota") * 2' }));
  });

  it("erro ao salvar fica colado ao formulário, com a expressão intacta", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, message: "database bloqueada" });
    render(
      <PropertyConfigDialog mode="edit" spec={formulaPropertySpec} property={media} databaseId="db-1" properties={[media]} records={[]} onCancel={vi.fn()} onSave={onSave} />,
    );
    const dialog = screen.getByRole("dialog");
    const save = await within(dialog).findByRole("button", { name: "Salvar fórmula" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("database bloqueada");
    expect(within(dialog).getByLabelText("Expressão")).toHaveValue('prop("Nota") / 2');
  });

  it("uma Fórmula com config {} vinda do banco abre vazia em vez de quebrar", () => {
    const orfa: PropertyDescriptor = { ...media, config: {} };
    render(
      <PropertyConfigDialog mode="edit" spec={formulaPropertySpec} property={orfa} databaseId="db-1" properties={[orfa]} records={[]} onCancel={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByLabelText("Expressão")).toHaveValue("");
  });
});
