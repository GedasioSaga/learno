/**
 * O menu do cabeçalho de coluna atravessando o DOM de verdade, montado pela
 * própria `TableView` com os specs REAIS (`ensureDatabaseExtensionsDiscovered`).
 * O que importa provar é a COSTURA: cada item chama a ação certa de
 * `PropertyActions` com os argumentos certos — é isso que tira
 * rename_property/change_property_type/reorder_property/delete_property
 * de `REGISTRADOS_SEM_TELA`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RecordRow } from "../../contract";
import { ensureDatabaseExtensionsDiscovered } from "../../core/discover-extensions";
import type { PropertyDescriptor } from "../../core/property-spec";
import type { PropertyActions, ViewDescriptor } from "../../core/view-spec";
import { TableView } from "./TableView";

beforeAll(() => ensureDatabaseExtensionsDiscovered());
afterEach(cleanup);

const DB = "22222222-2222-4222-8222-222222222222";
const view: ViewDescriptor = { id: "view-1", databaseId: DB, name: "Tabela", type: "table", config: {}, position: "a0" };

const nota: PropertyDescriptor = { id: "p-nota", databaseId: DB, name: "Nota", type: "number", config: { format: "plain" }, position: "a0" };
const texto: PropertyDescriptor = { id: "p-texto", databaseId: DB, name: "Resumo", type: "text", config: {}, position: "a1" };
const media: PropertyDescriptor = { id: "p-media", databaseId: DB, name: "Média", type: "formula", config: { expression: 'prop("Nota") / 2' }, position: "a2" };

function record(id: string, values: RecordRow["values"] = {}): RecordRow {
  return { id, title: id, icon: null, parentId: null, position: id, createdAt: "", updatedAt: "", values, matchedColorRuleIds: [] };
}

function actionsMock(): PropertyActions {
  return {
    rename: vi.fn().mockResolvedValue({ ok: true }),
    changeType: vi.fn().mockResolvedValue({ ok: true }),
    reorder: vi.fn().mockResolvedValue({ ok: true }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    editConfig: vi.fn(),
  };
}

function renderTable(actions: PropertyActions | null, records: RecordRow[] = [], properties = [nota, texto, media], config: unknown = {}) {
  return render(<TableView ctx={{ view: { ...view, config }, properties, records, mutations: null, propertyActions: actions }} />);
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  return screen.getByRole("dialog", { name: `Opções da coluna ${name}` });
}

describe("o cabeçalho abre menu só quando há ações de estrutura", () => {
  it("sem propertyActions (bloqueada / somente-leitura), o cabeçalho é texto — nenhum botão", () => {
    renderTable(null);
    expect(screen.queryByRole("button", { name: /Nota/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Nota/ })).toBeInTheDocument();
  });

  it("clicar no cabeçalho abre o painel com o nome já focado e selecionado; Escape fecha e devolve o foco", () => {
    renderTable(actionsMock());
    const trigger = screen.getByRole("button", { name: /^Nota/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    const panel = openMenu("Nota");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const input = within(panel).getByRole("textbox", { name: "Nome da propriedade" });
    expect(input).toHaveValue("Nota");
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("clicar fora fecha", () => {
    renderTable(actionsMock());
    openMenu("Nota");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("renomear", () => {
  it("Enter no campo de nome chama rename com o nome aparado e fecha", () => {
    const actions = actionsMock();
    renderTable(actions);
    const panel = openMenu("Nota");
    const input = within(panel).getByRole("textbox", { name: "Nome da propriedade" });
    fireEvent.change(input, { target: { value: "  Nota final  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(actions.rename).toHaveBeenCalledWith("p-nota", "Nota final");
    expect(actions.rename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sair do campo (blur) também grava; nome igual ou vazio não chama nada", () => {
    const actions = actionsMock();
    renderTable(actions);
    const panel = openMenu("Nota");
    const input = within(panel).getByRole("textbox", { name: "Nome da propriedade" });

    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(actions.rename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Pontuação" } });
    fireEvent.blur(input);
    expect(actions.rename).toHaveBeenCalledWith("p-nota", "Pontuação");
    // Enter depois do blur, com o mesmo nome, não renomeia de novo.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.rename).toHaveBeenCalledTimes(1);
  });
});

describe("mudar o tipo", () => {
  it("'Tipo' abre a lista com o atual marcado; escolher outro chama changeType e fecha", () => {
    const actions = actionsMock();
    renderTable(actions);
    const panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: /^Tipo/ }));

    const current = within(panel).getByRole("button", { name: /Número/ });
    expect(current).toHaveAttribute("aria-pressed", "true");
    // Relação e rollup não são oferecidos: o Rust recusa a troca.
    expect(within(panel).queryByRole("button", { name: /Relação|Rollup/ })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: /Texto/ }));
    expect(actions.changeType).toHaveBeenCalledWith("p-nota", "text");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("escolher o tipo atual não chama nada; Escape na lista volta à raiz em vez de fechar", () => {
    const actions = actionsMock();
    renderTable(actions);
    const panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: /^Tipo/ }));
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: "Nome da propriedade" })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: /^Tipo/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Número/ }));
    expect(actions.changeType).not.toHaveBeenCalled();
  });
});

describe("editar a configuração", () => {
  it("só um tipo com formulário (Fórmula) mostra 'Editar fórmula…', e o item pede editConfig com a propriedade", () => {
    const actions = actionsMock();
    renderTable(actions);
    const notaPanel = openMenu("Nota");
    expect(within(notaPanel).queryByRole("button", { name: /^Editar/ })).not.toBeInTheDocument();
    fireEvent.keyDown(notaPanel, { key: "Escape" });

    const mediaPanel = openMenu("Média");
    fireEvent.click(within(mediaPanel).getByRole("button", { name: "Editar fórmula…" }));
    expect(actions.editConfig).toHaveBeenCalledWith(media);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("mover", () => {
  it("a primeira coluna não move para a esquerda (desabilitado, com motivo); mover para a direita fica depois da vizinha", () => {
    const actions = actionsMock();
    renderTable(actions);
    const panel = openMenu("Nota");
    const left = within(panel).getByRole("button", { name: "Mover para a esquerda" });
    expect(left).toBeDisabled();
    expect(left).toHaveAttribute("title", "Já é a primeira coluna");

    fireEvent.click(within(panel).getByRole("button", { name: "Mover para a direita" }));
    expect(actions.reorder).toHaveBeenCalledWith("p-nota", "p-texto");
  });

  it("mover a última para a esquerda cai depois da que está duas à esquerda; a segunda vai para primeiro (null)", () => {
    const actions = actionsMock();
    renderTable(actions);
    let panel = openMenu("Média");
    expect(within(panel).getByRole("button", { name: "Mover para a direita" })).toBeDisabled();
    fireEvent.click(within(panel).getByRole("button", { name: "Mover para a esquerda" }));
    expect(actions.reorder).toHaveBeenCalledWith("p-media", "p-nota");

    panel = openMenu("Resumo");
    fireEvent.click(within(panel).getByRole("button", { name: "Mover para a esquerda" }));
    expect(actions.reorder).toHaveBeenCalledWith("p-texto", null);
  });

  it("com columnOrder na view, a ordem da tela não é a position — os itens de mover nem aparecem", () => {
    renderTable(actionsMock(), [], [nota, texto, media], { columnOrder: ["p-texto", "p-nota"] });
    const panel = openMenu("Nota");
    expect(within(panel).queryByRole("button", { name: /^Mover/ })).not.toBeInTheDocument();
  });
});

describe("apagar", () => {
  it("pede confirmação dizendo quantos registros perdem valor; confirmar chama delete", async () => {
    const actions = actionsMock();
    renderTable(actions, [record("r1", { "p-nota": 7 }), record("r2", { "p-nota": 0 }), record("r3")]);
    const panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: "Apagar propriedade" }));

    const dialog = screen.getByRole("alertdialog", { name: "Apagar a propriedade “Nota”?" });
    // `0` conta como valor (I1): dois registros têm valor, não um.
    expect(dialog).toHaveTextContent("2 registros perdem o valor desta coluna");
    expect(actions.delete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancelar" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Apagar propriedade" }));
    await waitFor(() => expect(actions.delete).toHaveBeenCalledWith("p-nota"));
  });

  it("Cancelar e Escape não apagam; erro do backend fica no diálogo", async () => {
    const actions = actionsMock();
    vi.mocked(actions.delete).mockResolvedValue({ ok: false, message: "database bloqueada" });
    renderTable(actions);

    let panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: "Apagar propriedade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: "Apagar propriedade" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(actions.delete).not.toHaveBeenCalled();

    panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: "Apagar propriedade" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apagar propriedade" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database bloqueada");
  });
});

describe("teclado dentro do painel", () => {
  it("setas andam entre nome e itens, dando a volta; nada sobe para a grade", () => {
    renderTable(actionsMock());
    const panel = openMenu("Nota");
    const input = within(panel).getByRole("textbox", { name: "Nome da propriedade" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(panel, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: /^Tipo/ }));
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Apagar propriedade" }));
  });
});

describe("foco ao trocar de página", () => {
  it("entrar em 'Tipo' foca o '‹ Tipo'; Escape volta e foca o nome — o teclado nunca cai no body", () => {
    renderTable(actionsMock());
    const panel = openMenu("Nota");
    fireEvent.click(within(panel).getByRole("button", { name: /^Tipo/ }));
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: /^Tipo$/ }));

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement).toBe(within(panel).getByRole("textbox", { name: "Nome da propriedade" }));
  });
});
