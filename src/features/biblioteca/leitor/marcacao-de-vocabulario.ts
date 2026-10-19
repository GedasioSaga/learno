/**
 * Sublinha no texto do livro as palavras colhidas no vocabulário (marcador
 * ligado no `PainelDeVocabulario`). Duas metades:
 *
 * - `encontrarOcorrencias` é pura: acha a palavra INTEIRA num texto, sem
 *   ligar para caixa nem acento, e devolve os índices do texto ORIGINAL;
 * - `aplicarMarcacao` usa a CSS Custom Highlight API: monta `Range`s sobre os
 *   nós de texto e registra UM `Highlight` chamado `learno-vocabulario`. Nada
 *   no DOM do livro muda (nenhum `<mark>`, nenhum `<span>` novo) — é isso que
 *   mantém de pé os CFIs de seleção e de anotação do epub.js, que contam nós,
 *   e a camada de texto do PDF, que o pdf.js recria a cada página.
 *
 * Limitação aceita: a busca roda nó de texto por nó de texto. Palavra partida
 * entre dois nós (um `<em>` no meio dela, um span do PDF por pedaço) ou
 * hifenizada na quebra de linha do PDF ("vo-" / "raz") não é marcada.
 */

/** O nome no registro `CSS.highlights` — e o argumento do `::highlight()` no estilo. */
export const NOME_DA_MARCACAO = "learno-vocabulario";

const ID_DO_ESTILO = "learno-vocabulario-estilo";

/**
 * Explícita, nunca `currentColor`: o texto da camada do PDF é transparente
 * (`text-layer.css`), e um sublinhado que herdasse a cor do texto sumiria
 * junto. Também não dá para usar token do tema: o iframe do EPUB é outro
 * documento e não enxerga as variáveis de `theme.css`.
 *
 * `#b5771c` é o `--amber` do tema claro. Amarelo-escuro, e não vermelho, de
 * propósito: sublinhado ondulado vermelho já quer dizer "erro de ortografia"
 * em todo editor. Contraste de elemento não-textual (WCAG 1.4.11 pede 3:1):
 * ~3,7:1 sobre o branco da página e ~4,5:1 sobre `#1e1e1e` — legível em livro
 * claro e em livro de fundo escuro.
 */
const COR_DO_SUBLINHADO = "#b5771c";

const REGRA_DO_ESTILO =
  `::highlight(${NOME_DA_MARCACAO}) {` +
  " text-decoration-line: underline;" +
  " text-decoration-style: wavy;" +
  ` text-decoration-color: ${COR_DO_SUBLINHADO};` +
  " text-decoration-thickness: 1.5px;" +
  " text-underline-offset: 3px; }";

/** Um trecho `[inicio, fim)` em índices de code unit do texto original — o que `Range.setStart`/`setEnd` esperam. */
export interface Ocorrencia {
  inicio: number;
  fim: number;
}

const MARCA_COMBINANTE = /\p{M}/gu;
const ESPACOS = /\s+/gu;
/**
 * Invisíveis que moram DENTRO da palavra: o hífen opcional (U+00AD, o `&shy;`
 * de EPUB hifenizado), o espaço de largura zero (U+200B), o não-junção e a
 * junção de largura zero (U+200C, U+200D) e o "word joiner" (U+2060). Sem
 * tirá-los, "vo&shy;raz" seriam duas palavras e "voraz" nunca casaria.
 */
const INVISIVEIS_NA_PALAVRA = /[­​-‍⁠]/gu;
/**
 * O sigma final (U+03C2) vira sigma comum (U+03C3). `toLowerCase` só produz o
 * final no fim de palavra da string INTEIRA: o termo é baixado de uma vez e o
 * texto do livro caractere a caractere, e "ΛΟΓΟΣ" viraria "λογοσ" de um lado
 * e "λογος" do outro.
 */
