import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import {
  criarVoz,
  instalarSpeechSynthesisFalsa,
  instalarUtteranceFalsa,
  removerSpeechSynthesis,
  type SpeechSynthesisFalsa,
} from "./fala-test-fixtures";
import { LeitorDeVoz } from "./LeitorDeVoz";
import { usePreferenciasDeVozStore } from "./preferencias-de-voz";

const DECK_ID = "deck-1";

beforeEach(() => {
  localStorage.clear();
  usePreferenciasDeVozStore.setState({ porBaralho: {} });
  instalarUtteranceFalsa();
});

afterEach(() => {
  removerSpeechSynthesis();
});

function definirPreferencias(idioma: string, vozURI: string | null = null, falarAutomaticamente = false) {
  usePreferenciasDeVozStore.getState().definirIdioma(DECK_ID, idioma);
  if (vozURI) usePreferenciasDeVozStore.getState().definirVoz(DECK_ID, vozURI);
  if (falarAutomaticamente) usePreferenciasDeVozStore.getState().alternarFalarAutomaticamente(DECK_ID);
}

describe("LeitorDeVoz — botão Ouvir", () => {
  it("chama falar com o TEXTO da frente e o IDIOMA da preferência, antes de revelar", () => {
    definirPreferencias("en-US");
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "en-US", voiceURI: "zira", name: "Zira" })]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Hello, world" verso="" revelado={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir" }));

    expect(falsa.chamadasDeSpeak).toHaveLength(1);
    expect(falsa.chamadasDeSpeak[0]?.text).toBe("Hello, world");
    expect(falsa.chamadasDeSpeak[0]?.lang).toBe("en-US");
  });

  it("depois de revelado, lê frente E verso concatenados", () => {
    definirPreferencias("en-US");
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "en-US" })]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Hello" verso="Olá" revelado={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir" }));

    expect(falsa.chamadasDeSpeak[0]?.text).toBe("Hello. Olá");
  });
});

describe("LeitorDeVoz — clicar Ouvir de novo com a fala anterior ainda rodando", () => {
  it("cancela antes de falar de novo, mesmo padrão do efeito de troca de cartão — sem isto, o segundo clique ENFILEIRA em vez de substituir", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    // Log ordenado local ao teste (não mexe na fixture compartilhada com
    // fala.test.ts): `chamadasDeCancel`/`chamadasDeSpeak` só contam, não
    // provam ORDEM — é a ordem que este teste existe para travar. Os spies
    // chamam a implementação real por trás (`cancelOriginal`/`speakOriginal`)
    // para não quebrar os contadores que os outros `expect` abaixo usam.
    const eventos: Array<"cancel" | "speak"> = [];
    const cancelOriginal = falsa.cancel.bind(falsa);
    const speakOriginal = falsa.speak.bind(falsa);
    vi.spyOn(falsa, "cancel").mockImplementation(() => {
      eventos.push("cancel");
      cancelOriginal();
    });
    vi.spyOn(falsa, "speak").mockImplementation((utterance) => {
      eventos.push("speak");
      speakOriginal(utterance);
    });

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />);
    const botao = screen.getByRole("button", { name: "Ouvir" });
    eventos.length = 0; // ignora o cancel do efeito de montagem — o teste é sobre o clique

    fireEvent.click(botao);
    fireEvent.click(botao);

    // Prova a ORDEM (cancelar antes de falar, nos dois cliques) e o
    // CONTEÚDO do segundo `speak()` — as duas coisas que a versão anterior
    // deste teste não distinguia de `falar(); pararFala()`.
    expect(eventos).toEqual(["cancel", "speak", "cancel", "speak"]);
    expect(falsa.chamadasDeSpeak).toHaveLength(2);
    expect(falsa.chamadasDeSpeak[1]?.text).toBe("Olá");
  });
});

describe("LeitorDeVoz — trocar de cartão", () => {
  it("virar de cartão chama cancel, para não sobrepor o cartão anterior", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    const { rerender } = render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Um" verso="" revelado={false} />);
    const cancelamentosNoMount = falsa.chamadasDeCancel;

    rerender(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-2" frente="Dois" verso="" revelado={false} />);

    expect(falsa.chamadasDeCancel).toBeGreaterThan(cancelamentosNoMount);
  });
});

