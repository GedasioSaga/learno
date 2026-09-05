import { describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { registerBlockSpec } from "../../core/block-spec";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { bookmarkBlockSpec } from "./bookmark-spec";
import { BOOKMARK_BLOCK_TYPE, BOOKMARK_NODE_NAME } from "./constants";

// Registrations are module-global (same convention `block-spec.test.ts`
// documents) - registering here, once, is what lets `blocksToDoc` know
// about "bookmark" at all in this test file, without importing `register.ts`
// (which would also pull in React/CSS for no reason a spec round-trip needs).
registerBlockSpec(bookmarkBlockSpec);

function storedBookmark(overrides: Partial<Block>): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    parentBlockId: null,
    blockType: BOOKMARK_BLOCK_TYPE,
    content: {},
    plainText: "",
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

describe("bookmarkBlockSpec", () => {
  it("EDT-028: um bookmark sobrevive ao round trip salvar/abrir com url, título, descrição e favicon intactos", () => {
    const stored = storedBookmark({
      content: { url: "https://exemplo.test/artigo", title: "Um artigo", description: "Resumo do artigo", favicon: "https://exemplo.test/favicon.ico" },
      plainText: "Um artigo https://exemplo.test/artigo",
    });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe(BOOKMARK_NODE_NAME);
    expect(contentNode?.attrs).toMatchObject({
      url: "https://exemplo.test/artigo",
      title: "Um artigo",
      description: "Resumo do artigo",
      favicon: "https://exemplo.test/favicon.ico",
    });
    // Átomo: nenhum array de conteúdo, do contrário o ProseMirror recusaria
    // o nó (content: "" não aceita filhos).
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe(BOOKMARK_BLOCK_TYPE);
    expect(flat.content).toEqual({
      url: "https://exemplo.test/artigo",
      title: "Um artigo",
      description: "Resumo do artigo",
      favicon: "https://exemplo.test/favicon.ico",
    });
  });

  it("EDT-028: plainText junta título e URL para a busca global achar o bookmark pelos dois", () => {
    const doc = blocksToDoc([
      storedBookmark({ content: { url: "https://exemplo.test", title: "Exemplo", description: "", favicon: null } }),
    ]);
    const [flat] = docToFlatBlocks(doc);
    expect(flat.plainText).toBe("Exemplo https://exemplo.test");
  });

  it("sem favicon nem descrição (campos ausentes no content), reidrata como string vazia / null em vez de quebrar", () => {
    const doc = blocksToDoc([storedBookmark({ content: { url: "https://exemplo.test" } })]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.attrs).toMatchObject({ title: "", description: "", favicon: null });
  });
});
