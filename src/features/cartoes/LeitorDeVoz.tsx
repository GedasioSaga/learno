import { useEffect, useState } from "react";
import { assinarVozes, falaDisponivel, falar, obterVozes, pararFala, vozesParaIdioma } from "./fala";
import { usePreferenciasDeVoz, usePreferenciasDeVozStore } from "./preferencias-de-voz";

/**
 * Idiomas oferecidos no seletor. Fixo e curto de propósito: o app não sabe
 * de antemão que idiomas o SO tem voz instalada (isso só se descobre em
 * runtime, via `obterVozes`), então a lista aqui é só "o que o usuário pode
 * pedir" — a lista de vozes filtrada por `vozesParaIdioma` é quem decide se o
 * pedido tem som atrás.
 */
const IDIOMAS_SUPORTADOS: readonly { codigo: string; rotulo: string }[] = [
  { codigo: "pt-BR", rotulo: "Português (Brasil)" },
  { codigo: "en-US", rotulo: "Inglês (Estados Unidos)" },
  { codigo: "en-GB", rotulo: "Inglês (Reino Unido)" },
  { codigo: "es-ES", rotulo: "Espanhol" },
  { codigo: "fr-FR", rotulo: "Francês" },
  { codigo: "de-DE", rotulo: "Alemão" },
  { codigo: "it-IT", rotulo: "Italiano" },
  { codigo: "ja-JP", rotulo: "Japonês" },
];

/** Tentativas de reconsulta depois da montagem, se a lista chegar vazia. */
const TENTATIVAS_DE_RECONSULTA = 5;
/** Intervalo entre reconsultas — curto o bastante para não fazer o usuário esperar. */
const INTERVALO_DE_RECONSULTA_MS = 400;

/**
 * A lista de vozes do sistema. Começa com o que `obterVozes()` já tiver (pode
 * ser `[]`) e tenta se recuperar de duas formas independentes, porque nenhuma
 * das duas é confiável sozinha:
 *
 * 1. O evento `voiceschanged` do `fala.ts`, quando ele dispara.
 * 2. Reconsulta ativa por `TENTATIVAS_DE_RECONSULTA` vezes a cada
 *    `INTERVALO_DE_RECONSULTA_MS` — WebView2 e Chromium têm histórico de
 *    nunca disparar `voiceschanged`, e sem isto a lista ficaria vazia para
 *    sempre mesmo com voz instalada no SO. Para assim que achar voz ou
 *    esgotar as tentativas.
 *
 * `revalidar` cobre o resto: se mesmo assim a lista continuar vazia (SO
 * particularmente lento, ou os dois caminhos acima falharam), dá para o
 * usuário pedir de novo com um clique em vez de ficar bloqueado sem saída.
 */
function useVozesDoSistema(): { vozes: SpeechSynthesisVoice[]; revalidar: () => void } {
  const [vozes, setVozes] = useState<SpeechSynthesisVoice[]>(() => obterVozes());

  useEffect(() => {
    const atualizar = () => setVozes(obterVozes());
    atualizar();
    const cancelarAssinatura = assinarVozes(atualizar);

    let tentativas = 0;
    const temporizador = window.setInterval(() => {
      tentativas += 1;
      const encontradas = obterVozes();
      if (encontradas.length > 0) {
        setVozes(encontradas);
        window.clearInterval(temporizador);
        return;
      }
      if (tentativas >= TENTATIVAS_DE_RECONSULTA) {
        window.clearInterval(temporizador);
      }
    }, INTERVALO_DE_RECONSULTA_MS);

    return () => {
      cancelarAssinatura();
      window.clearInterval(temporizador);
    };
  }, []);

  const revalidar = () => setVozes(obterVozes());

  return { vozes, revalidar };
}

interface LeitorDeVozProps {
  /** Dono da preferência de idioma/voz — cada baralho guarda a sua. */
  deckId: string;
  /** Muda a cada cartão novo: é o gatilho para parar a fala anterior e, se ligado, falar a nova. */
  cartaoId: string;
  frente: string;
  /** Campos do verso já concatenados em texto corrido; vazio antes de revelar. */
  verso: string;
  revelado: boolean;
}

/**
 * Botão "Ouvir" + configuração de idioma/voz/fala automática da Sessão de
 * Estudo. Usa só `window.speechSynthesis` (Web Speech API do WebView2) — sem
 * dependência nova, sem chave de API, sem nada saindo da máquina.
 */
