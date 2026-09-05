/**
 * EDT-017: o `EditorOverlay` do item "Link para página" - autocomplete sobre
 * as páginas existentes (FUN-001's árvore, via `usePageTreeStore`), aberto
 * pelo item de menu `/` em `register.ts` e fechado por escolha, Escape ou
 * clique fora. `editor` chega como prop porque `core/Editor.tsx` chama
 * `overlay.render(editor)` com a instância viva a cada render - nunca fica
 * stale entre abrir o seletor e confirmar uma escolha.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { usePageTreeStore } from "../../../pages/store";
import { displayTitle } from "../../../pages/tree-utils";
import { linkToExistingPage } from "./actions";
import { pickablePages } from "./picker-results";
import { usePageLinkPickerStore } from "./picker-store";
import "./page-link.css";

interface PageLinkPickerProps {
  editor: TiptapEditor;
}

export function PageLinkPicker({ editor }: PageLinkPickerProps) {
  const isOpen = usePageLinkPickerStore((state) => state.isOpen);
  const query = usePageLinkPickerStore((state) => state.query);
  const setQuery = usePageLinkPickerStore((state) => state.setQuery);
  const close = usePageLinkPickerStore((state) => state.close);
  const pagesById = usePageTreeStore((state) => state.pagesById);
  const childrenIndex = usePageTreeStore((state) => state.childrenIndex);
  const currentPageId = usePageTreeStore((state) => state.selectedPageId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const results = useMemo(
    () => (currentPageId ? pickablePages(pagesById, childrenIndex, currentPageId, query) : []),
    [pagesById, childrenIndex, currentPageId, query],
  );

  if (!isOpen) return null;

  function choose(pageId: string) {
    close();
    void linkToExistingPage(editor, pageId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  }

  return (
    <div className="ed-page-link-picker-backdrop" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link para página"
        className="ed-page-link-picker"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Buscar página…"
          aria-label="Buscar página para vincular"
          className="ed-page-link-picker__input"
        />
        {results.length === 0 ? (
          <p className="ed-page-link-picker__empty">Nenhuma página encontrada.</p>
        ) : (
          <ul className="ed-page-link-picker__list" role="listbox" aria-label="Páginas">
            {results.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="ed-page-link-picker__item"
                  onClick={() => choose(page.id)}
                >
                  <span aria-hidden="true">{page.icon ?? "📄"}</span>
                  <span>{displayTitle(page)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
