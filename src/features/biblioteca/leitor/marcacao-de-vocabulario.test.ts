import { afterEach, describe, expect, it } from "vitest";
import { NOME_DA_MARCACAO, aplicarMarcacao, encontrarOcorrencias, limparMarcacao } from "./marcacao-de-vocabulario";

/** O pedaço do texto original que cada ocorrência cobre — o que de fato fica sublinhado na tela. */
function trechos(texto: string, termos: readonly string[]): string[] {
  return encontrarOcorrencias(texto, termos).map(({ inicio, fim }) => texto.slice(inicio, fim));
}

describe("encontrarOcorrencias", () => {
  it("acha a palavra inteira no começo do texto, antes da vírgula", () => {
    expect(encontrarOcorrencias("Voraz, o lobo", ["voraz"])).toEqual([{ inicio: 0, fim: 5 }]);
  });

  it("não acha a palavra dentro de outra maior", () => {
    expect(encontrarOcorrencias("comia vorazmente", ["voraz"])).toEqual([]);
  });

  it("singular e plural são palavras diferentes", () => {
    expect(encontrarOcorrencias("vidas austeras", ["austera"])).toEqual([]);
  });

  it("ignora acento e caixa nos dois sentidos", () => {
    expect(trechos("uma mesa de Ebano", ["ébano"])).toEqual(["Ebano"]);
    expect(trechos("uma mesa de ébano", ["Ebano"])).toEqual(["ébano"]);
  });

  it("texto já decomposto (NFD) devolve os índices do ORIGINAL, acento incluído", () => {
    const texto = "o café e o ébano";
    expect(texto.length).toBe(18);

    expect(encontrarOcorrencias(texto, ["café"])).toEqual([{ inicio: 2, fim: 7 }]);
    expect(encontrarOcorrencias(texto, ["ébano"])).toEqual([{ inicio: 12, fim: 18 }]);
    expect(trechos(texto, ["café", "ébano"])).toEqual(["café", "ébano"]);
  });

  it("termo de várias palavras casa com quebra de linha no meio", () => {
    expect(trechos("andava ao\nléu pela rua", ["ao léu"])).toEqual(["ao\nléu"]);
    expect(trechos("andava ao   léu", ["ao léu"])).toEqual(["ao   léu"]);
  });

  it("termo vazio ou só com espaço é ignorado, sem casar o texto inteiro", () => {
    expect(encontrarOcorrencias("qualquer texto", [""])).toEqual([]);
    expect(encontrarOcorrencias("qualquer texto", ["   "])).toEqual([]);
    expect(encontrarOcorrencias("qualquer texto", [])).toEqual([]);
    expect(trechos("um texto", ["", "texto", "  "])).toEqual(["texto"]);
  });

  it("acha todas as ocorrências, em ordem, e o termo mais longo vence o pedaço", () => {
    expect(trechos("Voraz. voraz! VORAZ?", ["voraz"])).toEqual(["Voraz", "voraz", "VORAZ"]);
    expect(trechos("ao léu, só léu", ["léu", "ao léu"])).toEqual(["ao léu", "léu"]);
  });

  it("ligadura tipográfica do PDF não esconde a palavra", () => {
    expect(trechos("é preciso deﬁnir", ["definir"])).toEqual(["deﬁnir"]);
  });

  it("caractere especial de regex no termo é literal", () => {
    expect(trechos("usa c++ e c", ["c++"])).toEqual(["c++"]);
  });

  it("hífen opcional e caracteres de largura zero do EPUB hifenizado não partem a palavra, e o trecho cobre a palavra inteira", () => {
    expect(encontrarOcorrencias("o lobo vo­raz corre", ["voraz"])).toEqual([{ inicio: 7, fim: 13 }]);
    for (const invisivel of ["­", "​", "‌", "‍", "⁠"]) {
      expect(trechos(`o vo${invisivel}raz lobo`, ["voraz"])).toEqual([`vo${invisivel}raz`]);
    }
    // O termo colhido de uma seleção hifenizada carrega o mesmo hífen invisível.
    expect(trechos("o lobo voraz", ["vo­raz"])).toEqual(["voraz"]);
  });

  it("sigma final grego casa nos dois sentidos de caixa", () => {
    const texto = "ο ΛΟΓΟΣ και ο λόγος";
    expect(trechos(texto, ["λόγος"])).toEqual(["ΛΟΓΟΣ", "λόγος"]);
    expect(trechos(texto, ["ΛΟΓΟΣ"])).toEqual(["ΛΟΓΟΣ", "λόγος"]);
  });
});