const SIGMA_FINAL = /ς/gu;
const SIGMA = "σ";
/** Fronteira de palavra: qualquer coisa que NÃO seja letra, marca ou número. "vorazmente" não contém "voraz". */
const CARACTERE_DE_PALAVRA = "[\\p{L}\\p{M}\\p{N}]";

/** Minúsculas, NFKD, sem acento e sem invisível — a parte comum ao termo (string inteira) e ao texto (caractere a caractere). */
function formaComparavel(texto: string): string {
  return texto
    .toLowerCase()
    .replace(SIGMA_FINAL, SIGMA)
    .normalize("NFKD")
    .replace(MARCA_COMBINANTE, "")
    .replace(INVISIVEIS_NA_PALAVRA, "");
}

/**
 * A forma comparável de um texto: minúsculas, NFKD sem acento, sem os
 * invisíveis de dentro da palavra e espaços colapsados. NFKD (e não NFD) também
 * desfaz ligaduras tipográficas comuns em PDF — "ﬁ" vira "fi" —, então
 * "definir" acha "deﬁnir".
 */
export function normalizarParaComparar(texto: string): string {
  return formaComparavel(texto).replace(ESPACOS, " ").trim();
}

/**
 * O texto normalizado e, para cada code unit dele, de onde veio no original.
 * Um caractere pode virar vários (ligadura, "é" decomposto) ou nenhum (acento
 * solto de um texto que já chegou em NFD); o mapa é o que deixa devolver
 * índices do ORIGINAL mesmo assim.
 */
interface TextoComMapa {
  texto: string;
  inicioOriginal: number[];
  fimOriginal: number[];
}

function normalizarComMapa(original: string): TextoComMapa {
  let texto = "";
  const inicioOriginal: number[] = [];
  const fimOriginal: number[] = [];
  let posicao = 0;
  // `for...of` anda por code point, nunca parte um par substituto ao meio.
  for (const caractere of original) {
    const fim = posicao + caractere.length;
    const normalizado = formaComparavel(caractere);
    if (normalizado === "") {
      // Acento solto (texto em NFD) ou invisível de dentro da palavra:
      // pertence à letra de antes, e o trecho marcado precisa incluí-lo —
      // senão "café" sublinharia "cafe" e deixaria o acento de fora.
      if (fimOriginal.length > 0) fimOriginal[fimOriginal.length - 1] = fim;
    } else {
      for (let i = 0; i < normalizado.length; i += 1) {
        inicioOriginal.push(posicao);
        fimOriginal.push(fim);
      }
      texto += normalizado;
    }
    posicao = fim;
  }
  return { texto, inicioOriginal, fimOriginal };
}

function escaparParaRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Uma expressão só para todos os termos, guardada pela IDENTIDADE da lista:
 * `aplicarMarcacao` chama `encontrarOcorrencias` uma vez por nó de texto com
 * a mesma lista, e recompilar a cada nó seria o custo inteiro da varredura.
 */
const expressoesPorLista = new WeakMap<readonly string[], RegExp | null>();

function expressaoDosTermos(termos: readonly string[]): RegExp | null {
  const guardada = expressoesPorLista.get(termos);
  if (guardada !== undefined) return guardada;

  const alternativas = [...new Set(termos.map(normalizarParaComparar).filter((termo) => termo !== ""))]
    // O mais longo primeiro: com "ao léu" e "léu" marcados, a alternância
    // casa a expressão inteira em vez de parar no pedaço.
    .sort((a, b) => b.length - a.length)
    // Termo de várias palavras: qualquer espaço entre elas, inclusive quebra de linha.
    .map((termo) => termo.split(" ").map(escaparParaRegex).join("\\s+"));

  const expressao =
    alternativas.length === 0
      ? null
      : new RegExp(`(?<!${CARACTERE_DE_PALAVRA})(?:${alternativas.join("|")})(?!${CARACTERE_DE_PALAVRA})`, "gu");
  expressoesPorLista.set(termos, expressao);
  return expressao;
}

