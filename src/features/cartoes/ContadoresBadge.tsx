import type { DeckCounts } from "../../lib/ipc";

interface ContadoresBadgeProps {
  contagens: DeckCounts;
}

/**
 * Os três contadores de um baralho, lado a lado — o mesmo "cartão por deck,
 * contagem visível" que a captura do AnkiPro mostrou.
 *
 * Cores: `novos` fica neutro (é fila, não é aviso nem sucesso); `aprendendo`
 * usa `amber` (são os cartões que voltam logo, pedem atenção); `revisar` usa
 * `mint` (o que está pronto para ser feito hoje). Decisão desta tela — o
 * contrato de IPC não define semântica de cor para os três números.
 */
export function ContadoresBadge({ contagens }: ContadoresBadgeProps) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
      <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 text-ink-muted" aria-label={`${contagens.novos} novos`}>
        {contagens.novos}
      </span>
      <span className="rounded-sm bg-amber/10 px-1.5 py-0.5 text-amber-ink" aria-label={`${contagens.aprendendo} aprendendo`}>
        {contagens.aprendendo}
      </span>
      <span className="rounded-sm bg-mint/10 px-1.5 py-0.5 text-mint-ink" aria-label={`${contagens.revisar} para revisar`}>
        {contagens.revisar}
      </span>
    </span>
  );
}
