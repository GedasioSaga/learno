import type { SVGProps } from "react";

/**
 * Ícones do rail e da casca, em SVG inline com `currentColor`.
 *
 * Não são emoji, ao contrário do resto do app, por dois motivos: o rail tinge
 * o ícone da seção ativa de âmbar (§8 do DESIGN-TOKENS: acento como
 * indicador, não como fundo), e emoji não aceita cor; e sete emojis coloridos
 * lado a lado viram uma barra de brinquedo, não de ferramenta. O emoji
 * continua onde é conteúdo (ícone de página, marca do app).
 *
 * Traçado em 1.75px sobre grade de 24, desenhado à mão no estilo do Lucide.
 * `aria-hidden` sempre: o nome acessível vem do texto ou do `aria-label` do
 * controle que o envolve, nunca do desenho.
 */
function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Hoje — sol em meio-dia: o começo do dia de estudo. */
export function IconeHoje(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1" />
      <path d="M12 20v1" />
      <path d="M3 12h1" />
      <path d="M20 12h1" />
      <path d="m18.364 5.636-.707.707" />
      <path d="m6.343 17.657-.707.707" />
      <path d="m5.636 5.636.707.707" />
      <path d="m17.657 17.657.707.707" />
    </Svg>
  );
}

/** Notas — folha com linhas de texto. */
export function IconeNotas(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </Svg>
  );
}

/** Cartões — pilha de cartões vista de frente. */
export function IconeCartoes(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M7 2h10" />
      <path d="M5 6h14" />
      <rect width="18" height="12" x="3" y="10" rx="2" />
    </Svg>
  );
}

/** Mapa mental — nó central ligado a vizinhos. */
export function IconeMapaMental(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="4.5" r="2.5" />
      <path d="m10.2 6.3-3.9 3.9" />
      <circle cx="4.5" cy="12" r="2.5" />
      <path d="M7 12h10" />
      <circle cx="19.5" cy="12" r="2.5" />
      <path d="m13.8 17.7 3.9-3.9" />
      <circle cx="12" cy="19.5" r="2.5" />
    </Svg>
  );
}

/** Trilha — caminho de um ponto a outro. */
export function IconeTrilha(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </Svg>
  );
}

/** Cronograma — calendário. */
export function IconeCronograma(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </Svg>
  );
}

/** Finanças — carteira. */
export function IconeFinancas(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

/** Biblioteca — lombadas de livro numa prateleira. */
export function IconeBiblioteca(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </Svg>
  );
}

/** Configurações — controles deslizantes. */
export function IconeConfiguracoes(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M21 4h-7" />
      <path d="M10 4H3" />
      <path d="M21 12h-9" />
      <path d="M8 12H3" />
      <path d="M21 20h-5" />
      <path d="M12 20H3" />
      <path d="M14 2v4" />
      <path d="M8 10v4" />
      <path d="M16 18v4" />
    </Svg>
  );
}

/** Painel lateral recolhendo (seta para dentro). */
export function IconeRecolherPainel(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </Svg>
  );
}

/** Painel lateral abrindo (seta para fora). */
export function IconeMostrarPainel(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </Svg>
  );
}
