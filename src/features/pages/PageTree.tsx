import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { PageRow } from "../../lib/ipc";
import { MoveToDialog } from "./MoveToDialog";
import { PageTreeItem, type DropIndicator } from "./PageTreeItem";
import { usePageTreeStore } from "./store";
import { TrashDialog } from "./TrashDialog";
import {
  computeKeyboardMove,
  displayTitle,
  dropPositionRelativeToSibling,
  flattenVisibleTree,
  isValidDropTarget,
  type FlatPageNode,
  type KeyboardMoveAction,
} from "./tree-utils";

type DragZone = Exclude<DropIndicator, null>;

interface ActiveDropTarget {
  overId: string;
  zone: DragZone;
}

/** Terço de cima solta ANTES, terço de baixo solta DEPOIS, meio ANINHA — ver `emil-kowalski-ui-craft` sobre indicador de posição em drag-and-drop. */
function zoneFromPointerY(event: DragEvent<HTMLDivElement>): DragZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "nest";
}

const KEY_TO_KEYBOARD_MOVE: Record<string, KeyboardMoveAction> = {
  ArrowUp: "reorder-up",
  ArrowDown: "reorder-down",
  ArrowRight: "nest",
  ArrowLeft: "unnest",
};

/**
 * FUN-001/002/004/005/006/008/009/011/020/022: a árvore de páginas na barra
 * lateral. Arrastar-e-soltar (mouse) e Alt+seta (teclado) chamam a mesma
 * ação `move` da store com o mesmo par (novo pai, posição) — só muda como
 * esse par é decidido, não o que ele faz depois.
 */
