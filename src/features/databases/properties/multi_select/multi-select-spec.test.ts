/**
 * `multi-select-spec.ts` — a metade de lógica pura (I1, DBS-008). A metade de
 * interação está em `MultiSelectCell.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { removeOption } from "../select/option-model";
import { configWith, optionByLabel } from "../select/test-fixtures";
import { multiSelectPropertySpec } from "./multi-select-spec";

describe("multi_select — valueShape e vocabulário declarado", () => {
  it("declara option_list, configOrder e agrupamento por opção (arquitetura §6/§8)", () => {
    expect(multiSelectPropertySpec.valueShape).toBe("option_list");
    expect(multiSelectPropertySpec.sort).toBe("configOrder");
    expect(multiSelectPropertySpec.grouping?.strategy).toBe("option");
  });
});

describe("multi_select — I1: array vazio é vazio, nunca `[]` gravado", () => {
  it("array vazio, null e undefined são vazios", () => {
    const config = configWith("Álgebra");
    expect(multiSelectPropertySpec.isEmpty([], config)).toBe(true);
    expect(multiSelectPropertySpec.isEmpty(null, config)).toBe(true);
    expect(multiSelectPropertySpec.isEmpty(undefined, config)).toBe(true);
  });

  it("array com pelo menos um id vivo NÃO é vazio", () => {
    const config = configWith("Álgebra", "Geometria");
    expect(multiSelectPropertySpec.isEmpty([optionByLabel(config, "Álgebra").id], config)).toBe(false);
  });

  it("array em que TODO id é órfão conta como vazio (arquitetura §6)", () => {
    const config = configWith("Álgebra");
    const id = optionByLabel(config, "Álgebra").id;
    const semAOpcao = removeOption(config, id);
    expect(multiSelectPropertySpec.isEmpty([id], semAOpcao)).toBe(true);
  });

  it("array com UM id vivo e outro órfão NÃO é vazio — ainda há algo real pra mostrar", () => {
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const semGeometria = removeOption(config, geometriaId);
    expect(multiSelectPropertySpec.isEmpty([algebraId, geometriaId], semGeometria)).toBe(false);
  });
});

describe("multi_select — normalize", () => {
  it("array vazio normaliza para null (apaga a linha)", () => {
    expect(multiSelectPropertySpec.normalize([], { options: [] })).toBeNull();
  });

  it("remove duplicata e lixo de tipo (não-string, string vazia), preserva a ordem de primeira ocorrência", () => {
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    // Lixo deliberado: um `unknown[]` com tipos que NUNCA deveriam chegar
    // aqui (número, string vazia) é exatamente o que `normalize` recebe de
    // um jsonb corrompido — daí o `as unknown[]`: o próprio teste prova que
    // esse lixo é descartado, então o cast não esconde nenhum bug, só
    // simula a entrada hostil que `normalize(value: unknown, ...)` promete tratar.
    const garbage = [algebraId, 42, "", algebraId, geometriaId] as unknown[];
    expect(multiSelectPropertySpec.normalize(garbage, config)).toEqual([algebraId, geometriaId]);
  });

  it("NÃO derruba um id órfão que já estava no array (evita apagar em silêncio uma tag não tocada)", () => {
    const config = configWith("Álgebra");
    const id = optionByLabel(config, "Álgebra").id;
    const semAOpcao = removeOption(config, id);
    // O chamador reescreveu o array (ex.: removendo OUTRA tag) mas manteve
    // este id órfão intocado — normalize não pode fazê-lo sumir sozinho.
    expect(multiSelectPropertySpec.normalize([id], semAOpcao)).toEqual([id]);
  });

  it("não é um array vira null", () => {
    expect(multiSelectPropertySpec.normalize("não é array", { options: [] })).toBeNull();
  });
});

describe("multi_select — toPlainText/parsePlainText", () => {
  it("toPlainText junta os RÓTULOS separados por vírgula, na ordem do valor", () => {
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    expect(multiSelectPropertySpec.toPlainText([algebraId, geometriaId], config)).toBe("Álgebra, Geometria");
  });

  it("ids órfãos são simplesmente omitidos do texto — nunca aparece um id cru", () => {
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    const semGeometria = removeOption(config, geometriaId);
    expect(multiSelectPropertySpec.toPlainText([algebraId, geometriaId], semGeometria)).toBe("Álgebra");
  });

  it("parsePlainText resolve uma lista separada por vírgula pelos rótulos", () => {
    const config = configWith("Álgebra", "Geometria");
    const algebraId = optionByLabel(config, "Álgebra").id;
    const geometriaId = optionByLabel(config, "Geometria").id;
    expect(multiSelectPropertySpec.parsePlainText?.("Álgebra, Geometria", config)).toEqual([algebraId, geometriaId]);
  });

  it("parsePlainText devolve null quando nenhum rótulo casa", () => {
    const config = configWith("Álgebra");
    expect(multiSelectPropertySpec.parsePlainText?.("Química, Biologia", config)).toBeNull();
  });
});
