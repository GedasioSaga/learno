import { useCallback, useEffect, useRef } from "react";
import { autosaveClearPending, autosaveWritePending } from "../../lib/ipc";

/**
 * PLT-005: how long the editor waits after the user stops typing before the
 * draft is written to disk. Short enough that a crash loses only a few
 * seconds of work, long enough that a fast typist doesn't trigger a write on
 * every keystroke.
 */
const AUTOSAVE_DEBOUNCE_MS = 3000;

/**
 * PLT-005's editor-facing half: call `saveDraft` on every content change
 * (typically from the editor's own change/debounce), and `clearDraft` right
 * after the content is durably saved to Postgres. The crash-recovery half —
 * detecting and offering a leftover draft back — is `useAutosaveRecovery`.
 *
 * Debouncing lives here instead of in the caller so every editor surface
 * that adopts this hook gets the same PLT-005 cadence for free.
 */
export function useAutosaveDraft(pageId: string | null) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;

  useEffect(() => {
    // Switching pages (or unmounting) cancels a write scheduled for the
    // page being left — it would otherwise land under the wrong `page_id`
    // moments after the user navigated away.
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pageId]);

  const saveDraft = useCallback((title: string, content: unknown) => {
    const currentPageId = pageIdRef.current;
    if (currentPageId === null) return;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Autosave failing silently is the right default here: it retries on
      // the next keystroke, and surfacing every transient I/O hiccup as a
      // user-facing error would be noisier than the problem it reports.
      void autosaveWritePending(currentPageId, title, content).catch(() => undefined);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  const clearDraft = useCallback(async () => {
    const currentPageId = pageIdRef.current;
    if (currentPageId === null) return;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await autosaveClearPending(currentPageId);
  }, []);

  return { saveDraft, clearDraft };
}
