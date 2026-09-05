import { describe, expect, it } from "vitest";
import type { SlashMenuItem } from "../../core/block-spec";
import { filterSlashMenuItems, groupSlashMenuItems, UNGROUPED_LABEL } from "./slash-menu-filter";

function item(overrides: Partial<SlashMenuItem> & Pick<SlashMenuItem, "id" | "title">): SlashMenuItem {
  return { run: () => true, ...overrides };
}

describe("filterSlashMenuItems", () => {
  const items: SlashMenuItem[] = [
    item({ id: "heading_1", title: "Título 1", keywords: ["titulo", "heading"] }),
    item({ id: "quote", title: "Citação", keywords: ["quote", "citacao"] }),
    item({ id: "code", title: "Código", keywords: ["code"] }),
  ];

  it("EDT-047: query vazia não filtra nada", () => {
    expect(filterSlashMenuItems(items, "")).toEqual(items);
  });

  it('EDT-047: "head" casa pelo título "Título 1" via a keyword "heading"', () => {
    expect(filterSlashMenuItems(items, "head").map((i) => i.id)).toEqual(["heading_1"]);
  });

  it('EDT-047: "titulo" (sem acento) casa "Título 1" (com acento) pelo título', () => {
    expect(filterSlashMenuItems(items, "titulo").map((i) => i.id)).toEqual(["heading_1"]);
  });

  it('EDT-047: "codigo" (sem acento) casa "Código" pelo título', () => {
    expect(filterSlashMenuItems(items, "codigo").map((i) => i.id)).toEqual(["code"]);
  });

  it("EDT-047: query sem nenhum item correspondente devolve lista vazia", () => {
    expect(filterSlashMenuItems(items, "xyz-nao-existe")).toEqual([]);
  });
});

describe("groupSlashMenuItems", () => {
  it("EDT-047: agrupa preservando a ordem de primeira aparição do grupo", () => {
    const items: SlashMenuItem[] = [
      item({ id: "a", title: "A", group: "Mídia", order: 0 }),
      item({ id: "b", title: "B", group: "Básico", order: 0 }),
      item({ id: "c", title: "C", group: "Mídia", order: 1 }),
    ];
    const groups = groupSlashMenuItems(items);
    expect(groups.map((g) => g.name)).toEqual(["Mídia", "Básico"]);
  });

  it("EDT-047: ordena dentro do grupo por item.order, não pela ordem de chegada", () => {
    const items: SlashMenuItem[] = [
      item({ id: "z", title: "Z", group: "Básico", order: 5 }),
      item({ id: "a", title: "A", group: "Básico", order: 1 }),
    ];
    const [group] = groupSlashMenuItems(items);
    expect(group.items.map((i) => i.id)).toEqual(["a", "z"]);
  });

  it(`EDT-047: item sem "group" cai em "${UNGROUPED_LABEL}"`, () => {
    const groups = groupSlashMenuItems([item({ id: "solo", title: "Solo" })]);
    expect(groups).toEqual([{ name: UNGROUPED_LABEL, items: [expect.objectContaining({ id: "solo" })] }]);
  });
});
