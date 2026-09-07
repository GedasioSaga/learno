import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { criarNotaComOrigem } from "../../cartoes/criar-nota-com-origem";
import { useCartoesStore } from "../../cartoes/store";
import { buildChildrenIndex } from "../../cartoes/tree-utils";
import {
  AppError,
  atualizarNotaDaPalavra,
  coletarPalavra,
  listarPalavrasDoLivro,
  removerPalavra,
  type DeckRow,
  type NoteRow,
  type NoteTypeRow,
  type PalavraColetada,
} from "../../../lib/ipc";
import { PainelDeVocabulario, type SelecaoParaColeta } from "./PainelDeVocabulario";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    listarPalavrasDoLivro: vi.fn(),
    coletarPalavra: vi.fn(),
    atualizarNotaDaPalavra: vi.fn(),
    removerPalavra: vi.fn(),
  };
});

vi.mock("../../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const listarPalavrasDoLivroMock = vi.mocked(listarPalavrasDoLivro);
const coletarPalavraMock = vi.mocked(coletarPalavra);
const atualizarNotaDaPalavraMock = vi.mocked(atualizarNotaDaPalavra);
const removerPalavraMock = vi.mocked(removerPalavra);
const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

/** Mesmo baralho/tipo de nota mínimo usado por `LeitorDeLivro.test.tsx` — o formulário de cartão exige os dois para não cair no aviso "crie um baralho". */
function deckFixture(overrides: Partial<DeckRow> & Pick<DeckRow, "id">): DeckRow {
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

function noteRowFixture(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-1",
    deckId: "ingles",
    fieldValues: { Frente: "a mitocôndria é a usina da célula", Verso: "Verso do cartão" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: "a mitocôndria é a usina da célula",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function palavraFixture(overrides: Partial<PalavraColetada> = {}): PalavraColetada {
  return {
    id: "palavra-1",
    bookId: "livro-1",
    term: "mitocôndria",
    contextSnippet: "a mitocôndria é a usina da célula",
    note: null,
    locator: "42",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const SELECAO_FIXTURE: SelecaoParaColeta = {
  texto: "mitocôndria",
  contexto: "a mitocôndria é a usina da célula",
  locator: "42",
};

beforeEach(() => {
  vi.clearAllMocks();
  listarPalavrasDoLivroMock.mockResolvedValue([]);
  const ingles = deckFixture({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
  });
});

describe("sem seleção — a lista do que já foi colhido", () => {
  it("lista vazia diz o que fazer em vez de ficar em branco", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([]);

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);

    expect(await screen.findByText(/Nenhuma palavra colhida ainda\. Selecione uma palavra durante a leitura/)).toBeInTheDocument();
  });

  it("a busca filtra de verdade, por termo ou por nota", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([
      palavraFixture({ id: "a", term: "mitocôndria" }),
      palavraFixture({ id: "b", term: "ribossomo", contextSnippet: "o ribossomo fica no citoplasma", note: "organela que sintetiza proteína" }),
    ]);

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");
    expect(screen.getByText("ribossomo")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar palavra colhida" }), { target: { value: "mito" } });

    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
    expect(screen.queryByText("ribossomo")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar palavra colhida" }), { target: { value: "sintetiza" } });

    expect(screen.getByText("ribossomo")).toBeInTheDocument();
    expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument();
  });

  it("busca sem nenhuma correspondência mostra uma mensagem específica, não a lista vazia genérica", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture()]);

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar palavra colhida" }), { target: { value: "zzz" } });

    expect(screen.getByText("Nenhuma palavra encontrada para “zzz”.")).toBeInTheDocument();
  });

  it("editar a nota chama atualizarNotaDaPalavra e reflete o novo valor na lista", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture({ note: null })]);
    atualizarNotaDaPalavraMock.mockResolvedValue(palavraFixture({ note: "lembrar de revisar" }));

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");

    fireEvent.click(screen.getByRole("button", { name: "Editar nota de mitocôndria" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nota de mitocôndria" }), { target: { value: "lembrar de revisar" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(atualizarNotaDaPalavraMock).toHaveBeenCalledWith("palavra-1", "lembrar de revisar"));
    expect(await screen.findByText("lembrar de revisar")).toBeInTheDocument();
  });

  it("remover exige confirmação NO PRÓPRIO PAINEL antes de chamar removerPalavra", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture()]);
    removerPalavraMock.mockResolvedValue(undefined);

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");

    fireEvent.click(screen.getByRole("button", { name: "Remover mitocôndria" }));
    expect(removerPalavraMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(removerPalavraMock).toHaveBeenCalledWith("palavra-1"));
    expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument();
  });

  it("cancelar a confirmação de remoção não chama removerPalavra", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture()]);

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");

    fireEvent.click(screen.getByRole("button", { name: "Remover mitocôndria" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removerPalavraMock).not.toHaveBeenCalled();
    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
  });

  it("a ponte com cartões: 'Cartão' abre o formulário compartilhado com a frase de origem já na frente", async () => {
    listarPalavrasDoLivroMock.mockResolvedValue([palavraFixture()]);
    criarNotaComOrigemMock.mockResolvedValue(noteRowFixture());

    render(<PainelDeVocabulario livroId="livro-1" selecao={null} />);
    await screen.findByText("mitocôndria");

    fireEvent.click(screen.getByRole("button", { name: "Cartão" }));

    expect(await screen.findByLabelText("Frente")).toHaveValue("a mitocôndria é a usina da célula");
  });
});

