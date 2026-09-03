interface EmptyStateProps {
  title: string;
  description: string;
}

/**
 * Estado vazio genérico. `image-rendering: pixelated` no emoji de livro é de
 * propósito: é o único lugar fora do ícone/selo de sequência onde a "alma"
 * pixel art do app aparece — o resto da interface é vetor limpo.
 */
export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span
        aria-hidden="true"
        className="text-4xl"
        style={{ imageRendering: "pixelated" }}
      >
        📚
      </span>
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <p className="max-w-sm text-sm text-ink-muted">{description}</p>
    </div>
  );
}
