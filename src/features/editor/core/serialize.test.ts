import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import type { Block } from "../contract";
import { blocksToDoc, diffToChanges, docToFlatBlocks } from "./serialize";

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

/** Builds one `Block` wrapper - `type`/`attrs`/`inline` describe its `blockContent` child; `children` (already-built wrappers, from nested calls to this same function) become its `childBlocks` second child. */
function block(
  id: string,
  type: string,
  attrs: Record<string, unknown>,
  inline: JSONContent[],
  children: JSONContent[] = [],
): JSONContent {
  const contentNode: JSONContent = { type, attrs: { ...attrs, id } };
  if (type !== "divider") contentNode.content = inline;
  const wrapperContent = [contentNode, ...(children.length > 0 ? [{ type: "childBlocks", content: children }] : [])];
  return { type: "block", content: wrapperContent };
}

function makeBlock(overrides: Partial<Block> & Pick<Block, "id" | "blockType">): Block {
  return {
    pageId: "page-1",
    parentBlockId: null,
    content: {},
    plainText: "",
    syncedSourceId: null,
    position: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("docToFlatBlocks", () => {
  it("flattens a doc depth-first, tracking each block's previous sibling", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        block("a", "paragraph", {}, [text("Olá")]),
        block("b", "toggle", { collapsed: false }, [text("Detalhes")], [block("c", "paragraph", {}, [text("Filho")])]),
      ],
    };

    const flat = docToFlatBlocks(doc);

    expect(flat.map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(flat[0]).toMatchObject({ parentBlockId: null, afterId: null, blockType: "paragraph", plainText: "Olá" });
    expect(flat[1]).toMatchObject({ parentBlockId: null, afterId: "a", blockType: "toggle", plainText: "Detalhes" });
    expect(flat[2]).toMatchObject({ parentBlockId: "b", afterId: null, blockType: "paragraph", plainText: "Filho" });
  });

  it("encodes heading level into blockType and drops it as a separate node attr", () => {
    const doc: JSONContent = { type: "doc", content: [block("h", "heading", { level: 2 }, [text("Título")])] };
    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("heading_2");
    expect(flat.content.level).toBe(2);
  });

  it("flattens a hardBreak as a newline in plainText", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [block("p", "paragraph", {}, [text("linha 1"), { type: "hardBreak" }, text("linha 2")])],
    };
    const [flat] = docToFlatBlocks(doc);
    expect(flat.plainText).toBe("linha 1\nlinha 2");
  });
});

describe("blocksToDoc / docToFlatBlocks round trip", () => {
  it("rebuilds the same flat shape it started from, tree and all", () => {
    const blocks: Block[] = [
      makeBlock({ id: "a", blockType: "paragraph", plainText: "Olá", content: { inline: [text("Olá")] }, position: "b" }),
      makeBlock({
        id: "b",
        blockType: "to_do",
        plainText: "Tarefa",
        content: { checked: true, inline: [text("Tarefa")] },
        position: "d",
      }),
      makeBlock({
        id: "c",
        blockType: "paragraph",
        parentBlockId: "b",
        plainText: "Filho",
        content: { inline: [text("Filho")] },
        position: "m",
      }),
    ];

    const doc = blocksToDoc(blocks);
    const roundTripped = docToFlatBlocks(doc);

    expect(roundTripped.map((b) => ({ id: b.id, parentBlockId: b.parentBlockId, blockType: b.blockType, plainText: b.plainText }))).toEqual([
      { id: "a", parentBlockId: null, blockType: "paragraph", plainText: "Olá" },
      { id: "b", parentBlockId: null, blockType: "to_do", plainText: "Tarefa" },
      { id: "c", parentBlockId: "b", blockType: "paragraph", plainText: "Filho" },
    ]);
    expect(roundTripped.find((b) => b.id === "b")?.content.checked).toBe(true);
  });

  it("bootstraps a brand new page with a single empty paragraph instead of an empty doc", () => {
    const doc = blocksToDoc([]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0]?.type).toBe("block");
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("paragraph");
    expect(typeof contentNode?.attrs?.id).toBe("string");
  });
});

describe("diffToChanges", () => {
  it("reports a brand new block as a create with the right placement", () => {
    const changes = diffToChanges(
      "page-1",
      [],
      [{ id: "a", parentBlockId: null, afterId: null, blockType: "paragraph", content: {}, plainText: "novo" }],
    );
    expect(changes).toEqual([
      {
        kind: "create",
        block: {
          // O id que o nó já tem no doc viaja no create: sem isso o backend
          // gravaria a linha com um id próprio e a edição seguinte mandaria
          // UPDATE de uma linha inexistente — ver `NewBlock.id` em
          // `contract.ts` e `use-blocks-document.test.tsx`.
          id: "a",
          blockType: "paragraph",
          content: {},
          plainText: "novo",
          placement: { pageId: "page-1", parentBlockId: null, afterBlockId: null },
        },
      },
    ]);
  });

  it("reports a removed block as a delete", () => {
    const previous = [{ id: "a", parentBlockId: null, afterId: null, blockType: "paragraph", content: {}, plainText: "" }];
    expect(diffToChanges("page-1", previous, [])).toEqual([{ kind: "delete", id: "a" }]);
  });

  it("reports only the fields that changed as an update, and nothing when nothing did", () => {
    const previous = [
      { id: "a", parentBlockId: null, afterId: null, blockType: "paragraph", content: { inline: [] }, plainText: "" },
    ];
    const sameText = diffToChanges("page-1", previous, previous.map((b) => ({ ...b })));
    expect(sameText).toEqual([]);

    const changedText = diffToChanges("page-1", previous, [{ ...previous[0], plainText: "editado" }]);
    expect(changedText).toEqual([{ kind: "update", id: "a", patch: { plainText: "editado" } }]);
  });

  it("reports a reparented block as a move, separate from any content patch", () => {
    const previous = [
      { id: "a", parentBlockId: null, afterId: null, blockType: "paragraph", content: {}, plainText: "x" },
    ];
    const current = [{ id: "a", parentBlockId: "parent-1", afterId: null, blockType: "paragraph", content: {}, plainText: "x" }];
    expect(diffToChanges("page-1", previous, current)).toEqual([
      { kind: "move", id: "a", placement: { pageId: "page-1", parentBlockId: "parent-1", afterBlockId: null } },
    ]);
  });
});
