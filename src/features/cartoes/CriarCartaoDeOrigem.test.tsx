import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DeckRow, NoteRow, NoteTypeRow } from "../../lib/ipc";
import { CriarCartaoDeOrigem, type OrigemDoCartao } from "./CriarCartaoDeOrigem";
import { criarNotaComOrigem } from "./criar-nota-com-origem";
import { paginaDoBloco } from "./origem-do-cartao";
import { useCartoesStore } from "./store";
import { buildChildrenIndex } from "./tree-utils";

vi.mock("./criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

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

function noteRow(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-1",
    deckId: "ingles",
    fieldValues: { Frente: "Mitocôndria", Verso: "" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  // `resetAllMocks`, não `clearAllMocks`: um teste que deixa
  // `mockRejectedValue`/`mockResolvedValue` armado não pode vazar essa
  // implementação para o próximo — mesmo motivo de `TrashDialog.test.tsx`.
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

describe("CriarCartaoDeOrigem", () => {
  it("pré-preenche a frente com o trecho recebido", async () => {
    const origem: OrigemDoCartao = { trecho: "Mitocôndria é a organela..." };
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    expect(await screen.findByLabelText("Frente")).toHaveValue("Mitocôndria é a organela...");
  });

  it("de uma página de notas: cria a nota com o bloco de origem e o trecho como texto congelado, mesmo se a frente for editada depois", async () => {
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    const origem: OrigemDoCartao = {
      trecho: "Mitocôndria é a organela...",
      blocoOrigemId: "bloco-1",
      paginaOrigemId: "pagina-1",
    };
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    // Edita a frente depois de pré-preenchida - o texto congelado enviado ao
    // backend continua sendo o trecho ORIGINAL, não o editado.
    fireEvent.change(await screen.findByLabelText("Frente"), { target: { value: "Mitocôndria (editado)" } });
    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Organela que produz energia" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "Mitocôndria (editado)", Verso: "Organela que produz energia" },
        [],
        "bloco-1",
        "Mitocôndria é a organela...",
      ),
    );
  });

  it("de um nó de mapa mental (sem bloco): cria a nota com sourceBlockId nulo - nunca promete um link que não existe", async () => {
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    const origem: OrigemDoCartao = { trecho: "Fotossíntese" };
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Verso"), { target: { value: "Conversão de luz em energia" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "Fotossíntese", Verso: "Conversão de luz em energia" },
        [],
        null,
        "Fotossíntese",
      ),
    );
  });

  it("com bloco e página de origem, grava o par bloco→página para a Sessão de Estudo achar depois", async () => {
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    const origem: OrigemDoCartao = { trecho: "Trecho", blocoOrigemId: "bloco-2", paginaOrigemId: "pagina-2" };
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Verso"), { target: { value: "Verso" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() => expect(criarNotaComOrigemMock).toHaveBeenCalled());
    expect(paginaDoBloco("bloco-2")).toBe("pagina-2");
  });

  it("erro ao criar mostra uma mensagem visível, nunca tela branca", async () => {
    criarNotaComOrigemMock.mockRejectedValue(new Error("disco cheio"));
    const origem: OrigemDoCartao = { trecho: "Trecho" };
    const onClose = vi.fn();
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText("Verso"), { target: { value: "Verso" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão", hidden: true }));

    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("Não foi possível criar o cartão.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("bloqueia o envio sem nada no verso, sem chamar o backend", async () => {
    const origem: OrigemDoCartao = { trecho: "Trecho" };
    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    await screen.findByLabelText("Frente");
    fireEvent.click(screen.getByRole("button", { name: "Criar cartão", hidden: true }));

    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("Escreva ao menos o verso.");
    expect(criarNotaComOrigemMock).not.toHaveBeenCalled();
  });

  it("sem nenhum baralho, mostra o aviso em vez de um formulário quebrado", () => {
    useCartoesStore.setState({ decksById: new Map(), childrenIndex: new Map() });
    const origem: OrigemDoCartao = { trecho: "Trecho" };

    render(<CriarCartaoDeOrigem isOpen origem={origem} onClose={vi.fn()} />);

    expect(screen.getByText("Crie um baralho antes de criar cartões.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();
  });

  it("fechado não renderiza o formulário", () => {
    const origem: OrigemDoCartao = { trecho: "Trecho" };
    render(<CriarCartaoDeOrigem isOpen={false} origem={origem} onClose={vi.fn()} />);

    expect(screen.queryByLabelText("Frente")).not.toBeInTheDocument();
  });
});
