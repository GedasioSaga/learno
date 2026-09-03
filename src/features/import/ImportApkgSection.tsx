import { useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppError, importApkg } from "../../lib/ipc";

type ImportStatus =
  | { kind: "idle" }
  | { kind: "importing"; fileName: string }
  | { kind: "done"; fileName: string; notesImported: number }
  | { kind: "error"; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError || error instanceof Error ? error.message : fallback;
}

/**
 * O diálogo nativo devolve o caminho absoluto do arquivo escolhido — só o
 * nome do arquivo importa para o status na tela, não o caminho inteiro do
 * disco do usuário. `\\` e `/` cobrem separador do Windows e do resto.
 */
function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * PLT-004: único ponto de entrada real do import de `.apkg` — antes deste
 * componente, `import_apkg` (que fala de verdade com o sidecar Python
 * empacotado, provado por teste que roda o binário e importa um `.apkg`
 * real) não tinha seletor de arquivo, botão nem feedback de progresso que o
 * alcançasse a partir da UI: um grep por "apkg" em `src/` não achava nada.
 *
 * `handlePickFile` nunca bloqueia a thread de UI enquanto o sidecar
 * processa — é um `await` comum sobre uma Promise, então cliques e scroll em
 * qualquer outro lugar da tela continuam funcionando durante os até 30s que
 * `SidecarProcess::call` espera antes de expirar (ver `CALL_TIMEOUT` em
 * `src-tauri/src/sidecar/mod.rs`), o que o teste deste componente confirma
 * mantendo a Promise pendente e interagindo com outro elemento antes de
 * resolvê-la.
 *
 * Nesta fase o sidecar só valida o arquivo como zip e sempre devolve
 * `notes_imported: 0` — ler as notas de verdade é Fase 4 (ver o comentário
 * em `sidecar/learno_sidecar/handlers/apkg.py`). A mensagem de sucesso
 * mostra esse número tal como o backend devolve, sem prometer que alguma
 * nota já virou cartão estudável: é isso que "honesto sobre o que ocorreu"
 * significa aqui.
 *
 * PLT-013: um import pode sobrescrever cartões que já existiam, então é um
 * dos dois gatilhos de operação de risco do checklist com código real por
 * trás — o campo de senha existe só para isso: o backend faz uma cópia de
 * segurança antes de chamar o sidecar, e a senha nunca fica salva (mesma
 * regra de `BackupSettings`/`CheckDatabaseSection`).
 */
export function ImportApkgSection() {
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });

  async function handlePickFile() {
    const selected = await open({
      title: "Selecionar baralho do Anki",
      filters: [{ name: "Baralho do Anki", extensions: ["apkg"] }],
    });

    // Usuário fechou o diálogo sem escolher nada — não é erro, só nada a fazer.
    if (typeof selected !== "string") return;

    const fileName = fileNameFromPath(selected);
    setStatus({ kind: "importing", fileName });
    try {
      const result = await importApkg(selected, password);
      setStatus({ kind: "done", fileName, notesImported: result.notes_imported });
    } catch (error) {
      // Cobre tanto `ApkgInvalido` (zip corrompido/não é .apkg) e as falhas
      // do backup pré-import (PLT-013: pg_dump ausente, disco cheio) quanto
      // `SidecarTimeout`/`SidecarCrashed` do critério de aceite de PLT-004 —
      // todas chegam aqui como `AppError` com `message` já pronta para o
      // usuário (ver o comentário de `importApkg` em `src/lib/ipc.ts`),
      // nunca como exceção não tratada.
      setStatus({ kind: "error", message: errorMessage(error, "Não foi possível importar o arquivo .apkg.") });
    }
  }

  const isImporting = status.kind === "importing";
  const canImport = password.length > 0 && !isImporting;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        Importa um baralho exportado do Anki (arquivo <code>.apkg</code>). O app continua respondendo
        durante o processamento, mesmo em arquivos grandes.
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
          Necessária para que o app faça uma cópia de segurança antes de importar — nunca é salva.
        </p>
      </div>

      <div>
        <button
          type="button"
          disabled={!canImport}
          onClick={() => void handlePickFile()}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
        >
          {isImporting ? `Importando "${status.fileName}"…` : "Importar baralho do Anki (.apkg)"}
        </button>
      </div>

      {status.kind === "done" ? (
        <p role="status" className="text-sm text-mint-ink">
          {`"${status.fileName}": ${status.notesImported} nota(s) importada(s).`}
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
