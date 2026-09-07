import { describe, expect, it } from "vitest";
import {
  adicionarLacuna,
  apararIntervalo,
  cartoesDe,
  mesmaLacuna,
  montarTextoCloze,
  novaLacuna,
  numeroAtual,
  proximoNumero,
  removerLacuna,
  segmentosDoCartao,
  type Lacuna,
} from "./lacunas";

const TEXTO = "A mitocôndria produz ATP na respiração celular.";
// "mitocôndria" = [2, 13); "ATP" = [21, 24); "respiração" = [28, 38)

function ok(resultado: ReturnType<typeof adicionarLacuna>): Lacuna[] {
  if (!resultado.ok) throw new Error(`esperava sucesso, veio recusa: ${resultado.motivo}`);
  return resultado.lacunas;
}

describe("montarTextoCloze", () => {
  it("embrulha o trecho como {{c1::...}} e deixa o resto do texto byte a byte igual", () => {
    const lacunas = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    expect(montarTextoCloze(TEXTO, lacunas)).toBe("A {{c1::mitocôndria}} produz ATP na respiração celular.");
  });

  it("nova lacuna incrementa o número (duas perguntas); mesma lacuna reusa (uma pergunta, dois buracos)", () => {
    const c1 = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));

    const duasPerguntas = ok(novaLacuna(TEXTO, c1, { inicio: 21, fim: 24 }));
    expect(montarTextoCloze(TEXTO, duasPerguntas)).toBe(
      "A {{c1::mitocôndria}} produz {{c2::ATP}} na respiração celular.",
    );
    expect(cartoesDe(duasPerguntas)).toEqual([1, 2]);

    const umaPergunta = ok(mesmaLacuna(TEXTO, c1, { inicio: 21, fim: 24 }));
    expect(montarTextoCloze(TEXTO, umaPergunta)).toBe(
      "A {{c1::mitocôndria}} produz {{c1::ATP}} na respiração celular.",
    );
    expect(cartoesDe(umaPergunta)).toEqual([1]);
  });

  it("a ordem de marcação não importa: a string sai na ordem do texto", () => {
    const tarde = ok(novaLacuna(TEXTO, [], { inicio: 28, fim: 38 }));
    const cedo = ok(novaLacuna(TEXTO, tarde, { inicio: 2, fim: 13 }));
    expect(montarTextoCloze(TEXTO, cedo)).toBe("A {{c2::mitocôndria}} produz ATP na {{c1::respiração}} celular.");
  });
});

