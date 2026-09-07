/**
 * DBS-001 — ver `register.ts`/`node.ts`. Dois blocos de prova, no mesmo
 * padrão de `../page-link/page-link.test.tsx`:
 * - round trip de persistência (`BlockSpec`), incluindo o caso de regra 5
 *   ("campo opcional ausente") em que `content` nunca teve `databaseId`;
 * - o NodeView em si, agora ligado à fonte real (`useDatabase`, IPC
 *   mockado aqui): carrega e desenha a Tabela, e em erro explica em vez de
 *   travar o editor — "TOTAL, nunca lança" aplicado à UI;
 * - o item "/database", que cria database + view antes de inserir o bloco.
 */
import { useEffect } from "react";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  createDatabase,
  createProperty,
  createRecord,
  createView,
  deleteDatabase,
  getDatabase,
  listProperties,
  listRecords,
  listViews,
  type DatabaseRow,
  type PageRow,
} from "../../../../lib/ipc";
import { usePageTreeStore } from "../../../pages/store";
import { collectSlashMenuItems } from "../../core/block-spec";
import { DatabaseInsertError } from "./DatabaseInsertError";
import { useDatabaseInsertErrorStore } from "./insert-error-store";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import "./register";

vi.mock("../../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/ipc")>();
  return {
    ...actual,
    getDatabase: vi.fn(),
    listProperties: vi.fn(),
    listViews: vi.fn(),
    listRecords: vi.fn(),
    createDatabase: vi.fn(),
    createView: vi.fn(),
    deleteDatabase: vi.fn(),
    createProperty: vi.fn(),
    createRecord: vi.fn(),
  };
});

const database: DatabaseRow = {
  id: "db-1",
  containerPageId: "page-1",
  name: "Estudos",
  isLocked: false,
  config: {},
  dataVersion: 0,
  createdAt: "",
  updatedAt: "",
};

const recordPage: PageRow = {
  id: "r1",
  parent_id: null,
  database_id: "db-1",
  title: "Aula 1",
  icon: null,
  position: "a0",
  is_favorite: false,
  deleted_at: null,
  created_at: "",
  updated_at: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  useDatabaseInsertErrorStore.getState().dismiss();
  vi.mocked(deleteDatabase).mockResolvedValue(undefined);
  vi.mocked(createProperty).mockResolvedValue({
    id: "p-novo", databaseId: "db-1", name: "Texto", propertyType: "text", config: {}, position: "a0", createdAt: "", updatedAt: "",
  });
  vi.mocked(createRecord).mockResolvedValue({ ...recordPage, id: "r-novo", title: "" });
  vi.mocked(getDatabase).mockResolvedValue(database);
  vi.mocked(listProperties).mockResolvedValue([]);
  vi.mocked(listViews).mockResolvedValue([
    { id: "v-1", databaseId: "db-1", name: "Tabela", viewType: "table", config: {}, position: "a0", createdAt: "", updatedAt: "" },
  ]);
  vi.mocked(listRecords).mockResolvedValue([{ page: recordPage, values: [] }]);
  vi.mocked(createDatabase).mockResolvedValue(database);
  vi.mocked(createView).mockResolvedValue({
    id: "v-1", databaseId: "db-1", name: "Tabela", viewType: "table", config: {}, position: "a0", createdAt: "", updatedAt: "",
  });
});

let editor: Editor | undefined;

function Harness({ content, onReady }: { content: JSONContent; onReady: (editor: Editor) => void }) {
  const instance = useEditor({ extensions: buildEditorExtensions(), content, immediatelyRender: true }, [content]);
  useEffect(() => {
    if (instance) onReady(instance);
  }, [instance, onReady]);
  return <EditorContent editor={instance} />;
}

async function renderDatabaseBlock(content: JSONContent): Promise<void> {
  render(<Harness content={content} onReady={(instance) => (editor = instance)} />);
  await waitFor(() => expect(editor).toBeDefined());
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  cleanup();
});

