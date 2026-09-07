/**
 * DBS-001/DBS-002. Registra um `ViewSpec` de mentira (o registro real de
 * table/board é de outra peça, ainda não existe nesta rodada) só para provar
 * duas coisas que são do MEU escopo: (1) o cabeçalho — hover/foco revela
 * Filtrar/Ordenar/+Novo, "+ Propriedade"/"+ View" desabilitam com
 * `isLocked`, expandir reabre o MESMO estado em página inteira; (2) o corpo
 * nunca recebe nem propaga `isLocked` — o que garante, estruturalmente, que
 * bloquear estrutura nunca trava edição de valor.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listFormulaFunctions, validateFormula } from "../../../lib/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../contract";
import { registerViewSpec, resetViewSpecRegistryForTests } from "../core/view-spec";
import type { PropertyDescriptor } from "../core/property-spec";
import type { ViewDescriptor } from "../core/view-spec";
import { DatabaseContainer } from "./DatabaseContainer";
import type { DatabaseContainerActions, DatabaseContainerState, DatabaseSchema } from "./types";

const FAKE_VIEW_TYPE = "spec_test_table";

function makeDatabase(overrides: Partial<Database> = {}): Database {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    containerPageId: "11111111-1111-4111-8111-111111111111",
    name: "Notas de aula",
    isLocked: false,
    config: {},
    dataVersion: 0,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

function makeView(overrides: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return {
    id: "view-1",
    databaseId: "22222222-2222-4222-8222-222222222222",
    name: "Tabela",
    type: FAKE_VIEW_TYPE,
    config: {},
    position: "a0",
    ...overrides,
  };
}

function makeSchema(overrides: Partial<DatabaseSchema> = {}): DatabaseSchema {
  const properties: readonly PropertyDescriptor[] = [];
  const views: readonly ViewDescriptor[] = [makeView()];
  return { database: makeDatabase(), properties, views, ...overrides };
}

function readyState(schema: DatabaseSchema = makeSchema()): DatabaseContainerState {
  return { status: "ready", schema, records: [] };
}

/** O que a view "renderiza": um marcador de linhas e um input que simula edição de célula — o corpo nunca sabe (nem precisa saber) se a database está bloqueada. */
function registerFakeViewSpec() {
  registerViewSpec({
    type: FAKE_VIEW_TYPE,
    label: "Tabela (teste)",
    icon: "▦",
    defaultConfig: {},
    render: ({ properties }) => (
      <div>
        <p>propriedades: {properties.length}</p>
        <label htmlFor="fake-cell">Valor da célula</label>
        <input id="fake-cell" defaultValue="42" />
      </div>
    ),
  });
}

beforeEach(() => {
  registerFakeViewSpec();
});

afterEach(() => {
  resetViewSpecRegistryForTests();
});

describe("DBS-001: cabeçalho inline revela ações no hover/foco", () => {
  it("Filtrar/Ordenar/+Novo ficam ausentes até o cabeçalho ganhar hover ou foco, e somem ao sair", () => {
    const actions: DatabaseContainerActions = { onFilter: vi.fn(), onSort: vi.fn(), onCreateRecord: vi.fn() };
    render(<DatabaseContainer state={readyState()} mode="inline" actions={actions} />);

    expect(screen.queryByRole("button", { name: "Filtrar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ordenar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Novo" })).not.toBeInTheDocument();

    const header = screen.getByText("Notas de aula").parentElement;
    if (!header) throw new Error("cabeçalho não encontrado");
    fireEvent.mouseEnter(header);

    expect(screen.getByRole("button", { name: "Filtrar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ordenar" })).toBeInTheDocument();
    const novo = screen.getByRole("button", { name: "+ Novo" });
    fireEvent.click(novo);
    expect(actions.onCreateRecord).toHaveBeenCalledOnce();

    fireEvent.mouseLeave(header);
    expect(screen.queryByRole("button", { name: "Filtrar" })).not.toBeInTheDocument();
  });

  it("sem nenhum callback de ação (campo opcional ausente), Filtrar/Ordenar/+Novo nunca aparecem — sem controle morto", () => {
    render(<DatabaseContainer state={readyState()} mode="inline" />);

    const header = screen.getByText("Notas de aula").parentElement;
    if (!header) throw new Error("cabeçalho não encontrado");
    fireEvent.mouseEnter(header);

    expect(screen.queryByRole("button", { name: "Filtrar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ordenar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Novo" })).not.toBeInTheDocument();
    // "+ Propriedade"/"+ View" continuam existindo (não são gated por hover
    // nem por callback ausente da mesma forma) — só ficam desabilitados.
    expect(screen.getByRole("button", { name: "+ Propriedade" })).toBeDisabled();
  });
});

