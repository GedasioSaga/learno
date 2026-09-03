import { useEffect, useRef, useState } from "react";
import { AppError, listTrashedPages, permanentlyDeletePage, restorePage, type PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { displayTitle } from "./tree-utils";

interface TrashDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type Status = "loading" | "ready" | "error";

/**
 * FUN-027/029/030/031: a Lixeira. `<dialog>` nativo pelo mesmo motivo de
 * `MoveToDialog` — foco preso e fechar com Escape/clique fora de graça.
 * Restaurar recarrega a árvore principal (`load`) além da própria lista,
 * porque a página restaurada precisa reaparecer na sidebar, não só sumir
 * daqui.
 */
export function TrashDialog({ isOpen, onClose }: TrashDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const load = usePageTreeStore((state) => state.load);
  const [status, setStatus] = useState<Status>("loading");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function messageFor(error: unknown, fallback: string): string {
    return error instanceof AppError || error instanceof Error ? error.message : fallback;
  }

  async function refresh() {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const rows = await listTrashedPages();
      setPages(rows);
      setStatus("ready");
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível carregar a lixeira."));
      setStatus("error");
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Ver `MoveToDialog` para por que `showModal`/`close` são checados: o
    // jsdom dos testes de componente não os implementa.
    if (isOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      void refresh();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
    // `refresh` de propósito fora da lista de dependências: é recriada a
    // cada render (fecha sobre `pages`/`status` atuais para os `set*`), mas
    // o único gatilho real para buscar de novo é o diálogo abrir, não uma
    // mudança de identidade da função.
  }, [isOpen]);

  async function handleRestore(id: string) {
    setBusyId(id);
    setErrorMessage(null);
    try {
      await restorePage(id);
      await Promise.all([refresh(), load()]);
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível restaurar esta página."));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePermanentlyDelete(id: string, title: string) {
    // Irreversível — igual a qualquer exclusão definitiva, confirmação
    // nativa é suficiente para uma ação deste tipo (sem lib extra de dialog).
    const confirmed = window.confirm(`Excluir "${displayTitle({ title })}" permanentemente? Isto não pode ser desfeito.`);
    if (!confirmed) return;

    setBusyId(id);
    setErrorMessage(null);
    try {
      await permanentlyDeletePage(id);
      setPages((current) => current.filter((page) => page.id !== id));
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível excluir esta página permanentemente."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onCancel={onClose}
      className="w-full max-w-md rounded-md border border-border bg-surface p-0 text-ink shadow-hard backdrop:bg-ink/40"
    >
      {isOpen ? (
        <div className="flex max-h-[70vh] flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-display text-lg text-ink">Lixeira</h2>
            <button type="button" onClick={onClose} aria-label="Fechar lixeira" className="text-ink-muted hover:text-ink">
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {status === "loading" && <p className="px-3 py-4 text-sm text-ink-muted">Carregando lixeira…</p>}

            {status === "error" && (
              <p role="alert" className="px-3 py-4 text-sm text-terracotta-ink">
                {errorMessage}
              </p>
            )}

            {status === "ready" && pages.length === 0 && (
              <p className="px-3 py-4 text-sm text-ink-muted">A lixeira está vazia.</p>
            )}

            {status === "ready" && pages.length > 0 && (
              <ul className="flex flex-col gap-1">
                {pages.map((page) => (
                  <li key={page.id} className="flex items-center justify-between gap-2 rounded-sm border border-border bg-paper px-3 py-2">
                    <span className="min-w-0 truncate text-sm text-ink">
                      {page.icon ?? "📄"} {displayTitle(page)}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void handleRestore(page.id)}
                        className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink disabled:opacity-50"
                      >
                        {busyId === page.id ? "Restaurando…" : "Restaurar"}
                      </button>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void handlePermanentlyDelete(page.id, page.title)}
                        className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-terracotta-ink disabled:opacity-50"
                      >
                        Excluir
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {status === "ready" && errorMessage ? (
              <p role="alert" className="px-3 pt-2 text-xs text-terracotta-ink">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
