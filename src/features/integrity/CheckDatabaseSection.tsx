import { useId, useState } from "react";
import { AppError, checkDatabase, type IntegrityReport } from "../../lib/ipc";

type CheckDatabaseStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; report: IntegrityReport }
  | { kind: "error"; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError || error instanceof Error ? error.message : fallback;
}

/**
 * Frase que a checagem realmente encontrou — segue o "Check Database" do
 * Anki: "0 problemas" e "12 cartões órfãos removidos" são desfechos muito
 * diferentes, e o usuário precisa ler qual dos dois aconteceu, não só um
 * número genérico de "problemas corrigidos".
 */
function summarize(report: IntegrityReport): string {
  if (report.total_repaired === 0) {
    return "Nenhum problema encontrado. O banco de dados está íntegro.";
  }
  const count = report.orphaned_card_ids.length;
  const noun = count === 1 ? "cartão órfão foi removido" : "cartões órfãos foram removidos";
  return `${count} ${noun} por não ter nota correspondente.`;
}

/**
 * PLT-014: "Check Database" — vasculha a coleção local em busca de cartões
 * cujo `note_id` não corresponde a nenhuma nota (uma inconsistência que as
 * constraints do schema já impedem em uso normal, mas que sobrevive a um
 * import de baralho fora de ordem, à restauração de um backup antigo, ou a
 * uma edição direta do banco) e conserta na hora.
 *
 * Antes deste componente, `db::integrity::IntegrityRepository` já existia,
 * testado e correto, mas sem nenhum `#[tauri::command]` registrado nem botão
 * nenhum para chamá-lo — o usuário não tinha como disparar a checagem em
 * nenhuma tela do app. É este arquivo, montado em `App.tsx` ao lado de
 * `BackupSettings`, que fecha esse caminho.
 *
 * PLT-013: o reparo apaga linha (cartão órfão), então é um dos dois
 * gatilhos de operação de risco do checklist com código real por trás — o
 * campo de senha existe só para isso: o backend faz uma cópia de segurança
 * antes de reparar, e a senha nunca fica salva em lugar nenhum (mesma regra
 * de `BackupSettings`).
 */
export function CheckDatabaseSection() {
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<CheckDatabaseStatus>({ kind: "idle" });

  async function handleCheck() {
    setStatus({ kind: "running" });
    try {
      const report = await checkDatabase(password);
      setStatus({ kind: "done", report });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error, "Não foi possível verificar o banco de dados.") });
    }
  }

  const canCheck = password.length > 0 && status.kind !== "running";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        Procura e conserta inconsistências que passaram pelas checagens normais do banco — por exemplo, depois
        de importar um baralho ou restaurar um backup antigo.
      </p>

      <div>
        <label htmlFor={passwordId} className="block text-sm font-medium text-ink">
          Senha do Postgres
        </label>
        <input
          id={passwordId}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <p className="mt-1 text-xs text-ink-muted">
          Necessária para que o app faça uma cópia de segurança antes de consertar qualquer coisa — nunca é
          salva.
        </p>
      </div>

      <div>
        <button
          type="button"
          disabled={!canCheck}
          onClick={() => void handleCheck()}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
        >
          {status.kind === "running" ? "Verificando…" : "Verificar banco de dados"}
        </button>
      </div>

      {status.kind === "done" ? (
        <p
          role="status"
          className={`text-sm ${status.report.total_repaired === 0 ? "text-mint-ink" : "text-amber-ink"}`}
        >
          {summarize(status.report)}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
