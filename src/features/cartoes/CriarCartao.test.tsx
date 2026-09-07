import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createNote, deckCounts, type DeckRow, type NoteTypeRow } from "../../lib/ipc";
import { CriarCartao } from "./CriarCartao";
import { buildChildrenIndex } from "./tree-utils";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    createNote: vi.fn(),
    deckCounts: vi.fn(),
  };
});

const createNoteMock = vi.mocked(createNote);
const deckCountsMock = vi.mocked(deckCounts);

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
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  deckCountsMock.mockResolvedValue({ novos: 0, aprendendo: 0, revisar: 0 });
  const ingles = deck({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
    tela: "criar",
  });
});

describe("CriarCartao", () => {
  it("préseleciona o baralho ativo e mostra um campo por campo do tipo de nota, empilhados", async () => {
    render(<CriarCartao />);

    expect(await screen.findByRole("combobox", { name: "Baralho" })).toHaveValue("ingles");
    expect(screen.getByLabelText("Frente")).toBeInTheDocument();
    expect(screen.getByLabelText("Verso")).toBeInTheDocument();
  });

  it("bloqueia o envio quando todos os campos estão vazios, sem chamar o backend", async () => {
    render(<CriarCartao />);

    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Preencha ao menos um campo.");
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("cria a nota com os campos preenchidos e as etiquetas separadas por vírgula/espaço, e limpa o formulário", async () => {
    createNoteMock.mockResolvedValue({
      id: "nota-1",
      noteTypeId: "tipo-1",
      deckId: "ingles",
      fieldValues: { Frente: "Hello", Verso: "Olá" },
      tags: ["saudações", "básico"],
      sourceBlockId: null,
      sourceTextFrozen: null,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    render(<CriarCartao />);

    fireEvent.change(screen.getByLabelText("Frente"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Olá" } });
    fireEvent.change(screen.getByLabelText("Etiquetas"), { target: { value: "saudações, básico" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    await waitFor(() =>
      expect(createNoteMock).toHaveBeenCalledWith("ingles", "tipo-1", { Frente: "Hello", Verso: "Olá" }, ["saudações", "básico"]),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Cartão criado.");
    expect(screen.getByLabelText("Frente")).toHaveValue("");
  });

  it("sem nenhum baralho, mostra o aviso em vez de um formulário quebrado", () => {
    useCartoesStore.setState({ decksById: new Map(), childrenIndex: new Map() });

    render(<CriarCartao />);

    expect(screen.getByText("Crie um baralho antes de criar cartões.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();
  });
});