describe("com seleção ativa — colher a palavra", () => {
  it("colhe a palavra chamando coletarPalavra com termo, contexto e locator da seleção", async () => {
    const nova = palavraFixture();
    coletarPalavraMock.mockResolvedValue(nova);

    render(<PainelDeVocabulario livroId="livro-1" selecao={SELECAO_FIXTURE} />);

    fireEvent.change(screen.getByLabelText("Nota (opcional)"), { target: { value: "lembrar de revisar" } });
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    await waitFor(() =>
      expect(coletarPalavraMock).toHaveBeenCalledWith(
        "livro-1",
        "mitocôndria",
        "a mitocôndria é a usina da célula",
        "lembrar de revisar",
        "42",
      ),
    );
    expect(await screen.findByText("Palavra colhida.")).toBeInTheDocument();
  });

  it("termo só com espaço não chega ao IPC — o painel avisa em vez de deixar colher", async () => {
    render(<PainelDeVocabulario livroId="livro-1" selecao={{ texto: "   ", contexto: "frase qualquer", locator: "1" }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Selecione uma palavra para colher.");
    expect(screen.queryByRole("button", { name: "Colher palavra" })).not.toBeInTheDocument();
    expect(coletarPalavraMock).not.toHaveBeenCalled();
  });

  it("colher a mesma palavra duas vezes no mesmo livro: o gatilho de duplicata vira mensagem útil, nunca o erro cru do SQL", async () => {
    coletarPalavraMock.mockRejectedValue(
      new AppError({
        kind: "database",
        message: "banco de dados: library_vocabulary.term duplicado neste livro (ignorando caixa e acento)",
      }),
    );

    render(<PainelDeVocabulario livroId="livro-1" selecao={SELECAO_FIXTURE} />);
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Essa palavra já foi colhida neste livro.");
    expect(alerta).not.toHaveTextContent("library_vocabulary");
    expect(alerta).not.toHaveTextContent("gatilho");
  });

  it("erro do IPC (não-duplicata) vira mensagem visível sem perder a nota já digitada", async () => {
    coletarPalavraMock.mockRejectedValue(new Error("banco ocupado"));

    render(<PainelDeVocabulario livroId="livro-1" selecao={SELECAO_FIXTURE} />);

    fireEvent.change(screen.getByLabelText("Nota (opcional)"), { target: { value: "não perder isto" } });
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível colher esta palavra.");
    expect(screen.getByLabelText("Nota (opcional)")).toHaveValue("não perder isto");
  });
});
