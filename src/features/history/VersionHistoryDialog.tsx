import type { KeyboardEvent } from "react";
import { EmptyState } from "../../components/EmptyState";
import { formatSnapshotTimestamp, snapshotReasonLabel } from "./format";
import { useVersionHistory } from "./useVersionHistory";

interface VersionHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pageId: string;
  pageTitle: string;
}

/**
 * FUN-035/036: tela de histórico de versões. Modal em vez de rota própria
 * porque não existe roteador de páginas ainda (isso é Fase 2) — quem
 * construir a árvore de páginas decide de onde abrir isto, passando o
 * `pageId`/`pageTitle` da página aberta no momento.
 */
export function VersionHistoryDialog({
  isOpen,
  onClose,
  pageId,
  pageTitle,
}: VersionHistoryDialogProps) {
  const { status, versions, errorMessage, restoringId, restore } = useVersionHistory(pageId);

  if (!isOpen) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  // Uma falha ao restaurar não esvazia a lista — o histórico continua
  // completo e visível, só o aviso some depois da próxima tentativa.
  const restoreFailed = status === "ready" && errorMessage !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Histórico de versões de ${pageTitle}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-sm border border-border bg-surface shadow-hard"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-display text-lg text-ink">Histórico de versões</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar histórico"
            className="text-ink-muted hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {status === "loading" && (
            <p className="px-3 py-4 text-sm text-ink-muted">Carregando histórico…</p>
          )}

          {status === "error" && (
            <p role="alert" className="px-3 py-4 text-sm text-terracotta-ink">
              {errorMessage}
            </p>
          )}

          {status === "ready" && versions.length === 0 && (
            <EmptyState
              title="Nenhuma versão salva ainda"
              description="Snapshots aparecem aqui conforme você edita esta página."
            />
          )}

          {status === "ready" && versions.length > 0 && (
            <ul className="flex flex-col gap-1">
              {versions.map((version) => (
                <li key={version.id} className="rounded-sm border border-border bg-paper px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-ink">{formatSnapshotTimestamp(version.created_at)}</p>
                      <p className="text-xs text-ink-muted">{snapshotReasonLabel(version.reason)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => restore(version.id)}
                      disabled={restoringId !== null}
                      className="shrink-0 rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none disabled:opacity-50"
                    >
                      {restoringId === version.id ? "Restaurando…" : "Restaurar"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {restoreFailed && (
            <p role="alert" className="px-3 pt-2 text-xs text-terracotta-ink">
              {errorMessage}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
