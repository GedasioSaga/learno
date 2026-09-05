/**
 * `select-spec.ts` — a metade de lógica pura (I1, DBS-007). A metade de
 * interação (escolher substitui, chip órfão visível) está em
 * `SelectCell.test.tsx`, que monta o editor de verdade em vez de chamar as
 * funções isoladas — a lição da Fase 2 (`docs/ACHADOS-FASE-2.md`) sobre teste
 * que não atravessa a fronteira que a feature atravessa.
 */
import { describe, expect, it } from "vitest";
import { removeOption } from "./option-model";
import { selectPropertySpec } from "./select-spec";
import { configWith, optionByLabel } from "./test-fixtures";

describe("select — valueShape e vocabulário declarado", () => {
  it("declara a forma e o vocabulário que o Rust traduz (arquitetura §6)", () => {
    expect(selectPropertySpec.valueShape).toBe("option");
    expect(selectPropertySpec.sort).toBe("configOrder");
    expect(selectPropertySpec.grouping?.strategy).toBe("option");
  });
});

describe("select — I1: isEmpty NUNCA é `!value`", () => {
  it("string vazia, null e undefined são vazios", () => {
    const config = configWith("Matemática");
    expect(selectPropertySpec.isEmpty("", config)).toBe(true);
    expect(selectPropertySpec.isEmpty(null, config)).toBe(true);
    expect(selectPropertySpec.isEmpty(undefined, config)).toBe(true);
  });

  it("um id que resolve a uma opção viva NÃO é vazio", () => {
    const config = configWith("Matemática");
    const id = optionByLabel(config, "Matemática").id;
    expect(selectPropertySpec.isEmpty(id, config)).toBe(false);
  });

  it("valor órfão (opção apagada) CONTA como vazio — arquitetura §6, mesmo a linha existindo", () => {
    const config = configWith("Matemática");
    const id = optionByLabel(config, "Matemática").id;
    const semAOpcao = removeOption(config, id);
    expect(selectPropertySpec.isEmpty(id, semAOpcao)).toBe(true);
  });
});

describe("select — normalize: caminho de escrita (I1 + validação de id)", () => {
  it("um id válido é mantido tal qual", () => {
    const config = configWith("Matemática");
    const id = optionByLabel(config, "Matemática").id;
    expect(selectPropertySpec.normalize(id, config)).toBe(id);
  });

  it("string vazia normaliza para null (apaga a linha)", () => {
    const config = configWith("Matemática");
    expect(selectPropertySpec.normalize("", config)).toBeNull();
  });

  it("um id que não existe em config.options nunca é escrito — normalize devolve null", () => {
    const config = configWith("Matemática");
    expect(selectPropertySpec.normalize("id-que-nunca-existiu", config)).toBeNull();
  });
});

describe("select — parse/serialize são totais (nunca lançam)", () => {
  it("parse devolve string vazia para jsonb corrompido, nunca lança", () => {
    expect(selectPropertySpec.parse(42)).toBe("");
    expect(selectPropertySpec.parse(null)).toBe("");
    expect(selectPropertySpec.parse(undefined)).toBe("");
    expect(selectPropertySpec.parse(["não", "é", "select"])).toBe("");
  });

  it("serialize é identidade", () => {
    expect(selectPropertySpec.serialize("abc")).toBe("abc");
  });
});

describe("select — toPlainText/parsePlainText (CSV, busca)", () => {
  it("toPlainText devolve o RÓTULO da opção, não o id", () => {
    const config = configWith("Matemática", "Física");
    const id = optionByLabel(config, "Física").id;
    expect(selectPropertySpec.toPlainText(id, config)).toBe("Física");
  });

  it("toPlainText de um id órfão é string vazia — nunca lança, nunca mostra o id cru", () => {
    const config = configWith("Matemática");
    const id = optionByLabel(config, "Matemática").id;
    const semAOpcao = removeOption(config, id);
    expect(selectPropertySpec.toPlainText(id, semAOpcao)).toBe("");
  });

  it("toPlainText de null é string vazia", () => {
    const config = configWith("Matemática");
    expect(selectPropertySpec.toPlainText(null, config)).toBe("");
  });

  it("parsePlainText resolve pelo RÓTULO (import de CSV), ignorando maiúsculas/acentuação de caixa", () => {
    const config = configWith("Matemática", "Física");
    const id = optionByLabel(config, "Matemática").id;
    expect(selectPropertySpec.parsePlainText?.("matemática", config)).toBe(id);
  });

  it("parsePlainText devolve null quando nada casa — nunca inventa opção", () => {
    const config = configWith("Matemática");
    expect(selectPropertySpec.parsePlainText?.("Química", config)).toBeNull();
    expect(selectPropertySpec.parsePlainText?.("   ", config)).toBeNull();
  });
});
