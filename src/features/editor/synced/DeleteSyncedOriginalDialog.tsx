/**
 * EDT-078: the confirmation dialog `requestDeleteSyncedOriginal`
 * (`synced-actions.ts`) opens when the backend refuses an unconfirmed
 * delete of a synced original with more than its warning threshold of
 * copies. Registered as a `registerEditorOverlay` (`register.ts` must stay
 * plain `.ts` - JSX needs this `.tsx` file, the same split
 * `marks/basic/formatting-buttons.tsx` uses).
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { ReactNode } from "react";
import "./synced.css";
import { useDeleteSyncedOriginalDialogStore } from "./delete-confirm-store";
import { confirmDeleteSyncedOriginal } from "./synced-actions";

function copyCountMessage(copyCount: number | null): string {
  if (copyCount === null) return "Isso vai apagar o bloco original e todas as suas cópias.";
  const noun = copyCount === 1 ? "cópia vinculada" : "cópias vinculadas";
  return `Isso vai apagar o bloco original e ${copyCount} ${noun} — não só desvinculá-las.`;
}

export function DeleteSyncedOriginalDialog({ editor }: { editor: TiptapEditor }) {
  const open = useDeleteSyncedOriginalDialogStore((state) => state.open);
  const copyCount = useDeleteSyncedOriginalDialogStore((state) => state.copyCount);
  const pending = useDeleteSyncedOriginalDialogStore((state) => state.pending);
  const errorMessage = useDeleteSyncedOriginalDialogStore((state) => state.errorMessage);
  const close = useDeleteSyncedOriginalDialogStore((state) => state.close);

  if (!open) return null;

  return (
    <div className="ed-synced-dialog-backdrop">
      <div className="ed-synced-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ed-synced-dialog-title">
        <h2 id="ed-synced-dialog-title" className="ed-synced-dialog__title">
          Apagar bloco sincronizado?
        </h2>
        <p className="ed-synced-dialog__body">{copyCountMessage(copyCount)}</p>
        {errorMessage && (
          <p className="ed-synced-dialog__error" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="ed-synced-dialog__actions">
          <button type="button" className="ed-synced-dialog__button" onClick={close} disabled={pending}>
            Cancelar
          </button>
          <button
            type="button"
            className="ed-synced-dialog__button ed-synced-dialog__button--danger"
            onClick={() => void confirmDeleteSyncedOriginal(editor)}
            disabled={pending}
          >
            {pending ? "Apagando…" : "Apagar mesmo assim"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `register.ts`'s `EditorOverlay.render` - kept as a plain function export the same way `formatting-buttons.tsx` exposes `render*` functions for a `.ts` file to reference without itself needing JSX. */
export function renderDeleteSyncedOriginalDialog(editor: TiptapEditor): ReactNode {
  return <DeleteSyncedOriginalDialog editor={editor} />;
}
