/**
 * EDT-017/FUN-003/FUN-043: registra o bloco "link para página" nos cinco
 * pontos de `core/block-spec.ts` - ver o README do editor para o porquê de
 * cada um. Este arquivo nunca é importado por ninguém: `core/
 * discover-extensions.ts` o descobre via `import.meta.glob`.
 */
import { createElement } from "react";
import { registerBlockSpec, registerEditorOverlay, registerSlashMenuItem, registerTurnIntoItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { usePageTreeStore } from "../../../pages/store";
import { displayTitle } from "../../../pages/tree-utils";
import { createSubPageAndInsert } from "./actions";
import { BLOCK_TYPE, LinkToPage, NODE_NAME } from "./node";
import { PageLinkPicker } from "./PageLinkPicker";
import { usePageLinkPickerStore } from "./picker-store";
import "./page-link.css";

registerBlockExtension(LinkToPage);

registerBlockSpec({
  blockType: BLOCK_TYPE,
  nodeName: NODE_NAME,
  hasContent: false,
  serialization: {
    attrs: (_blockType, content) => ({
      pageId: typeof content.pageId === "string" ? content.pageId : null,
    }),
    content: (attrs) => ({
      pageId: typeof attrs.pageId === "string" ? attrs.pageId : null,
    }),
    // Resolvido ao vivo em `usePageTreeStore` a cada serialização (salvar
    // aciona `docToFlatBlocks`, ver `use-blocks-document.ts`), nunca
    // congelado num campo próprio - é o que faz FUN-045 (renomear propaga)
    // valer também para o texto buscável deste bloco, não só para a tela.
    plainText: (content) => {
      if (typeof content.pageId !== "string") return "";
      const page = usePageTreeStore.getState().pagesById.get(content.pageId);
      return page ? displayTitle(page) : "";
    },
  },
});

registerSlashMenuItem([
  {
    id: "blocks:link-to-page",
    title: "Link para página",
    keywords: ["link", "pagina", "página", "vincular", "referencia"],
    group: "Páginas",
    icon: "🔗",
    // Não insere nada por si - abre o seletor (`PageLinkPicker`), que
    // insere ao confirmar. `insertBlockHere` exige um `pageId` de saída
    // (não existe "átomo vazio depois preenchido" no contrato de
    // `BlockSpec`), então não há como inserir antes de saber o alvo.
    run: (_editor) => {
      if (!usePageTreeStore.getState().selectedPageId) return false;
      usePageLinkPickerStore.getState().open();
      return true;
    },
  },
  {
    id: "blocks:sub-page",
    title: "Sub-página",
    keywords: ["page", "subpagina", "sub-página", "nova pagina"],
    group: "Páginas",
    icon: "📄",
    run: (editor) => {
      if (!usePageTreeStore.getState().selectedPageId) return false;
      // Async por natureza (cria a página antes de saber o `pageId` do
      // bloco) - `run` só precisa dizer que a ação começou. Uma falha do
      // lado do backend já fica em `usePageTreeStore.errorMessage`
      // (`createChild` a grava lá antes de rejeitar), então não há um
      // segundo canal de erro para repetir aqui.
      void createSubPageAndInsert(editor).catch(() => undefined);
      return true;
    },
  },
]);

registerEditorOverlay({
  id: "blocks:page-link-picker",
  render: (editor) => createElement(PageLinkPicker, { editor }),
});

// EDT-049: "Transformar em" > "Sub-página" - só "Sub-página" foi pedida
// ("Link para página" abre um seletor, que não cabe no contrato síncrono de
// `TurnIntoItem.run`, e não foi pedida). Mesmo corpo do item "/" acima
// (linha 66) - duplicado, não extraído: são só duas chamadas, abaixo do
// limiar de 3 usos reais deste projeto para abstrair. `createSubPageAndInsert`
// já chama `insertBlockHere` por baixo (`actions.ts`), então um bloco com
// texto mantém seu texto e ganha o link como próximo irmão - nada some.
registerTurnIntoItem({
  id: "blocks:turn:sub-page",
  title: "Sub-página",
  group: "Páginas",
  icon: "📄",
  run: (editor) => {
    if (!usePageTreeStore.getState().selectedPageId) return false;
    void createSubPageAndInsert(editor).catch(() => undefined);
    return true;
  },
});
