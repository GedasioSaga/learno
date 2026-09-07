/**
 * Lê a seleção do navegador DENTRO da prévia de `CriarLacunaDeOrigem` e a
 * converte em índices do texto do bloco.
 *
 * A prévia renderiza o texto em pedaços — literal, lacuna — e cada pedaço
 * que carrega caracteres do texto tem `data-inicio="<índice>"` e contém UM
 * nó de texto. Tudo o que não é texto do bloco (o selo com o número da
 * lacuna, o botão de remover, rótulo para leitor de tela) fica FORA desses
 * pedaços, então uma seleção que começa ou termina num deles é recusada
 * (`null`) em vez de produzir um índice inventado.
 *
 * DOM puro, sem React, para ser testável com `document.createRange()` no
 * jsdom e para a leitura acontecer no `selectionchange`, que não passa pelo
 * React.
 */

import type { Intervalo } from "./lacunas";

export const ATRIBUTO_INICIO = "data-inicio";

function indiceDe(container: HTMLElement, no: Node, offsetNoNo: number): number | null {
  const elemento = no instanceof Element ? no : no.parentElement;
  const pedaco = elemento?.closest(`[${ATRIBUTO_INICIO}]`);
  if (!(pedaco instanceof HTMLElement) || !container.contains(pedaco)) return null;

  const inicio = Number(pedaco.getAttribute(ATRIBUTO_INICIO));
  if (!Number.isInteger(inicio)) return null;

  // Um nó de texto dentro do pedaço: o offset é em caracteres desse nó.
  // Um elemento (a seleção "pegou" o pedaço inteiro, offset em filhos):
  // 0 é o começo do pedaço, qualquer outro é o fim.
  if (no.nodeType === Node.TEXT_NODE) return inicio + offsetNoNo;
  return offsetNoNo === 0 ? inicio : inicio + (pedaco.textContent?.length ?? 0);
}

/**
 * O intervalo selecionado dentro de `container`, em índices do texto, ou
 * `null` se não há seleção, se ela está colapsada, ou se alguma ponta cai
 * fora de um pedaço de texto.
 */
export function intervaloSelecionadoEm(container: HTMLElement, selecao: Selection | null): Intervalo | null {
  if (!selecao || selecao.rangeCount === 0 || selecao.isCollapsed) return null;
  const range = selecao.getRangeAt(0);

  const inicio = indiceDe(container, range.startContainer, range.startOffset);
  const fim = indiceDe(container, range.endContainer, range.endOffset);
  if (inicio === null || fim === null || inicio === fim) return null;

  return inicio < fim ? { inicio, fim } : { inicio: fim, fim: inicio };
}
