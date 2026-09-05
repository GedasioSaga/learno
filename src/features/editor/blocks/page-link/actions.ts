/**
 * FUN-043: o que separa este bloco da @menção (EDT-044, outro construtor) -
 * inserir um link-to-page pede ao backend para reparentear a página alvo sob
 * a página atual; a menção nunca chama nada parecido. As duas funções
 * abaixo são a única porta de entrada para inserir este bloco no editor,
 * exatamente para que esse pedido nunca seja esquecido em um dos dois
 * caminhos (página existente via seletor, sub-página nova via "/page").
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { insertBlockHere } from "../../core/commands";
import { usePageTreeStore } from "../../../pages/store";
import { NODE_NAME } from "./node";

/**
 * FUN-043: reparenteia `targetPageId` como última filha de `currentPageId`.
 * `usePageTreeStore.move` já cobre IPC + atualização do índice de filhos que
 * a sidebar lê - reimplementar isso aqui duplicaria exatamente a lógica que
 * `store.ts` existe para centralizar.
 */
async function reparentUnderCurrentPage(targetPageId: string, currentPageId: string): Promise<void> {
  // Um alvo já filtrado pelo seletor (`picker-results.ts`) nunca chega aqui
  // sendo a própria página atual, mas a lista em memória pode ter ficado
  // stale entre a renderização e o clique - checar de novo custa nada.
  if (targetPageId === currentPageId) return;
  await usePageTreeStore.getState().move(targetPageId, currentPageId, { type: "end" });
}

/**
 * EDT-017/FUN-043: "Link para página" confirmado sobre uma página existente.
 * Reparenteia primeiro - é essa chamada que existe para provar, não a ordem
 * em si - e só insere o bloco depois que ela resolve, para nunca deixar um
 * link-to-page na árvore de blocos apontando para uma página cujo reparent
 * falhou silenciosamente.
 */
export async function linkToExistingPage(editor: TiptapEditor, targetPageId: string): Promise<boolean> {
  const currentPageId = usePageTreeStore.getState().selectedPageId;
  if (!currentPageId) return false;
  await reparentUnderCurrentPage(targetPageId, currentPageId);
  if (editor.isDestroyed) return false;
  return insertBlockHere(editor, NODE_NAME, { pageId: targetPageId });
}

/**
 * FUN-003: "/page" cria a sub-página primeiro (já nascendo filha de
 * `currentPageId` via `createPage`'s próprio `parentId` - sem reparent
 * separado, diferente de `linkToExistingPage` acima) e só então insere o
 * bloco que aponta para ela.
 */
export async function createSubPageAndInsert(editor: TiptapEditor): Promise<boolean> {
  const currentPageId = usePageTreeStore.getState().selectedPageId;
  if (!currentPageId) return false;
  const newPage = await usePageTreeStore.getState().createChild(currentPageId);
  if (editor.isDestroyed) return false;
  return insertBlockHere(editor, NODE_NAME, { pageId: newPage.id });
}
