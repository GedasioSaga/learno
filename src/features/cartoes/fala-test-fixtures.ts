/**
 * Fixtures compartilhados pelos testes de `fala.ts` e `LeitorDeVoz.tsx` — não
 * termina em `.test.ts`, então o vitest não o coleta como suíte própria, só
 * como helper importado pelas duas.
 *
 * jsdom não implementa a Web Speech API (nem `speechSynthesis`, nem
 * `SpeechSynthesisUtterance`) — é o próprio pedido desta peça que avisa disso.
 * As duas classes abaixo implementam só a fatia da API que `fala.ts` usa,
 * como classe real (`implements SpeechSynthesis` / `implements
 * SpeechSynthesisUtterance`, herdando `EventTarget` para `addEventListener`),
 * para não precisar de `as`/`any` nenhum instalando os globais em teste.
 */

export function criarVoz(overrides: Partial<SpeechSynthesisVoice> = {}): SpeechSynthesisVoice {
  return {
    default: false,
    lang: "pt-BR",
    localService: true,
    name: "Voz de teste",
    voiceURI: "voz-de-teste",
    ...overrides,
  };
}

export class UtteranceFalsa extends EventTarget implements SpeechSynthesisUtterance {
  lang = "";
  onboundary = null;
  onend = null;
  onerror = null;
  onmark = null;
  onpause = null;
  onresume = null;
  onstart = null;
  pitch = 1;
  rate = 1;
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;

  constructor(text = "") {
    super();
    this.text = text;
  }
}

/** Instala `globalThis.SpeechSynthesisUtterance` — o construtor que `fala.ts` chama com `new`. */
export function instalarUtteranceFalsa(): void {
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    value: UtteranceFalsa,
    writable: true,
    configurable: true,
  });
}

export class SpeechSynthesisFalsa extends EventTarget implements SpeechSynthesis {
  onvoiceschanged: ((this: SpeechSynthesis, ev: Event) => unknown) | null = null;
  paused = false;
  pending = false;
  speaking = false;
  readonly chamadasDeSpeak: SpeechSynthesisUtterance[] = [];
  chamadasDeCancel = 0;
  private vozesAtuais: SpeechSynthesisVoice[];

  constructor(vozesIniciais: SpeechSynthesisVoice[] = []) {
    super();
    this.vozesAtuais = vozesIniciais;
  }

  cancel(): void {
    this.chamadasDeCancel += 1;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.vozesAtuais;
  }

  pause(): void {}

  resume(): void {}

  speak(utterance: SpeechSynthesisUtterance): void {
    this.chamadasDeSpeak.push(utterance);
  }

  /** Simula o SO terminando de carregar a lista — dispara `voiceschanged`, como o navegador real faz. */
  definirVozes(vozes: SpeechSynthesisVoice[]): void {
    this.vozesAtuais = vozes;
    this.dispatchEvent(new Event("voiceschanged"));
  }
}

/** Instala `window.speechSynthesis` falso e devolve a instância, para inspecionar chamadas no teste. */
export function instalarSpeechSynthesisFalsa(vozesIniciais: SpeechSynthesisVoice[] = []): SpeechSynthesisFalsa {
  const falsa = new SpeechSynthesisFalsa(vozesIniciais);
  Object.defineProperty(window, "speechSynthesis", { value: falsa, writable: true, configurable: true });
  return falsa;
}

/**
 * Remove `window.speechSynthesis` de fato (não só zera o valor) — para testar
 * o caminho "API indisponível" de `falaDisponivel`, que checa `"speechSynthesis"
 * in window`. `Reflect.deleteProperty` aceita qualquer `object` por
 * assinatura, então tira a propriedade sem precisar de `as`/`any` para
 * contornar o tipo `readonly` que `Window` declara para ela.
 */
export function removerSpeechSynthesis(): void {
  Reflect.deleteProperty(window, "speechSynthesis");
}