describe("BlockSpec: round trip salva/abre", () => {
  it("um bloco database persistido sobrevive ao round trip com o databaseId", () => {
    const stored = [
      {
        id: "b1",
        pageId: "page-x",
        parentBlockId: null,
        blockType: "database",
        content: { databaseId: "db-1" },
        plainText: "",
        syncedSourceId: null,
        position: "a0",
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
      },
    ];

    const doc = blocksToDoc(stored);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("databaseInline");
    expect(contentNode?.attrs).toMatchObject({ databaseId: "db-1" });
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("database");
    expect(flat.content).toEqual({ databaseId: "db-1" });
    expect(flat.plainText).toBe("");
  });

  // Regra 5, caso 2: `content` sem a CHAVE `databaseId` — não `null`
  // explícito — a forma que um bloco nunca preenchido de fato chegaria do
  // banco. `attrs()` faz `typeof content.databaseId === "string"`, nunca
  // `content.databaseId as string`, e é essa checagem que evita "Cannot
  // read properties of undefined" aqui em vez de só empurrar pro NodeView.
  it("um bloco persistido sem databaseId no content não quebra o round trip", () => {
    const stored = [
      {
        id: "b1",
        pageId: "page-x",
        parentBlockId: null,
        blockType: "database",
        content: {},
        plainText: "",
        syncedSourceId: null,
        position: "a0",
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
      },
    ];

    const doc = blocksToDoc(stored);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.attrs).toMatchObject({ databaseId: null });

    const [flat] = docToFlatBlocks(doc);
    expect(flat.content).toEqual({ databaseId: null });
  });
});

describe("NodeView: carrega pela fonte real e nunca quebra o editor", () => {
  it("com databaseId, carrega o schema pelo IPC e desenha a Tabela", async () => {
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: "db-1" } }] }],
    });

    expect(await screen.findByRole("grid", { name: "Tabela" })).toBeInTheDocument();
    expect(getDatabase).toHaveBeenCalledWith("db-1");
    expect(screen.getByText("Estudos")).toBeInTheDocument();
    expect(screen.getByText("Aula 1")).toBeInTheDocument();
  });

  it("IPC falhando vira alerta explicado, não editor travado", async () => {
    vi.mocked(getDatabase).mockRejectedValue(new AppError({ kind: "not_found", message: "database sumiu" }));
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: "db-1" } }] }],
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("database sumiu");
  });

  it("sem databaseId (bloco sem vínculo), explica que falta vincular", async () => {
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: null } }] }],
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi vinculado/);
    expect(getDatabase).not.toHaveBeenCalled();
  });
});

