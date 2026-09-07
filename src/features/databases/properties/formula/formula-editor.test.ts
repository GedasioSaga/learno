/**
 * A lógica pura do editor: inserção no cursor, linha/coluna em UTF-16 (o
 * que o Rust já devolve), agrupamento na ordem do Rust, busca sem acento e
 * o filtro das propriedades que o motor consegue ler.
 */
import { describe, expect, it } from "vitest";
import type { FormulaFunctionDoc } from "../../../../lib/ipc";
import type { PropertyDescriptor } from "../../core/property-spec";
import {
  filterFunctions,
  groupFunctionsByCategory,
  insertFunctionCall,
  insertPropertyReference,
  lineAndColumn,
  referenceableProperties,
} from "./formula-editor";

describe("inserir no cursor", () => {
  it("sem seleção: `round()` com o cursor entre os parênteses", () => {
    expect(insertFunctionCall("1 + ", 4, 4, "round")).toEqual({ next: "1 + round()", caret: 10 });
  });

  it("com seleção: o texto selecionado vira o argumento e o cursor fica depois do `)`", () => {
    expect(insertFunctionCall("1 + 2.5", 4, 7, "round")).toEqual({ next: "1 + round(2.5)", caret: 14 });
  });

  it("a seleção pode vir invertida (fim antes do início)", () => {
    expect(insertFunctionCall("ab", 2, 0, "f")).toEqual({ next: "f(ab)", caret: 5 });
  });

  it("prop(\"Nome\") substitui a seleção e deixa o cursor depois do `)`", () => {
    expect(insertPropertyReference("x + ", 4, 4, "Preço")).toEqual({ next: 'x + prop("Preço")', caret: 17 });
  });
});

describe("linha e coluna", () => {
  it("conta em unidades UTF-16: 'é' é 1 coluna, como o Rust já converteu", () => {
    const src = '"café" + naoexiste';
    expect(lineAndColumn(src, src.indexOf("naoexiste"))).toEqual({ line: 1, column: 10 });
  });

  it("atravessa quebras de linha", () => {
    expect(lineAndColumn("a\nbc\nd", 4)).toEqual({ line: 2, column: 3 });
  });

  it("fora do texto gruda no fim em vez de lançar", () => {
    expect(lineAndColumn("ab", 99)).toEqual({ line: 1, column: 3 });
    expect(lineAndColumn("ab", -5)).toEqual({ line: 1, column: 1 });
  });
});

const docs: FormulaFunctionDoc[] = [
  { name: "round", category: "matemática", doc: "Arredonda para o inteiro mais próximo.", arity: "entre 1 e 2 argumentos" },
  { name: "sum", category: "agregação", doc: "Soma os números de uma lista.", arity: "exatamente 1 argumento" },
  { name: "abs", category: "matemática", doc: "Valor absoluto.", arity: "exatamente 1 argumento" },
  { name: "length", category: "texto", doc: "Quantidade de caracteres.", arity: "exatamente 1 argumento" },
];

describe("a paleta", () => {
  it("agrupa por categoria na ordem em que o Rust devolve, não alfabética", () => {
    const groups = groupFunctionsByCategory(docs);
    expect(groups.map((group) => group.category)).toEqual(["matemática", "agregação", "texto"]);
    expect(groups[0].functions.map((doc) => doc.name)).toEqual(["round", "abs"]);
  });

  it("busca por nome ou documentação, sem acento e sem caixa", () => {
    expect(filterFunctions(docs, "SOMA").map((doc) => doc.name)).toEqual(["sum"]);
    expect(filterFunctions(docs, "proximo").map((doc) => doc.name)).toEqual(["round"]);
    expect(filterFunctions(docs, "").length).toBe(4);
  });

  it("só oferece prop() para tipos que o motor mapeia, e nunca a própria propriedade", () => {
    const property = (id: string, type: string): PropertyDescriptor => ({ id, databaseId: "db", name: id, type, config: {}, position: id });
    const properties = [property("nota", "number"), property("tags", "multi_select"), property("outra", "formula"), property("eu", "number")];
    expect(referenceableProperties(properties, "eu").map((p) => p.id)).toEqual(["nota"]);
    expect(referenceableProperties(properties, "").map((p) => p.id)).toEqual(["nota", "eu"]);
  });
});