describe("numeração", () => {
  it("sem lacunas: próxima é 1 e não há 'mesma'", () => {
    expect(proximoNumero([])).toBe(1);
    expect(numeroAtual([])).toBeNull();
  });

  it("mesma lacuna sem nenhuma existente vira c1 — o usuário pediu uma lacuna e ganha uma", () => {
    const lacunas = ok(mesmaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    expect(lacunas.map((l) => l.numero)).toEqual([1]);
  });

  it("remover a c1 não renumera a c2: a próxima continua sendo c3, como no Anki", () => {
    const c1 = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    const c1c2 = ok(novaLacuna(TEXTO, c1, { inicio: 21, fim: 24 }));
    const soC2 = removerLacuna(c1c2, c1c2[0]);
    expect(cartoesDe(soC2)).toEqual([2]);
    expect(proximoNumero(soC2)).toBe(3);
    expect(montarTextoCloze(TEXTO, soC2)).toBe("A mitocôndria produz {{c2::ATP}} na respiração celular.");
  });
});

describe("recusas — uma nota que não pergunta nada não pode nascer", () => {
  it("seleção vazia", () => {
    expect(novaLacuna(TEXTO, [], { inicio: 5, fim: 5 })).toEqual({ ok: false, motivo: "vazia" });
  });

  it("seleção só de espaço é vazia depois de aparar", () => {
    expect(novaLacuna(TEXTO, [], { inicio: 1, fim: 2 })).toEqual({ ok: false, motivo: "vazia" });
  });

  it("apara espaço nas pontas antes de marcar", () => {
    expect(apararIntervalo(TEXTO, { inicio: 1, fim: 14 })).toEqual({ inicio: 2, fim: 13 });
    const lacunas = ok(novaLacuna(TEXTO, [], { inicio: 1, fim: 14 }));
    expect(montarTextoCloze(TEXTO, lacunas)).toBe("A {{c1::mitocôndria}} produz ATP na respiração celular.");
  });

  it("seleção que já contém {{ ou }}", () => {
    const comMarcacao = "Veja {{c1::isto}} aqui";
    expect(novaLacuna(comMarcacao, [], { inicio: 5, fim: 17 })).toEqual({ ok: false, motivo: "contem-marcacao" });
    expect(novaLacuna(comMarcacao, [], { inicio: 12, fim: 18 })).toEqual({ ok: false, motivo: "contem-marcacao" });
  });

  it("texto do bloco vazio", () => {
    expect(novaLacuna("", [], { inicio: 0, fim: 0 })).toEqual({ ok: false, motivo: "vazia" });
    expect(novaLacuna("", [], { inicio: 0, fim: 3 })).toEqual({ ok: false, motivo: "fora-do-texto" });
  });

  it("intervalo fora do texto", () => {
    expect(novaLacuna(TEXTO, [], { inicio: -1, fim: 3 })).toEqual({ ok: false, motivo: "fora-do-texto" });
    expect(novaLacuna(TEXTO, [], { inicio: 3, fim: TEXTO.length + 1 })).toEqual({ ok: false, motivo: "fora-do-texto" });
  });

  it("sobreposição com lacuna existente — aninhar {{ dentro de {{ nunca chega ao backend", () => {
    const c1 = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    expect(novaLacuna(TEXTO, c1, { inicio: 0, fim: 5 })).toEqual({ ok: false, motivo: "sobrepoe" });
    expect(novaLacuna(TEXTO, c1, { inicio: 4, fim: 8 })).toEqual({ ok: false, motivo: "sobrepoe" });
    expect(novaLacuna(TEXTO, c1, { inicio: 10, fim: 20 })).toEqual({ ok: false, motivo: "sobrepoe" });
    // Encostar sem sobrepor é permitido.
    expect(novaLacuna(TEXTO, c1, { inicio: 13, fim: 20 }).ok).toBe(true);
  });

  it("nenhuma lacuna: o texto sai puro e não há cartão nenhum", () => {
    expect(montarTextoCloze(TEXTO, [])).toBe(TEXTO);
    expect(cartoesDe([])).toEqual([]);
  });
});

describe("segmentosDoCartao — a prévia usa a mesma forma que o Rust devolve na sessão", () => {
  it("esconde só as lacunas deste número; as dos outros aparecem como texto, fundidas com os vizinhos", () => {
    const c1 = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    const c1c2 = ok(novaLacuna(TEXTO, c1, { inicio: 21, fim: 24 }));

    expect(segmentosDoCartao(TEXTO, c1c2, 1)).toEqual([
      { text: "A ", hidden: false, hint: null },
      { text: "mitocôndria", hidden: true, hint: null },
      { text: " produz ATP na respiração celular.", hidden: false, hint: null },
    ]);
    expect(segmentosDoCartao(TEXTO, c1c2, 2)).toEqual([
      { text: "A mitocôndria produz ", hidden: false, hint: null },
      { text: "ATP", hidden: true, hint: null },
      { text: " na respiração celular.", hidden: false, hint: null },
    ]);
  });

  it("dois buracos no mesmo cartão", () => {
    const c1 = ok(novaLacuna(TEXTO, [], { inicio: 2, fim: 13 }));
    const c1c1 = ok(mesmaLacuna(TEXTO, c1, { inicio: 21, fim: 24 }));
    const escondidos = segmentosDoCartao(TEXTO, c1c1, 1).filter((s) => s.hidden);
    expect(escondidos.map((s) => s.text)).toEqual(["mitocôndria", "ATP"]);
  });
});
