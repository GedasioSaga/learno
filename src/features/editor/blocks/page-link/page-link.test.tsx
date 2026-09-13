/**
 * EDT-017/FUN-003/FUN-043 - ver `register.ts`/`actions.ts`.
 *
 * Dois jeitos de montar o editor, conforme o que o teste precisa provar:
 * - `createEditor` (`new Editor`, mesmo padrão de `core/commands.test.ts` e
 *   `marks/script/register.test.tsx`) para os testes que só olham a árvore
 *   de blocos (`editor.getJSON()`) - mais rápido, e o NodeView React não
 *   entra no caminho.
 * - `renderLinkToPage` (`useEditor` + `<EditorContent>`, a mesma dupla que
 *   `core/Editor.tsx` usa) só para EDT-017's asserções de DOM/clique - um
 *   `new Editor({ element })` sozinho nunca seta `editor.contentComponent`
 *   (`@tiptap/react`'s `ReactRenderer` depende dele para portar o
 *   componente pro DOM real), então o NodeView React não renderiza nada
 *   fora de uma árvore React de verdade.
 */
import { useEffect } from "react";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { buildEditorExtensions } from "../../core/extensions";
import { collectSlashMenuItems, collectTurnIntoItems } from "../../core/block-spec";
import { type PageRow, createPage, movePage } from "../../../../lib/ipc";
import { buildChildrenIndex } from "../../../pages/tree-utils";
import { usePageTreeStore } from "../../../pages/store";
import { linkToExistingPage, createSubPageAndInsert } from "./actions";
import { PageLinkPicker } from "./PageLinkPicker";
import { pickablePages } from "./picker-results";
import { usePageLinkPickerStore } from "./picker-store";
import "./register";

vi.mock("../../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/ipc")>();
  return { ...actual, createPage: vi.fn(), movePage: vi.fn() };
});

const createPageMock = vi.mocked(createPage);
const movePageMock = vi.mocked(movePage);

function row(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "1",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

/** Monta `editor` numa árvore React real (ver comentário do topo) e devolve só depois que `useEditor` já entregou a instância - o que `EDT-017` precisa pra encontrar o NodeView renderizado. */
function Harness({ content, onReady }: { content: JSONContent; onReady: (editor: Editor) => void }) {
  const instance = useEditor({ extensions: buildEditorExtensions(), content, immediatelyRender: true }, [content]);
  useEffect(() => {
    if (instance) onReady(instance);
  }, [instance, onReady]);
  return <EditorContent editor={instance} />;
}

async function renderLinkToPage(content: JSONContent): Promise<void> {
  render(<Harness content={content} onReady={(instance) => (editor = instance)} />);
  await waitFor(() => expect(editor).toBeDefined());
}

/**
 * Como `Harness`, mas monta `PageLinkPicker` ao lado do `EditorContent` -
 * reproduz exatamente o que `core/Editor.tsx` faz com todo `EditorOverlay`
 * registrado (`overlay.render(editor)`, ver comentário no topo do arquivo).
 * Existe para que FUN-043 exercite o seletor de verdade (input, lista,
 * clique numa opção) em vez de chamar `linkToExistingPage` como função pura -
 * o gap que a rodada anterior deixou aberto.
 */
function HarnessWithPicker({ content, onReady }: { content: JSONContent; onReady: (editor: Editor) => void }) {
  const instance = useEditor({ extensions: buildEditorExtensions(), content, immediatelyRender: true }, [content]);
  useEffect(() => {
    if (instance) onReady(instance);
  }, [instance, onReady]);
  if (!instance) return null;
  return (
    <>
      <EditorContent editor={instance} />
      <PageLinkPicker editor={instance} />
    </>
  );
}

async function renderWithPicker(content: JSONContent): Promise<void> {
  render(<HarnessWithPicker content={content} onReady={(instance) => (editor = instance)} />);
  await waitFor(() => expect(editor).toBeDefined());
}

/** Todo nó `linkToPage` no doc atual, achatado - usado pra achar o que `insertBlockHere` acabou de inserir sem hardcodar posição. */
function linkToPageNodes(): JSONContent[] {
  const found: JSONContent[] = [];
  function walk(node: JSONContent) {
    if (node.type === "linkToPage") found.push(node);
    node.content?.forEach(walk);
  }
  walk(editor.getJSON());
  return found;
}

const curso = row({ id: "curso", title: "Curso" });
const modulo3 = row({ id: "modulo-3", title: "Módulo 3" });

beforeEach(() => {
  vi.clearAllMocks();
  const pagesById = new Map([
    [curso.id, curso],
    [modulo3.id, modulo3],
  ]);
  usePageTreeStore.setState({
    status: "ready",
    errorMessage: null,
    pagesById,
    childrenIndex: buildChildrenIndex([...pagesById.values()]),
    expandedIds: new Set(),
    selectedPageId: curso.id,
    pendingFocusId: null,
  });
  usePageLinkPickerStore.setState({ isOpen: false, query: "" });
});

afterEach(() => {
  editor?.destroy();
  cleanup();
});

describe("EDT-017: bloco link-to-page", () => {
  it("EDT-017: mostra ícone e título da página apontada e navega ao clicar", async () => {
    await renderLinkToPage({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "linkToPage", attrs: { id: "b1", pageId: "modulo-3" } }],
        },
      ],
    });

    const link = await screen.findByRole("button", { name: "Abrir página Módulo 3" });
    expect(link).toHaveTextContent("📄");
    expect(link).toHaveTextContent("Módulo 3");

    fireEvent.click(link);

    expect(usePageTreeStore.getState().selectedPageId).toBe("modulo-3");
  });

  it("EDT-017: página apagada/inexistente aparece como 'não encontrada', sem navegação", async () => {
    await renderLinkToPage({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "linkToPage", attrs: { id: "b1", pageId: "pagina-sumida" } }],
        },
      ],
    });

    const link = await screen.findByRole("button", { name: "Página vinculada não encontrada" });
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveTextContent("Página não encontrada");
  });
});

