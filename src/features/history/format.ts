import type { SnapshotReason } from "../../lib/ipc";

const REASON_LABEL: Record<SnapshotReason, string> = {
  autosave: "Salvo automaticamente",
  manual: "Salvo manualmente",
  restore: "Restauração de versão anterior",
};

/** FUN-035: rótulo em português para o motivo do snapshot. */
export function snapshotReasonLabel(reason: SnapshotReason): string {
  return REASON_LABEL[reason];
}

/**
 * FUN-035: formata `created_at` (ISO 8601 vindo do backend) como data e hora
 * legíveis em pt-BR. Uma string que não parseia como data volta como o
 * próprio texto original em vez de "Invalid Date" — não deveria acontecer
 * vindo do backend, mas mostrar o dado bruto é mais seguro que mentir uma data.
 */
export function formatSnapshotTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}
