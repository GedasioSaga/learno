import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { VersionHistoryDialog } from "../history";
import { Breadcrumb } from "./Breadcrumb";
import { MoveToDialog } from "./MoveToDialog";
import { PageOptionsMenu } from "./PageOptionsMenu";
import { PageSurface } from "./PageSurface";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface PageWorkspaceProps {
  pageId: string;
}

/**
 * Cabeçalho de navegação de uma página aberta pela árvore: breadcrumb
 * (FUN-019), favoritar (FUN-008 é especificamente a estrela "no topo" — a
 * remoção pelo menu de contexto, FUN-009, mora em `PageContextMenu`) e o
 * "•••" de opções da página (`PageOptionsMenu`) — fonte, texto pequeno,
 * largura total, duplicar, mover, histórico (FUN-035) e exportar (FUN-023).
 * Nenhum desses faz sentido para um registro de database aberto em side
 * peek/página cheia (S1) — por isso ficaram aqui, e não em `PageSurface`
 * (N3), quando o corpo (ícone + título editável + editor de blocos +
 * backlinks) foi extraído de dentro deste arquivo para lá. Ver
 * `docs/FASE-3-ARQUITETURA.md` seção 11.
 */
export function PageWorkspace({ pageId }: PageWorkspaceProps) {
  const page = usePageTreeStore((state) => state.pagesById.get(pageId));
  const setFavorite = usePageTreeStore((state) => state.setFavorite);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);

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
      {/* Uma linha só: a trilha ocupa o espaço, as ações encostam à direita.
          Antes eram três linhas empilhadas, e "Exportar como Markdown" saía
          numa faixa da largura inteira — o elemento mais gritante da tela era
          o mais raro de usar. Ação secundária tem tamanho de ação
          secundária. */}
      <header className="flex items-center gap-3 border-b border-hairline px-8 py-3">
        {/* FUN-019/FUN-045: `Breadcrumb` deriva a trilha da store da árvore,
            então renomear um ancestral com a página aberta já atualiza aqui —
            sem remount e sem ida nova ao backend. */}
        <div className="min-w-0 flex-1">
          <Breadcrumb pageId={pageId} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-pressed={page.is_favorite}
            aria-label={page.is_favorite ? "Remover dos favoritos" : "Favoritar"}
            onClick={() => void setFavorite(page.id, !page.is_favorite)}
            className="grid size-8 place-items-center rounded-sm text-lg text-amber transition-transform duration-150 ease-out active:scale-90"
          >
            {page.is_favorite ? "★" : "☆"}
          </button>
          <PageOptionsMenu
            page={page}
            onRequestHistory={() => setHistoryOpen(true)}
            onRequestMoveTo={() => setMoveDialogOpen(true)}
          />
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
      <MoveToDialog page={moveDialogOpen ? page : null} onClose={() => setMoveDialogOpen(false)} />
    </div>
  );
}