describe("aplicarMarcacao", () => {
  const janela = document.defaultView;
  const cssOriginal = Object.getOwnPropertyDescriptor(janela ?? {}, "CSS");
  const highlightOriginal = Object.getOwnPropertyDescriptor(janela ?? {}, "Highlight");

  afterEach(() => {
    if (!janela) return;
    if (cssOriginal) Object.defineProperty(janela, "CSS", cssOriginal);
    else Reflect.deleteProperty(janela, "CSS");
    if (highlightOriginal) Object.defineProperty(janela, "Highlight", highlightOriginal);
    else Reflect.deleteProperty(janela, "Highlight");
    document.getElementById("learno-vocabulario-estilo")?.remove();
    document.body.replaceChildren();
  });

  /** O jsdom não implementa a CSS Custom Highlight API; isto é o mínimo dela que `aplicarMarcacao` usa, posto na janela `alvo` (a de cima, por padrão). */
  function instalarApiFalsa(alvo: Window | null = janela): Map<string, Set<AbstractRange>> {
    if (!alvo) throw new Error("o jsdom deveria ter document.defaultView");
    const registro = new Map<string, Set<AbstractRange>>();
    Object.defineProperty(alvo, "CSS", { configurable: true, value: { highlights: registro } });
    Object.defineProperty(alvo, "Highlight", { configurable: true, value: class extends Set<AbstractRange> {} });
    return registro;
  }

  function montarParagrafo(texto: string): HTMLElement {
    const paragrafo = document.createElement("p");
    paragrafo.textContent = texto;
    document.body.append(paragrafo);
    return paragrafo;
  }

  it("sem a API (jsdom puro) não faz nada e não quebra", () => {
    const raiz = montarParagrafo("o lobo voraz");
    expect(() => aplicarMarcacao(raiz, ["voraz"])).not.toThrow();
    expect(() => limparMarcacao(document)).not.toThrow();
    expect(document.getElementById("learno-vocabulario-estilo")).toBeNull();
  });

  it("registra um Highlight com um Range por ocorrência, sem mexer no DOM, e injeta o estilo uma vez só", () => {
    const registro = instalarApiFalsa();
    const raiz = montarParagrafo("Voraz, o lobo voraz comia vorazmente");
    const htmlAntes = raiz.innerHTML;

    aplicarMarcacao(raiz, ["voraz"]);
    aplicarMarcacao(raiz, ["voraz"]);

    const marcacao = registro.get(NOME_DA_MARCACAO);
    if (!marcacao) throw new Error("nenhum Highlight registrado");
    expect([...marcacao].map((intervalo) => `${intervalo.startOffset}-${intervalo.endOffset}`)).toEqual(["0-5", "14-19"]);
    expect(raiz.innerHTML).toBe(htmlAntes);
    expect(document.querySelectorAll("#learno-vocabulario-estilo")).toHaveLength(1);
    expect(document.getElementById("learno-vocabulario-estilo")?.textContent).toContain("text-decoration-color: #b5771c");
  });

  it("documento de iframe (seção do EPUB): registra e injeta o estilo na janela DO IFRAME, nunca na de cima", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const docDoIframe = iframe.contentDocument;
    if (!docDoIframe) throw new Error("o jsdom deveria dar um contentDocument ao iframe montado");
    const registroDoIframe = instalarApiFalsa(iframe.contentWindow);
    // A de cima TAMBÉM tem a API: se a marcação fosse para a janela errada, este registro a receberia.
    const registroDeCima = instalarApiFalsa();
    const paragrafo = docDoIframe.createElement("p");
    paragrafo.textContent = "o lobo voraz";
    docDoIframe.body.append(paragrafo);

    aplicarMarcacao(paragrafo, ["voraz"]);

    const marcacao = registroDoIframe.get(NOME_DA_MARCACAO);
    if (!marcacao) throw new Error("nenhum Highlight registrado na janela do iframe");
    expect([...marcacao].map((intervalo) => `${intervalo.startOffset}-${intervalo.endOffset}`)).toEqual(["7-12"]);
    expect(registroDeCima.has(NOME_DA_MARCACAO)).toBe(false);
    expect(docDoIframe.getElementById("learno-vocabulario-estilo")).not.toBeNull();
    expect(document.getElementById("learno-vocabulario-estilo")).toBeNull();
  });

  it("lista vazia apaga a marcação; limparMarcacao também", () => {
    const registro = instalarApiFalsa();
    const raiz = montarParagrafo("o lobo voraz");

    aplicarMarcacao(raiz, ["voraz"]);
    expect(registro.has(NOME_DA_MARCACAO)).toBe(true);
    aplicarMarcacao(raiz, []);
    expect(registro.has(NOME_DA_MARCACAO)).toBe(false);

    aplicarMarcacao(raiz, ["voraz"]);
    limparMarcacao(document);
    expect(registro.has(NOME_DA_MARCACAO)).toBe(false);
  });
});
