import { useEffect, useState } from "react";
import { AppError, getPageBreadcrumb, type PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface BreadcrumbProps {
  pageId: string;
}

/**
 * FUN-019: trilha da raiz até a página aberta, clicável. Busca no backend
 * (`get_page_breadcrumb`) em vez de subir `parent_id` pelo que já está em
 * memória — a store só garante ter a página selecionada e seus ancestrais
 * carregados via `selectPage`, então isto é a fonte de verdade mesmo que a
 * árvore completa ainda não tenha chegado.
 */
export function Breadcrumb({ pageId }: BreadcrumbProps) {
  const selectPage = usePageTreeStore((state) => state.selectPage);
  const [trail, setTrail] = useState<PageRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrail(null);
    setErrorMessage(null);

    getPageBreadcrumb(pageId)
      .then((rows) => {
        if (!cancelled) setTrail(rows);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof AppError ? error.message : "Não foi possível carregar a trilha.");
      });

    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (errorMessage) {
    return (
      <p role="alert" className="text-sm text-terracotta-ink">
        {errorMessage}
      </p>
    );
  }

  if (!trail) {
    return <p className="text-sm text-ink-muted">Carregando…</p>;
  }

  return (
    <nav aria-label="Trilha de navegação">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-muted">
        {trail.map((page, index) => {
          const isCurrent = index === trail.length - 1;
          return (
            <li key={page.id} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              {isCurrent ? (
                <span aria-current="page" className="font-medium text-ink">
                  {page.icon ?? "📄"} {displayTitle(page)}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => selectPage(page.id)}
                  className="rounded-sm px-1 hover:bg-surface-sunken hover:text-ink"
                >
                  {page.icon ?? "📄"} {displayTitle(page)}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
