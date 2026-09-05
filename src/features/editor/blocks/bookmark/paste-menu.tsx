/**
 * EDT-030's menu: appears the instant `paste-plugin.ts` records a pending
 * paste, offers "Criar bookmark" and "Criar link/menção" (plus "Cancelar",
 * which pastes the URL back as plain text - the closest thing to "do
 * nothing" once the plugin has already swallowed the native paste).
 *
 * Subscribes to the editor's own `transaction` event via
 * `useSyncExternalStore` rather than relying on `Editor.tsx` re-rendering on
 * every keystroke (it doesn't - typing goes through TipTap/ProseMirror's own
 * DOM updates, not React state) - this way the menu appears and disappears
 * exactly when the plugin's state actually changes, regardless of the host
 * component's render cadence.
 */
import type { Editor } from "@tiptap/core";
import { useSyncExternalStore } from "react";
import { fetchBookmarkMetadata } from "./metadata";
import {
  bookmarkPasteKey,
  confirmBookmarkCard,
  confirmInlineLink,
  confirmPlainTextPaste,
} from "./paste-plugin";

function subscribeToTransactions(editor: Editor, onStoreChange: () => void): () => void {
  editor.on("transaction", onStoreChange);
  return () => editor.off("transaction", onStoreChange);
}

interface BookmarkPasteMenuProps {
  editor: Editor;
}

export function BookmarkPasteMenu({ editor }: BookmarkPasteMenuProps) {
  const pending = useSyncExternalStore(
    (onStoreChange) => subscribeToTransactions(editor, onStoreChange),
    () => bookmarkPasteKey.getState(editor.state) ?? null,
  );

  if (!pending) return null;

  const handleCreateBookmark = () => {
    void fetchBookmarkMetadata(pending.url).then((metadata) => {
      confirmBookmarkCard(editor, pending, metadata);
    });
  };

  const handleCreateLink = () => {
    confirmInlineLink(editor, pending);
  };

  const handleCancel = () => {
    confirmPlainTextPaste(editor, pending);
  };

  // `editor.view.dom` may not be attached to a real, laid-out page (a test
  // constructs an `Editor` without mounting it) - `coordsAtPos` still
  // returns a (possibly all-zero) rect rather than throwing in that case, so
  // no try/catch is needed for that; guarding here is only about `pending`.
  const coords = editor.view.coordsAtPos(pending.pos);

  return (
    <div
      className="ed-bookmark-paste-menu"
      role="menu"
      aria-label="Colar URL como"
      style={{ position: "fixed", top: coords.bottom + 4, left: coords.left }}
    >
      <button type="button" role="menuitem" className="ed-bookmark-paste-menu__item" onClick={handleCreateBookmark}>
        Criar bookmark
      </button>
      <button type="button" role="menuitem" className="ed-bookmark-paste-menu__item" onClick={handleCreateLink}>
        Criar link/menção
      </button>
      <button
        type="button"
        role="menuitem"
        className="ed-bookmark-paste-menu__item ed-bookmark-paste-menu__item--cancel"
        aria-label="Cancelar e colar como texto simples"
        onClick={handleCancel}
      >
        Cancelar
      </button>
    </div>
  );
}
