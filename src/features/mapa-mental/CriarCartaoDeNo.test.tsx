/**
 * Item 2 do briefing desta peça: criar um cartão a partir do RÓTULO de um nó
 * de mapa mental selecionado. A parte que mais importa provar: essa origem
 * NUNCA promete um link de volta — um nó de mapa mental não é um bloco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DeckRow, NoteRow, NoteTypeRow } from "../../lib/ipc";
import { criarNotaComOrigem } from "../cartoes/criar-nota-com-origem";
import { paginaDoBloco } from "../cartoes/origem-do-cartao";
import { useCartoesStore } from "../cartoes/store";
import { buildChildrenIndex } from "../cartoes/tree-utils";
import { ConteudoDeMapaMental } from "./ConteudoDeMapaMental";
import { useMapaMentalStore, type NoDoMapa } from "./store";

vi.mock("../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

/** Mesmo motivo de `ConteudoDeMapaMental.test.tsx`: o jsdom deste projeto não implementa `ResizeObserver`, que `@xyflow/react` usa sem checar. Escopo só deste arquivo. */
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

function deck(overrides: Partial<DeckRow> & Pick<DeckRow, "id">): DeckRow {
  return {
    parentId: null,
    name: "",
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const TIPO_BASICO: NoteTypeRow = {
  id: "tipo-1",
  name: "Básico",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{Verso}}" }],
  kind: "standard",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function noteRow(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-1",
    deckId: "ingles",
    fieldValues: { Frente: "Fotossíntese", Verso: "Conversão de luz em energia" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: "Fotossíntese",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  const ingles = deck({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
  });
});

describe("criar cartão a partir de um nó do mapa mental", () => {
  it("nó NÃO selecionado: a ação 'Criar cartão' não aparece", () => {
    const no: NoDoMapa = { id: "n1", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Fotossíntese" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });

    render(<ConteudoDeMapaMental />);

    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();
  });

  it("nó selecionado: a ação aparece, abre o formulário com o RÓTULO na frente, e cria a nota SEM bloco de origem", async () => {
    const no: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      data: { label: "Fotossíntese" },
      selected: true,
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });
    criarNotaComOrigemMock.mockResolvedValue(noteRow());

    render(<ConteudoDeMapaMental />);

    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarCartaoDeOrigem não montou");

    expect(await screen.findByLabelText("Frente")).toHaveValue("Fotossíntese");

    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Conversão de luz em energia" } });
    // `within(dialog)`: o botão do próprio nó ("Criar cartão" no
    // `NodeToolbar`) continua montado - o nó continua selecionado - e tem o
    // mesmo nome acessível do botão de enviar o formulário.
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() =>
      // Os dois últimos argumentos são o par sourceBlockId/sourceTextFrozen:
      // `null` no bloco (um nó de mapa mental não é um bloco - não há link
      // de volta possível) e o RÓTULO como texto congelado.
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "Fotossíntese", Verso: "Conversão de luz em energia" },
        [],
        null,
        "Fotossíntese",
      ),
    );
    // Sem bloco, não há o que gravar em `origem-do-cartao.ts` - nenhuma
    // página fica associada a este cartão.
    expect(paginaDoBloco("n1")).toBeNull();
  });
});
