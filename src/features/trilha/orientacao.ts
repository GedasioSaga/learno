import type { EtapaDaTrilha, FlechaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";
import { estadoVisualDaEtapa } from "./descricoes";
import { ordenarRaiasParaExibicao } from "./layout";

/**
 * Orientação — as perguntas que uma trilha existe para responder, todas
 * PURAS (só leem `etapas`/`flechas`/`raias`; nunca tocam em estado nem em
 * DOM), no mesmo espírito de `layout.ts` e `descricoes.ts`:
 *
 * 1. "O que eu faço agora?" → `proximaEtapaRecomendada`
 * 2. "O que esta etapa exige, e o que ela destrava?" → `cadeiaDeDependencias`
 * 3. "Quais etapas pesam mais?" → `ehMarco`
 * 4. "Em que zoom a tela abre?" → `enquadramentoInicial`
 *
 * Nada aqui inventa dado: tudo é derivado do grafo que `obterTrilha` já
 * devolve. Um "marco", por exemplo, não é um campo novo — é a etapa onde
 * vários caminhos convergem, o que já está escrito nas flechas.
 */

/**
 * A etapa onde o estudante deve continuar. Ordem de preferência:
 * primeiro uma "em andamento" (trabalho já começado vence trabalho novo),
 * depois uma "disponível"; dentro de cada grupo, a de menor nível, e em
 * empate a que aparece primeiro na ordem das raias — a mesma leitura de
 * cima para baixo e da esquerda para a direita que o canvas propõe.
 *
 * `null` quando não há nada a fazer: tudo concluído, ou o que resta está
 * bloqueado/em ciclo (a tela diz isso por extenso em vez de apontar para
 * uma etapa em que não dá para agir).
 *
 * Etapas fora do caminho ativo (`situacaoNoCaminho !== "ativo"`) nunca são
 * recomendadas: uma etapa descartada por decisão não é "o próximo passo"
 * por mais disponível que o grafo a considere.
 */
export function proximaEtapaRecomendada(etapas: readonly EtapaDaTrilha[], raias: readonly RaiaDaTrilha[]): EtapaDaTrilha | null {
  const indiceDaRaia = new Map(ordenarRaiasParaExibicao([...etapas], [...raias]).map((raia, indice) => [raia.laneValue, indice] as const));
  const posicaoDaRaia = (etapa: EtapaDaTrilha) => indiceDaRaia.get(etapa.laneValue) ?? Number.MAX_SAFE_INTEGER;

  const candidatas = etapas
    .filter((etapa) => etapa.situacaoNoCaminho === "ativo")
    .map((etapa) => ({ etapa, estado: estadoVisualDaEtapa(etapa) }))
    .filter(({ estado }) => estado === "em-andamento" || estado === "disponivel")
    .sort(
      (a, b) =>
        Number(a.estado !== "em-andamento") - Number(b.estado !== "em-andamento") ||
        a.etapa.level - b.etapa.level ||
        posicaoDaRaia(a.etapa) - posicaoDaRaia(b.etapa) ||
        a.etapa.title.localeCompare(b.etapa.title),
    );

  return candidatas[0]?.etapa ?? null;
}

/** As duas metades da cadeia de uma etapa, cada uma como conjunto de ids — a própria etapa não entra em nenhuma. */
export interface CadeiaDeDependencias {
  /** Tudo que precisa vir antes, transitivamente (as bloqueadoras, as bloqueadoras delas…). */
  exige: Set<string>;
  /** Tudo que só destrava depois dela, transitivamente. */
  desbloqueia: Set<string>;
}

/**
 * Fecho transitivo nos dois sentidos a partir de `stepId`. É o que a tela
 * realça ao passar o mouse ou focar uma etapa (padrão Civ VI / roadmap.sh):
 * "o que ela exige" à esquerda, "o que ela desbloqueia" à direita.
 *
 * Tolera ciclo: o `visitados` impede loop infinito, e uma etapa em ciclo
 * simplesmente aparece nos dois conjuntos — o que é verdade (ela exige e é
 * exigida pela outra ponta do laço).
 */
export function cadeiaDeDependencias(stepId: string, flechas: readonly FlechaDaTrilha[]): CadeiaDeDependencias {
  const bloqueadorasDe = new Map<string, string[]>();
  const bloqueadasPor = new Map<string, string[]>();
  for (const flecha of flechas) {
    bloqueadorasDe.set(flecha.blockedId, [...(bloqueadorasDe.get(flecha.blockedId) ?? []), flecha.blockingId]);
    bloqueadasPor.set(flecha.blockingId, [...(bloqueadasPor.get(flecha.blockingId) ?? []), flecha.blockedId]);
  }

  function fecho(vizinhos: Map<string, string[]>): Set<string> {
    const visitados = new Set<string>();
    const fila = [...(vizinhos.get(stepId) ?? [])];
    while (fila.length > 0) {
      const atual = fila.pop();
      if (atual === undefined || visitados.has(atual)) continue;
      visitados.add(atual);
      fila.push(...(vizinhos.get(atual) ?? []));
    }
    visitados.delete(stepId);
    return visitados;
  }

  return { exige: fecho(bloqueadorasDe), desbloqueia: fecho(bloqueadasPor) };
}

/** Abaixo disto, uma etapa é um passo comum; a partir daqui, um marco — ver `ehMarco`. */
const MINIMO_DE_PRE_REQUISITOS_PARA_MARCO = 2;

/**
 * Um MARCO é a etapa onde dois ou mais caminhos convergem — o simulado que
 * junta quatro matérias, a revisão que exige teoria E exercícios. É o
 * segundo peso visual que a referência (roadmap.sh) tem e esta tela não
 * tinha: o olho precisa achar os pontos de encontro numa trilha de vinte
 * etapas sem ler os vinte títulos.
 *
 * Só convergência (flechas de ENTRADA) conta. Ramificação (várias saídas)
 * ficou de fora de propósito: numa trilha pequena quase toda etapa
 * desbloqueia duas, e um peso que quase todo mundo tem não é peso nenhum.
 */
export function ehMarco(stepId: string, flechas: readonly FlechaDaTrilha[]): boolean {
  return contarPreRequisitos(stepId, flechas) >= MINIMO_DE_PRE_REQUISITOS_PARA_MARCO;
}

export function contarPreRequisitos(stepId: string, flechas: readonly FlechaDaTrilha[]): number {
  return flechas.filter((flecha) => flecha.blockedId === stepId).length;
}

/**
 * Abaixo deste zoom o título de 14px vira ~11px e deixa de ser leitura
 * confortável — a queixa concreta do item 7 do pedido. A tela prefere abrir
 * mostrando MENOS trilha em tamanho legível a mostrar tudo miúdo; o botão
 * "Ver tudo" dos controles continua existindo para quem quiser o mapa inteiro.
 */
export const ZOOM_MINIMO_LEGIVEL = 0.8;
export const ZOOM_MAXIMO_INICIAL = 1;
/** Folga entre o conteúdo e a borda do canvas ao enquadrar, em px de tela. */
export const MARGEM_DO_ENQUADRAMENTO = 32;

export interface Enquadramento {
  x: number;
  y: number;
  zoom: number;
}

/**
 * O viewport inicial: cabe tudo se couber legível; senão, abre em
 * `ZOOM_MINIMO_LEGIVEL` ancorado no canto superior esquerdo (a raiz — de
 * onde a trilha parte — nunca fica fora da tela na abertura). Substitui o
 * `fitView` da lib, que (a) roda antes de os nós existirem, porque eles
 * nascem num `useEffect`, e (b) não tem noção de "legível".
 *
 * Só matemática sobre retângulos: nada de DOM, para ser testável.
 */
export function enquadramentoInicial(conteudo: { largura: number; altura: number }, tela: { largura: number; altura: number }): Enquadramento {
  const larguraUtil = Math.max(tela.largura - MARGEM_DO_ENQUADRAMENTO * 2, 1);
  const alturaUtil = Math.max(tela.altura - MARGEM_DO_ENQUADRAMENTO * 2, 1);
  const zoomParaCaber = Math.min(larguraUtil / Math.max(conteudo.largura, 1), alturaUtil / Math.max(conteudo.altura, 1), ZOOM_MAXIMO_INICIAL);

  if (zoomParaCaber >= ZOOM_MINIMO_LEGIVEL) {
    // Cabe legível: centraliza nos dois eixos.
    const x = (tela.largura - conteudo.largura * zoomParaCaber) / 2;
    const y = (tela.altura - conteudo.altura * zoomParaCaber) / 2;
    return { x, y, zoom: zoomParaCaber };
  }

  // Não cabe legível: ancora à esquerda (a raiz fica na tela) e, na
  // vertical, centraliza se couber — o que evita a faixa morta embaixo
  // numa trilha larga e baixa.
  const alturaNaTela = conteudo.altura * ZOOM_MINIMO_LEGIVEL;
  const y = alturaNaTela <= alturaUtil ? (tela.altura - alturaNaTela) / 2 : MARGEM_DO_ENQUADRAMENTO;
  return { x: MARGEM_DO_ENQUADRAMENTO, y, zoom: ZOOM_MINIMO_LEGIVEL };
}