describe("/database: o item de menu que cria a database antes de inserir o bloco", () => {
  it("está registrado e, com página selecionada, cria database + view 'Tabela' e insere o bloco com o databaseId real", async () => {
    usePageTreeStore.setState({ selectedPageId: "page-1" });
    await renderDatabaseBlock({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph" }] }] });
    const item = collectSlashMenuItems().find((candidate) => candidate.id === "blocks:database");
    if (!item || !editor) throw new Error("item /database não registrado");

    expect(item.run(editor)).toBe(true);
    await waitFor(() => expect(createView).toHaveBeenCalledWith("db-1", "Tabela", "table"));
    expect(createDatabase).toHaveBeenCalledWith("page-1", "Nova database");
    await waitFor(() => {
      const [flat] = docToFlatBlocks(editor!.getJSON());
      expect(flat.blockType).toBe("database");
      expect(flat.content).toEqual({ databaseId: "db-1" });
    });
  });

  it("sem página selecionada, recusa (devolve false) e não chama IPC", async () => {
    usePageTreeStore.setState({ selectedPageId: null });
    await renderDatabaseBlock({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph" }] }] });
    const item = collectSlashMenuItems().find((candidate) => candidate.id === "blocks:database");
    if (!item || !editor) throw new Error("item /database não registrado");
    expect(item.run(editor)).toBe(false);
    expect(createDatabase).not.toHaveBeenCalled();
  });
});

/**
 * A COSTURA que nenhum outro teste cobre: `DatabaseContainer.test.tsx`
 * prova o clique contra um `vi.fn()`, `use-database.test.tsx` prova o hook
 * contra o IPC — e o elo entre os dois (a lambda de uma linha em
 * `DatabaseBlockView.tsx`) ficava sem prova. Aqui o `useDatabase` é o de
 * verdade e só `src/lib/ipc.ts` é mockado: desligar `onAddProperty` ou
 * `mutations` no NodeView deixa este arquivo vermelho.
 */
describe("DatabaseBlockView: o clique na tela chega ao IPC pelo useDatabase real", () => {
  async function renderReadyBlock() {
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: "db-1" } }] }],
    });
    await screen.findByRole("grid", { name: "Tabela" });
    // Cabeçalho inline só revela as ações com hover/foco (DBS-001).
    const header = screen.getByText("Estudos").parentElement;
    if (!header) throw new Error("cabeçalho não encontrado");
    fireEvent.mouseEnter(header);
  }

  it("'+ Propriedade' > 'Texto' chama create_property com o defaultConfig do tipo e recarrega o schema", async () => {
    await renderReadyBlock();
    expect(listProperties).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "+ Propriedade" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Texto" }));

    // O quarto argumento é o `defaultConfig` do `PropertySpec`, e ele não é
    // decorativo: `create_property` (`db/databases.rs`) grava `{}` quando o
    // config vem ausente, porque o Rust não conhece `PropertySpec` — e uma
    // propriedade Número nascida com `{}` ficava com a célula MUDA para
    // sempre, o valor certo no banco e invisível na tela.
    //
    // Para "Texto" o default é `{}` e o efeito é o mesmo de omitir; o que
    // este teste trava é que o default SEJA ENVIADO, porque é isso que
    // conserta Número, Data e Seleção. Se alguém voltar a omitir o config,
    // aqui fica vermelho antes de o defeito chegar à tela.
    await waitFor(() => expect(createProperty).toHaveBeenCalledWith("db-1", "Texto", "text", {}));
    await waitFor(() => expect(listProperties).toHaveBeenCalledTimes(2));
  });

  it("'+ Propriedade' > 'Número' manda { format: 'plain' }, não um config vazio", async () => {
    await renderReadyBlock();

    fireEvent.click(screen.getByRole("button", { name: "+ Propriedade" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Número" }));

    // O caso que motivou a correção: sem isto a coluna nasce com `{}`,
    // `format` chega `undefined` no formatador, e a célula não renderiza
    // nada — sem erro no console, e recarregar não resolve, porque o
    // config persistido continua `{}`.
    await waitFor(() => expect(createProperty).toHaveBeenCalledWith("db-1", "Número", "number", { format: "plain" }));
  });

  it("'Nova linha' chama create_record com (databaseId, '') e a linha nova abre no título", async () => {
    await renderReadyBlock();

    fireEvent.click(screen.getByRole("button", { name: "Nova linha" }));

    await waitFor(() => expect(createRecord).toHaveBeenCalledWith("db-1", ""));
    expect(await screen.findByRole("textbox", { name: "Título do registro" })).toBeInTheDocument();
  });

  it("'+ Novo' do cabeçalho também chega em create_record", async () => {
    await renderReadyBlock();
    fireEvent.click(screen.getByRole("button", { name: "+ Novo" }));
    await waitFor(() => expect(createRecord).toHaveBeenCalledWith("db-1", ""));
  });
});

describe("/database: falha no meio não é engolida", () => {
  it("create_view falhando desfaz a database (delete_database), mostra o motivo na tela e NÃO insere o bloco", async () => {
    usePageTreeStore.setState({ selectedPageId: "page-1" });
    vi.mocked(createView).mockRejectedValue(new AppError({ kind: "database", message: "disco cheio" }));
    await renderDatabaseBlock({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph" }] }] });
    render(<DatabaseInsertError />);
    const item = collectSlashMenuItems().find((candidate) => candidate.id === "blocks:database");
    if (!item || !editor) throw new Error("item /database não registrado");

    item.run(editor);

    await waitFor(() => expect(deleteDatabase).toHaveBeenCalledWith("db-1"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("disco cheio");
    expect(alert).toHaveTextContent(/desfeita/);
    expect(docToFlatBlocks(editor.getJSON()).some((block) => block.blockType === "database")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("se a compensação também falhar, o aviso diz que a database ficou para trás", async () => {
    usePageTreeStore.setState({ selectedPageId: "page-1" });
    vi.mocked(createView).mockRejectedValue(new AppError({ kind: "database", message: "disco cheio" }));
    vi.mocked(deleteDatabase).mockRejectedValue(new AppError({ kind: "database", message: "travado" }));
    await renderDatabaseBlock({ type: "doc", content: [{ type: "block", content: [{ type: "paragraph" }] }] });
    render(<DatabaseInsertError />);
    const item = collectSlashMenuItems().find((candidate) => candidate.id === "blocks:database");
    if (!item || !editor) throw new Error("item /database não registrado");

    item.run(editor);
    expect(await screen.findByRole("alert")).toHaveTextContent(/ficou no banco sem view/);
  });
});
