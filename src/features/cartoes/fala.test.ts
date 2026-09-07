import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  criarVoz,
  instalarSpeechSynthesisFalsa,
  instalarUtteranceFalsa,
  removerSpeechSynthesis,
} from "./fala-test-fixtures";
import { assinarVozes, falaDisponivel, falar, obterVozes, pararFala, vozesParaIdioma } from "./fala";

beforeEach(() => {
  instalarUtteranceFalsa();
});

afterEach(() => {
  removerSpeechSynthesis();
});

describe("falaDisponivel", () => {
  it("é falso sem window.speechSynthesis (o caso real do jsdom, e de um WebView antigo)", () => {
    removerSpeechSynthesis();
    expect(falaDisponivel()).toBe(false);
  });

  it("é verdadeiro quando a API está instalada", () => {
    instalarSpeechSynthesisFalsa();
    expect(falaDisponivel()).toBe(true);
  });
});

describe("vozesParaIdioma", () => {
  const vozes = [
    criarVoz({ lang: "en-US", name: "Zira", voiceURI: "zira" }),
    criarVoz({ lang: "en-GB", name: "Hazel", voiceURI: "hazel" }),
    criarVoz({ lang: "pt-BR", name: "Maria", voiceURI: "maria" }),
  ];

  it("compara só o subtag principal — 'en-US' bate com uma voz 'en-GB'", () => {
    const resultado = vozesParaIdioma(vozes, "en-US");
    expect(resultado.map((voz) => voz.voiceURI)).toEqual(["zira", "hazel"]);
  });

  it("idioma sem nenhuma voz instalada devolve lista vazia, não lança", () => {
    expect(vozesParaIdioma(vozes, "ja-JP")).toEqual([]);
  });
});

describe("falar", () => {
  it("chama speak com o TEXTO e o IDIOMA certos", () => {
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "en-US", voiceURI: "zira", name: "Zira" })]);

    falar("Hello, world", { idioma: "en-US", vozURI: null });

    expect(falsa.chamadasDeSpeak).toHaveLength(1);
    expect(falsa.chamadasDeSpeak[0]?.text).toBe("Hello, world");
    expect(falsa.chamadasDeSpeak[0]?.lang).toBe("en-US");
  });

  it("usa a voz específica pedida quando ela existe entre as do idioma", () => {
    const zira = criarVoz({ lang: "en-US", voiceURI: "zira", name: "Zira" });
    const david = criarVoz({ lang: "en-US", voiceURI: "david", name: "David" });
    const falsa = instalarSpeechSynthesisFalsa([zira, david]);

    falar("Hello", { idioma: "en-US", vozURI: "david" });

    expect(falsa.chamadasDeSpeak[0]?.voice).toBe(david);
  });

  it("vozURI nulo (\"Automática\") usa a primeira voz do idioma", () => {
    const zira = criarVoz({ lang: "en-US", voiceURI: "zira", name: "Zira" });
    const falsa = instalarSpeechSynthesisFalsa([zira]);

    falar("Hello", { idioma: "en-US", vozURI: null });

    expect(falsa.chamadasDeSpeak[0]?.voice).toBe(zira);
  });

  it("SEM voz para o idioma, não chama speak — o defeito que este projeto mais combate é ficar mudo sem dizer por quê, e é quem CHAMA falar() que deve avisar antes (vozesParaIdioma)", () => {
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    falar("Hello", { idioma: "en-US", vozURI: null });

    expect(falsa.chamadasDeSpeak).toHaveLength(0);
  });

  it("texto vazio não chama speak", () => {
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "en-US" })]);

    falar("   ", { idioma: "en-US", vozURI: null });

    expect(falsa.chamadasDeSpeak).toHaveLength(0);
  });
});

describe("pararFala", () => {
  it("chama cancel na API instalada", () => {
    const falsa = instalarSpeechSynthesisFalsa();
    pararFala();
    expect(falsa.chamadasDeCancel).toBe(1);
  });

  it("sem a API instalada, não lança", () => {
    removerSpeechSynthesis();
    expect(() => pararFala()).not.toThrow();
  });
});

describe("assinarVozes", () => {
  it("getVoices vazio na primeira chamada é recuperado depois do evento voiceschanged", () => {
    // O caso descrito no pedido: a primeira leitura vem vazia porque o SO
    // ainda não populou a lista — só o evento avisa quando ela chega.
    const falsa = instalarSpeechSynthesisFalsa([]);
    expect(obterVozes()).toEqual([]);

    let disparado = 0;
    const cancelar = assinarVozes(() => {
      disparado += 1;
    });

    falsa.definirVozes([criarVoz({ lang: "en-US" })]);

    expect(disparado).toBe(1);
    expect(obterVozes()).toHaveLength(1);

    cancelar();
  });

  it("cancelar a assinatura para de notificar", () => {
    const falsa = instalarSpeechSynthesisFalsa([]);
    let disparado = 0;
    const cancelar = assinarVozes(() => {
      disparado += 1;
    });

    cancelar();
    falsa.definirVozes([criarVoz()]);

    expect(disparado).toBe(0);
  });
});
