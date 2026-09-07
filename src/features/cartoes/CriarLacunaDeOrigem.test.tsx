import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DeckRow, NoteRow, NoteTypeRow } from "../../lib/ipc";
import { CriarLacunaDeOrigem, type OrigemDeLacuna } from "./CriarLacunaDeOrigem";
import { criarNotaComOrigem } from "./criar-nota-com-origem";
import { paginaDoBloco } from "./origem-do-cartao";
import { ATRIBUTO_INICIO } from "./selecao-no-texto";
import { useCartoesStore } from "./store";
import { buildChildrenIndex } from "./tree-utils";

vi.mock("./criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

const TEXTO = "A mitocôndria produz ATP na respiração celular.";
// "mitocôndria" = [2, 13); "ATP" = [21, 24)

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

// Básico PRIMEIRO na lista, de propósito: o formulário precisa achar o tipo
// pelo `kind`, nunca por `noteTypes[0]` como o irmão `CriarCartaoDeOrigem`.
const TIPO_BASICO: NoteTypeRow = {
  id: "tipo-basico",
  name: "Básico",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{Verso}}" }],
  kind: "standard",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const TIPO_CLOZE: NoteTypeRow = {
  id: "tipo-cloze",
  name: "Cloze",
  fields: ["Texto", "Extra"],
  templates: [{ name: "Lacuna", front: "{{cloze:Texto}}", back: "{{cloze:Texto}}<br>{{Extra}}" }],
  kind: "cloze",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function noteRow(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-cloze",
    deckId: "biologia",
    fieldValues: { Texto: "", Extra: "" },
    tags: [],
    sourceBlockId: "bloco-1",
    sourceTextFrozen: "mitocôndria",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function origemPadrao(overrides: Partial<OrigemDeLacuna> = {}): OrigemDeLacuna {
  return {
    textoDoBloco: TEXTO,
    selecao: { inicio: 2, fim: 13 },
    trecho: "mitocôndria",
    blocoOrigemId: "bloco-1",
    paginaOrigemId: "pagina-1",
    ...overrides,
  };
}

function dialogo(): HTMLDialogElement {
  const dialog = document.querySelector("dialog");
  if (!dialog) throw new Error("o <dialog> de CriarLacunaDeOrigem não montou");
  return dialog;
}

/**
 * Seleciona `trecho` dentro da prévia como o usuário faria com o mouse — um
 * Range real sobre o nó de texto do pedaço que o contém — e avisa o
 * documento, que é o que o componente escuta.
 */
function selecionarNaPrevia(trecho: string) {
  const pedacos = [...document.querySelectorAll<HTMLElement>(`[${ATRIBUTO_INICIO}]`)];
  const pedaco = pedacos.find((elemento) => elemento.textContent?.includes(trecho));
  const no = pedaco?.firstChild;
  if (!pedaco || !no || no.nodeType !== Node.TEXT_NODE) throw new Error(`prévia sem o trecho "${trecho}"`);
  const deslocamento = (pedaco.textContent ?? "").indexOf(trecho);
  const range = document.createRange();
  range.setStart(no, deslocamento);
  range.setEnd(no, deslocamento + trecho.length);
  const selecao = document.getSelection();
  if (!selecao) throw new Error("jsdom sem Selection");
  selecao.removeAllRanges();
  selecao.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  const biologia = deck({ id: "biologia", name: "Biologia" });
  useCartoesStore.setState({
    decksById: new Map([["biologia", biologia]]),
    childrenIndex: buildChildrenIndex([biologia]),
    deckSelecionadoId: "biologia",
    noteTypes: [TIPO_BASICO, TIPO_CLOZE],
    noteTypesStatus: "ready",
  });
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe("CriarLacunaDeOrigem — abrir", () => {
  it("abre com o trecho já marcado como lacuna 1 e diz que vai criar 1 cartão", async () => {
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);

    expect(await screen.findByText("Vai criar 1 cartão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remover lacuna 1: mitocôndria", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar 1 cartão", hidden: true })).toBeEnabled();
    expect(screen.getByRole("list", { name: "Cartões que vão nascer", hidden: true }).children).toHaveLength(1);
  });

  it("sem seleção na prévia, os dois botões de marcar ficam desabilitados com o motivo à vista", async () => {
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Nova lacuna/, hidden: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Mesma lacuna/, hidden: true })).toBeDisabled();
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("Selecione um trecho no texto para marcar.");
  });
});

describe("CriarLacunaDeOrigem — marcar mais lacunas", () => {
  it("nova lacuna incrementa: nasce um segundo cartão, e a nota vai com c1 e c2", async () => {
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);
    await screen.findByText("Vai criar 1 cartão");

    selecionarNaPrevia("ATP");
    const nova = await screen.findByRole("button", { name: /Nova lacuna/, hidden: true });
    await waitFor(() => expect(nova).toBeEnabled());
    fireEvent.click(nova);

    expect(await screen.findByText("Vai criar 2 cartões")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Cartões que vão nascer", hidden: true }).children).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remover lacuna 2: ATP", hidden: true })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Extra"), { target: { value: "Organela da respiração" } });
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Criar 2 cartões", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "biologia",
        "tipo-cloze",
        { Texto: "A {{c1::mitocôndria}} produz {{c2::ATP}} na respiração celular.", Extra: "Organela da respiração" },
        [],
        "bloco-1",
        "mitocôndria",
      ),
    );
    expect(paginaDoBloco("bloco-1")).toBe("pagina-1");
  });

  it("mesma lacuna reusa o número: continua 1 cartão, com dois buracos", async () => {
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);
    await screen.findByText("Vai criar 1 cartão");

    selecionarNaPrevia("ATP");
    const mesma = await screen.findByRole("button", { name: /Mesma lacuna/, hidden: true });
    await waitFor(() => expect(mesma).toBeEnabled());
    fireEvent.click(mesma);

    expect(await screen.findByRole("button", { name: "Remover lacuna 1: ATP", hidden: true })).toBeInTheDocument();
    expect(screen.getByText("Vai criar 1 cartão")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Cartões que vão nascer", hidden: true }).children).toHaveLength(1);

    fireEvent.click(within(dialogo()).getByRole("button", { name: "Criar 1 cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "biologia",
        "tipo-cloze",
        { Texto: "A {{c1::mitocôndria}} produz {{c1::ATP}} na respiração celular.", Extra: "" },
        [],
        "bloco-1",
        "mitocôndria",
      ),
    );
  });

  it("Ctrl+Shift+C marca nova lacuna e Ctrl+Shift+Alt+C marca a mesma — os atalhos do Anki, sobre a cópia", async () => {
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);
    await screen.findByText("Vai criar 1 cartão");

    selecionarNaPrevia("ATP");
    await waitFor(() => expect(screen.getByRole("button", { name: /Nova lacuna/, hidden: true })).toBeEnabled());
    fireEvent.keyDown(dialogo(), { key: "C", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("Vai criar 2 cartões")).toBeInTheDocument();

    selecionarNaPrevia("respiração");
    await waitFor(() => expect(screen.getByRole("button", { name: /Mesma lacuna/, hidden: true })).toBeEnabled());
    fireEvent.keyDown(dialogo(), { key: "c", ctrlKey: true, shiftKey: true, altKey: true });
    expect(await screen.findByRole("button", { name: "Remover lacuna 2: respiração", hidden: true })).toBeInTheDocument();
    expect(screen.getByText("Vai criar 2 cartões")).toBeInTheDocument();
  });

  it("selecionar por cima de uma lacuna existente é recusado com motivo, sem mudar nada", async () => {
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);
    await screen.findByText("Vai criar 1 cartão");

    selecionarNaPrevia("mitocôndria");
    const nova = screen.getByRole("button", { name: /Nova lacuna/, hidden: true });
    await waitFor(() => expect(nova).toBeEnabled());
    fireEvent.click(nova);

    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("Esse trecho já está dentro de uma lacuna.");
    expect(screen.getByText("Vai criar 1 cartão")).toBeInTheDocument();
  });

  it("remover a única lacuna desabilita o salvar: uma nota sem lacuna não nasce", async () => {
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);
    await screen.findByText("Vai criar 1 cartão");

    fireEvent.click(screen.getByRole("button", { name: "Remover lacuna 1: mitocôndria", hidden: true }));

    expect(await screen.findByText("Nenhum cartão ainda — marque ao menos uma lacuna.")).toBeInTheDocument();
    const criar = screen.getByRole("button", { name: "Criar cartão", hidden: true });
    expect(criar).toBeDisabled();
    fireEvent.submit(criar.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("Marque ao menos uma lacuna"));
    expect(criarNotaComOrigemMock).not.toHaveBeenCalled();
  });
});

