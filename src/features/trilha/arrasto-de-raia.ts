import type { FaixaDaRaia } from "./layout";

/**
 * Lógica PURA do arrasto de um cartão de etapa para outra raia — extraída de
 * `TrilhaCanvas.tsx` pelo mesmo motivo de `layout.ts`/`ligacao.ts`: a decisão
 * ("para qual raia isto cai, e isso deveria virar uma chamada de IPC?") não
 * depende de DOM nem do `@xyflow/react`, só de números — e função pura é o
 * que dá para testar sem simular um gesto de mouse em cima de um canvas
 * (jsdom não faz hit-testing; ver o relatório desta entrega).
 */

/**
 * Em qual raia um ponto Y (mesmo espaço de coordenadas de `layout.faixas` —
 * canvas, não tela) cai — ou `null` quando o ponto está fora de qualquer
 * faixa OU quando a faixa que ele atravessa está RECOLHIDA.
 *
 * DECISÃO (o pedido pedia para escolher e documentar): uma raia recolhida
 * recusa o drop, não aceita e expande sozinha. Expandir como efeito colateral
 * de "eu só queria mover um cartão" é uma mutação extra que ninguém pediu — e
 * o alvo recolhido mede só `RAIA_CABECALHO_ALTURA` (37.5px, ver layout.ts),
 * pequeno demais para acertar de propósito. `null` aqui também significa
 * "nenhum destaque aparece" (`TrilhaCanvas.tsx` só marca uma raia como alvo
 * quando este retorno não é `null`), então o usuário já vê que aquela faixa
 * não é um pouso válido antes mesmo de soltar.
 */
export function raiaAlvoNoY(y: number, faixas: readonly FaixaDaRaia[]): string | null {
  const faixa = faixas.find((candidata) => !candidata.isCollapsed && y >= candidata.y && y < candidata.y + candidata.height);
  return faixa ? faixa.laneValue : null;
}

/**
 * Decide se um drop deve virar uma chamada de `moverEtapaParaRaia` — e para
 * qual raia. `null` cobre os dois casos de "não faz nada" do pedido: soltar
 * fora de qualquer raia (`laneAlvo === null`, já filtrado por `raiaAlvoNoY`
 * acima) e soltar na MESMA raia em que a etapa já está. `laneAtual` é sempre
 * o valor já resolvido por `laneEfetivaDaEtapa` (layout.ts) — esta função não
 * sabe nada sobre etapa órfã, só compara dois `laneValue` finais.
 */
export function laneParaMover(laneAtual: string, laneAlvo: string | null): string | null {
  if (laneAlvo === null || laneAlvo === laneAtual) return null;
  return laneAlvo;
}

/**
 * A posição que um cartão de etapa deve assumir durante/depois do arrasto,
 * com o eixo X sempre travado no valor calculado pelo layout (a coluna é o
 * nível de dependência — nunca um lugar que o mouse decide, mesmo motivo que
 * `docs/DESIGN-TRILHA.md §1` já dá para o layout inteiro). Um arrasto na
 * diagonal também só resulta em movimento vertical: `y` passa direto, `x`
 * nunca é o que o chamador passou.
 */
export function posicaoComXTravado(xOriginal: number, y: number): { x: number; y: number } {
  return { x: xOriginal, y };
}

/**
 * Um cartão IRMÃO do que está sendo arrastado — mesmo nível, mesma raia
 * efetiva, exceto ele mesmo. As duas funções abaixo (`yDaLinhaDeInsercao` e
 * `alvoDeReordenacaoNaRaia`) só precisam disto: `y` (onde o layout desenhou
 * o CENTRO dele agora) para achar onde o cartão arrastado caiu visualmente,
 * e `position` (o índice fracionário de `pages.position`, a única coisa que
 * `movePage` entende) para saber onde ele já estava de fato.
 */
export interface CartaoIrmaoParaReordenar {
  id: string;
  position: string;
  y: number;
}

/** Onde `movePage(id, null, alvo)` deve inserir o cartão arrastado — sempre relativo a um irmão, nunca por índice numérico (o backend não tem esse conceito). */
export type AlvoDeReordenacao = { type: "start" } | { type: "after"; value: string };

