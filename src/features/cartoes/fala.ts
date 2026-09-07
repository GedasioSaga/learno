/**
 * Wrapper fino sobre `window.speechSynthesis` (Web Speech API) — a síntese de
 * voz que o próprio WebView2 já traz: local, offline, sem chave de API e sem
 * mandar o texto do usuário para lugar nenhum. Não é permitido instalar nada
 * para esta peça; é por isto que ela existe.
 *
 * Duas armadilhas da API, e por que cada função aqui existe:
 *
 * 1. `getVoices()` costuma devolver `[]` na primeira chamada — a lista real só
 *    é populada depois do evento `voiceschanged`, de forma assíncrona e sem
 *    prazo (varia por SO). `assinarVozes` existe para isso: quem precisa da
 *    lista assina o evento em vez de confiar numa chamada só (ver
 *    `useVozesDisponiveis`, o hook que usa isto).
 * 2. Não existe erro quando não há voz para o idioma escolhido — `speak()`
 *    simplesmente não emite som, silenciosamente. `vozesParaIdioma` é o que
 *    permite detectar isso ANTES de chamar `falar`, para avisar o usuário em
 *    vez de deixar um botão mudo (ver `LeitorDeVoz`).
 */

/** `false` num navegador/WebView sem a API — motivo real de silêncio, distinto de "sem voz instalada". */
export function falaDisponivel(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Pode vir vazio na primeira chamada mesmo com vozes instaladas — ver o ponto 1 acima. */
export function obterVozes(): SpeechSynthesisVoice[] {
  if (!falaDisponivel()) return [];
  return window.speechSynthesis.getVoices();
}

/**
 * Assina o evento `voiceschanged` — dispara `callback` quando a lista de
 * vozes do sistema muda, inclusive na primeira vez que ela é populada de
 * fato. Devolve a função de cancelamento, no mesmo formato de um `useEffect`.
 * Num ambiente sem a API, devolve um cancelamento que não faz nada, em vez de
 * lançar.
 */
export function assinarVozes(callback: () => void): () => void {
  if (!falaDisponivel()) return () => {};
  window.speechSynthesis.addEventListener("voiceschanged", callback);
  // A checagem de novo dentro do cancelamento (não só na assinatura) importa
  // porque o cancelamento roda depois, possivelmente numa tela que já saiu
  // do ar — não dá para assumir que o mesmo estado de `falaDisponivel()` de
  // agora ainda vale lá na frente.
  return () => {
    if (falaDisponivel()) window.speechSynthesis.removeEventListener("voiceschanged", callback);
  };
}

/** Primeiro subtag do BCP-47 ("en" de "en-US") — compara idioma sem exigir a região exata. */
function subtagPrincipal(idioma: string): string {
  return idioma.split("-")[0]?.toLowerCase() ?? idioma.toLowerCase();
}

/** As vozes instaladas que atendem o idioma pedido, comparando só o subtag principal. */
export function vozesParaIdioma(vozes: readonly SpeechSynthesisVoice[], idioma: string): SpeechSynthesisVoice[] {
  const alvo = subtagPrincipal(idioma);
  return vozes.filter((voz) => subtagPrincipal(voz.lang) === alvo);
}

export interface OpcoesDeFala {
  idioma: string;
  /** `voiceURI` da voz escolhida como preferência, ou `null` para a primeira voz do idioma. */
  vozURI: string | null;
}

/**
 * Fala `texto` na voz escolhida (ou a primeira disponível para o idioma, se
 * `vozURI` for `null` ou não bater com nenhuma voz instalada). Não faz nada
 * se a API está indisponível, o texto é vazio, ou não há voz nenhuma para o
 * idioma — quem chama já deveria ter avisado o usuário desse último caso via
 * `vozesParaIdioma` antes de oferecer o botão.
 */
export function falar(texto: string, opcoes: OpcoesDeFala): void {
  if (!falaDisponivel() || texto.trim() === "") return;
  const candidatas = vozesParaIdioma(obterVozes(), opcoes.idioma);
  if (candidatas.length === 0) return;
  const voz = candidatas.find((item) => item.voiceURI === opcoes.vozURI) ?? candidatas[0];

  const utterance = new SpeechSynthesisUtterance(texto);
  utterance.lang = opcoes.idioma;
  utterance.voice = voz;
  window.speechSynthesis.speak(utterance);
}

/** Interrompe qualquer fala em andamento — chamado ao virar de cartão ou sair da tela. */
export function pararFala(): void {
  if (!falaDisponivel()) return;
  window.speechSynthesis.cancel();
}
