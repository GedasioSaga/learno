/**
 * Contrato do `PropertySpec` "files" — I1 (vazio é a AUSÊNCIA da linha) e o
 * round-trip normalize -> serialize -> parse, exercitado sobre `FileRef`
 * de verdade (o mesmo formato que `FilesEditor` produz via `storeMediaFile`
 * real, não um objeto fabricado à mão — ver `FilesEditor.test.tsx` para essa
 * fronteira).
 */
import { describe, expect, it } from "vitest";
import type { FileRef } from "../../contract";
import { filesPropertySpec } from "./files-property-spec";

function fileRef(overrides: Partial<FileRef> & Pick<FileRef, "id">): FileRef {
  return { src: `${overrides.id}.png`, name: `${overrides.id}.png`, kind: "image", ...overrides };
}

describe("filesPropertySpec — metadados fixados pelo contrato (§6)", () => {
  it("valueShape é file_list, e sort é none (arquivo não é ordenável por valor)", () => {
    expect(filesPropertySpec.valueShape).toBe("file_list");
    expect(filesPropertySpec.sort).toBe("none");
  });

  it("só oferece isEmpty/isNotEmpty como filtro — não há 'contém' nem comparação sobre uma lista de anexos", () => {
    expect(filesPropertySpec.filterOperators).toEqual(["isEmpty", "isNotEmpty"]);
  });

  it("não declara parsePlainText — não há como materializar bytes a partir de um nome colado/importado", () => {
    expect(filesPropertySpec.parsePlainText).toBeUndefined();
  });
});

describe("I1 — isEmpty não confunde array vazio com lista ausente, mas os dois SÃO vazios", () => {
  it("[] é vazio", () => {
    expect(filesPropertySpec.isEmpty([], {})).toBe(true);
  });

  it("null e undefined são vazios (propriedade nunca escrita, ou apagada)", () => {
    expect(filesPropertySpec.isEmpty(null, {})).toBe(true);
    expect(filesPropertySpec.isEmpty(undefined, {})).toBe(true);
  });

  it("uma lista com um FileRef de verdade não é vazia", () => {
    expect(filesPropertySpec.isEmpty([fileRef({ id: "a" })], {})).toBe(false);
  });
});

describe("normalize — I1 no caminho de escrita", () => {
  it("lista vazia normaliza para null — APAGA a linha, não grava `[]`", () => {
    expect(filesPropertySpec.normalize([], {})).toBeNull();
  });

  it("entrada que não é array normaliza para null (nada de válido para gravar)", () => {
    expect(filesPropertySpec.normalize("não é uma lista", {})).toBeNull();
    expect(filesPropertySpec.normalize(undefined, {})).toBeNull();
  });

  it("descarta item corrompido isolado, mas preserva os válidos ao redor dele", () => {
    const valid = fileRef({ id: "a" });
    const result = filesPropertySpec.normalize([valid, { id: "sem-src-nem-kind" }, null], {});
    expect(result).toEqual([valid]);
  });

  it("uma lista onde TODOS os itens são corrompidos normaliza para null, não para []", () => {
    expect(filesPropertySpec.normalize([{ nonsense: true }], {})).toBeNull();
  });
});

describe("parse — TOTAL: nunca lança, mesmo com jsonb corrompido", () => {
  it("raw ausente (propriedade nunca escrita) devolve lista vazia, não null nem undefined", () => {
    expect(filesPropertySpec.parse(undefined)).toEqual([]);
  });

  it("raw que não é array devolve lista vazia em vez de lançar", () => {
    expect(filesPropertySpec.parse("corrompido")).toEqual([]);
    expect(filesPropertySpec.parse(42)).toEqual([]);
    expect(filesPropertySpec.parse({ not: "an array" })).toEqual([]);
  });

  it("filtra item inválido dentro de um array bem formado, mantendo o resto — uma célula não pode derrubar a view por causa de UM item torto", () => {
    const valid = fileRef({ id: "b", kind: "file" });
    expect(filesPropertySpec.parse([valid, 123, { id: "" }])).toEqual([valid]);
  });
});

describe("round-trip normalize -> serialize -> parse", () => {
  it("uma lista reordenada sobrevive ao ciclo completo na mesma ordem — é o que 'persistir a nova ordem ao recarregar' (DBS-016) significa no limite desta peça", () => {
    const reordered = [fileRef({ id: "segunda" }), fileRef({ id: "primeira" })];
    const normalized = filesPropertySpec.normalize(reordered, {});
    // Narrowing por `if`, não por `as` — `expect().not.toBeNull()` não
    // estreita o tipo para o compilador, e o teste já falharia aqui mesmo
    // (`throw`) se `normalize` tivesse devolvido `null` por engano.
    if (normalized === null) throw new Error("normalize() não deveria apagar uma lista com 2 arquivos válidos");
    const serialized = filesPropertySpec.serialize(normalized);
    const reparsed = filesPropertySpec.parse(serialized);
    expect(reparsed).toEqual(reordered);
    expect(reparsed.map((file) => file.id)).toEqual(["segunda", "primeira"]);
  });
});

describe("toPlainText — determinístico, sem locale", () => {
  it("lista vazia (ou null) vira string vazia", () => {
    expect(filesPropertySpec.toPlainText([], {})).toBe("");
    expect(filesPropertySpec.toPlainText(null, {})).toBe("");
  });

  it("junta os nomes na ordem da lista, separados por vírgula", () => {
    const value = [fileRef({ id: "a", name: "foto.png" }), fileRef({ id: "b", name: "nota.pdf", kind: "file" })];
    expect(filesPropertySpec.toPlainText(value, {})).toBe("foto.png, nota.pdf");
  });
});
