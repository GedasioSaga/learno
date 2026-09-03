import { useCallback, useEffect, useState } from "react";
import {
  autosaveClearPending,
  autosaveListRecoverable,
  autosaveMergeWithSaved,
  type AutosaveJournalEntry,
} from "../../lib/ipc";

type Status = "loading" | "ready" | "error";

interface RecoveryState {
  status: Status;
  entries: AutosaveJournalEntry[];
  errorMessage: string | null;
}

const INITIAL_STATE: RecoveryState = { status: "loading", entries: [], errorMessage: null };

/**
 * PLT-005's crash-recovery half: on mount, lists every draft left on disk by
 * a session that never confirmed it reached Postgres, then asks the backend
 * to merge each one against that page's last known save — a draft older
 * than the save it's compared against is dropped here, never shown to the
 * user (see `backup::autosave::merge_after_crash` for why that race matters).
 */
export function useAutosaveRecovery() {
  const [state, setState] = useState<RecoveryState>(INITIAL_STATE);

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, status: "loading", errorMessage: null }));
    try {
      const pending = await autosaveListRecoverable();
      const merged = await Promise.all(pending.map((entry) => autosaveMergeWithSaved(entry)));
      const recoverable = merged.filter((entry): entry is AutosaveJournalEntry => entry !== null);
      setState({ status: "ready", entries: recoverable, errorMessage: null });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Não foi possível verificar edições não salvas.";
      setState({ status: "error", entries: [], errorMessage: message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** The user dismissed (or the caller already restored) this draft — it stops being offered again. */
  const dismiss = useCallback(async (pageId: string) => {
    await autosaveClearPending(pageId);
    setState((previous) => ({
      ...previous,
      entries: previous.entries.filter((entry) => entry.page_id !== pageId),
    }));
  }, []);

  return { ...state, dismiss };
}
