import { useState } from "react";
import { AppError, abrirPastaDeLogs } from "../../lib/ipc";

/** Configurações > Diagnóstico: o caminho até o arquivo de log, para anexar a um relato de problema. */
export function DiagnosticoSection() {
  const [erro, setErro] = useState<string | null>(null);

  async function abrir() {
    setErro(null);
    try {
      await abrirPastaDeLogs();
    } catch (falha) {
      setErro(
        falha instanceof AppError || falha instanceof Error ? falha.message : "Não foi possível abrir a pasta de logs.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        O Learno grava um arquivo de log por dia, com os erros e o funcionamento do app, e guarda os últimos 7 dias. Ao
        relatar um problema, anexe o arquivo do dia em que ele aconteceu.
      </p>
      <div>
        <button
          type="button"
          onClick={() => void abrir()}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink"
        >
          Abrir pasta de logs
        </button>
      </div>
      {erro ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
