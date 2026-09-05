/**
 * DBS-001 — ver `register.ts`/`node.ts`. Dois blocos de prova, no mesmo
 * padrão de `../page-link/page-link.test.tsx`:
 * - round trip de persistência (`BlockSpec`), incluindo o caso de regra 5
 *   ("campo opcional ausente") em que `content` nunca teve `databaseId`;
 * - o NodeView em si, que hoje só sabe explicar "ainda não há como carregar"
 *   (a divergência S2) em vez de travar o editor — "TOTAL, nunca lança"
 *   aplicado à UI.
 */
import { useEffect } from "react";
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import "./register";

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

describe("NodeView: nunca quebra o editor, mesmo sem fonte de dados real", () => {
  it("com databaseId, explica que ainda não há como carregar em vez de travar", async () => {
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: "db-1" } }] }],
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/ainda não pode ser carregada/);
  });

  it("sem databaseId (bloco sem vínculo), explica que falta vincular", async () => {
    await renderDatabaseBlock({
      type: "doc",
      content: [{ type: "block", content: [{ type: "databaseInline", attrs: { id: "b1", databaseId: null } }] }],
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi vinculado/);
  });
});
