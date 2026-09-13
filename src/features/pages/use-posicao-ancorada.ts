import { useCallback, useEffect, type RefObject } from "react";

/**
 * Prende um painel de `popover` ao botão que o abriu, por medida explícita.
 *
 * ## Por que isto existe
 *
 * Os menus deste projeto usam a Popover API (`popover="auto"`), que dá de
 * graça o fechar-ao-clicar-fora e o Escape. O que ela NÃO dá é posição: um
 * popover aberto entra na *top layer* do navegador, e lá o bloco continente de
 * um elemento `position: absolute` deixa de ser o ancestral posicionado e
 * passa a ser o bloco continente inicial — a janela.
 *
 * Os três menus estavam escritos com as classes `absolute right-0 top-full`.
 * Dentro da top layer, `top: 100%` parou de significar "logo abaixo do botão"
 * e passou a significar "uma altura de janela inteira para baixo": o painel
 * abria inteiro fora da área visível. Do lado de fora isso é
 * indistinguível de um botão quebrado, e foi exatamente assim que o usuário
 * relatou — "aperto nos ... e nada acontece", "aperto no ícone e nada
 * acontece".
 *
 * Nenhum teste pegou porque o jsdom não faz layout: `getByRole` encontra o
 * painel esteja ele onde estiver na tela, e todas as asserções passavam.
 *
 * ## Por que medir em vez de arrumar o CSS
 *
 * Dava para tentar corrigir só as classes, mas a correção continuaria
 * dependendo de como cada navegador resolve o bloco continente de um elemento
 * na top layer — um detalhe que já mudou de interpretação e que a WebView2 do
 * usuário pode implementar em outra versão que a do desenvolvedor. Medir o
 * botão e cravar `position: fixed` com coordenadas em pixel não depende disso
 * em lugar nenhum: o painel vai para onde a conta mandar.
 *
 * (O posicionamento por âncora do CSS resolveria isto de forma declarativa,
 * mas é recente demais para uma WebView2 cuja versão não controlamos.)
 */

/** De que lado do gatilho a borda do painel se alinha. */
export type AlinhamentoDoPainel = "inicio" | "fim";

export interface OpcoesDeAncoragem {
  /** `"fim"` encosta a borda direita do painel na direita do gatilho. */
  alinhamento?: AlinhamentoDoPainel;
  /** Respiro entre o gatilho e o painel, em pixels. */
  espacamento?: number;
}

/** Folga mínima até a borda da janela — painel colado no canto parece corte. */
const MARGEM_DA_JANELA = 8;

/**
 * Posiciona `painelRef` logo abaixo de `gatilhoRef` enquanto `aberto` for
 * verdadeiro, virando para cima ou para o lado quando não couber.
 *
 * Reposiciona em `resize` e em qualquer rolagem (na fase de captura, porque a
 * rolagem que importa costuma ser a de um contêiner interno, não a da janela),
 * e desliga os ouvintes ao fechar.
 */
export function usePosicaoAncorada(
  gatilhoRef: RefObject<HTMLElement | null>,
  painelRef: RefObject<HTMLElement | null>,
  aberto: boolean,
  opcoes: OpcoesDeAncoragem = {},
): void {
  const { alinhamento = "inicio", espacamento = 4 } = opcoes;

  const posicionar = useCallback(() => {
    const gatilho = gatilhoRef.current;
    const painel = painelRef.current;
    if (!gatilho || !painel) return;

    const g = gatilho.getBoundingClientRect();
    const p = painel.getBoundingClientRect();

    const alturaDaJanela = window.innerHeight;
    const larguraDaJanela = window.innerWidth;

    // Vertical: abaixo por padrão; acima quando o que sobra embaixo não cabe
    // E o que sobra em cima cabe. Se não couber em lugar nenhum (painel mais
    // alto que a janela), fica embaixo e o `clamp` adiante o encosta no topo,
    // que é o menos ruim: o começo do menu é o que a pessoa precisa ver.
    const abaixo = g.bottom + espacamento;
    const acima = g.top - espacamento - p.height;
    const cabeAbaixo = abaixo + p.height <= alturaDaJanela - MARGEM_DA_JANELA;
    const cabeAcima = acima >= MARGEM_DA_JANELA;
    const topo = cabeAbaixo || !cabeAcima ? abaixo : acima;

    const esquerda = alinhamento === "fim" ? g.right - p.width : g.left;

    painel.style.position = "fixed";
    painel.style.top = `${prender(topo, MARGEM_DA_JANELA, alturaDaJanela - p.height - MARGEM_DA_JANELA)}px`;
    painel.style.left = `${prender(esquerda, MARGEM_DA_JANELA, larguraDaJanela - p.width - MARGEM_DA_JANELA)}px`;
    painel.style.right = "auto";
    painel.style.bottom = "auto";
    painel.style.margin = "0";
  }, [gatilhoRef, painelRef, alinhamento, espacamento]);

  useEffect(() => {
    if (!aberto) return;

    posicionar();

    window.addEventListener("resize", posicionar);
    // `true` = fase de captura: pega a rolagem de qualquer contêiner no
    // caminho, não só a da janela. O painel está preso a um botão que rola
    // junto com a árvore de páginas.
    window.addEventListener("scroll", posicionar, true);
    return () => {
      window.removeEventListener("resize", posicionar);
      window.removeEventListener("scroll", posicionar, true);
    };
  }, [aberto, posicionar]);
}

/**
 * Mantém `valor` dentro de [`minimo`, `maximo`], sem inverter quando o
 * intervalo é vazio — um painel mais alto que a janela produz
 * `maximo < minimo`, e aí o topo vence, porque é onde o menu começa.
 */
function prender(valor: number, minimo: number, maximo: number): number {
  if (maximo < minimo) return minimo;
  return Math.min(Math.max(valor, minimo), maximo);
}
