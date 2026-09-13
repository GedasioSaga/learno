import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { EstiloComVariaveisCss, NoDeLinhaDeInsercao } from "./tipos-do-canvas";

/**
 * O traço que aparece DURANTE o arrasto de reordenação (soltar na MESMA raia
 * do cartão em voo) — mostra exatamente onde ele vai cair, para o usuário
 * nunca precisar adivinhar (item 3 do pedido). `TrilhaCanvas` só monta este
 * nó quando `linhaDeInsercao` não é `null` (derivado a cada quadro de
 * `onNodeDrag`, nunca gravado em `nodes` — mesmo padrão do destaque de raia
 * em `nosComCadeia`); some sozinho ao soltar ou ao sair da MESMA raia.
 *
 * Puramente decorativo, igual a `FundoDeNiveisNode`: sem handle, sem clique,
 * sem foco (`selectable:false, focusable:false, draggable:false` postos por
 * `TrilhaCanvas.tsx` no objeto do nó).
 */
function LinhaDeInsercaoNodeComponent({ data }: NodeProps<NoDeLinhaDeInsercao>) {
  const estilo: EstiloComVariaveisCss = { "--trilha-linha-insercao-largura": `${data.largura}px` };
  return <div className="trilha-linha-de-insercao" style={estilo} aria-hidden="true" />;
}

export const LinhaDeInsercaoNode = memo(LinhaDeInsercaoNodeComponent);
