/**
 * A confirmação de "Apagar propriedade" — destrutivo, então pede
 * confirmação e diz o que se perde: os valores desta coluna em N registros
 * (CASCADE em `database_record_values`) e, se uma Trilha agrupava por ela,
 * as raias (o `group_property_id` vira `NULL`; a Trilha continua). Mesmo
 * padrão de `editor/synced/DeleteSyncedOriginalDialog.tsx`: `alertdialog`,
 * botão de cancelar primeiro, o destrutivo por último e em terracota.
 *
 * Portal no `body` pelo mesmo motivo de `EditorFlyout`: dentro do bloco
 * inline, Escape e Enter borbulhariam até o editor de blocos.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useOpenTransition } from "../../../pages/use-open-transition";
import type { PropertyDescriptor } from "../../core/property-spec";
import type { PropertyActionResult } from "../../core/view-spec";

interface DeletePropertyDialogProps {
  property: PropertyDescriptor;
  filledCount: number;
  onCancel(): void;
  /** Só `ok` desmonta (a coluna some com a propriedade); em erro o diálogo mostra a mensagem. */
  onConfirm(): Promise<PropertyActionResult>;
}

type Pending = { kind: "idle" } | { kind: "deleting" } | { kind: "failed"; message: string };

export function lossMessage(filledCount: number): string {
  if (filledCount === 0) return "Nenhum registro tem valor nesta coluna ainda. Uma Trilha que agrupava por ela volta a ser uma raia só.";
  const noun = filledCount === 1 ? "1 registro perde o valor" : `${filledCount} registros perdem o valor`;
  return `${noun} desta coluna, e isso não tem desfazer. Uma Trilha que agrupava por ela volta a ser uma raia só.`;
}

export function DeletePropertyDialog({ property, filledCount, onCancel, onConfirm }: DeletePropertyDialogProps) {
  const [pending, setPending] = useState<Pending>({ kind: "idle" });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const entered = useOpenTransition(true);
  const titleId = `delete-property-${property.id}`;

  // O foco nasce em "Cancelar": o caminho seguro é o que Enter aciona.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  async function confirm() {
    if (pending.kind === "deleting") return;
    setPending({ kind: "deleting" });
    const result = await onConfirm();
    if (!result.ok) setPending({ kind: "failed", message: result.message });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
    event.stopPropagation();
  }

  function stopPropagation(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4" onClick={onCancel} onPointerDown={stopPropagation}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={stopPropagation}
        onKeyDown={handleKeyDown}
        className={[
          "flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-surface p-5 shadow-hard",
          "transition-[opacity,transform] duration-[var(--motion-base)] ease-out motion-reduce:transition-none",
          entered ? "scale-100 opacity-100" : "scale-95 opacity-0",
        ].join(" ")}
      >
        <h2 id={titleId} className="font-display text-lg text-ink">
          Apagar a propriedade “{property.name}”?
        </h2>
        <p className="text-sm text-ink-muted">{lossMessage(filledCount)}</p>
        {pending.kind === "failed" ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {pending.message}
          </p>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending.kind === "deleting"}
            className="rounded-sm border border-border bg-surface px-3 py-1.5 text-sm text-ink shadow-hard-sm hover:bg-surface-raised active:scale-97 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={pending.kind === "deleting"}
            className="rounded-sm border border-terracotta bg-terracotta/10 px-3 py-1.5 text-sm font-medium text-terracotta-ink hover:bg-terracotta/15 active:scale-97 disabled:opacity-50"
          >
            {pending.kind === "deleting" ? "Apagando…" : "Apagar propriedade"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
