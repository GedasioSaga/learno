/**
 * A ação "Criar cartão" na barra de seleção: aparece/desaparece com a
 * seleção, e o cartão nasce com o TRECHO e o BLOCO certos — não só "a
 * chamada aconteceu" (ver o pedido desta peça: afirmar os argumentos, não
 * só a ocorrência).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DeckRow, NoteRow, NoteTypeRow } from "../../../../lib/ipc";
import { criarNotaComOrigem } from "../../../cartoes/criar-nota-com-origem";
import { paginaDoBloco } from "../../../cartoes/origem-do-cartao";
import { useCartoesStore } from "../../../cartoes/store";
import { buildChildrenIndex } from "../../../cartoes/tree-utils";
import { buildEditorExtensions } from "../../core/extensions";
import { CreateCardOverlay } from "./CreateCardOverlay";
import { useCreateCardOverlayStore } from "./create-card-store";
import { renderCreateCardButton } from "./CreateCardButton";
import "./register";

vi.mock("../../../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

let editor: Editor;

function paragraphDoc(text: string, id: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "block", content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }] }],
  };
}

function createEditor(text: string, blockId: string, pageId: string | null): Editor {
  return new Editor({ extensions: buildEditorExtensions({ pageId: pageId ?? undefined }), content: paragraphDoc(text, blockId) });
}

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
    fieldValues: { Frente: "Mitocôndria é a organela...", Verso: "Produz energia" },
    tags: [],
    sourceBlockId: "bloco-1",
    sourceTextFrozen: "Mitocôndria é a organela...",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useCreateCardOverlayStore.setState({ open: false, origem: null });
  const ingles = deck({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
  });
});

afterEach(() => {
  editor?.destroy();
});

describe("botão Criar cartão na barra de seleção", () => {
  it("sem seleção (cursor só), o botão não aparece", () => {
    editor = createEditor("Mitocôndria é a organela...", "bloco-1", "pagina-1");
    editor.commands.setTextSelection(2); // seleção vazia

    render(renderCreateCardButton(editor));

    expect(screen.queryByRole("button", { name: "Criar cartão" })).not.toBeInTheDocument();
  });

  it("com texto selecionado, o botão aparece", () => {
    editor = createEditor("Mitocôndria é a organela...", "bloco-1", "pagina-1");
    editor.commands.setTextSelection({ from: 2, to: 13 }); // "Mitocôndria"

    render(renderCreateCardButton(editor));

    expect(screen.getByRole("button", { name: "Criar cartão" })).toBeInTheDocument();
  });
});

describe("clicar Criar cartão", () => {
  it("abre o formulário com o TRECHO selecionado e cria a nota com o bloco de origem certo", async () => {
    editor = createEditor("Mitocôndria é a organela...", "bloco-1", "pagina-1");
    editor.commands.setTextSelection({ from: 2, to: 13 }); // "Mitocôndria"
    criarNotaComOrigemMock.mockResolvedValue(noteRow());

    render(
      <>
        {renderCreateCardButton(editor)}
        <CreateCardOverlay />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Criar cartão" }));

    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarCartaoDeOrigem não montou");

    expect(await screen.findByLabelText("Frente")).toHaveValue("Mitocôndria");

    fireEvent.change(screen.getByLabelText("Verso"), { target: { value: "Produz energia" } });
    // `within(dialog)`, não `screen`: o botão do próprio TOOLBAR de seleção
    // também se chama "Criar cartão" e continua montado (a seleção não
    // mudou) — sem escopo, a consulta por papel/nome seria ambígua.
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "ingles",
        "tipo-1",
        { Frente: "Mitocôndria", Verso: "Produz energia" },
        [],
        "bloco-1",
        "Mitocôndria",
      ),
    );
    // A página do bloco fica guardada para a Sessão de Estudo achar depois
    // (`origem-do-cartao.ts`) — só possível porque o editor sabe `pageIdOf`
    // no instante da criação.
    expect(paginaDoBloco("bloco-1")).toBe("pagina-1");
  });
});
