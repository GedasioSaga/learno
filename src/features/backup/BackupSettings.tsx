import { useEffect, useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppError,
  createBackup,
  getBackupScheduleConfig,
  restoreBackup,
  runDueScheduledBackup,
  saveBackupScheduleConfig,
  type BackupCadence,
  type BackupScheduleConfig,
} from "../../lib/ipc";

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  action?: { label: string; onClick: () => void };
}

function Field({ label, value, onChange, type = "text", placeholder, action }: FieldProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type BackupStatus = { kind: "idle" } | { kind: "running" } | { kind: "done"; path: string } | { kind: "error"; message: string };
type RestoreStatus = { kind: "idle" } | { kind: "confirming" } | { kind: "running" } | { kind: "done" } | { kind: "error"; message: string };
type CheckStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ran"; path: string }
  | { kind: "not-due" }
  | { kind: "error"; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError || error instanceof Error ? error.message : fallback;
}

const CADENCE_LABEL: Record<BackupCadence, string> = {
  daily: "Diário",
  weekly: "Semanal",
  monthly: "Mensal",
};

/**
 * PLT-013: configuração do backup automático periódico com retenção — o
 * critério de aceite é "cargo-test" (a lógica de agendamento e retenção em
 * `backup::schedule` é o que prova o comportamento); esta seção só precisa
 * dar ao usuário um jeito real de ligar/ajustar isso e de confirmar que
 * rodou, reaproveitando a senha que `BackupSettings` já pede para o backup
 * manual — nenhum backup automático de verdade roda sem alguém com a senha
 * em mãos disparando esta checagem, já que o app nunca persiste uma (ver
 * `config::AppConfig`).
 */
function AutomaticBackupSection() {
  const [config, setConfig] = useState<BackupScheduleConfig | null>(null);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [password, setPassword] = useState("");
  const [checkStatus, setCheckStatus] = useState<CheckStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    getBackupScheduleConfig()
      .then((loaded) => {
        if (!cancelled) setConfig(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadErrorMessage(errorMessage(error, "Não foi possível carregar a configuração de backup automático."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!config) return;
    setSaveStatus("saving");
    try {
      await saveBackupScheduleConfig(config);
      setSaveStatus("saved");
    } catch (error) {
      setSaveStatus("error");
      setLoadErrorMessage(errorMessage(error, "Não foi possível salvar a configuração de backup automático."));
    }
  }

  async function handleCheckNow() {
    setCheckStatus({ kind: "running" });
    try {
      const path = await runDueScheduledBackup(password);
      setCheckStatus(path ? { kind: "ran", path } : { kind: "not-due" });
    } catch (error) {
      setCheckStatus({ kind: "error", message: errorMessage(error, "Não foi possível checar o backup automático.") });
    }
  }

  if (loadErrorMessage && !config) {
    return (
      <p role="alert" className="text-sm text-terracotta-ink">
        {loadErrorMessage}
      </p>
    );
  }

  if (!config) {
    return <p className="text-sm text-ink-muted">Carregando configuração de backup automático…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })}
        />
        Fazer backup automático periodicamente
      </label>

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor="backup-cadence" className="block text-sm font-medium text-ink">
            Frequência
          </label>
          <select
            id="backup-cadence"
            value={config.cadence}
            onChange={(event) => setConfig({ ...config, cadence: event.currentTarget.value as BackupCadence })}
            className="mt-1 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
          >
            {(Object.keys(CADENCE_LABEL) as BackupCadence[]).map((cadence) => (
              <option key={cadence} value={cadence}>
                {CADENCE_LABEL[cadence]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="backup-keep-scheduled" className="block text-sm font-medium text-ink">
            Cópias a manter
          </label>
          <input
            id="backup-keep-scheduled"
            type="number"
            min={1}
            value={config.keep_scheduled}
            onChange={(event) =>
              setConfig({ ...config, keep_scheduled: Number(event.currentTarget.value) || 1 })
            }
            className="mt-1 w-24 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>

        <div>
          <label htmlFor="backup-keep-risky" className="block text-sm font-medium text-ink">
            Cópias por operação de risco
          </label>
          <input
            id="backup-keep-risky"
            type="number"
            min={1}
            value={config.keep_risky_operation}
            onChange={(event) =>
              setConfig({ ...config, keep_risky_operation: Number(event.currentTarget.value) || 1 })
            }
            className="mt-1 w-24 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => void handleSave()}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink"
        >
          {saveStatus === "saving" ? "Salvando…" : "Salvar configuração"}
        </button>
        {saveStatus === "saved" ? <span className="ml-3 text-sm text-mint-ink">Salvo.</span> : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-ink-muted">
          O app não guarda a senha do Postgres — para rodar a checagem de backup automático agora, informe-a aqui.
        </p>
        <Field label="Senha do Postgres" type="password" value={password} onChange={setPassword} />
        <div>
          <button
            type="button"
            disabled={password.length === 0 || checkStatus.kind === "running"}
            onClick={() => void handleCheckNow()}
            className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {checkStatus.kind === "running" ? "Checando…" : "Checar backup automático agora"}
          </button>
        </div>
        {checkStatus.kind === "ran" ? (
          <p role="status" className="text-sm text-mint-ink">
            Backup automático criado em {checkStatus.path}
          </p>
        ) : null}
        {checkStatus.kind === "not-due" ? (
          <p role="status" className="text-sm text-ink-muted">
            Ainda não é hora do próximo backup automático.
          </p>
        ) : null}
        {checkStatus.kind === "error" ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {checkStatus.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * PLT-011: manual backup and restore of the local Postgres database. The
 * password never gets stored by this component (or anywhere on disk) — it
 * lives only in this form's state for the duration of one backup/restore
 * call, same as `FirstRunWizard`'s connection test.
 */
export function BackupSettings() {
  const [backupPassword, setBackupPassword] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ kind: "idle" });

  const [restorePassword, setRestorePassword] = useState("");
  const [dumpPath, setDumpPath] = useState("");
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>({ kind: "idle" });

  async function pickOutputDir() {
    const selected = await open({ directory: true, title: "Pasta para salvar o backup" });
    if (typeof selected === "string") setOutputDir(selected);
  }

  async function pickDumpFile() {
    const selected = await open({
      title: "Selecionar arquivo de backup",
      filters: [{ name: "Backup do Learno", extensions: ["dump"] }],
    });
    if (typeof selected === "string") setDumpPath(selected);
  }

  async function handleCreateBackup() {
    setBackupStatus({ kind: "running" });
    try {
      const path = await createBackup(backupPassword, outputDir);
      setBackupStatus({ kind: "done", path });
    } catch (error) {
      setBackupStatus({ kind: "error", message: errorMessage(error, "Não foi possível criar o backup.") });
    }
  }

  async function handleRestore() {
    setRestoreStatus({ kind: "running" });
    try {
      await restoreBackup(restorePassword, dumpPath);
      setRestoreStatus({ kind: "done" });
    } catch (error) {
      setRestoreStatus({ kind: "error", message: errorMessage(error, "Não foi possível restaurar o backup.") });
    }
  }

  const canBackup = backupPassword.length > 0 && outputDir.length > 0 && backupStatus.kind !== "running";
  const canRestore = restorePassword.length > 0 && dumpPath.length > 0 && restoreStatus.kind !== "running";

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="backup-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="backup-heading" className="font-display text-lg text-ink">
            Copiar de segurança
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Gera um arquivo com todo o conteúdo do banco local, que pode ser restaurado depois.
          </p>
        </div>

        <Field label="Senha do Postgres" type="password" value={backupPassword} onChange={setBackupPassword} />
        <Field
          label="Pasta de destino"
          value={outputDir}
          onChange={setOutputDir}
          placeholder="Escolha uma pasta"
          action={{ label: "Escolher pasta", onClick: () => void pickOutputDir() }}
        />

        <div>
          <button
            type="button"
            disabled={!canBackup}
            onClick={() => void handleCreateBackup()}
            className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald disabled:opacity-60"
          >
            {backupStatus.kind === "running" ? "Criando backup…" : "Criar backup"}
          </button>
        </div>

        {backupStatus.kind === "done" ? (
          <p role="status" className="text-sm text-mint-ink">
            Backup criado em {backupStatus.path}
          </p>
        ) : null}
        {backupStatus.kind === "error" ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {backupStatus.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="restore-heading" className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 id="restore-heading" className="font-display text-lg text-ink">
            Restaurar backup
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Substitui o conteúdo atual do banco pelo conteúdo do arquivo selecionado. Esta ação não pode ser
            desfeita.
          </p>
        </div>

        <Field label="Senha do Postgres" type="password" value={restorePassword} onChange={setRestorePassword} />
        <Field
          label="Arquivo de backup"
          value={dumpPath}
          onChange={setDumpPath}
          placeholder="Escolha um arquivo .dump"
          action={{ label: "Escolher arquivo", onClick: () => void pickDumpFile() }}
        />

        {restoreStatus.kind === "confirming" ? (
          <div role="alertdialog" aria-label="Confirmar restauração" className="rounded-sm border border-terracotta-ink bg-surface p-3">
            <p className="text-sm text-ink">
              Isso substitui todo o conteúdo atual do banco pelo conteúdo deste arquivo. Confirma?
            </p>
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                onClick={() => void handleRestore()}
                className="rounded-sm bg-terracotta-ink px-3 py-1 text-xs font-medium text-on-emerald"
              >
                Sim, restaurar
              </button>
              <button
                type="button"
                onClick={() => setRestoreStatus({ kind: "idle" })}
                className="rounded-sm border border-border px-3 py-1 text-xs font-medium text-ink-muted"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              disabled={!canRestore}
              onClick={() => setRestoreStatus({ kind: "confirming" })}
              className="rounded-sm border border-terracotta-ink px-4 py-2 text-sm font-medium text-terracotta-ink disabled:opacity-60"
            >
              {restoreStatus.kind === "running" ? "Restaurando…" : "Restaurar"}
            </button>
          </div>
        )}

        {restoreStatus.kind === "done" ? (
          <p role="status" className="text-sm text-mint-ink">
            Backup restaurado com sucesso.
          </p>
        ) : null}
        {restoreStatus.kind === "error" ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {restoreStatus.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="automatic-backup-heading" className="flex flex-col gap-4 border-t border-border pt-6">
        <div>
          <h2 id="automatic-backup-heading" className="font-display text-lg text-ink">
            Backup automático
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Cria cópias de segurança periodicamente, mantendo só as mais recentes de cada frequência.
          </p>
        </div>
        <AutomaticBackupSection />
      </section>
    </div>
  );
}
