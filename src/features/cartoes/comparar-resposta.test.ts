import { describe, expect, it } from "vitest";
import { compararResposta } from "./comparar-resposta";

describe("compararResposta", () => {
  it("letra a mais no final: acerta a normalização, mas mostra a sobra", () => {
    const resultado = compararResposta("gato", "gatoo");
    expect(resultado.acertou).toBe(false);
    expect(resultado.pedacos).toEqual([
      { status: "certo", texto: "gato" },
      { status: "sobrando", texto: "o" },
    ]);
  });

  it("letra a menos no final: mostra o que faltou digitar", () => {
    const resultado = compararResposta("gato", "gat");
    expect(resultado.acertou).toBe(false);
    expect(resultado.pedacos).toEqual([
      { status: "certo", texto: "gat" },
      { status: "faltando", texto: "o" },
    ]);
  });

  it("letra trocada: falta+sobra adjacentes viram um único pedaço 'errado' com o texto digitado", () => {
    const resultado = compararResposta("gato", "gado");
    expect(resultado.acertou).toBe(false);
    expect(resultado.pedacos).toEqual([
      { status: "certo", texto: "ga" },
      { status: "errado", texto: "d" },
      { status: "certo", texto: "o" },
    ]);
  });

  it("acento faltando: acerta pela normalização, mas o diff aponta a letra sem acento", () => {
    const resultado = compararResposta("café", "cafe");
    expect(resultado.acertou).toBe(true);
    expect(resultado.pedacos).toEqual([
      { status: "certo", texto: "caf" },
      { status: "errado", texto: "e" },
    ]);
  });

  it("caixa diferente: acerta pela normalização, mesmo com várias letras em caixa trocada", () => {
    const resultado = compararResposta("Sao Paulo", "sao paulo");
    expect(resultado.acertou).toBe(true);
    expect(resultado.pedacos).toEqual([
      { status: "errado", texto: "s" },
      { status: "certo", texto: "ao " },
      { status: "errado", texto: "p" },
      { status: "certo", texto: "aulo" },
    ]);
  });

  it("espaço nas pontas: acerta pela normalização, e a sobra de espaço aparece separada do texto certo", () => {
    const resultado = compararResposta("Rio", " Rio ");
    expect(resultado.acertou).toBe(true);
    expect(resultado.pedacos).toEqual([
      { status: "sobrando", texto: " " },
      { status: "certo", texto: "Rio" },
      { status: "sobrando", texto: " " },
    ]);
  });

  it("espaço interno repetido: normaliza para um espaço só e ainda assim acerta", () => {
    const resultado = compararResposta("Sao Paulo", "Sao   Paulo");
    expect(resultado.acertou).toBe(true);
  });

  it("resposta vazia quando algo era esperado: não lança exceção, e tudo vira 'faltando'", () => {
    const resultado = compararResposta("gato", "");
    expect(resultado.acertou).toBe(false);
    expect(resultado.pedacos).toEqual([{ status: "faltando", texto: "gato" }]);
  });

  it("as duas vazias: acerta e não gera pedaço nenhum", () => {
    const resultado = compararResposta("", "");
    expect(resultado.acertou).toBe(true);
    expect(resultado.pedacos).toEqual([]);
  });

  it("resposta idêntica: um único pedaço 'certo', sem exceção para string de um caractere só", () => {
    const identica = compararResposta("gato", "gato");
    expect(identica.acertou).toBe(true);
    expect(identica.pedacos).toEqual([{ status: "certo", texto: "gato" }]);

    const umCaractere = compararResposta("a", "a");
    expect(umCaractere.acertou).toBe(true);
    expect(umCaractere.pedacos).toEqual([{ status: "certo", texto: "a" }]);
  });

  it("mescla pedaços consecutivos de mesmo status num só, mesmo com vários caracteres iguais seguidos", () => {
    // "xy" inteiro tem que virar 1 pedaço "sobrando", nunca 2 pedaços de 1
    // caractere cada — é a prova de que a fusão de adjacentes está ativa.
    const resultado = compararResposta("gato", "gatoxy");
    expect(resultado.acertou).toBe(false);
    expect(resultado.pedacos).toHaveLength(2);
    expect(resultado.pedacos).toEqual([
      { status: "certo", texto: "gato" },
      { status: "sobrando", texto: "xy" },
    ]);
  });

  it("reconstrução: concatenar tudo que não é 'faltando' reproduz exatamente o texto digitado", () => {
    const casos: Array<[string, string]> = [
      ["gato", "gatoo"],
      ["gato", "gat"],
      ["gato", "gado"],
      ["café", "cafe"],
      ["Sao Paulo", "sao paulo"],
      ["Rio", " Rio "],
      ["", ""],
      ["gato", ""],
      ["", "gato"],
    ];

    for (const [esperado, digitado] of casos) {
      const { pedacos } = compararResposta(esperado, digitado);
      const reconstruido = pedacos
        .filter((pedaco) => pedaco.status !== "faltando")
        .map((pedaco) => pedaco.texto)
        .join("");
      expect(reconstruido).toBe(digitado);
    }
  });
});