describe("FUN-003: sub-página pelo comando /page", () => {
  it("FUN-003: cria a sub-página e insere o bloco que aponta pra ela; ela aparece como filha na sidebar", async () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    createPageMock.mockResolvedValue(row({ id: "nova-sub", title: "" , parent_id: "curso" }));

    const ok = await createSubPageAndInsert(editor);

    expect(ok).toBe(true);
    // A chamada que faz a página nascer filha de "Curso" - `createChild`
    // (store.ts) repassa `parentId` direto pra este comando.
    expect(createPageMock).toHaveBeenCalledWith("curso", undefined);
    // FUN-003: aparece como filha na sidebar - `childrenIndex` (o que
    // `PageTree` renderiza) agora lista "nova-sub" sob "curso".
    const children = usePageTreeStore.getState().childrenIndex.get("curso") ?? [];
    expect(children.map((p) => p.id)).toContain("nova-sub");
    // O bloco inserido aponta pra página recém-criada.
    expect(linkToPageNodes()).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ pageId: "nova-sub" }) })]);
  });

  it("run() do item '/' de menu dispara a mesma criação", async () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    createPageMock.mockResolvedValue(row({ id: "nova-sub-2", title: "", parent_id: "curso" }));
    const item = collectSlashMenuItems().find((i) => i.id === "blocks:sub-page");
    if (!item) throw new Error('item "blocks:sub-page" não registrado');

    const handled = item.run(editor);
    expect(handled).toBe(true);
    // `run` só dispara a criação (assíncrona) - espera ela terminar antes de checar.
    await vi.waitFor(() => expect(createPageMock).toHaveBeenCalledWith("curso", undefined));
  });
});

