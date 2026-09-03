import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { PageRow } from "../../lib/ipc";
import { EmojiIconPicker } from "./EmojiIconPicker";
import { PageContextMenu } from "./PageContextMenu";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

export type DropIndicator = "before" | "after" | "nest" | null;

interface PageTreeItemProps {
  page: PageRow;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  isRovingTarget: boolean;
  dropIndicator: DropIndicator;
  onToggleExpand: () => void;
  onSelect: () => void;
  onFocusRow: () => void;
  onKeyDownRow: (event: KeyboardEvent<HTMLDivElement>) => void;
  onDragStartRow: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragOverRow: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragLeaveRow: (id: string) => void;
  onDropRow: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDragEndRow: () => void;
  onRequestMoveTo: (page: PageRow) => void;
  registerRef: (id: string, element: HTMLDivElement | null) => void;
}

/** Cada 16px de recuo é um nível de profundidade — sem teto (FUN-001). */
const INDENT_PER_DEPTH_PX = 16;

const DROP_INDICATOR_CLASS: Record<Exclude<DropIndicator, null>, string> = {
  before: "before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full before:bg-emerald",
  after: "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-emerald",
  nest: "outline outline-2 outline-offset-[-2px] outline-emerald",
};

/**
 * Uma linha da árvore. FUN-002 (botão + só aparece no hover/foco — não é uma
 * ação de alta frequência que precise ficar sempre visível, então some por
 * padrão em vez de disputar espaço com o título o tempo todo).
 */
export function PageTreeItem({
  page,
  depth,
  hasChildren,
  expanded,
  selected,
  isRovingTarget,
  dropIndicator,
  onToggleExpand,
  onSelect,
  onFocusRow,
  onKeyDownRow,
  onDragStartRow,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
  onDragEndRow,
  onRequestMoveTo,
  registerRef,
}: PageTreeItemProps) {
  const rename = usePageTreeStore((state) => state.rename);
  const createChild = usePageTreeStore((state) => state.createChild);
  const pendingFocusId = usePageTreeStore((state) => state.pendingFocusId);
  const consumePendingFocus = usePageTreeStore((state) => state.consumePendingFocus);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(page.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  function startRenaming() {
    setDraftTitle(page.title);
    setIsRenaming(true);
  }

  // FUN-002: a página nasce pelo `+` já com foco no título — a linha só
  // existe no DOM a partir deste render, então é aqui (não em `createChild`)
  // que a intenção guardada em `pendingFocusId` vira, de fato, modo de edição.
  // `startRenaming`/`consumePendingFocus` ficam fora da lista de dependências
  // de propósito: são a função e a ação da store deste módulo, recriadas a
  // cada render sem nunca mudar de comportamento — incluí-las dispararia o
  // efeito de novo sem nenhuma mudança real de estado para reagir.
  useEffect(() => {
    if (pendingFocusId === page.id) {
      startRenaming();
      consumePendingFocus(page.id);
    }
  }, [pendingFocusId, page.id]);

  async function commitRename() {
    setIsRenaming(false);
    const trimmed = draftTitle;
    if (trimmed === page.title) return;
    await rename(page.id, trimmed);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setIsRenaming(false);
      setDraftTitle(page.title);
    }
    // Não deixa a tecla borbulhar para o atalho de navegação da árvore
    // (setas/Alt+setas) enquanto o usuário está digitando o título.
    event.stopPropagation();
  }

  /** F2 entra em edição aqui, porque só esta linha sabe seu próprio estado de edição; todo o resto delega para a navegação da árvore. */
  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "F2") {
      event.preventDefault();
      startRenaming();
      return;
    }
    onKeyDownRow(event);
  }

  return (
    <div
      ref={(element) => registerRef(page.id, element)}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={depth + 1}
      tabIndex={isRovingTarget ? 0 : -1}
      draggable={!isRenaming}
      onFocus={onFocusRow}
      onKeyDown={handleRowKeyDown}
      onDragStart={(event) => onDragStartRow(page.id, event)}
      onDragOver={(event) => onDragOverRow(page.id, event)}
      onDragLeave={() => onDragLeaveRow(page.id)}
      onDrop={(event) => onDropRow(page.id, event)}
      onDragEnd={onDragEndRow}
      style={{ paddingLeft: depth * INDENT_PER_DEPTH_PX }}
      className={`group relative flex items-center gap-1 rounded-sm py-1 pr-1 text-sm outline-none
        ${selected ? "bg-surface-sunken text-ink" : "text-ink hover:bg-surface-sunken/60"}
        ${dropIndicator ? DROP_INDICATOR_CLASS[dropIndicator] : ""}`}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        aria-label={hasChildren ? (expanded ? "Recolher" : "Expandir") : undefined}
        tabIndex={-1}
        className={`grid size-5 shrink-0 place-items-center rounded-sm text-ink-muted transition-transform duration-150
          ${expanded ? "rotate-90" : ""} ${hasChildren ? "" : "invisible"}`}
      >
        ▶
      </button>

      <EmojiIconPicker
        pageId={page.id}
        currentIcon={page.icon}
        triggerLabel={`Ícone de ${displayTitle(page)}`}
      />

      {isRenaming ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.currentTarget.value)}
          onBlur={() => void commitRename()}
          onKeyDown={handleTitleKeyDown}
          aria-label={`Título de ${displayTitle(page)}`}
          className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-1 py-0.5 text-sm text-ink"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={startRenaming}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-left"
        >
          {displayTitle(page)}
        </button>
      )}

      {page.is_favorite ? (
        <span aria-label="Favorita" title="Favorita" className="shrink-0 text-xs text-amber">
          ★
        </span>
      ) : null}

      <button
        type="button"
        tabIndex={-1}
        onClick={() => void createChild(page.id)}
        aria-label={`Adicionar subpágina em ${displayTitle(page)}`}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted opacity-0
          transition-opacity hover:bg-surface hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        +
      </button>

      <PageContextMenu page={page} onRequestRename={startRenaming} onRequestMoveTo={() => onRequestMoveTo(page)} />
    </div>
  );
}
