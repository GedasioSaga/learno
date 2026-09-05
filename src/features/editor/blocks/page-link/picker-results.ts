/**
 * Filtro puro por trás da lista do seletor de "Link para página" - separado
 * de `PageLinkPicker.tsx` para ser testável sem montar componente nenhum.
 *
 * Exclui a própria página atual (linkar uma página a ela mesma não faz
 * sentido) e qualquer página da qual a atual já é descendente
 * (`isValidDropTarget`, de `pages/tree-utils`, é exatamente essa checagem -
 * aqui invertida: o candidato a alvo é o "arrastado", a página atual é o
 * "destino" do reparent que a escolha vai disparar) - escolher uma dessas
 * reparentearia um ancestral da própria página atual para dentro dela,
 * o ciclo que `move_block`/`move_page` já rejeita no backend, então isto só
 * evita oferecer a opção na lista antes de tentar.
 */
import type { PageRow } from "../../../../lib/ipc";
import { isValidDropTarget } from "../../../pages/tree-utils";

const MAX_RESULTS = 50;

export function pickablePages(
  pagesById: Map<string, PageRow>,
  childrenIndex: Map<string | null, PageRow[]>,
  currentPageId: string,
  query: string,
): PageRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  return [...pagesById.values()]
    .filter((page) => page.id !== currentPageId)
    .filter((page) => isValidDropTarget(page.id, currentPageId, childrenIndex))
    .filter((page) => normalizedQuery === "" || page.title.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"))
    .slice(0, MAX_RESULTS);
}
