/**
 * O gesto central do produto, de ponta a ponta: selecionar um trecho na
 * página → "Criar lacuna" → nota do tipo Cloze com o texto do bloco, o
 * trecho como `{{c1::...}}`, `sourceBlockId` e `sourceTextFrozen`. E a
 * garantia oposta, igualmente importante: o documento do editor sai IGUAL
 * ao que entrou — marcar lacuna cria um cartão, não edita a página.
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
import { renderCreateClozeButton } from "./CreateClozeButton";
import "./register";

vi.mock("../../../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

let editor: Editor;

const TEXTO = "A mitocôndria produz ATP na respiração celular.";

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

const TIPO_CLOZE: NoteTypeRow = {
  id: "tipo-cloze",
  name: "Cloze",
  fields: ["Texto", "Extra"],
  templates: [{ name: "Lacuna", front: "{{cloze:Texto}}", back: "{{cloze:Texto}}" }],
  kind: "cloze",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function noteRow(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-cloze",
    deckId: "biologia",
    fieldValues: { Texto: "A {{c1::mitocôndria}} produz ATP na respiração celular.", Extra: "" },
    tags: [],
    sourceBlockId: "bloco-1",
    sourceTextFrozen: "mitocôndria",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useCreateCardOverlayStore.setState({ open: false, origem: null, lacuna: null });
  const biologia = deck({ id: "biologia", name: "Biologia" });
  useCartoesStore.setState({
    decksById: new Map([["biologia", biologia]]),
    childrenIndex: buildChildrenIndex([biologia]),
    deckSelecionadoId: "biologia",
    noteTypes: [TIPO_CLOZE],
    noteTypesStatus: "ready",
  });
});

afterEach(() => {
  editor?.destroy();
});

describe("botão Criar lacuna na barra de seleção", () => {
  it("sem seleção, não aparece", () => {
    editor = createEditor(TEXTO, "bloco-1", "pagina-1");
    editor.commands.setTextSelection(2);
    render(renderCreateClozeButton(editor));
    expect(screen.queryByRole("button", { name: "Criar lacuna" })).not.toBeInTheDocument();
  });

  it("com texto selecionado, aparece", () => {
    editor = createEditor(TEXTO, "bloco-1", "pagina-1");
    editor.commands.setTextSelection({ from: 4, to: 15 }); // "mitocôndria"
    render(renderCreateClozeButton(editor));
    expect(screen.getByRole("button", { name: "Criar lacuna" })).toBeInTheDocument();
  });
});

describe("selecionar um trecho e pedir lacuna", () => {
  it("cria uma nota Cloze com o texto do bloco, o trecho como {{c1::...}}, o bloco e o texto congelado — e a página não muda", async () => {
    editor = createEditor(TEXTO, "bloco-1", "pagina-1");
    editor.commands.setTextSelection({ from: 4, to: 15 }); // "mitocôndria" (pos 0 abre block, 1 abre paragraph, o texto começa em 2)
    criarNotaComOrigemMock.mockResolvedValue(noteRow());
    const documentoAntes = JSON.stringify(editor.getJSON());

    render(
      <>
        {renderCreateClozeButton(editor)}
        <CreateCardOverlay />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Criar lacuna" }));

    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("o <dialog> de CriarLacunaDeOrigem não montou");

    // A prévia mostra o bloco inteiro, com o trecho já como lacuna 1, e diz quantos cartões nascem.
    expect(await within(dialog).findByText("Vai criar 1 cartão")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remover lacuna 1: mitocôndria", hidden: true })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Criar 1 cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "biologia",
        "tipo-cloze",
        { Texto: "A {{c1::mitocôndria}} produz ATP na respiração celular.", Extra: "" },
        [],
        "bloco-1",
        "mitocôndria",
      ),
    );
    expect(paginaDoBloco("bloco-1")).toBe("pagina-1");

    // O invariante da bar: o bloco na página continua byte a byte igual.
    expect(JSON.stringify(editor.getJSON())).toBe(documentoAntes);
  });

  it("seleção com espaço nas pontas: a lacuna é aparada, o texto congelado também", async () => {
    editor = createEditor(TEXTO, "bloco-1", "pagina-1");
    editor.commands.setTextSelection({ from: 3, to: 16 }); // " mitocôndria "
    criarNotaComOrigemMock.mockResolvedValue(noteRow());

    render(
      <>
        {renderCreateClozeButton(editor)}
        <CreateCardOverlay />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Criar lacuna" }));
    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("dialog não montou");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Criar 1 cartão", hidden: true }));

    await waitFor(() =>
      expect(criarNotaComOrigemMock).toHaveBeenCalledWith(
        "biologia",
        "tipo-cloze",
        { Texto: "A {{c1::mitocôndria}} produz ATP na respiração celular.", Extra: "" },
        [],
        "bloco-1",
        "mitocôndria",
      ),
    );
  });
});
