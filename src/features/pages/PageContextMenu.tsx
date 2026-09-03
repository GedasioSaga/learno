import { useId, useRef, useState } from "react";
import type { PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { hidePopoverSafely } from "./dom-compat";
import { useOpenTransition } from "./use-open-transition";

interface PageContextMenuProps {
  page: PageRow;
  onRequestRename: () => void;
  onRequestMoveTo: () => void;
}

/**
 * Menu de contexto de uma linha da árvore: favoritar/desfavoritar (FUN-009 é
 * justamente "via menu de contexto"), duplicar (FUN-020) e mover para
 * (abre o `MoveToDialog`, FUN-022). `popover="auto"` cobre fechar ao clicar
 * fora e com Escape sem listener nenhum escrito à mão — ver `EmojiIconPicker`
 * para o mesmo raciocínio.
 */
export function PageContextMenu({ page, onRequestRename, onRequestMoveTo }: PageContextMenuProps) {
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const entered = useOpenTransition(open);
  const setFavorite = usePageTreeStore((state) => state.setFavorite);
  const duplicate = usePageTreeStore((state) => state.duplicate);
  const trash = usePageTreeStore((state) => state.trash);

  function close() {
    hidePopoverSafely(panelRef.current);
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        popoverTarget={panelId}
        popoverTargetAction="toggle"
        aria-label={`Mais ações para ${page.title || "página sem título"}`}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted transition-transform hover:bg-surface hover:text-ink active:scale-97"
      >
        ⋯
      </button>

      <div
        id={panelId}
        ref={panelRef}
        popover="auto"
        role="menu"
        onToggle={(event) => setOpen(event.newState === "open")}
        className={`absolute right-0 top-full m-0 mt-1 w-48 origin-top-right rounded-md border border-border
          bg-surface p-1 shadow-hard transition duration-150 ease-out motion-reduce:transition-none
          ${entered ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
      >
        <MenuItem
          onSelect={() => {
            onRequestRename();
            close();
          }}
        >
          Renomear
        </MenuItem>
        <MenuItem
          onSelect={() => {
            void setFavorite(page.id, !page.is_favorite);
            close();
          }}
        >
          {page.is_favorite ? "Remover dos favoritos" : "Favoritar"}
        </MenuItem>
        <MenuItem
          onSelect={() => {
            void duplicate(page.id);
            close();
          }}
        >
          Duplicar
        </MenuItem>
        <MenuItem
          onSelect={() => {
            onRequestMoveTo();
            close();
          }}
        >
          Mover para...
        </MenuItem>
        <MenuItem
          destructive
          onSelect={() => {
            void trash(page.id);
            close();
          }}
        >
          Mover para lixeira
        </MenuItem>
      </div>
    </span>
  );
}

function MenuItem({
  children,
  onSelect,
  destructive,
}: {
  children: string;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-sunken
        ${destructive ? "text-terracotta-ink" : "text-ink"}`}
    >
      {children}
    </button>
  );
}
