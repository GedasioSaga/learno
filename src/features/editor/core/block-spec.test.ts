/**
 * The registry's own contract: a block type declared from outside `core/`
 * survives a save/open round trip with its attrs and its search text
 * intact, and a stored type nobody claims still opens.
 *
 * This is the gate the sixteen Fase 2 builders are held to - if a new block
 * type round-trips here, it round-trips in the app; if it doesn't, it
 * silently persists as a paragraph, which is the one failure mode the
 * `BlockSpec` registry exists to make impossible.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../contract";
import { registerBlockSpec, specForBlockType, specForNodeName } from "./block-spec";
import { blocksToDoc, docToFlatBlocks } from "./serialize";

function storedBlock(overrides: Partial<Block>): Block {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pageId: "22222222-2222-4222-8222-222222222222",
    parentBlockId: null,
    blockType: "paragraph",
    content: { inline: [] },
    plainText: "",
    syncedSourceId: null,
    position: "a0",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

// Registrations are module-global on purpose (that's what makes
// `discover-extensions.ts` work), so these tests register once and never
// reset - resetting would drop the nine core specs every other suite in
// this file's neighbourhood depends on.
afterEach(() => {
  /* deliberately no reset - see comment above */
});

describe("BlockSpec registry", () => {
  it("os nove tipos do core estão registrados e resolvem nos dois sentidos", () => {
    expect(specForBlockType("paragraph")?.nodeName).toBe("paragraph");
    expect(specForBlockType("to_do")?.nodeName).toBe("todoItem");
    expect(specForNodeName("callout")?.blockType).toBe("callout");
  });

  it("um spec de família cobre heading_1..3 com um registro só", () => {
    expect(specForBlockType("heading_1")?.nodeName).toBe("heading");
    expect(specForBlockType("heading_3")?.nodeName).toBe("heading");
  });

  it("recusa dois tipos de bloco diferentes com o mesmo blockType persistido", () => {
    registerBlockSpec({ blockType: "spec_test_clash", nodeName: "specTestClashA" });
    expect(() => registerBlockSpec({ blockType: "spec_test_clash", nodeName: "specTestClashB" })).toThrow(
      /já está registrado/,
    );
  });

  it("re-registrar o mesmo tipo (hot reload) é aceito", () => {
    registerBlockSpec({ blockType: "spec_test_reload", nodeName: "specTestReload" });
    expect(() => registerBlockSpec({ blockType: "spec_test_reload", nodeName: "specTestReload" })).not.toThrow();
  });
});

describe("serialize consulta o registro, não uma lista interna", () => {
  it("um bloco atômico registrado de fora sobrevive ao round trip com seus attrs", () => {
    registerBlockSpec({
      blockType: "spec_test_image",
      nodeName: "specTestImage",
      hasContent: false,
      serialization: {
        attrs: (_blockType, content) => ({ src: content.src, caption: content.caption }),
        content: (attrs) => ({ src: attrs.src, caption: attrs.caption }),
        plainText: (content) => String(content.caption ?? ""),
      },
    });

    const stored = storedBlock({
      blockType: "spec_test_image",
      content: { src: "learno.png", caption: "Ícone" },
      plainText: "Ícone",
    });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("specTestImage");
    expect(contentNode?.attrs).toMatchObject({ src: "learno.png", caption: "Ícone" });
    // `hasContent: false` means no content array at all - ProseMirror rejects
    // one on a node whose content expression is empty.
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("spec_test_image");
    expect(flat.content).toEqual({ src: "learno.png", caption: "Ícone" });
    expect(flat.plainText).toBe("Ícone");
  });

  it("um bloco estruturado registrado de fora achata seu próprio texto de busca", () => {
    registerBlockSpec({
      blockType: "spec_test_bookmark",
      nodeName: "specTestBookmark",
      hasContent: false,
      serialization: {
        attrs: (_blockType, content) => ({ url: content.url, title: content.title }),
        content: (attrs) => ({ url: attrs.url, title: attrs.title }),
        plainText: (content) => `${content.title ?? ""} ${content.url ?? ""}`.trim(),
      },
    });

    const doc = blocksToDoc([
      storedBlock({
        blockType: "spec_test_bookmark",
        content: { url: "https://exemplo.test", title: "Exemplo" },
      }),
    ]);
    const [flat] = docToFlatBlocks(doc);
    expect(flat.plainText).toBe("Exemplo https://exemplo.test");
  });

  it("um blockType que nenhum spec reivindica abre como parágrafo em vez de sumir", () => {
    const doc = blocksToDoc([
      storedBlock({ blockType: "tipo_de_uma_versao_futura", content: { inline: [{ type: "text", text: "texto" }] } }),
    ]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("paragraph");
    const [flat] = docToFlatBlocks(doc);
    expect(flat.plainText).toBe("texto");
    // Degrada o tipo, nunca o conteúdo: o texto continua salvo e buscável.
    expect(flat.blockType).toBe("paragraph");
  });
});