describe("DBS-002: bloqueio de estrutura nunca trava edição de valor", () => {
  it("database bloqueada desabilita '+ Propriedade'/'+ View', mas o campo de valor no corpo continua editável", () => {
    const actions: DatabaseContainerActions = { onAddProperty: vi.fn(), onAddView: vi.fn() };
    const schema = makeSchema({ database: makeDatabase({ isLocked: true }) });
    render(<DatabaseContainer state={readyState(schema)} mode="fullPage" actions={actions} />);

    const addProperty = screen.getByRole("button", { name: "+ Propriedade" });
    const addView = screen.getByRole("button", { name: "+ View" });
    expect(addProperty).toBeDisabled();
    expect(addView).toBeDisabled();
    expect(addProperty).toHaveAttribute("title", "Database bloqueada contra alteração de estrutura");

    // O corpo (aqui, o spec de view de mentira) nunca sabe que a database
    // está bloqueada — `ViewRenderContext` não carrega esse campo — então a
    // "célula" simulada continua um <input> comum, editável de verdade.
    const cell = screen.getByLabelText("Valor da célula");
    expect(cell).not.toBeDisabled();
    fireEvent.change(cell, { target: { value: "99" } });
    expect(cell).toHaveValue("99");
  });

  it("database DESbloqueada habilita '+ Propriedade'/'+ View' quando há callback", () => {
    const actions: DatabaseContainerActions = { onAddProperty: vi.fn(), onAddView: vi.fn() };
    render(<DatabaseContainer state={readyState()} mode="fullPage" actions={actions} />);

    const addProperty = screen.getByRole("button", { name: "+ Propriedade" });
    expect(addProperty).not.toBeDisabled();
    // "+ Propriedade" abre o menu de TIPO (registro real de `properties/`,
    // descoberto por `DatabaseContainer`); escolher um tipo é o que chama o
    // callback — com o tipo e o nome inicial.
    fireEvent.click(addProperty);
    fireEvent.click(screen.getByRole("menuitem", { name: "Texto" }));
    expect(actions.onAddProperty).toHaveBeenCalledWith("text", "Texto");
  });

  it("em página inteira a barra de ações fica sempre visível, sem precisar de hover", () => {
    render(<DatabaseContainer state={readyState()} mode="fullPage" actions={{ onFilter: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Filtrar" })).toBeInTheDocument();
  });
});

describe("DBS-001: expandir abre como página inteira com o MESMO estado", () => {
  it("clicar em 'Abrir como página inteira' mostra um diálogo com o mesmo conteúdo, e 'Fechar' o remove", () => {
    render(<DatabaseContainer state={readyState()} mode="inline" />);

    const header = screen.getByText("Notas de aula").parentElement;
    if (!header) throw new Error("cabeçalho não encontrado");
    fireEvent.mouseEnter(header);
    fireEvent.click(screen.getByRole("button", { name: "Abrir como página inteira" }));

    const dialog = screen.getByRole("dialog", { name: "Notas de aula — página inteira" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Mesmas propriedades (0), mesma view — nenhum segundo carregamento.
    expect(within(dialog).getByText("propriedades: 0")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicar no fundo (backdrop) também fecha, e clicar dentro do painel não fecha", () => {
    render(<DatabaseContainer state={readyState()} mode="inline" />);
    const header = screen.getByText("Notas de aula").parentElement;
    if (!header) throw new Error("cabeçalho não encontrado");
    fireEvent.mouseEnter(header);
    fireEvent.click(screen.getByRole("button", { name: "Abrir como página inteira" }));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("backdrop do diálogo não encontrado");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("DatabaseContainer: estados de carregamento", () => {
  it("loading mostra status, error mostra alerta — nenhum dos dois tenta desenhar o corpo", () => {
    const { rerender } = render(<DatabaseContainer state={{ status: "loading" }} mode="inline" />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando database…");

    rerender(<DatabaseContainer state={{ status: "error", message: "Falhou de propósito" }} mode="inline" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Falhou de propósito");
  });
});

describe("DatabaseContainerBody: fallback sem quebrar quando não há view desenhável", () => {
  it("sem view nenhuma, mostra estado vazio explicado", () => {
    const schema = makeSchema({ views: [] });
    render(<DatabaseContainer state={readyState(schema)} mode="fullPage" />);
    expect(screen.getByText("Nenhuma view ainda")).toBeInTheDocument();
  });

  it("view de um tipo sem spec registrado nomeia o tipo em vez de travar", () => {
    const schema = makeSchema({ views: [makeView({ type: "board_de_versao_futura", name: "Board" })] });
    render(<DatabaseContainer state={readyState(schema)} mode="fullPage" />);
    expect(screen.getByText('Tipo de view "board_de_versao_futura" desconhecido')).toBeInTheDocument();
  });
});

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, listFormulaFunctions: vi.fn(), validateFormula: vi.fn(), previewFormula: vi.fn() };
});

describe("propriedade que pede configuração antes de nascer (Fórmula)", () => {
  it("escolher 'Fórmula' abre o editor em vez de criar na hora; criar com expressão válida entrega nome e config ao callback", async () => {
    vi.mocked(listFormulaFunctions).mockResolvedValue([]);
    vi.mocked(validateFormula).mockResolvedValue({ valid: true, returnType: "número", diagnostics: [], dependsOn: [] });
    const actions: DatabaseContainerActions = { onAddProperty: vi.fn() };
    render(<DatabaseContainer state={readyState()} mode="fullPage" actions={actions} />);

    fireEvent.click(screen.getByRole("button", { name: "+ Propriedade" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fórmula" }));

    // Nada foi criado ainda: o diálogo é quem decide.
    expect(actions.onAddProperty).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Nova propriedade: Fórmula" });
    fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "Dobro" } });
    fireEvent.change(within(dialog).getByLabelText("Expressão"), { target: { value: "2 * 2" } });
    const create = await within(dialog).findByRole("button", { name: "Criar propriedade" });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);

    expect(actions.onAddProperty).toHaveBeenCalledWith("formula", "Dobro", { expression: "2 * 2" });
    // O diálogo fecha DEPOIS de o `onAddProperty` resolver, não no clique: se
    // `create_property` falhar, ele precisa continuar aberto com a expressão
    // digitada, em vez de sumir e deixar o erro aparecer solto ao lado da
    // tabela. Por isso a espera — a asserção é a mesma, só aguardada.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Escape fecha o editor sem criar nada", () => {
    vi.mocked(listFormulaFunctions).mockResolvedValue([]);
    const actions: DatabaseContainerActions = { onAddProperty: vi.fn() };
    render(<DatabaseContainer state={readyState()} mode="fullPage" actions={actions} />);

    fireEvent.click(screen.getByRole("button", { name: "+ Propriedade" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fórmula" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(actions.onAddProperty).not.toHaveBeenCalled();
  });
});
