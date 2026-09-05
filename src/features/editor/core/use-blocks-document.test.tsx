/**
 * O ciclo que ninguém tinha exercitado: abrir uma página VAZIA, digitar,
 * salvar, digitar de novo, salvar de novo.
 *
 * Cada peça da Fase 2 testou o seu próprio bloco e passou; o app real não
 * gravava bloco nenhum. A prova veio de um e2e contra o Postgres de verdade
 * (`select count(*) from blocks` = 0 depois de digitar A/Enter/B/Enter/C) com
 * `{"kind":"not_found","message":"não encontrado: bloco ativo <uuid>"}` no
 * console — o erro de `src-tauri/src/db/blocks.rs:303`, ou seja o front-end
 * mandando UPDATE de um id que o backend nunca criou.
 *
 * São duas causas somadas, e os dois testes abaixo separam uma da outra:
 *
 * 1. `blocksToDoc([])` inventa um parágrafo-placeholder com id novo para a
 *    página vazia ter onde receber o cursor. A baseline de diff era montada
 *    a partir desse doc, então o placeholder entrava como "já salvo" e a
 *    primeira digitação virava `update`, não `create`.
 * 2. O id era gerado no cliente e ignorado pelo backend, que gerava o seu
 *    (`Uuid::now_v7()`). Mesmo com a baseline certa, o `create` gravava uma
 *    linha com OUTRO id, e a digitação seguinte voltava a mandar `update`
 *    para um id inexistente. Por isso `NewBlock.id` existe.
 */
import { act, render } from "@testing-library/react";
import type { JSONContent } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, BlockChange } from "../contract";
import { newBlockId } from "./ids";

const applied: BlockChange[][] = [];
let storedBlocks: Block[] = [];

vi.mock("./blocks-api", () => ({
  blocksApi: {
    list_page_blocks: async () => storedBlocks,
    create_block: async () => {
      throw new Error("não usado neste teste");
    },
    update_block: async () => {
      throw new Error("não usado neste teste");
    },
    delete_blocks: async () => {},
    move_block: async () => {
      throw new Error("não usado neste teste");
    },
    apply_block_changes: async (changes: BlockChange[]) => {
      applied.push(changes);
      // Faz o papel do backend: aplica o lote sobre o estado guardado, com a
      // mesma regra do Postgres — UPDATE de id inexistente é erro, não no-op.
      for (const change of changes) {
        if (change.kind === "create") {
          storedBlocks.push({
            id: change.block.id ?? newBlockId(),
            pageId: change.block.placement.pageId,
            parentBlockId: change.block.placement.parentBlockId,
            blockType: change.block.blockType,
            content: change.block.content,
            plainText: change.block.plainText,
            syncedSourceId: null,
            position: String(storedBlocks.length + 1),
            createdAt: "2026-09-03T00:00:00Z",
            updatedAt: "2026-09-03T00:00:00Z",
          });
        } else if (change.kind === "update") {
          const target = storedBlocks.find((b) => b.id === change.id);
          if (!target) throw new Error(`não encontrado: bloco ativo ${change.id}`);
          Object.assign(target, change.patch);
        }
      }
      return storedBlocks;
    },
  },
}));

const { useBlocksDocument } = await import("./use-blocks-document");

const PAGE_ID = "22222222-2222-4222-8222-222222222222";

/** Um doc com um único parágrafo do id e texto dados, na forma que `docToFlatBlocks` espera (wrapper `block` > `paragraph`). */
function docWithParagraph(id: string, text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "block",
        content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
      },
    ],
  };
}

interface Harness {
  current: ReturnType<typeof useBlocksDocument> | null;
}

function renderHook(): Harness {
  const harness: Harness = { current: null };
  function Probe() {
    harness.current = useBlocksDocument(PAGE_ID);
    return null;
  }
  render(<Probe />);
  return harness;
}

async function settle() {
  // Deixa o `list_page_blocks` resolver e o estado do hook assentar.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  applied.length = 0;
  storedBlocks = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("autosave de uma página vazia", () => {
  it("a primeira digitação numa página vazia é um create, não um update de bloco que não existe", async () => {
    const harness = renderHook();
    await settle();
    expect(harness.current?.status).toBe("ready");

    // O id que o editor usaria: o do placeholder que `blocksToDoc([])` criou.
    const placeholderId = harness.current?.initialContent?.content?.[0]?.content?.[0]?.attrs?.id;
    expect(typeof placeholderId).toBe("string");

    await act(async () => {
      harness.current?.scheduleSave(docWithParagraph(placeholderId as string, "primeira linha"));
      await harness.current?.flush();
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(1);
    expect(applied[0][0].kind).toBe("create");
    expect(storedBlocks).toHaveLength(1);
    expect(storedBlocks[0].plainText).toBe("primeira linha");
  });

  it("a segunda digitação vira update do MESMO id, porque o create levou o id do cliente", async () => {
    const harness = renderHook();
    await settle();
    const placeholderId = harness.current?.initialContent?.content?.[0]?.content?.[0]?.attrs?.id as string;

    await act(async () => {
      harness.current?.scheduleSave(docWithParagraph(placeholderId, "primeira"));
      await harness.current?.flush();
    });
    await act(async () => {
      harness.current?.scheduleSave(docWithParagraph(placeholderId, "primeira e segunda"));
      await harness.current?.flush();
    });

    expect(applied).toHaveLength(2);
    expect(applied[1][0].kind).toBe("update");
    // O id gravado é o id do cliente: sem isso o update acima seria contra um
    // id que o backend não conhece, que é exatamente o bug que este arquivo
    // existe para travar.
    expect(storedBlocks).toHaveLength(1);
    expect(storedBlocks[0].id).toBe(placeholderId);
    expect(storedBlocks[0].plainText).toBe("primeira e segunda");
  });

  it("uma página que já tem blocos não recria nada ao abrir e editar", async () => {
    const existingId = newBlockId();
    storedBlocks = [
      {
        id: existingId,
        pageId: PAGE_ID,
        parentBlockId: null,
        blockType: "paragraph",
        content: { inline: [{ type: "text", text: "salvo antes" }] },
        plainText: "salvo antes",
        syncedSourceId: null,
        position: "a0",
        createdAt: "2026-09-03T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z",
      },
    ];

    const harness = renderHook();
    await settle();

    await act(async () => {
      harness.current?.scheduleSave(docWithParagraph(existingId, "salvo antes e depois"));
      await harness.current?.flush();
    });

    expect(applied).toHaveLength(1);
    expect(applied[0][0].kind).toBe("update");
    expect(storedBlocks).toHaveLength(1);
  });
});
