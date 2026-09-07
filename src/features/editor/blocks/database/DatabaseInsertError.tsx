/**
 * O `EditorOverlay` que mostra a falha de "/database" (ver
 * `insert-error-store.ts`). Um alerta acima do editor, com o motivo vindo
 * do backend e um jeito de fechar — sem animação (é erro, não convite).
 */
import { useDatabaseInsertErrorStore } from "./insert-error-store";

export function DatabaseInsertError() {
  const message = useDatabaseInsertErrorStore((state) => state.message);
  const dismiss = useDatabaseInsertErrorStore((state) => state.dismiss);
  if (!message) return null;

  return (
    <div role="alert" className="mb-2 flex items-start justify-between gap-3 rounded-sm border border-terracotta bg-surface px-3 py-2 text-sm text-terracotta-ink">
      <span>{message}</span>
      <button type="button" onClick={dismiss} className="shrink-0 rounded-sm px-1 text-ink-muted hover:text-ink" aria-label="Fechar aviso">
        ✕
      </button>
    </div>
  );
}
