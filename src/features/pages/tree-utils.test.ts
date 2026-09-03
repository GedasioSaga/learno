import { describe, expect, it } from "vitest";
import type { PageRow } from "../../lib/ipc";
import {
  buildChildrenIndex,
  computeKeyboardMove,
  displayTitle,
  dropPositionRelativeToSibling,
  flattenVisibleTree,
  getDescendantIds,
  isValidDropTarget,
  searchMoveTargets,
} from "./tree-utils";

function page(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "0",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// Árvore de fixture, refletindo o exemplo do checklist (FUN-001):
// A > B > C, e uma segunda raiz D com duas filhas E, F.
const A = page({ id: "A", title: "A", position: "1" });
const B = page({ id: "B", parent_id: "A", title: "B", position: "1" });
const C = page({ id: "C", parent_id: "B", title: "C", position: "1" });
const D = page({ id: "D", title: "D", position: "2" });
const E = page({ id: "E", parent_id: "D", title: "E", position: "1" });
const F = page({ id: "F", parent_id: "D", title: "F", position: "2" });
const allPages = [A, B, C, D, E, F];

describe("buildChildrenIndex", () => {
  it("agrupa por parent_id e ordena cada grupo por position", () => {
    const outOfOrder = [F, E, D, C, B, A];
    const index = buildChildrenIndex(outOfOrder);

    expect(index.get(null)?.map((p) => p.id)).toEqual(["A", "D"]);
    expect(index.get("D")?.map((p) => p.id)).toEqual(["E", "F"]);
    expect(index.get("A")?.map((p) => p.id)).toEqual(["B"]);
  });

  it("uma lista vazia produz um índice vazio, não um erro", () => {
    expect(buildChildrenIndex([]).size).toBe(0);
  });
});

describe("getDescendantIds", () => {
  it("FUN-001: pega toda a cadeia A>B>C a partir de A, sem teto de profundidade", () => {
    const index = buildChildrenIndex(allPages);
    expect(getDescendantIds("A", index)).toEqual(new Set(["B", "C"]));
  });

  it("uma folha não tem descendentes", () => {
    const index = buildChildrenIndex(allPages);
    expect(getDescendantIds("C", index).size).toBe(0);
  });
});

describe("isValidDropTarget", () => {
  const index = buildChildrenIndex(allPages);

  it("a raiz (null) sempre é um destino válido", () => {
    expect(isValidDropTarget("B", null, index)).toBe(true);
  });

  it("uma página não pode virar filha de si mesma", () => {
    expect(isValidDropTarget("A", "A", index)).toBe(false);
  });

  it("uma página não pode virar filha de um descendente seu (evita ciclo)", () => {
    // Mover A para dentro de C (que é neta de A) criaria o ciclo A>B>C>A.
    expect(isValidDropTarget("A", "C", index)).toBe(false);
  });

  it("mover para uma subárvore não relacionada continua válido", () => {
    expect(isValidDropTarget("B", "D", index)).toBe(true);
  });
});

describe("dropPositionRelativeToSibling", () => {
  // FUN-004: "Aula 1" e "Aula 2" irmãs — soltar "Aula 2" acima de "Aula 1"
  // precisa produzir a mesma âncora que o backend (`SiblingPosition::Start`)
  // usaria para colocá-la antes da primeira.
  const aula1 = page({ id: "aula-1", title: "Aula 1" });
  const aula2 = page({ id: "aula-2", title: "Aula 2" });
  const siblings = [aula1, aula2]; // já sem a página sendo movida

  it("soltar antes do primeiro irmão produz Start", () => {
    expect(dropPositionRelativeToSibling(siblings, "aula-1", "before")).toEqual({ type: "start" });
  });

  it("soltar depois de um irmão produz After(esse irmão)", () => {
    expect(dropPositionRelativeToSibling(siblings, "aula-1", "after")).toEqual({
      type: "after",
      value: "aula-1",
    });
  });

  it("soltar antes de um irmão que não é o primeiro produz After(o irmão anterior)", () => {
    expect(dropPositionRelativeToSibling(siblings, "aula-2", "before")).toEqual({
      type: "after",
      value: "aula-1",
    });
  });

  it("rejeita uma âncora que não está entre os irmãos informados", () => {
    expect(() => dropPositionRelativeToSibling(siblings, "estranho", "before")).toThrow();
  });
});

describe("flattenVisibleTree", () => {
  it("com tudo colapsado, só mostra as páginas raiz", () => {
    const index = buildChildrenIndex(allPages);
    const flat = flattenVisibleTree(index, new Set());
    expect(flat.map((n) => n.page.id)).toEqual(["A", "D"]);
    expect(flat.every((n) => n.depth === 0)).toBe(true);
  });

  it("expandir um nó revela seus filhos diretos, não os netos (as outras raízes continuam visíveis)", () => {
    const index = buildChildrenIndex(allPages);
    const flat = flattenVisibleTree(index, new Set(["A"]));
    expect(flat.map((n) => n.page.id)).toEqual(["A", "B", "D"]);
    expect(flat.find((n) => n.page.id === "B")?.depth).toBe(1);
  });

  it("expandir toda a cadeia revela a árvore inteira na ordem certa", () => {
    const index = buildChildrenIndex(allPages);
    const flat = flattenVisibleTree(index, new Set(["A", "B", "D"]));
    expect(flat.map((n) => `${n.page.id}@${n.depth}`)).toEqual([
      "A@0",
      "B@1",
      "C@2",
      "D@0",
      "E@1",
      "F@1",
    ]);
  });

  it("marca hasChildren mesmo quando o nó está colapsado", () => {
    const index = buildChildrenIndex(allPages);
    const flat = flattenVisibleTree(index, new Set());
    expect(flat.find((n) => n.page.id === "A")?.hasChildren).toBe(true);
    expect(flat.find((n) => n.page.id === "D")?.hasChildren).toBe(true);
  });
});

describe("searchMoveTargets", () => {
  it("FUN-022: exclui a própria página e toda a sua subárvore da busca", () => {
    const index = buildChildrenIndex(allPages);
    const results = searchMoveTargets(allPages, "", "A", index);
    expect(results.map((p) => p.id).sort()).toEqual(["D", "E", "F"]);
  });

  it("filtra por título, sem diferenciar maiúsculas de minúsculas", () => {
    const index = buildChildrenIndex(allPages);
    const results = searchMoveTargets(allPages, "d", "A", index);
    expect(results.map((p) => p.id)).toEqual(["D"]);
  });

  it("string de busca vazia lista todo mundo elegível", () => {
    const index = buildChildrenIndex(allPages);
    const results = searchMoveTargets(allPages, "   ", "C", index);
    expect(results.map((p) => p.id).sort()).toEqual(["A", "B", "D", "E", "F"]);
  });
});

describe("computeKeyboardMove", () => {
  // Três irmãos raiz, na ordem X, Y, Z — o mesmo cenário do FUN-004 (Alt+seta
  // é o equivalente de teclado de arrastar).
  const x = page({ id: "X", title: "X", position: "1" });
  const y = page({ id: "Y", title: "Y", position: "2" });
  const z = page({ id: "Z", title: "Z", position: "3" });
  const pagesById = new Map([
    ["X", x],
    ["Y", y],
    ["Z", z],
  ]);
  const childrenIndex = buildChildrenIndex([x, y, z]);

  it("FUN-004: reorder-up move Y para antes de X", () => {
    expect(computeKeyboardMove("reorder-up", "Y", pagesById, childrenIndex)).toEqual({
      newParentId: null,
      target: { type: "start" },
    });
  });

  it("FUN-004: reorder-down move Y para depois de Z", () => {
    expect(computeKeyboardMove("reorder-down", "Y", pagesById, childrenIndex)).toEqual({
      newParentId: null,
      target: { type: "after", value: "Z" },
    });
  });

  it("reorder-up do primeiro irmão não tem para onde ir", () => {
    expect(computeKeyboardMove("reorder-up", "X", pagesById, childrenIndex)).toBeNull();
  });

  it("reorder-down do último irmão não tem para onde ir", () => {
    expect(computeKeyboardMove("reorder-down", "Z", pagesById, childrenIndex)).toBeNull();
  });

  it("FUN-005: nest aninha Y como última filha de X (o irmão anterior)", () => {
    expect(computeKeyboardMove("nest", "Y", pagesById, childrenIndex)).toEqual({
      newParentId: "X",
      target: { type: "end" },
    });
  });

  it("nest do primeiro irmão não tem sob quem aninhar", () => {
    expect(computeKeyboardMove("nest", "X", pagesById, childrenIndex)).toBeNull();
  });

  it("FUN-006: unnest sobe B (filho de A) para irmã de A, logo depois dela", () => {
    const a = page({ id: "A", title: "A" });
    const b = page({ id: "B", parent_id: "A", title: "B" });
    const c = page({ id: "C", title: "C", position: "2" }); // outra raiz, depois de A
    const nestedIndex = buildChildrenIndex([a, b, c]);
    const nestedPagesById = new Map([
      ["A", a],
      ["B", b],
      ["C", c],
    ]);

    expect(computeKeyboardMove("unnest", "B", nestedPagesById, nestedIndex)).toEqual({
      newParentId: null,
      target: { type: "after", value: "A" },
    });
  });

  it("unnest de uma página que já é raiz não tem para onde subir", () => {
    expect(computeKeyboardMove("unnest", "X", pagesById, childrenIndex)).toBeNull();
  });

  it("uma página desconhecida não produz movimento", () => {
    expect(computeKeyboardMove("reorder-up", "fantasma", pagesById, childrenIndex)).toBeNull();
  });
});

describe("displayTitle", () => {
  it("mostra o título quando existe", () => {
    expect(displayTitle({ title: "Biologia" })).toBe("Biologia");
  });

  // Caso de campo "ausente" (regra 5, obrigatório): título vazio é o valor
  // real que `create_page` grava (FUN-002 cria em branco), não um `?`
  // opcional — precisa de um rótulo utilizável antes do usuário digitar algo.
  it("cai para 'Sem título' quando o título é uma string vazia", () => {
    expect(displayTitle({ title: "" })).toBe("Sem título");
  });

  it("cai para 'Sem título' também quando o título só tem espaços", () => {
    expect(displayTitle({ title: "   " })).toBe("Sem título");
  });
});