describe('EDT-049: "Transformar em" > Sub-página', () => {
  it("está registrado", () => {
    expect(collectTurnIntoItems().find((i) => i.id === "blocks:turn:sub-page")).toMatchObject({ title: "Sub-página" });
  });

  it("aplicado a um parágrafo vazio - o documento resultante tem o nó linkToPage apontando pra sub-página nova", async () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    createPageMock.mockResolvedValue(row({ id: "nova-sub-3", title: "", parent_id: "curso" }));
    const item = collectTurnIntoItems().find((i) => i.id === "blocks:turn:sub-page");
    if (!item) throw new Error('item "blocks:turn:sub-page" não registrado');

    const handled = item.run(editor);

    expect(handled).toBe(true);
    await vi.waitFor(() =>
      expect(linkToPageNodes()).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ pageId: "nova-sub-3" }) })]),
    );
  });

  it("aplicado a um parágrafo com texto - o texto original sobrevive (o link entra como próximo irmão, não substitui)", async () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Já tinha texto" }] }] }],
    });
    createPageMock.mockResolvedValue(row({ id: "nova-sub-4", title: "", parent_id: "curso" }));
    const item = collectTurnIntoItems().find((i) => i.id === "blocks:turn:sub-page");
    if (!item) throw new Error('item "blocks:turn:sub-page" não registrado');

    const handled = item.run(editor);

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(linkToPageNodes()).toHaveLength(1));
    const doc = editor.getJSON();
    expect(doc.content?.[0]?.content?.[0]).toMatchObject({ type: "paragraph", content: [{ text: "Já tinha texto" }] });
  });
});

describe("FUN-043: link-to-page reparenteia a página alvo - diferente da @menção", () => {
  it("FUN-043: escolher 'Módulo 3' no seletor de verdade (clique na lista) pede o reparent (move_page) e ela vira filha de 'Curso' na sidebar", async () => {
    await renderWithPicker({
      type: "doc",
      content: [{ type: "block", content: [{ type: "toggle", attrs: { id: "t1", collapsed: false } }] }],
    });
    movePageMock.mockResolvedValue(row({ id: "modulo-3", title: "Módulo 3", parent_id: "curso" }));

    // Mesma entrada que `blocks:link-to-page`'s `run` usa (register.ts) -
    // abre o seletor em vez de inserir na hora, exatamente o que o item de
    // menu `/` faz (coberto à parte no teste "abre o seletor" abaixo).
    // `act`: a mudança de estado do zustand fora de um handler de evento do
    // React só reflete no DOM depois de um flush - sem isto o React acusa
    // "update not wrapped in act" porque o `findByRole` abaixo já observaria
    // um DOM potencialmente incompleto.
    act(() => usePageLinkPickerStore.getState().open());

    // Digitar filtra a lista renderizada por `PageLinkPicker` - prova que o
    // input real (não uma chamada direta a `pickablePages`) está no caminho.
    const searchInput = await screen.findByRole("textbox", { name: "Buscar página para vincular" });
    fireEvent.change(searchInput, { target: { value: "módulo" } });

    const option = await screen.findByRole("option", { name: /Módulo 3/ });
    fireEvent.click(option);

    // O clique fecha o diálogo de imediato (`choose` chama `close()` antes
    // do reparent assíncrono) - prova que é o botão real disparando, não
    // uma chamada de função por baixo.
    expect(usePageLinkPickerStore.getState().isOpen).toBe(false);

    // A prova pedida pela tarefa: inserir ESTE bloco pede reparent - a
    // @menção (EDT-044, outro construtor) nunca chama `movePage`.
    await waitFor(() => expect(movePageMock).toHaveBeenCalledWith("modulo-3", "curso", { type: "end" }));
    const children = usePageTreeStore.getState().childrenIndex.get("curso") ?? [];
    expect(children.map((p) => p.id)).toContain("modulo-3");
    await waitFor(() =>
      expect(linkToPageNodes()).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ pageId: "modulo-3" }) })]),
    );
  });

  it("FUN-043: linkToExistingPage (chamada direta) pede o mesmo reparent - cobre o caminho de '/page' que não passa pelo seletor", async () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "toggle", attrs: { id: "t1", collapsed: false } }] }],
    });
    movePageMock.mockResolvedValue(row({ id: "modulo-3", title: "Módulo 3", parent_id: "curso" }));

    const ok = await linkToExistingPage(editor, "modulo-3");

    expect(ok).toBe(true);
    expect(movePageMock).toHaveBeenCalledWith("modulo-3", "curso", { type: "end" });
    const children = usePageTreeStore.getState().childrenIndex.get("curso") ?? [];
    expect(children.map((p) => p.id)).toContain("modulo-3");
    expect(linkToPageNodes()).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ pageId: "modulo-3" }) })]);
  });

  it("linkar a própria página atual é um no-op silencioso - nunca chama move_page sobre si mesma", async () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });

    await linkToExistingPage(editor, "curso");

    expect(movePageMock).not.toHaveBeenCalled();
  });

  it("item de menu '/' abre o seletor em vez de inserir na hora - precisa da página escolhida antes", () => {
    editor = createEditor({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] });
    const item = collectSlashMenuItems().find((i) => i.id === "blocks:link-to-page");
    if (!item) throw new Error('item "blocks:link-to-page" não registrado');

    const handled = item.run(editor);

    expect(handled).toBe(true);
    expect(usePageLinkPickerStore.getState().isOpen).toBe(true);
    expect(linkToPageNodes()).toEqual([]);
  });
});

