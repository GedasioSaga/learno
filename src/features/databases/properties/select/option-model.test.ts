/**
 * Testes do modelo de opção compartilhado (`option-model.ts`) — a base de
 * DBS-007/008. Cobre especificamente o que a arquitetura §6 exige por nome:
 * id opaco (nunca o rótulo), ordem de config nunca reordenada na leitura, e
 * valor órfão que nunca some em silêncio.
 */
import { describe, expect, it } from "vitest";
import {
  addOption,
  findOption,
  listOptionsInOrder,
  recolorOption,
  removeOption,
  renameOption,
  reorderOptions,
  resolveDisplayOption,
} from "./option-model";
import { configWith, optionAt, optionByLabel } from "./test-fixtures";

describe("addOption", () => {
  it("gera um id OPACO — nunca o rótulo — para cada opção nova", () => {
    const { config, option } = addOption({ options: [] }, "Matemática");
    expect(option.id).not.toBe("Matemática");
    // uuid v4 tem 36 caracteres com hífens nas posições certas.
    expect(option.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(config.options).toHaveLength(1);
  });

  it("duas opções com o MESMO rótulo recebem ids diferentes — o id, não o texto, é a identidade", () => {
    const first = addOption({ options: [] }, "Repetido");
    const second = addOption(first.config, "Repetido");
    expect(second.config.options).toHaveLength(2);
    expect(optionAt(second.config, 0).id).not.toBe(optionAt(second.config, 1).id);
  });
});

describe("renameOption — a identidade não muda", () => {
  it("renomear preserva o id (nada que aponta pra esta opção quebra)", () => {
    const { config, option } = addOption({ options: [] }, "Matemática");
    const renamed = renameOption(config, option.id, "Matemática Avançada");
    expect(findOption(renamed, option.id)?.label).toBe("Matemática Avançada");
    expect(findOption(renamed, option.id)?.id).toBe(option.id);
  });
});

describe("listOptionsInOrder — a ordem É a ordem do array, nunca recalculada", () => {
  it("devolve as opções na ordem de inserção, não alfabética", () => {
    const config = configWith("Zebra", "Abelha", "Mamute");
    expect(listOptionsInOrder(config).map((option) => option.label)).toEqual(["Zebra", "Abelha", "Mamute"]);
  });
});

describe("reorderOptions", () => {
  it("aplica a nova ordem pedida", () => {
    const config = configWith("A", "B", "C");
    const a = optionByLabel(config, "A");
    const b = optionByLabel(config, "B");
    const c = optionByLabel(config, "C");
    const reordered = reorderOptions(config, [c.id, a.id, b.id]);
    expect(reordered.options.map((option) => option.label)).toEqual(["C", "A", "B"]);
  });

  it("uma opção que faltou na lista pedida não é destruída — vai para o final, não some", () => {
    const config = configWith("A", "B", "C");
    const a = optionByLabel(config, "A");
    const c = optionByLabel(config, "C");
    const reordered = reorderOptions(config, [c.id, a.id]); // "B" ausente da lista pedida
    expect(reordered.options.map((option) => option.label)).toEqual(["C", "A", "B"]);
  });

  it("um id que não existe mais em config é ignorado, sem lançar", () => {
    const config = configWith("A", "B");
    const a = optionByLabel(config, "A");
    const b = optionByLabel(config, "B");
    expect(() => reorderOptions(config, [b.id, "id-fantasma", a.id])).not.toThrow();
    expect(reorderOptions(config, [b.id, "id-fantasma", a.id]).options.map((o) => o.label)).toEqual(["B", "A"]);
  });
});

describe("removeOption — não mexe em valor de registro nenhum", () => {
  it("some da LISTA de opções", () => {
    const config = configWith("A", "B");
    const a = optionByLabel(config, "A");
    const after = removeOption(config, a.id);
    expect(findOption(after, a.id)).toBeUndefined();
    expect(after.options).toHaveLength(1);
  });

  it("resolveDisplayOption devolve null para um id apagado — nunca lança, nunca faz sumir o dado em silêncio", () => {
    const config = configWith("A", "B");
    const a = optionByLabel(config, "A");
    const after = removeOption(config, a.id);
    // O VALOR do registro continua sendo o id "a" (esta função só mexe na
    // lista de opções) — é essa a situação de "valor órfão" da arquitetura §6.
    expect(resolveDisplayOption(after, a.id)).toBeNull();
  });
});

describe("recolorOption", () => {
  it("muda só a cor, preserva id e rótulo", () => {
    const { config, option } = addOption({ options: [] }, "Física", "amber");
    const recolored = recolorOption(config, option.id, "mint");
    expect(findOption(recolored, option.id)).toEqual({ id: option.id, label: "Física", color: "mint" });
  });
});
