import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EmptyState } from "../../components/EmptyState";
import { createPageVersionSnapshot } from "../../lib/ipc";
import { ExportMarkdownButton, useAutosaveDraft } from "../backup";
import { Editor } from "../editor";
import { VersionHistoryDialog } from "../history";
import { Breadcrumb } from "./Breadcrumb";
import { BacklinksSection } from "./backlinks";
import { EmojiIconPicker } from "./EmojiIconPicker";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface PageWorkspaceProps {
  pageId: string;
}

/**
 * FUN-034: intervalo entre snapshots automáticos de versão — mesmo valor que
 * `src-tauri/src/backup/autosave.rs` documenta como "o snapshot de versão de
 * 10 minutos".
 */
const AUTOSAVE_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * FUN-034: dispara `createPageVersionSnapshot` a cada
 * `AUTOSAVE_SNAPSHOT_INTERVAL_MS` enquanto a página está aberta, mas só
 * quando o título mudou desde o último snapshot — sem isso, deixar a página
 * simplesmente aberta e parada geraria uma versão idêntica à anterior a cada
 * 10 minutos para sempre, o que o critério ("conteúdo distintos") não pede.
 *
 * Depende só de `pageId` no efeito (não de `title`): reiniciar o timer a
 * cada tecla digitada empurraria o snapshot pra sempre "daqui a 10 minutos",
 * e o critério é sobre um intervalo fixo, não um debounce de digitação — o
 * título mais recente é lido de uma ref a cada disparo do timer.
 */
function usePeriodicVersionSnapshot(pageId: string, title: string | undefined) {
  const latestTitleRef = useRef(title);
  latestTitleRef.current = title;
  const lastSnapshotTitleRef = useRef(title);

  useEffect(() => {
    lastSnapshotTitleRef.current = title;
    if (title === undefined) return;

    const intervalId = window.setInterval(() => {
      const currentTitle = latestTitleRef.current;
      if (currentTitle === undefined || currentTitle === lastSnapshotTitleRef.current) return;
      lastSnapshotTitleRef.current = currentTitle;
      // Fase 1 não tem editor de blocos (ver `0005_page_versions.sql`): o
      // conteúdo do snapshot só espelha o título até a Fase 2 preencher isto
      // com a árvore de blocos de verdade.
      void createPageVersionSnapshot(pageId, currentTitle, { title: currentTitle });
    }, AUTOSAVE_SNAPSHOT_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [pageId, title === undefined]);
}

/**
 * Cabeçalho de uma página aberta: breadcrumb (FUN-019), ícone (FUN-011),
 * título editável e a estrela de favoritar (FUN-008 é especificamente essa
 * estrela "no topo" — a remoção pelo menu de contexto, FUN-009, mora em
 * `PageContextMenu`). O corpo abaixo monta o editor de blocos da Fase 2
 * (`features/editor`) — ver `Editor`'s próprio hook de carregamento/save.
 */
export function PageWorkspace({ pageId }: PageWorkspaceProps) {
  const page = usePageTreeStore((state) => state.pagesById.get(pageId));
  const setFavorite = usePageTreeStore((state) => state.setFavorite);
  const rename = usePageTreeStore((state) => state.rename);
  const [historyOpen, setHistoryOpen] = useState(false);
  // PLT-005: the title is the only editable surface Phase 1 has (the block
  // editor is Phase 2) — `saveDraft` writes a draft to disk on every
  // keystroke, `clearDraft` only erases it once `rename` confirms the title
  // actually reached Postgres.
  const { saveDraft, clearDraft } = useAutosaveDraft(pageId);

  usePeriodicVersionSnapshot(pageId, page?.title);

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
          <EmojiIconPicker
            pageId={page.id}
            currentIcon={page.icon}
            triggerLabel={`Ícone de ${displayTitle(page)}`}
          />
          <TitleField
            title={page.title}
            onDraftChange={(title) => saveDraft(title, { title })}
            onCommit={(title) => {
              if (title !== page.title) {
                void rename(page.id, title).then(
                  () => {
                    // Only erase the draft once the title is actually
                    // confirmed in Postgres — if `rename` fails, the draft
                    // stays on disk as the safety net for the next recovery
                    // (see `RecoveryBanner`).
                    void clearDraft().catch(() => undefined);
                  },
                  () => undefined,
                );
              } else {
                // Nothing changed (e.g. the user typed something then
                // undid it before leaving the field) — any pending draft
                // already matches what's saved, so there's no reason to
                // keep it around until the next crash.
                void clearDraft().catch(() => undefined);
              }
            }}
          />
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

      <div className="min-h-0 flex-1 overflow-y-auto p-8">
        {/* `key={page.id}` força uma instância nova do editor por página —
            sem isso, a subárvore React de um <Editor> saindo de "Aula 1"
            para "Aula 2" seria só re-renderizada, e o `useEditor` interno
            já cuida da troca de conteúdo via seu próprio array de deps
            (`use-blocks-document.ts`), mas o `key` garante que nenhum
            estado de DOM/seleção de uma página vaze visualmente para a
            próxima durante o frame de transição. */}
        <Editor key={page.id} pageId={page.id} />
        <BacklinksSection pageId={page.id} />
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

/**
 * `onDraftChange` fires on every keystroke (PLT-005 debounces internally in
 * `useAutosaveDraft`); `onCommit` only fires when the field is left — two
 * deliberately different paths: one guards against a crash while the user
 * is still editing, the other is what actually persists to Postgres.
 */
function TitleField({
  title,
  onDraftChange,
  onCommit,
}: {
  title: string;
  onDraftChange: (title: string) => void;
  onCommit: (title: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(title), [title]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(title);
      inputRef.current?.blur();
    }
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraft(value);
        onDraftChange(value);
      }}
      onBlur={() => onCommit(draft)}
      onKeyDown={handleKeyDown}
      placeholder="Sem título"
      aria-label="Título da página"
      className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 font-display text-2xl text-ink outline-none
        focus-visible:bg-surface-sunken"
    />
  );
}