describe("CriarLacunaDeOrigem — bordas", () => {
  it("seleção que já contém {{: abre sem lacuna, com o motivo, e não deixa salvar", async () => {
    const texto = "Veja {{c1::isto}} aqui";
    render(
      <CriarLacunaDeOrigem
        isOpen
        origem={origemPadrao({ textoDoBloco: texto, selecao: { inicio: 5, fim: 17 }, trecho: "{{c1::isto}}" })}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("O trecho contém “{{” ou “}}”");
    expect(screen.getByRole("button", { name: "Criar cartão", hidden: true })).toBeDisabled();
    expect(criarNotaComOrigemMock).not.toHaveBeenCalled();
  });

  it("texto do bloco vazio: aviso em vez de formulário", () => {
    render(
      <CriarLacunaDeOrigem
        isOpen
        origem={origemPadrao({ textoDoBloco: "   ", selecao: { inicio: 0, fim: 0 }, trecho: "" })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Este bloco não tem texto para virar lacuna.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Criar/, hidden: true })).not.toBeInTheDocument();
  });

  it("sem tipo de nota cloze: aviso, nunca cai no Básico por engano", () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO] });
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);

    expect(screen.getByText("O tipo de nota Cloze não está disponível nesta instalação.")).toBeInTheDocument();
  });

  it("sem baralho: aviso", () => {
    useCartoesStore.setState({ decksById: new Map(), childrenIndex: new Map() });
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={vi.fn()} />);

    expect(screen.getByText("Crie um baralho antes de criar cartões.")).toBeInTheDocument();
  });

  it("erro ao criar mostra mensagem visível e não fecha", async () => {
    criarNotaComOrigemMock.mockRejectedValue(new Error("disco cheio"));
    const onClose = vi.fn();
    render(<CriarLacunaDeOrigem isOpen origem={origemPadrao()} onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Criar 1 cartão", hidden: true }));

    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent("Não foi possível criar o cartão.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fechado não renderiza o formulário", () => {
    render(<CriarLacunaDeOrigem isOpen={false} origem={origemPadrao()} onClose={vi.fn()} />);
    expect(screen.queryByText(/Vai criar/)).not.toBeInTheDocument();
  });
});