export function LeitorDeVoz({ deckId, cartaoId, frente, verso, revelado }: LeitorDeVozProps) {
  const preferencias = usePreferenciasDeVoz(deckId);
  const definirIdioma = usePreferenciasDeVozStore((state) => state.definirIdioma);
  const definirVoz = usePreferenciasDeVozStore((state) => state.definirVoz);
  const alternarFalarAutomaticamente = usePreferenciasDeVozStore((state) => state.alternarFalarAutomaticamente);
  const { vozes, revalidar } = useVozesDoSistema();

  const vozesDoIdioma = vozesParaIdioma(vozes, preferencias.idioma);
  const semVoz = falaDisponivel() && vozesDoIdioma.length === 0;

  // Trocar de cartão para de falar o anterior (o pedido explícito desta
  // peça) e, se "falar automaticamente" está ligado, lê a frente do novo. O
  // cleanup cobre os dois casos em que a fala precisa parar: outro cartão
  // chegou, ou a tela de estudo saiu do ar.
  useEffect(() => {
    pararFala();
    if (preferencias.falarAutomaticamente && frente.trim() !== "") {
      falar(frente, { idioma: preferencias.idioma, vozURI: preferencias.vozURI });
    }
    return () => pararFala();
    // Depende só de `cartaoId`, de propósito: é o cartão trocando que deve
    // disparar isto, não cada tecla digitada nas preferências enquanto o
    // mesmo cartão está na tela (isso reiniciaria a fala à toa a cada troca
    // de idioma/voz). `frente` e `preferencias` entram só na condicional, com
    // o valor mais recente do render atual.
  }, [cartaoId]);

  const textoParaOuvir = revelado ? [frente, verso].filter((parte) => parte.trim() !== "").join(". ") : frente;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-2 text-left">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!falaDisponivel() || semVoz || textoParaOuvir.trim() === ""}
          onClick={() => {
            // Mesmo padrão do efeito de troca de cartão: sem isto, clicar de
            // novo enquanto a fala anterior ainda roda ENFILEIRA no
            // speechSynthesis em vez de substituir, e o resultado é leitura
            // sobreposta.
            pararFala();
            falar(textoParaOuvir, { idioma: preferencias.idioma, vozURI: preferencias.vozURI });
          }}
          className="rounded-sm border border-border bg-surface px-3 py-1.5 text-sm text-ink transition
            hover:bg-surface-raised active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
        >
          Ouvir
        </button>

        <details className="text-sm text-ink-muted">
          <summary className="cursor-pointer select-none">Voz</summary>
          <div className="mt-2 flex flex-col gap-2 rounded-sm border border-border bg-surface p-3">
            <label className="flex flex-col gap-1">
              <span>Idioma</span>
              <select
                value={preferencias.idioma}
                onChange={(event) => definirIdioma(deckId, event.currentTarget.value)}
                className="rounded-sm border border-border bg-paper px-2 py-1 text-ink"
              >
                {IDIOMAS_SUPORTADOS.map((idioma) => (
                  <option key={idioma.codigo} value={idioma.codigo}>
                    {idioma.rotulo}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span>Voz</span>
              <select
                value={preferencias.vozURI ?? ""}
                onChange={(event) => definirVoz(deckId, event.currentTarget.value || null)}
                disabled={vozesDoIdioma.length === 0}
                className="rounded-sm border border-border bg-paper px-2 py-1 text-ink disabled:opacity-50"
              >
                <option value="">Automática</option>
                {vozesDoIdioma.map((voz) => (
                  <option key={voz.voiceURI} value={voz.voiceURI}>
                    {voz.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={preferencias.falarAutomaticamente}
                onChange={() => alternarFalarAutomaticamente(deckId)}
              />
              <span>Falar automaticamente ao mostrar o cartão</span>
            </label>
          </div>
        </details>
      </div>

      {!falaDisponivel() ? (
        <p className="text-xs text-terracotta-ink">Este WebView não tem síntese de voz disponível.</p>
      ) : semVoz ? (
        <div className="flex items-center gap-2">
          <p role="status" className="text-xs text-terracotta-ink">
            Nenhuma voz instalada para {IDIOMAS_SUPORTADOS.find((idioma) => idioma.codigo === preferencias.idioma)?.rotulo ??
              preferencias.idioma}
            . No Windows: Configurações → Hora e Idioma → Fala → adicionar um idioma com voz.
          </p>
          {/* Caminho manual: as tentativas automáticas em `useVozesDoSistema`
              podem esgotar antes do SO terminar de carregar a lista (ou o
              usuário instala uma voz nova depois de abrir a tela). */}
          <button
            type="button"
            onClick={revalidar}
            className="shrink-0 rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition
              hover:bg-surface-raised active:scale-97"
          >
            Atualizar vozes
          </button>
        </div>
      ) : null}
    </div>
  );
}
