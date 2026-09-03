import { useEffect, useMemo, useRef, useState } from "react";
import type { PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { displayTitle, searchMoveTargets } from "./tree-utils";

interface MoveToDialogProps {
  page: PageRow | null;
  onClose: () => void;
}

/**
 * FUN-022: reparenteia por busca, sem arrastar. `<dialog>` nativo dá foco
 * preso, fechar com Escape e o `::backdrop` de graça — só o fechar-ao-clicar-
 * no-fundo precisa de uma linha (`event.target === event.currentTarget`,
 * porque o clique dentro do conteúdo também borbulha até o próprio `<dialog>`).
 */
export function MoveToDialog({ page, onClose }: MoveToDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const pagesById = usePageTreeStore((state) => state.pagesById);
  const childrenIndex = usePageTreeStore((state) => state.childrenIndex);
  const move = usePageTreeStore((state) => state.move);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `showModal`/`close` (ver `dom-compat.ts`): existem de verdade no
    // WebView2, mas o jsdom dos testes de componente não os implementa.
    if (page) {
      setQuery("");
      if (typeof dialog.showModal === "function") dialog.showModal();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
  }, [page]);

  const results = useMemo(() => {
    if (!page) return [];
    return searchMoveTargets([...pagesById.values()], query, page.id, childrenIndex);
  }, [page, query, pagesById, childrenIndex]);

  async function moveTo(targetId: string | null) {
    if (!page) return;
    await move(page.id, targetId, { type: "end" });
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onCancel={onClose}
      className="w-full max-w-sm rounded-md border border-border bg-surface p-0 text-ink shadow-hard backdrop:bg-ink/40"
    >
      {page ? (
        <div className="p-4">
          <h2 className="font-display text-lg text-ink">
            Mover &ldquo;{displayTitle(page)}&rdquo; para
          </h2>

          <label className="sr-only" htmlFor="move-to-search">
            Buscar página de destino
          </label>
          <input
            id="move-to-search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Buscar por título..."
            className="mt-3 w-full rounded-sm border border-border bg-paper px-3 py-2 text-sm text-ink"
          />

          <ul className="mt-3 max-h-64 overflow-y-auto" role="listbox" aria-label="Páginas de destino">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => void moveTo(null)}
                className="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-sunken"
              >
                📚 Raiz (sem página-pai)
              </button>
            </li>
            {results.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => void moveTo(candidate.id)}
                  className="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-sunken"
                >
                  {candidate.icon ?? "📄"} {displayTitle(candidate)}
                </button>
              </li>
            ))}
            {results.length === 0 && query.trim() !== "" ? (
              <li className="px-2 py-1.5 text-sm text-ink-muted">Nenhuma página encontrada.</li>
            ) : null}
          </ul>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-border px-3 py-1.5 text-sm text-ink"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
