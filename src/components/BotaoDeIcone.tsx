import type { ReactNode } from "react";

interface BotaoDeIconeProps {
  /** O nome acessível. Vira `aria-label` e, se `title` não vier, o tooltip. */
  rotulo: string;
  title?: string;
  onClick: () => void;
  /** O ícone: SVG em `currentColor` (ver `features/navegacao/icones.tsx`) ou um emoji. */
  children: ReactNode;
}

/**
 * Botão só de ícone, do tamanho mínimo de alvo (`--hit-min`, 44px → `size-12`
 * na régua de 3.75px = 45px). Fantasma em repouso — no rail ele mora ao lado
 * das seções, e uma borda própria o faria gritar mais que "Notas".
 *
 * Os seis estados de §8 do DESIGN-TOKENS: repouso `text-ink-muted`; hover
 * sobe para `surface-raised` e `ink`; foco herdado do `:focus-visible`
 * global; pressionado encolhe a 0.97; desabilitado não existe aqui (é um
 * botão de navegação); selecionado não se aplica.
 */
export function BotaoDeIcone({ rotulo, title, onClick, children }: BotaoDeIconeProps) {
  return (
    <button
      type="button"
      aria-label={rotulo}
      title={title ?? rotulo}
      onClick={onClick}
      className="grid size-12 place-items-center rounded-sm text-ink-muted transition duration-150 ease-out hover:bg-surface-raised hover:text-ink active:scale-97"
    >
      {children}
    </button>
  );
}