/**
 * Em qual índice (0..irmãos.length) o cartão arrastado cairia, comparando o
 * CENTRO Y dele com o dos irmãos — nunca `position`: é o que o usuário está
 * vendo mexer na tela, e é a mesma régua que decide a linha de inserção
 * (`yDaLinhaDeInsercao`) e o alvo de verdade (`alvoDeReordenacaoNaRaia`), de
 * propósito, para as duas nunca poderem discordar uma da outra.
 */
function indiceDeInsercaoPorY(centroYArrastado: number, irmaosPorY: readonly CartaoIrmaoParaReordenar[]): number {
  const indice = irmaosPorY.findIndex((irmao) => centroYArrastado < irmao.y);
  return indice === -1 ? irmaosPorY.length : indice;
}

/**
 * A linha de inserção que o cartão arrastado desenha DURANTE o gesto (item 3
 * do pedido: "não deixe o usuário adivinhar onde vai cair") — a meio caminho
 * entre o irmão de cima e o de baixo no índice calculado, ou colada acima do
 * primeiro / abaixo do último nos extremos. `alturaDoCartao`/`gap` são as
 * mesmas réguas de `layout.ts` (`ETAPA_ALTURA_MIN`/`GAP_LINHA`) — passadas
 * pelo chamador para este módulo continuar sem importar nada de `layout.ts`
 * além do tipo `FaixaDaRaia` que já importava.
 */
export function yDaLinhaDeInsercao(
  centroYArrastado: number,
  irmaos: readonly CartaoIrmaoParaReordenar[],
  alturaDoCartao: number,
  gap: number,
): number {
  if (irmaos.length === 0) return centroYArrastado;
  const porY = [...irmaos].sort((a, b) => a.y - b.y);
  const indice = indiceDeInsercaoPorY(centroYArrastado, porY);
  if (indice === 0) return porY[0].y - alturaDoCartao / 2 - gap / 2;
  if (indice === porY.length) return porY[porY.length - 1].y + alturaDoCartao / 2 + gap / 2;
  return (porY[indice - 1].y + porY[indice].y) / 2;
}

/**
 * Decide o alvo de `movePage` para um drop dentro da MESMA raia — e mesmo
 * NÍVEL, porque o eixo X está travado (`posicaoComXTravado`): a coluna do
 * cartão arrastado nunca muda, então só faz sentido comparar com irmãos que
 * já compartilham o mesmo nível.
 *
 * Compara Y (nunca `position`) para achar ONDE o cartão caiu — mesma régua
 * de `yDaLinhaDeInsercao`, de propósito — e só then traduz esse lugar para
 * `position`, a única coisa que o backend entende (`SiblingPosition` não tem
 * "antes de X", só "depois de X"/"no início"/"no fim" — ver `pages.rs`).
 *
 * Devolve `null` quando o índice calculado por Y é EXATAMENTE onde a etapa
 * já estava por `position` (a ordem de verdade, antes deste arrasto) —
 * soltar de volta no mesmo lugar não deve gerar nenhuma chamada de IPC.
 */
export function alvoDeReordenacaoNaRaia(
  centroYArrastado: number,
  positionArrastada: string,
  irmaos: readonly CartaoIrmaoParaReordenar[],
): AlvoDeReordenacao | null {
  if (irmaos.length === 0) return null; // sozinha no nível/raia: nada para reordenar contra.

  const porY = [...irmaos].sort((a, b) => a.y - b.y);
  const indiceNovo = indiceDeInsercaoPorY(centroYArrastado, porY);
  const antecessorNovo = indiceNovo === 0 ? null : porY[indiceNovo - 1].id;

  // O antecessor ATUAL, por `position`: o irmão de maior `position` que
  // ainda é menor que a da etapa arrastada — `null` quando ela já é a
  // primeira do grupo. `localeCompare` porque é assim que `layout.ts`
  // (`atribuirLinhas`) e `ordenarRaiasParaExibicao` já comparam `position`.
  const antecessorAtual =
    [...irmaos]
      .filter((irmao) => irmao.position.localeCompare(positionArrastada) < 0)
      .sort((a, b) => b.position.localeCompare(a.position))[0]?.id ?? null;

  if (antecessorNovo === antecessorAtual) return null;

  return antecessorNovo === null ? { type: "start" } : { type: "after", value: antecessorNovo };
}
