import type { AutosaveJournalEntry } from "../../lib/ipc";
import { useAutosaveRecovery } from "./useAutosaveRecovery";

interface RecoveryBannerProps {
  /** Called when the user chooses to bring a recovered draft back into the editor. */
  onRestore: (entry: AutosaveJournalEntry) => void;
}

/**
 * PLT-005: shown once at startup for every page that has a draft left over
 * from a session that ended without confirming it reached Postgres. Renders
 * nothing while loading, on error, or once there is nothing to recover —
 * this banner is only ever an interruption when there is real work to save.
 */
export function RecoveryBanner({ onRestore }: RecoveryBannerProps) {
  const { status, entries, dismiss } = useAutosaveRecovery();

  if (status !== "ready" || entries.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Edições recuperadas"
      // `fixed`/`z-40`: este banner é sobre a sessão inteira, não sobre uma
      // página específica — flutuar por cima do `AppShell` (em vez de
      // disputar espaço dentro do `<main>` dele) evita empurrar a altura do
      // `PageWorkspace` abaixo, que já assume preencher 100% do container.
      className="fixed inset-x-0 top-0 z-40 flex flex-col gap-2 border-b border-border bg-amber/10 px-4 py-3 shadow-hard-sm"
    >
      {entries.map((entry) => (
        <div key={entry.page_id} className="flex items-center justify-between gap-4 text-sm">
          <p className="text-ink">
            Encontramos uma edição não salva de <strong>{entry.title || "Sem título"}</strong> de antes do app
            fechar inesperadamente.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => {
                onRestore(entry);
                void dismiss(entry.page_id);
              }}
              className="rounded-sm bg-emerald px-3 py-1 text-xs font-medium text-on-emerald"
            >
              Recuperar
            </button>
            <button
              type="button"
              onClick={() => void dismiss(entry.page_id)}
              className="rounded-sm border border-border px-3 py-1 text-xs font-medium text-ink-muted"
            >
              Descartar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
