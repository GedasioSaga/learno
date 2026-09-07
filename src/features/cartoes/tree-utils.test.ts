import { describe, expect, it } from "vitest";
import type { DeckRow } from "../../lib/ipc";
import { buildChildrenIndex, displayDeckName, flattenAllDecks, flattenVisibleTree } from "./tree-utils";

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

describe("buildChildrenIndex", () => {
  it("agrupa por parentId e ordena cada grupo por position", () => {
    const b = deck({ id: "b", name: "B", position: "2" });
    const a = deck({ id: "a", name: "A", position: "1" });
    const filho = deck({ id: "filho", parentId: "a", name: "Filho", position: "1" });

    const index = buildChildrenIndex([b, a, filho]);

    expect(index.get(null)?.map((d) => d.id)).toEqual(["a", "b"]);
    expect(index.get("a")?.map((d) => d.id)).toEqual(["filho"]);
    expect(index.get("b")).toBeUndefined();
  });
});

describe("flattenVisibleTree", () => {
  it("some com a subárvore de um pai recolhido", () => {
    const raiz = deck({ id: "raiz", name: "Raiz" });
    const filho = deck({ id: "filho", parentId: "raiz", name: "Filho" });
    const index = buildChildrenIndex([raiz, filho]);

    const recolhido = flattenVisibleTree(index, new Set());
    expect(recolhido.map((n) => n.deck.id)).toEqual(["raiz"]);
    expect(recolhido[0].hasChildren).toBe(true);

    const expandido = flattenVisibleTree(index, new Set(["raiz"]));
    expect(expandido.map((n) => n.deck.id)).toEqual(["raiz", "filho"]);
    expect(expandido[1].depth).toBe(1);
  });
});

describe("flattenAllDecks", () => {
  it("lista a árvore inteira com profundidade, independente de expandedIds", () => {
    const raiz = deck({ id: "raiz", name: "Raiz" });
    const filho = deck({ id: "filho", parentId: "raiz", name: "Filho" });
    const neto = deck({ id: "neto", parentId: "filho", name: "Neto" });
    const index = buildChildrenIndex([raiz, filho, neto]);

    const achatado = flattenAllDecks(index);

    expect(achatado.map((n) => [n.deck.id, n.depth])).toEqual([
      ["raiz", 0],
      ["filho", 1],
      ["neto", 2],
    ]);
  });
});

describe("displayDeckName", () => {
  it("baralho sem nome vira 'Sem nome', nunca um item em branco", () => {
    expect(displayDeckName({ name: "" })).toBe("Sem nome");
    expect(displayDeckName({ name: "   " })).toBe("Sem nome");
    expect(displayDeckName({ name: "Inglês" })).toBe("Inglês");
  });
});
