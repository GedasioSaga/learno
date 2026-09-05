/**
 * EDT-017: mostra o ícone e o título da página apontada e navega até ela ao
 * clicar. Título/ícone vêm de `usePageTreeStore` resolvidos pelo `pageId` a
 * cada render (FUN-045: renomear a página em qualquer lugar do app propaga
 * pra cá sozinho, porque não há cópia local do título para ficar velha).
 */
import type { KeyboardEvent } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { usePageTreeStore } from "../../../pages/store";
import { displayTitle } from "../../../pages/tree-utils";
import { NODE_NAME } from "./node";

const DEFAULT_PAGE_ICON = "📄";

export function LinkToPageView({ node, ref, selected }: ReactNodeViewProps<HTMLDivElement>) {
  const pageId = typeof node.attrs.pageId === "string" ? node.attrs.pageId : null;
  const page = usePageTreeStore((state) => (pageId ? state.pagesById.get(pageId) : undefined));
  const selectPage = usePageTreeStore((state) => state.selectPage);

  // Página nunca carregada (ainda salvando) ou apagada de vez depois de
  // vinculada: nada aqui tenta adivinhar um título antigo, só avisa.
  const missing = pageId === null || page === undefined;
  const title = missing ? "Página não encontrada" : displayTitle(page);
  const icon = missing ? "⚠️" : (page.icon ?? DEFAULT_PAGE_ICON);

  function navigate() {
    if (pageId) selectPage(pageId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    navigate();
  }

  return (
    // `NodeViewWrapper`, não uma `<div>` própria: `ReactNodeViewRenderer`
    // exige que a raiz renderizada carregue `data-node-view-wrapper` (é o
    // que ele usa pra achar o DOM real por trás do `<div class="react-
    // renderer">` que instancia por fora) - ver o próprio erro que dispara
    // sem isto ("Please use the NodeViewWrapper component").
    <NodeViewWrapper
      ref={ref}
      className={`ed-block ed-link-to-page${selected ? " ed-link-to-page--selected" : ""}${missing ? " ed-link-to-page--missing" : ""}`}
      data-block-type={NODE_NAME}
      data-block-id={typeof node.attrs.id === "string" ? node.attrs.id : undefined}
      contentEditable={false}
      role="button"
      tabIndex={missing ? -1 : 0}
      aria-disabled={missing}
      aria-label={missing ? "Página vinculada não encontrada" : `Abrir página ${title}`}
      onClick={missing ? undefined : navigate}
      onKeyDown={missing ? undefined : handleKeyDown}
    >
      <span className="ed-link-to-page__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ed-link-to-page__title">{title}</span>
    </NodeViewWrapper>
  );
}
