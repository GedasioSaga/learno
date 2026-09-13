import type { ReactNode, SVGProps } from "react";
import { useReactFlow } from "@xyflow/react";
import type { PosicaoDaEtapa } from "./layout";

/**
 * Movimento do canvas (zoom, "ver tudo", "ir até a próxima") dura `--motion-slow`
 * (240ms, theme.css) — é movimento NA tela, não entrada/saída, e o
 * `@xyflow/react` recebe o número em ms, não a variável CSS. Quem pediu
 * menos movimento no SO recebe 0: o `@layer base` de theme.css só alcança
 * transição CSS, não a interpolação que a lib faz em JS.
 */
export function duracaoDoMovimentoDoCanvas(): number {
  const reduzido = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  return reduzido ? 0 : 240;
}

/** Zoom em que o texto do cartão está no tamanho desenhado — o alvo de "ir até lá". */
const ZOOM_DE_LEITURA = 1;

function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

function IconeMais() {
  return (
    <Svg>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

function IconeMenos() {
  return (
    <Svg>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** Quatro cantos — "enquadrar tudo". */
function IconeVerTudo() {
  return (
    <Svg>
      <path d="M4 9V5a1 1 0 0 1 1-1h4" />
      <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h4" />
      <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    </Svg>
  );
}

/** Mira — "voltar para onde eu estou". */
function IconeMira() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
    </Svg>
  );
}

function BotaoDeControle({ rotulo, onClick, disabled, children }: { rotulo: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="trilha-controle" aria-label={rotulo} title={rotulo} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/**
 * Os controles do canto inferior esquerdo, no lugar do `<Controls />` cru
 * do `@xyflow/react` (item 8 do pedido: ele vinha com o desenho da lib, não
 * o do app). Quatro botões, todos com efeito real via `useReactFlow`:
 * mais/menos zoom, "ver tudo" e "ir para o próximo passo" — este último é
 * o "voltar para a minha posição" que uma trilha longa precisa (Duolingo).
 *
 * O cadeado da lib (travar interação) ficou de fora: nada aqui é
 * arrastável, então travar não mudaria nada visível.
 */
export function ControlesDoCanvas({ proximaEtapa }: { proximaEtapa: { id: string; posicao: PosicaoDaEtapa } | null }) {
  const { zoomIn, zoomOut, fitView, setCenter } = useReactFlow();

  function irParaAProxima() {
    if (!proximaEtapa) return;
    const { posicao } = proximaEtapa;
    void setCenter(posicao.x + posicao.width / 2, posicao.y + posicao.height / 2, {
      zoom: ZOOM_DE_LEITURA,
      duration: duracaoDoMovimentoDoCanvas(),
    });
  }

  return (
    <div className="trilha-controles" role="group" aria-label="Navegação do canvas">
      <BotaoDeControle rotulo="Aproximar" onClick={() => void zoomIn({ duration: duracaoDoMovimentoDoCanvas() })}>
        <IconeMais />
      </BotaoDeControle>
      <BotaoDeControle rotulo="Afastar" onClick={() => void zoomOut({ duration: duracaoDoMovimentoDoCanvas() })}>
        <IconeMenos />
      </BotaoDeControle>
      <BotaoDeControle rotulo="Ver a trilha inteira" onClick={() => void fitView({ padding: 0.08, maxZoom: ZOOM_DE_LEITURA, duration: duracaoDoMovimentoDoCanvas() })}>
        <IconeVerTudo />
      </BotaoDeControle>
      <BotaoDeControle
        rotulo={proximaEtapa ? "Ir para o próximo passo" : "Nenhum próximo passo disponível"}
        onClick={irParaAProxima}
        disabled={proximaEtapa === null}
      >
        <IconeMira />
      </BotaoDeControle>
    </div>
  );
}