export function PageTree() {
  const status = usePageTreeStore((state) => state.status);
  const errorMessage = usePageTreeStore((state) => state.errorMessage);
  const pagesById = usePageTreeStore((state) => state.pagesById);
  const childrenIndex = usePageTreeStore((state) => state.childrenIndex);
  const expandedIds = usePageTreeStore((state) => state.expandedIds);
  const selectedPageId = usePageTreeStore((state) => state.selectedPageId);
  const load = usePageTreeStore((state) => state.load);
  const selectPage = usePageTreeStore((state) => state.selectPage);
  const toggleExpanded = usePageTreeStore((state) => state.toggleExpanded);
  const move = usePageTreeStore((state) => state.move);
  const createRootPage = usePageTreeStore((state) => state.createChild);

  useEffect(() => {
    void load();
  }, [load]);

  const flat = useMemo(() => flattenVisibleTree(childrenIndex, expandedIds), [childrenIndex, expandedIds]);
  const favorites = useMemo(
    () =>
      [...pagesById.values()]
        .filter((page) => page.is_favorite)
        .sort((a, b) => a.title.localeCompare(b.title, "pt-BR")),
    [pagesById],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ActiveDropTarget | null>(null);
  const [moveDialogPage, setMoveDialogPage] = useState<PageRow | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const rovingId = focusedId ?? selectedPageId ?? flat[0]?.page.id ?? null;

  function registerRef(id: string, element: HTMLDivElement | null) {
    if (element) itemRefs.current.set(id, element);
    else itemRefs.current.delete(id);
  }

  function focusRow(id: string) {
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  }

  function destinationParentFor(overId: string, zone: DragZone): string | null {
    if (zone === "nest") return overId;
    return pagesById.get(overId)?.parent_id ?? null;
  }

  function handleDragStart(id: string, event: DragEvent<HTMLDivElement>) {
    setDraggedId(id);
    // Firefox recusa iniciar um arraste sem dado nenhum em `dataTransfer`.
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(overId: string, event: DragEvent<HTMLDivElement>) {
    if (!draggedId || draggedId === overId) return;
    const zone = zoneFromPointerY(event);
    const destinationParent = destinationParentFor(overId, zone);
    if (!isValidDropTarget(draggedId, destinationParent, childrenIndex)) return;

    // `preventDefault` é o que autoriza o `drop` no HTML5 DnD — sem isto o
    // navegador trata o alvo como não-aceitável e mostra o cursor de "proibido".
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ overId, zone });
  }

  function handleDragLeave(overId: string) {
    setDropTarget((current) => (current?.overId === overId ? null : current));
  }

  async function handleDrop(overId: string, event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const id = draggedId;
    const zone = dropTarget?.overId === overId ? dropTarget.zone : zoneFromPointerY(event);
    setDraggedId(null);
    setDropTarget(null);
    if (!id || id === overId) return;

    const destinationParent = destinationParentFor(overId, zone);
    if (!isValidDropTarget(id, destinationParent, childrenIndex)) return;

    if (zone === "nest") {
      await move(id, destinationParent, { type: "end" });
      return;
    }
    const siblings = (childrenIndex.get(destinationParent) ?? []).filter((page) => page.id !== id);
    await move(id, destinationParent, dropPositionRelativeToSibling(siblings, overId, zone));
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDropTarget(null);
  }

  async function handleKeyboardMove(id: string, action: KeyboardMoveAction) {
    const result = computeKeyboardMove(action, id, pagesById, childrenIndex);
    if (!result) return;
    await move(id, result.newParentId, result.target);
    focusRow(id);
  }

  function handleKeyDownRow(id: string, node: FlatPageNode, event: KeyboardEvent<HTMLDivElement>) {
    const index = flat.findIndex((n) => n.page.id === id);

    if (event.altKey && event.key in KEY_TO_KEYBOARD_MOVE) {
      event.preventDefault();
      void handleKeyboardMove(id, KEY_TO_KEYBOARD_MOVE[event.key]);
      return;
    }

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = flat[index + 1];
        if (next) focusRow(next.page.id);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = flat[index - 1];
        if (previous) focusRow(previous.page.id);
        break;
      }
      case "ArrowRight": {
        if (!node.hasChildren) break;
        event.preventDefault();
        if (expandedIds.has(id)) {
          const firstChild = flat[index + 1];
          if (firstChild) focusRow(firstChild.page.id);
        } else {
          toggleExpanded(id);
        }
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (node.hasChildren && expandedIds.has(id)) {
          toggleExpanded(id);
        } else if (node.parentId) {
          focusRow(node.parentId);
        }
        break;
      }
      case "Home": {
        event.preventDefault();
        if (flat[0]) focusRow(flat[0].page.id);
        break;
      }
      case "End": {
        event.preventDefault();
        const last = flat[flat.length - 1];
        if (last) focusRow(last.page.id);
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        selectPage(id);
        break;
      }
      default:
        break;
    }
  }

  if (status === "loading" || status === "idle") {
    return <p className="px-4 py-3 text-sm text-ink-muted">Carregando páginas…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar as páginas."}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col py-2">
      {favorites.length > 0 ? (
        <section aria-label="Favoritos" className="mb-2 border-b border-border px-2 pb-2">
          <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Favoritos
          </h2>
          <ul>
            {favorites.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => selectPage(page.id)}
                  className={`flex w-full items-center gap-2 truncate rounded-sm px-2 py-1 text-left text-sm
                    ${page.id === selectedPageId ? "bg-surface-sunken text-ink" : "text-ink hover:bg-surface-sunken/60"}`}
                >
                  <span aria-hidden="true">{page.icon ?? "📄"}</span>
                  <span className="truncate">{displayTitle(page)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div role="tree" aria-label="Árvore de páginas" className="min-h-0 flex-1 overflow-y-auto px-2">
        {flat.map((node) => (
          <PageTreeItem
            key={node.page.id}
            page={node.page}
            depth={node.depth}
            hasChildren={node.hasChildren}
            expanded={expandedIds.has(node.page.id)}
            selected={node.page.id === selectedPageId}
            isRovingTarget={node.page.id === rovingId}
            dropIndicator={dropTarget?.overId === node.page.id ? dropTarget.zone : null}
            onToggleExpand={() => toggleExpanded(node.page.id)}
            onSelect={() => selectPage(node.page.id)}
            onFocusRow={() => setFocusedId(node.page.id)}
            onKeyDownRow={(event) => handleKeyDownRow(node.page.id, node, event)}
            onDragStartRow={handleDragStart}
            onDragOverRow={handleDragOver}
            onDragLeaveRow={handleDragLeave}
            onDropRow={(id, event) => void handleDrop(id, event)}
            onDragEndRow={handleDragEnd}
            onRequestMoveTo={setMoveDialogPage}
            registerRef={registerRef}
          />
        ))}
      </div>

      <div className="border-t border-border px-2 pt-2">
        <button
          type="button"
          onClick={() => void createRootPage(null)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
            transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97"
        >
          <span aria-hidden="true">+</span> Nova página
        </button>
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
            transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97"
        >
          <span aria-hidden="true">🗑</span> Lixeira
        </button>
      </div>

      <MoveToDialog page={moveDialogPage} onClose={() => setMoveDialogPage(null)} />
      <TrashDialog isOpen={trashOpen} onClose={() => setTrashOpen(false)} />
    </div>
  );
}
