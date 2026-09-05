/**
 * FUN-045 (a metade difícil): o texto que mostra o título de outra página
 * precisa mudar assim que ela é renomeada, sem esperar reload nem qualquer
 * refetch manual. `usePageTreeStore` (`../store.ts`) já é a fonte reativa
 * certa para isso — `rename()` grava a `PageRow` atualizada de volta no
 * mesmo `Map` (`pagesById`), e o Zustand já notifica todo componente
 * assinado a esse seletor na hora. Não existe mecanismo novo de invalidação
 * para inventar aqui: o mecanismo é "leia o título por `id` deste store a
 * cada render, nunca guarde uma cópia dele no momento em que o vínculo foi
 * criado". `marks/mention-page/mention-page-node-view.ts` (outro
 * construtor, mesma rodada) chega à mesma conclusão pelo mesmo motivo, só
 * que fora do React (NodeView vanilla, com `usePageTreeStore.subscribe`
 * direto) — este hook é a versão para quem está em JSX, como
 * `BacklinksSection` abaixo.
 *
 * Ver `use-page-title.test.tsx` para a prova de que renomear dispara a
 * re-renderização sem remount.
 */
import { usePageTreeStore } from "../store";
import { displayTitle } from "../tree-utils";

/**
 * `fallback` cobre uma página que o chamador referencia por id mas que a
 * store ainda não carregou (recém-criada em outra sessão, por exemplo, ou o
 * `listPageTree()` inicial ainda em voo) — sem título conhecido, mostra isto
 * em vez de uma string vazia.
 */
export function usePageTitle(pageId: string, fallback = "Sem título"): string {
  return usePageTreeStore((state) => {
    const page = state.pagesById.get(pageId);
    return page ? displayTitle(page) : fallback;
  });
}