describe("LeitorDeVoz — falar automaticamente", () => {
  it("DESLIGADO por padrão: um cartão novo não fala sozinho", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Um" verso="" revelado={false} />);

    expect(falsa.chamadasDeSpeak).toHaveLength(0);
  });

  it("ligado, lê a frente sozinho a cada cartão novo", () => {
    definirPreferencias("pt-BR", null, true);
    const falsa = instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    const { rerender } = render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Um" verso="" revelado={false} />);
    expect(falsa.chamadasDeSpeak).toHaveLength(1);
    expect(falsa.chamadasDeSpeak[0]?.text).toBe("Um");

    rerender(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-2" frente="Dois" verso="" revelado={false} />);
    expect(falsa.chamadasDeSpeak).toHaveLength(2);
    expect(falsa.chamadasDeSpeak[1]?.text).toBe("Dois");
  });
});

describe("LeitorDeVoz — sem voz para o idioma escolhido", () => {
  it("avisa em vez de deixar o botão mudo, e desabilita o botão", () => {
    definirPreferencias("en-US");
    // Só português instalado — nenhuma voz para o inglês escolhido.
    instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Hello" verso="" revelado={false} />);

    expect(screen.getByRole("status")).toHaveTextContent(/Nenhuma voz instalada/);
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeDisabled();
  });

  it("com voz instalada para o idioma, não mostra aviso e o botão fica habilitado", () => {
    definirPreferencias("pt-BR");
    instalarSpeechSynthesisFalsa([criarVoz({ lang: "pt-BR" })]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeEnabled();
  });
});

describe("LeitorDeVoz — lista de vozes vazia na primeira chamada", () => {
  it("é recuperada depois do voiceschanged, sem exigir remontar o componente", () => {
    definirPreferencias("pt-BR");
    // getVoices() vazio de início — exatamente a corrida descrita no pedido:
    // o SO ainda não terminou de carregar a lista quando o componente monta.
    const falsa: SpeechSynthesisFalsa = instalarSpeechSynthesisFalsa([]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Nenhuma voz instalada/);
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeDisabled();

    act(() => {
      falsa.definirVozes([criarVoz({ lang: "pt-BR", voiceURI: "maria", name: "Maria" })]);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeEnabled();
  });
});

describe("LeitorDeVoz — lista de vozes vazia sem o evento voiceschanged disparar (WebView2/Chromium não são confiáveis nisso)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconsulta a lista sozinha em intervalo curto e se recupera mesmo sem o evento", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />);
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeDisabled();

    // Muda a lista "por baixo" sem passar por `definirVozes` (que dispara
    // `voiceschanged`) — é exatamente o cenário em que o evento não dispara.
    // `Reflect.set` em vez de `as`/`any`: o campo é `private` só em tempo de
    // compilação, e o alvo de `Reflect.set` é tipado como `object`.
    Reflect.set(falsa, "vozesAtuais", [criarVoz({ lang: "pt-BR", voiceURI: "maria", name: "Maria" })]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeEnabled();
  });

  it("esgotadas as tentativas automáticas sem achar voz, o botão Atualizar vozes recupera manualmente", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([]);

    render(<LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeDisabled();

    Reflect.set(falsa, "vozesAtuais", [criarVoz({ lang: "pt-BR", voiceURI: "maria", name: "Maria" })]);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar vozes" }));

    expect(screen.getByRole("button", { name: "Ouvir" })).toBeEnabled();
  });

  it("desmontar limpa o temporizador de reconsulta E cancela a assinatura de voiceschanged, sem deixar polling nem listener correndo à toa", () => {
    definirPreferencias("pt-BR");
    const falsa = instalarSpeechSynthesisFalsa([]);
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    // A fixture herda `EventTarget`, então o spy funciona sem cast — prova
    // que o cleanup do `useEffect` chama `cancelarAssinatura()` de fato, não
    // só `clearInterval`. Sem isto, remover a linha `cancelarAssinatura();`
    // do cleanup (LeitorDeVoz.tsx) deixa a suíte inteira passando do mesmo
    // jeito, com o listener antigo vivo sobre um componente já desmontado.
    const removeEventListenerSpy = vi.spyOn(falsa, "removeEventListener");

    const { unmount } = render(
      <LeitorDeVoz deckId={DECK_ID} cartaoId="card-1" frente="Olá" verso="" revelado={false} />,
    );
    const chamadasAntesDeDesmontar = clearIntervalSpy.mock.calls.length;

    unmount();

    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(chamadasAntesDeDesmontar);
    expect(removeEventListenerSpy).toHaveBeenCalledWith("voiceschanged", expect.any(Function));
  });
});
