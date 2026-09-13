import type { Edge, Node } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { EtapaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";
import type { CorDeRaia } from "./cores-de-raia";

/**
 * Mesma reabertura de `PageSurface.tsx`: o `CSSProperties` do `@types/react`
 * instalado não tem assinatura de índice para propriedade customizada
 * (`--nivel`, `--progresso`) — reabre só para `--*`, sem abrir mão da
 * checagem de tipo em nenhuma outra propriedade de `style`. Aceita `number`
 * também: React serializa para string ao aplicar no DOM, e `--nivel`/
 * `--progresso` entram em `calc()` sem unidade no CSS, então um número puro
 * já é o valor certo.
 */
export interface EstiloComVariaveisCss extends CSSProperties {
  [propriedade: `--${string}`]: string | number | undefined;
}

/**
 * Os três tipos de nó do canvas da Trilha. `type`, não `interface`, pelo
 * mesmo motivo de `NoDoMapa` em `mapa-mental/store.ts`: `Node<NodeData>`
 * exige `NodeData extends Record<string, unknown>`, e só um alias de objeto
 * ganha a assinatura de índice implícita que satisfaz essa constraint.
 *
 * Nenhum dos três é filho (`parentId`) de outro — raia, coluna de nível e
 * etapa são nós IRMÃOS, todos posicionados em coordenadas absolutas do
 * canvas por `layout.ts`. Decisão consciente: o `@xyflow/react` suporta
 * sub-fluxos (nó pai/filho) e o texto de `docs/DESIGN-TRILHA.md` linha 25
 * ("o nó filho não é descendente DOM do nó pai") lembra esse recurso, mas
 * usá-lo aqui exigiria filhos ordenados depois do pai no array e herdar
 * comportamento de arrasto/extensão que a Trilha não quer (nada arrasta —
 * ver `TrilhaCanvas.tsx`). Posição absoluta simples entrega a mesma
 * aparência final com menos superfície de bug.
 */
export type DadosDoNoDeEtapa = {
  etapa: EtapaDaTrilha;
  /** `null` quando a raia da etapa não está no mapa de cores (defensivo — não deveria acontecer). Cai em `--border` no CSS. */
  cor: CorDeRaia | null;
  /**
   * Os dois pesos de orientação (`orientacao.ts`), já resolvidos por
   * `TrilhaCanvas` porque precisam da trilha inteira. Opcionais de
   * propósito: ausente vale `false`, e um `EtapaNode` montado sozinho (os
   * testes fazem isso) continua sendo um cartão comum.
   */
  marco?: boolean;
  proxima?: boolean;
};
export type NoDeEtapa = Node<DadosDoNoDeEtapa, "trilhaEtapa">;

export type DadosDoNoDeRaia = {
  raia: RaiaDaTrilha;
  cor: CorDeRaia | null;
  totalEtapas: number;
  concluidas: number;
};
export type NoDeRaia = Node<DadosDoNoDeRaia, "trilhaRaia">;

/**
 * UM nó só para as colunas de nível, cobrindo o canvas inteiro — nunca um
 * nó por nível. É a única forma de usar a régua da CSS como o comentário de
 * `trilha.css` descreve (`.trilha-nivel{ left: calc(var(--nivel) * passo) }`,
 * uma posição relativa ao PRÓPRIO contêiner): se cada coluna fosse um nó
 * independente já posicionado em `x = nível·passo` pelo `@xyflow`, o `left`
 * da CSS somaria OUTRA vez o mesmo deslocamento, dobrando-o.
 */
export type DadosDoNoDeFundo = { totalNiveis: number };
export type NoDeFundo = Node<DadosDoNoDeFundo, "trilhaFundo">;

/**
 * A linha de inserção do arrasto de reordenação (item 3 do pedido: "não
 * deixe o usuário adivinhar onde o cartão vai cair" quando solta na MESMA
 * raia). Só existe enquanto `TrilhaCanvas` calcula uma (`linhaDeInsercao`,
 * derivado a cada quadro de `onNodeDrag` — nunca gravado em `nodes`, mesmo
 * padrão do destaque `trilha-raia-no--alvo-do-arrasto`) — nunca é um nó
 * arrastável/selecionável, só um traço.
 */
export type DadosDoNoDeLinhaDeInsercao = { largura: number };
export type NoDeLinhaDeInsercao = Node<DadosDoNoDeLinhaDeInsercao, "trilhaLinhaDeInsercao">;

export type NoDoCanvas = NoDeEtapa | NoDeRaia | NoDeFundo | NoDeLinhaDeInsercao;

export type DadosDaFlecha = { blockedId: string; blockingId: string };

/**
 * `type: "default"` (bezier embutido do `@xyflow/react`, não um componente
 * de aresta próprio — DESIGN-TRILHA.md §4 só pede curvatura e cor, nada que
 * justifique escrever um `EdgeComponent` do zero) com `pathOptions`, que o
 * tipo `Edge<...>` exportado pelo pacote não inclui (`BezierEdge`, que
 * inclui, não é exportado — só o componente de mesmo nome). Repete a forma
 * dele: `Edge<EdgeData,'default'> & { pathOptions?: { curvature } }`.
 */
/**
 * `"smoothstep"` e não `"default"`: a flecha da Trilha é um conector de
 * fluxograma, não uma curva. Ângulo reto com canto arredondado deixa o
 * caminho da dependência legível quando várias flechas atravessam a mesma
 * faixa — bézier sobreposta vira um novelo e o usuário perde qual etapa
 * bloqueia qual. `borderRadius` é o raio do canto; `curvature` não existe
 * neste tipo de aresta.
 */
export type FlechaDoCanvas = Edge<DadosDaFlecha, "smoothstep"> & { pathOptions?: { borderRadius?: number } };
