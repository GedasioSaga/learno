/**
 * EDT-076/077/078's buttons in the single selection toolbar `Editor.tsx`
 * renders (`registerFormattingMenuItem`) - which ones show depends on the
 * synced role of the block under the cursor (`synced-store.ts`, read
 * through `currentBlockSyncedRole`), `null` (nothing rendered) for an
 * ordinary, unsynced block.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import "./synced.css";
import {
  copyCurrentSyncedOriginToClipboard,
  currentBlockSyncedRole,
  requestDeleteSyncedOriginal,
  unsyncAllCopiesOfCurrentOrigin,
  unsyncCurrentBlock,
} from "./synced-actions";

/**
 * The actual component - `useEditorState` has to run inside a real React
 * component instance, not a plain function called inline from JSX (the
 * mistake this file's own test caught: `Editor.tsx` invokes every
 * `FormattingMenuItem.render(editor)` as a bare function call inside its own
 * JSX, so a hook called directly inside that function borrows `Editor`'s own
 * fiber instead of getting one of its own - fine for a single, stable hook
 * count, a latent "Rendered fewer/more hooks than expected" crash the moment
 * it isn't. `renderSyncedControls` below stays a plain wrapper returning
 * JSX, the same split `marks/basic/formatting-buttons.tsx`'s `renderBoldButton`
 * (etc.) uses around its own `MarkFormattingButton`.
 */
function SyncedControls({ editor }: { editor: TiptapEditor }) {
  const role = useEditorState({
    editor,
    selector: ({ editor: current }) => currentBlockSyncedRole(current),
  });

  if (role === null) return null;

  return (
    <div className="ed-synced-controls" role="group" aria-label="Bloco sincronizado">
      {role === "copy" && (
        <button
          type="button"
          aria-label="Desvincular esta cópia"
          className="ed-synced-controls__button"
          // Same reason `marks/basic`'s toggle buttons preventDefault on
          // mousedown: clicking must not collapse the selection before the
          // click handler runs.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void unsyncCurrentBlock(editor)}
        >
          Desvincular
        </button>
      )}
      {role === "origin" && (
        <>
          <button
            type="button"
            aria-label="Copiar bloco sincronizado"
            className="ed-synced-controls__button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => copyCurrentSyncedOriginToClipboard(editor)}
          >
            Copiar
          </button>
          <button
            type="button"
            aria-label="Desvincular todas as cópias"
            className="ed-synced-controls__button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void unsyncAllCopiesOfCurrentOrigin(editor)}
          >
            Desvincular todas
          </button>
          <button
            type="button"
            aria-label="Apagar bloco sincronizado"
            className="ed-synced-controls__button ed-synced-controls__button--danger"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void requestDeleteSyncedOriginal(editor)}
          >
            Apagar
          </button>
        </>
      )}
    </div>
  );
}

/** `register.ts`'s `FormattingMenuItem.render`. */
export function renderSyncedControls(editor: TiptapEditor): ReactNode {
  return <SyncedControls editor={editor} />;
}