/** Toda ocorrência da palavra inteira de qualquer um dos `termos` em `texto`, em ordem. Termo vazio ou só espaço é ignorado. */
export function encontrarOcorrencias(texto: string, termos: readonly string[]): Ocorrencia[] {
  const expressao = expressaoDosTermos(termos);
  if (!expressao || texto === "") return [];

  const normalizado = normalizarComMapa(texto);
  const ocorrencias: Ocorrencia[] = [];
  // `matchAll` trabalha numa cópia da expressão: o `lastIndex` da guardada no cache nunca anda.
  for (const achado of normalizado.texto.matchAll(expressao)) {
    const inicio = achado.index;
    if (inicio === undefined) continue;
    const ultimo = inicio + achado[0].length - 1;
    ocorrencias.push({ inicio: normalizado.inicioOriginal[inicio], fim: normalizado.fimOriginal[ultimo] });
  }
  return ocorrencias;
}

interface ApiDeMarcacao {
  registro: HighlightRegistry;
  criar: () => Highlight;
}

/**
 * O registro e o construtor da JANELA DONA do documento — no EPUB, a do
 * iframe de conteúdo; um `Highlight` registrado na janela errada não pinta
 * nada. `null` quando a API não existe (jsdom do vitest, WebView antiga).
 */
function apiDeMarcacao(doc: Document): ApiDeMarcacao | null {
  const janela = doc.defaultView;
  if (!janela) return null;
  // Tipos alargados de propósito: o lib.dom declara `CSS.highlights` e
  // `Highlight` como sempre presentes, e é justamente a ausência deles que
  // este teste precisa enxergar.
  const css: typeof CSS | undefined = janela.CSS;
  const registro: HighlightRegistry | undefined = css?.highlights;
  const ConstrutorDeHighlight: typeof Highlight | undefined = janela.Highlight;
  if (!registro || !ConstrutorDeHighlight) return null;
  return { registro, criar: () => new ConstrutorDeHighlight() };
}

/** Uma vez por documento: o EPUB troca de documento a cada seção, o PDF usa sempre o mesmo. */
function injetarEstilo(doc: Document): void {
  if (doc.getElementById(ID_DO_ESTILO)) return;
  const estilo = doc.createElement("style");
  estilo.id = ID_DO_ESTILO;
  estilo.textContent = REGRA_DO_ESTILO;
  // `head` pode faltar num XHTML de EPUB mal formado, apesar do tipo dizer que não.
  const cabeca: HTMLHeadElement | null = doc.head;
  (cabeca ?? doc.documentElement).appendChild(estilo);
}

/**
 * Sublinha, dentro de `raiz`, toda ocorrência dos `termos`. Substitui a
 * marcação anterior do mesmo documento inteira — chamar de novo com a lista
 * nova é o jeito de atualizar; lista vazia apaga. Sem a API, não faz nada.
 */
export function aplicarMarcacao(raiz: Element, termos: readonly string[]): void {
  const doc = raiz.ownerDocument;
  const api = apiDeMarcacao(doc);
  if (!api) return;

  if (!expressaoDosTermos(termos)) {
    api.registro.delete(NOME_DA_MARCACAO);
    return;
  }

  injetarEstilo(doc);
  const marcacao = api.criar();
  const caminhante = doc.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  for (let no = caminhante.nextNode(); no; no = caminhante.nextNode()) {
    const texto = no.nodeValue;
    if (!texto) continue;
    for (const { inicio, fim } of encontrarOcorrencias(texto, termos)) {
      const intervalo = doc.createRange();
      intervalo.setStart(no, inicio);
      intervalo.setEnd(no, fim);
      marcacao.add(intervalo);
    }
  }
  api.registro.set(NOME_DA_MARCACAO, marcacao);
}

/** Tira a marcação do documento — quem desmonta o leitor chama, para os `Range`s não segurarem nós que já saíram da tela. */
export function limparMarcacao(doc: Document): void {
  apiDeMarcacao(doc)?.registro.delete(NOME_DA_MARCACAO);
}