describe("BlockSpec: round trip salva/abre (serialize.ts consultando o registro)", () => {
  it("um bloco link_to_page persistido sobrevive ao round trip com o pageId e busca pelo título ao vivo", () => {
    const stored = [
      {
        id: "b1",
        pageId: "page-x",
        parentBlockId: null,
        blockType: "link_to_page",
        content: { pageId: "modulo-3" },
        plainText: "",
        syncedSourceId: null,
        position: "a0",
        createdAt: "2026-09-03T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z",
      },
    ];

    const doc = blocksToDoc(stored);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("linkToPage");
    expect(contentNode?.attrs).toMatchObject({ pageId: "modulo-3" });
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("link_to_page");
    expect(flat.content).toEqual({ pageId: "modulo-3" });
    // Resolvido ao vivo pelo store (FUN-045), não pelo que estava salvo antes.
    expect(flat.plainText).toBe("Módulo 3");
  });

  // Regra 5, caso 2: sem o campo opcional (aqui, `content.pageId` ausente de
  // verdade - não `undefined` explícito, a chave simplesmente não existe,
  // como um registro nunca preenchido chegaria do banco). `attrs()` faz
  // `typeof content.pageId === "string"` em vez de `content.pageId as
  // string` - é essa checagem que evita `Cannot read properties of
  // undefined` aqui em vez de só empurrar o problema pro NodeView.
  it("um bloco persistido sem pageId no content não quebra o round trip nem a busca", () => {
    const stored = [
      {
        id: "b1",
        pageId: "page-x",
        parentBlockId: null,
        blockType: "link_to_page",
        content: {},
        plainText: "",
        syncedSourceId: null,
        position: "a0",
        createdAt: "2026-09-03T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z",
      },
    ];

    const doc = blocksToDoc(stored);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.attrs).toMatchObject({ pageId: null });

    const [flat] = docToFlatBlocks(doc);
    expect(flat.content).toEqual({ pageId: null });
    expect(flat.plainText).toBe("");
  });
});

describe("picker-results: filtro do seletor de página existente", () => {
  it("exclui a própria página atual e casa por substring do título, ignorando caixa", () => {
    const pagesById = usePageTreeStore.getState().pagesById;
    const childrenIndex = usePageTreeStore.getState().childrenIndex;

    const all = pickablePages(pagesById, childrenIndex, "curso", "");
    expect(all.map((p) => p.id)).toEqual(["modulo-3"]);

    const filtered = pickablePages(pagesById, childrenIndex, "curso", "MÓDULO");
    expect(filtered.map((p) => p.id)).toEqual(["modulo-3"]);

    expect(pickablePages(pagesById, childrenIndex, "curso", "zzz")).toEqual([]);
  });

  it("exclui um ancestral da página atual - escolhê-lo reparentearia um ancestral para dentro do próprio descendente", () => {
    const aula = row({ id: "aula", title: "Aula", parent_id: "modulo-3" });
    const pagesById = new Map([
      [curso.id, curso],
      [modulo3.id, modulo3],
      [aula.id, aula],
    ]);
    const childrenIndex = buildChildrenIndex([...pagesById.values()]);

    // Editando "Aula" (filha de "Módulo 3"): "Módulo 3" não pode aparecer
    // como alvo, porque linkar a ele reparentearia "Módulo 3" pra dentro de
    // "Aula" - um ciclo.
    const results = pickablePages(pagesById, childrenIndex, "aula", "");
    expect(results.map((p) => p.id)).toEqual(["curso"]);
  });
});
