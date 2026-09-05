import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ExportMarkdownButton } from "../backup";
import { VersionHistoryDialog } from "../history";
import { Breadcrumb } from "./Breadcrumb";
import { PageSurface } from "./PageSurface";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface PageWorkspaceProps {
  pageId: string;
}

/**
 * Cabeçalho de navegação de uma página aberta pela árvore: breadcrumb
 * (FUN-019), favoritar (FUN-008 é especificamente a estrela "no topo" — a
 * remoção pelo menu de contexto, FUN-009, mora em `PageContextMenu`),
 * histórico (FUN-035) e exportar (FUN-023). Nenhum desses faz sentido para
 * um registro de database aberto em side peek/página cheia (S1) — por isso
 * ficaram aqui, e não em `PageSurface` (N3), quando o corpo (ícone + título
 * editável + editor de blocos + backlinks) foi extraído de dentro deste
 * arquivo para lá. Ver `docs/FASE-3-ARQUITETURA.md` seção 11.
 */
export function PageWorkspace({ pageId }: PageWorkspaceProps) {
  const page = usePageTreeStore((state) => state.pagesById.get(pageId));
  const setFavorite = usePageTreeStore((state) => state.setFavorite);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!page) {
    return (
      <EmptyState
        title="Página não encontrada"
        description="Ela pode ter sido excluída ou ainda não terminou de carregar."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-4">
        {/* FUN-019/FUN-045: `Breadcrumb` deriva a trilha da store da árvore,
            então renomear um ancestral com a página aberta já atualiza aqui —
            sem remount e sem ida nova ao backend. */}
        <Breadcrumb pageId={pageId} />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            aria-pressed={page.is_favorite}
            aria-label={page.is_favorite ? "Remover dos favoritos" : "Favoritar"}
            onClick={() => void setFavorite(page.id, !page.is_favorite)}
            className="grid size-8 shrink-0 place-items-center rounded-sm text-lg text-amber transition-transform active:scale-90"
          >
            {page.is_favorite ? "★" : "☆"}
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="shrink-0 rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none"
          >
            Histórico
          </button>
        </div>
        <div className="mt-2">
          <ExportMarkdownButton pageId={page.id} pageTitle={page.title} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <PageSurface pageId={pageId} />
      </div>

      <VersionHistoryDialog
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        pageId={page.id}
        pageTitle={displayTitle(page)}
      />
    </div>
  );
}
