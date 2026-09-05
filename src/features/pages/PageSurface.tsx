import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EmptyState } from "../../components/EmptyState";
import { createPageVersionSnapshot } from "../../lib/ipc";
import { useAutosaveDraft } from "../backup";
import { Editor } from "../editor";
import { BacklinksSection } from "./backlinks";
import { EmojiIconPicker } from "./EmojiIconPicker";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface PageSurfaceProps {
  /** Id da página a exibir. Funciona tanto para uma página comum quanto para
   *  um registro de database (`pages.database_id` — um registro É uma
   *  página), desde que já esteja em `usePageTreeStore().pagesById`. */
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
 * A superfície comum a QUALQUER página que abre um corpo de blocos: ícone
 * (FUN-011), título editável com autosave de rascunho (PLT-005) e snapshot
 * periódico (FUN-034), corpo do editor de blocos (Fase 2) e o rodapé de
 * backlinks (FUN-044).
 *
 * Extraído de `PageWorkspace` (N3 da Fase 3 — ver
 * `docs/FASE-3-ARQUITETURA.md` seção 11) para ser reusado tanto pela página
 * de árvore quanto pelo side peek/página cheia de um registro de database
 * (S1): um registro É uma página (`pages.database_id`), então o mesmo
 * ícone/título/editor/backlinks se aplicam sem duplicar a lógica.
 *
 * NÃO inclui breadcrumb, favoritar, histórico nem exportar — esse é o
 * cabeçalho de navegação que só faz sentido numa página alcançada pela
 * árvore, e continua em `PageWorkspace`.
 *
 * Trata `pageId` ausente em `pagesById` sozinha (mesmo texto de
 * "Página não encontrada" que `PageWorkspace` já mostrava), para que um
 * consumidor futuro (S1) não precise replicar essa checagem.
 */
export function PageSurface({ pageId }: PageSurfaceProps) {
  const page = usePageTreeStore((state) => state.pagesById.get(pageId));
  const rename = usePageTreeStore((state) => state.rename);
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
      <div className="flex items-center gap-2 px-8 pt-6">
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-4">
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
