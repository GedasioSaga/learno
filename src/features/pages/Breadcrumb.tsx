import { useMemo } from "react";
import type { PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface BreadcrumbProps {
  pageId: string;
}

/**
 * Sobe de `pageId` até a raiz usando só o que `pagesById` já tem carregado,
 * devolvendo a cadeia da raiz até a página aberta (a subida vai de folha a
 * raiz; o `reverse()` no fim é o que inverte para a ordem de exibição).
 * Pára — sem lançar — assim que um id não está no mapa: acontece com a
 * árvore ainda em carregamento (o próprio `pageId`, ou algum ancestral,
 * ainda não chegou) e também com um ancestral que foi para a lixeira
 * (FUN-027/030 tira da árvore ativa toda página com pai excluído, mesmo com
 * o próprio `deleted_at` nulo — ver `PageRepository::list_tree`). Nos dois
 * casos o resultado é uma trilha parcial, nunca um erro de parent_id
 * inexistente. `visited` é só uma trava defensiva contra ciclo — não deveria
 * existir um na árvore real, mas travar nele é pior que uma trilha curta.
 */
function ancestryTrail(pageId: string, pagesById: Map<string, PageRow>): PageRow[] {
  const trail: PageRow[] = [];
  const visited = new Set<string>();
  let current: string | null = pageId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const page = pagesById.get(current);
    if (!page) break;
    trail.push(page);
    current = page.parent_id;
  }
  return trail.reverse();
}

/**
 * FUN-019/FUN-045: trilha da raiz até a página aberta, clicável — derivada
 * ao vivo de `usePageTreeStore`, no mesmo padrão que `PageTree`/`Sidebar` já
 * usam (leia o seletor a cada render, nunca guarde cópia). É isto que torna
 * a trilha reativa a um ancestral renomeado enquanto a página continua
 * aberta (FUN-045): `rename()` grava a `PageRow` atualizada de volta no
 * mesmo `pagesById`, o seletor abaixo nota a mudança e o próximo render já
 * recalcula `trail` — sem remount, sem nova busca ao backend.
 */
export function Breadcrumb({ pageId }: BreadcrumbProps) {
  const status = usePageTreeStore((state) => state.status);
  const pagesById = usePageTreeStore((state) => state.pagesById);
  const selectPage = usePageTreeStore((state) => state.selectPage);

  const trail = useMemo(() => ancestryTrail(pageId, pagesById), [pageId, pagesById]);

  if (trail.length === 0) {
    // A árvore inteira chega de uma vez (`listPageTree()`, sem paginação) —
    // "carregando" é só a janela antes disso terminar; depois dela, uma
    // trilha vazia significa que `pageId` não está (mais) na árvore ativa.
    if (status === "loading" || status === "idle") {
      return <p className="text-sm text-ink-muted">Carregando…</p>;
    }
    return (
      <p role="alert" className="text-sm text-terracotta-ink">
        Não foi possível exibir a trilha desta página.
      </p>
    );
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
