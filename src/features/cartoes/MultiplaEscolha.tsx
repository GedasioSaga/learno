import { useEffect, useMemo } from "react";

type Props = {
  correta: string;
  erradas: string[];
  cartaoId: string;
  escolhida: string | null;
  onEscolher: (alternativa: string, acertou: boolean) => void;
};

/**
 * Hash curto e determinístico (djb2) — não é para nada criptográfico, só para
 * transformar `cartaoId` (uma string) numa semente numérica que o gerador
 * abaixo consegue usar.
 */
function hashDeString(texto: string): number {
  let hash = 5381;
  for (let indice = 0; indice < texto.length; indice += 1) {
    hash = (hash * 33) ^ texto.charCodeAt(indice);
  }
  return hash >>> 0;
}

/**
 * PRNG determinístico (mulberry32): a mesma semente sempre produz a mesma
 * sequência de números. É o que substitui `Math.random()` aqui — a tela
 * re-renderiza a cada tecla (revelar, responder), e um gerador de verdade
 * embaralharia as alternativas de novo debaixo do usuário a cada render.
 */
function criarGeradorDeterministico(semente: number): () => number {
  let estado = semente;
  return () => {
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates sobre o gerador determinístico acima — mesma semente, mesma ordem sempre. */
function embaralharComSemente<T>(itens: T[], semente: number): T[] {
  const resultado = [...itens];
  const proximoAleatorio = criarGeradorDeterministico(semente);
  for (let i = resultado.length - 1; i > 0; i -= 1) {
    const j = Math.floor(proximoAleatorio() * (i + 1));
    [resultado[i], resultado[j]] = [resultado[j], resultado[i]];
  }
  return resultado;
}

const TECLAS_DE_ESCOLHA = ["1", "2", "3", "4"];

/**
 * Múltipla escolha da tela de estudo. A Pergunta não é deste componente —
 * quem chama já decidiu o que mostrar antes; aqui só entram as alternativas.
 *
 * Controlado de fora (`escolhida` é prop, não estado interno): quem chama
 * decide quando a resposta já foi registrada, do mesmo jeito que
 * `EstudoSessao` já controla `enviando` para os botões de SM-2.
 */
export function MultiplaEscolha({ correta, erradas, cartaoId, escolhida, onEscolher }: Props) {
  const alternativas = useMemo(() => {
    // Dedup contra `correta`: dado malformado vindo do card pode repetir o
    // texto certo dentro de `erradas`, e sem isso duas alternativas iguais
    // acabam marcadas como "certa" na hora do feedback (linha `ehCorreta`).
    const erradasValidas = erradas.filter((texto) => texto.trim() !== "" && texto.trim() !== correta.trim());
    return embaralharComSemente([correta, ...erradasValidas], hashDeString(cartaoId));
  }, [correta, erradas, cartaoId]);

  const semAlternativaRealDeErro = alternativas.length <= 1;

  useEffect(() => {
    // Escolha já registrada: nada mais a capturar (e não deixar um listener
    // "morto" pendurado na window entre uma pergunta e a próxima).
    if (escolhida !== null) return;

    function aoTeclar(event: KeyboardEvent) {
      const alvo = event.target;
      // isContentEditable cobre os blocos ProseMirror/TipTap do editor (div
      // contenteditable, não INPUT/TEXTAREA) — sem isso, digitar "1".."4"
      // dentro de um bloco editável na mesma tela dispara onEscolher.
      if (alvo instanceof HTMLElement && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.isContentEditable))
        return;

      const indice = TECLAS_DE_ESCOLHA.indexOf(event.key);
      if (indice === -1) return;
      const alternativa = alternativas[indice];
      if (!alternativa) return;

      event.preventDefault();
      onEscolher(alternativa, alternativa === correta);
    }

    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [alternativas, escolhida, correta, onEscolher]);

  const jaEscolheu = escolhida !== null;

  return (
    <div className="flex flex-col gap-2">
      {semAlternativaRealDeErro ? (
        <p className="text-xs text-ink-muted">
          Este cartão tem só uma opção cadastrada — não há o que escolher de verdade.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {alternativas.map((alternativa, indice) => {
          const ehCorreta = alternativa === correta;
          const foiEscolhida = escolhida === alternativa;

          // Cor nunca sozinha: o texto/símbolo ao final do botão já diz
          // "Certa"/"Sua resposta" antes de qualquer leitor de tela chegar
          // na cor — bg-emerald e text-terracotta-ink aqui são reforço, não
          // o único sinal.
          let classesDeEstado = "border-border bg-surface text-ink hover:bg-surface-raised";
          if (jaEscolheu && ehCorreta) {
            classesDeEstado = "border-border bg-emerald text-on-emerald";
          } else if (jaEscolheu && foiEscolhida) {
            classesDeEstado = "border-border bg-surface text-terracotta-ink";
          } else if (jaEscolheu) {
            classesDeEstado = "border-border bg-surface text-ink-muted opacity-60";
          }

          return (
            <button
              key={`${indice}-${alternativa}`}
              type="button"
              disabled={jaEscolheu}
              onClick={() => onEscolher(alternativa, ehCorreta)}
              className={`flex items-center gap-2 rounded-sm border px-4 py-2.5 text-left text-sm transition active:scale-97 disabled:pointer-events-none ${classesDeEstado}`}
            >
              <span className="text-xs text-ink-muted">({indice + 1})</span>
              <span className="flex-1">{alternativa}</span>
              {jaEscolheu && ehCorreta ? <span className="text-xs font-medium">✓ Certa</span> : null}
              {jaEscolheu && foiEscolhida && !ehCorreta ? (
                <span className="text-xs font-medium">✗ Sua resposta</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {jaEscolheu ? (
        <p role="status" className="text-sm text-ink">
          {escolhida === correta ? "Certo." : `Errado. A resposta certa era: ${correta}`}
        </p>
      ) : null}
    </div>
  );
}
