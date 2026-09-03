import { useId, useState, type FormEvent } from "react";
import { AppError, connectDatabase, saveDataDir, testDatabaseConnection, type AppConfig } from "../lib/ipc";

/** `kind` que o backend usa quando nenhuma instância de Postgres respondeu — ver `Error::DatabaseUnreachable` em `src-tauri/src/error.rs`. */
const DATABASE_UNREACHABLE_KIND = "database_unreachable";

interface FirstRunWizardProps {
  onComplete: () => void;
  /**
   * `"setup"` (padrão) é o assistente de primeira execução completo, com a
   * pasta de dados. `"reconnect"` é a tela mostrada em toda abertura
   * seguinte em que já existe `AppConfig` salvo mas esta execução do
   * processo ainda não chamou `connectDatabase` — a senha nunca é
   * persistida (ver `AppConfig` em `src/lib/ipc.ts`), então precisa ser
   * pedida de novo, mas host/porta/banco/usuário já vêm de `savedConfig` e a
   * pasta de dados não é perguntada de novo.
   */
  mode?: "setup" | "reconnect";
  savedConfig?: AppConfig;
}

type Status = "idle" | "testing" | "tested" | "saving" | "error";

// Precisa bater com `config::DEFAULT_PORT` em src-tauri/src/config/mod.rs —
// é só o valor inicial do campo, o usuário pode trocar livremente.
const DEFAULT_PORT = 5432;

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "numeric";
  autoFocus?: boolean;
  /**
   * Vira só `aria-required` — nunca o atributo nativo `required`. Um
   * `<input required>` vazio bloqueia o `submit` do formulário ANTES do
   * `onSubmit` rodar, sem alerta nem estado de erro (era exatamente o
   * defeito do campo Senha, ver docs/ACHADOS-FASE-1.md #1). Cada campo
   * obrigatório valida sua própria ausência dentro de `handleTest`, onde dá
   * para mostrar uma mensagem de verdade em vez de deixar a tela muda.
   */
  required?: boolean;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  autoFocus,
  required = true,
}: FieldProps) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        autoFocus={autoFocus}
        aria-required={required}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
      />
    </div>
  );
}

/**
 * Assistente de primeira execução (PLT-016) e tela de reconexão (mesmo
 * formulário, `mode: "reconnect"`): pede host/porta/banco/usuário/senha do
 * Postgres (e, só na primeira execução, a pasta de dados do Learno), testa a
 * conexão de verdade e só então chama `connectDatabase` — que abre a conexão
 * real, aplica as migrações pendentes e persiste a configuração (nunca a
 * senha). `onComplete` só é chamado depois que a conexão de verdade existe;
 * uma falha aqui (banco fora do ar, senha errada, migração quebrada) deixa o
 * usuário nesta mesma tela, com a mensagem do backend e liberdade de tentar
 * de novo — nunca avança para um app sem conexão nenhuma.
 */
export function FirstRunWizard({ onComplete, mode = "setup", savedConfig }: FirstRunWizardProps) {
  const [host, setHost] = useState(savedConfig?.host ?? "localhost");
  const [port, setPort] = useState(String(savedConfig?.port ?? DEFAULT_PORT));
  const [database, setDatabase] = useState(savedConfig?.database ?? "learno");
  const [user, setUser] = useState(savedConfig?.user ?? "postgres");
  const [password, setPassword] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);

  const isReconnect = mode === "reconnect";
  const parsedPort = Number(port);
  const portIsValid = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;

  /**
   * Host, banco e usuário precisam de algum valor para o backend nem
   * tentar conectar — mas, ao contrário de Senha, não têm um caso de
   * domínio legítimo para ficarem em branco. Checados em ordem de
   * preenchimento no formulário; retorna a mensagem do primeiro vazio,
   * ou `null` se todos estão preenchidos.
   */
  function blankRequiredFieldMessage(): string | null {
    if (!host.trim()) return "Host não pode ficar em branco.";
    if (!database.trim()) return "Banco de dados não pode ficar em branco.";
    if (!user.trim()) return "Usuário não pode ficar em branco.";
    return null;
  }

  async function handleTest(event: FormEvent) {
    event.preventDefault();

    const blankFieldMessage = blankRequiredFieldMessage();
    if (blankFieldMessage) {
      setStatus("error");
      setErrorMessage(blankFieldMessage);
      setErrorKind(null);
      return;
    }

    if (!portIsValid) {
      setStatus("error");
      setErrorMessage("Porta precisa ser um número entre 1 e 65535.");
      setErrorKind(null);
      return;
    }

    setStatus("testing");
    setErrorMessage(null);
    setErrorKind(null);
    try {
      await testDatabaseConnection({ host, port: parsedPort, database, user, password });
      setStatus("tested");
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        error instanceof AppError ? error.message : "Não foi possível testar a conexão.",
      );
      setErrorKind(error instanceof AppError ? error.kind : null);
    }
  }

  async function handleContinue() {
    if (!portIsValid) return;

    setStatus("saving");
    setErrorMessage(null);
    setErrorKind(null);
    try {
      await connectDatabase({ host, port: parsedPort, database, user, password });
      // Pasta de dados é opcional e só existe no assistente de primeira
      // execução — em branco, o app segue no padrão do SO (`app_data_dir()`)
      // que `backup::dump` já usa; só grava quando o usuário de fato
      // informou algo.
      if (!isReconnect && dataDir.trim()) {
        await saveDataDir(dataDir.trim());
      }
      onComplete();
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        error instanceof AppError ? error.message : "Não foi possível conectar ao banco de dados.",
      );
      setErrorKind(error instanceof AppError ? error.kind : null);
    }
  }

  const canContinue = status === "tested" || status === "saving";

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-12">
      <div className="w-full max-w-md rounded-md border border-border bg-surface p-8 shadow-hard">
        <h1 className="font-display text-2xl text-ink">Conectar ao Postgres</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {isReconnect
            ? "Por segurança, a senha do Postgres nunca fica salva no disco — informe-a de novo para continuar."
            : "O Learno guarda tudo num banco Postgres na sua máquina. Preencha os dados de conexão para começar."}
        </p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={handleTest}>
          <Field label="Host" value={host} onChange={setHost} autoFocus={!isReconnect} />
          <Field label="Porta" value={port} onChange={setPort} inputMode="numeric" />
          <Field label="Banco de dados" value={database} onChange={setDatabase} />
          <Field label="Usuário" value={user} onChange={setUser} />
          <div>
            <Field
              label="Senha"
              value={password}
              onChange={setPassword}
              type="password"
              autoFocus={isReconnect}
              required={false}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Deixe em branco se o seu Postgres usa autenticação trust, peer ou ident — nesses
              casos não existe senha para digitar. Se a conexão falhar, revise a senha primeiro:
              é a causa mais comum de erro de conexão.
            </p>
          </div>
          {isReconnect ? null : (
            <div>
              <Field
                label="Pasta de dados (opcional)"
                value={dataDir}
                onChange={setDataDir}
                required={false}
              />
              <p className="mt-1 text-xs text-ink-muted">
                Onde o Learno guarda seus próprios arquivos locais (backups, exportações). Deixe em
                branco para usar a pasta padrão do sistema.
              </p>
            </div>
          )}

          {status === "error" && errorMessage ? (
            <div role="alert" className="text-sm text-terracotta-ink">
              <p>{errorMessage}</p>
              {errorKind === DATABASE_UNREACHABLE_KIND ? (
                <p className="mt-1 text-ink-muted">
                  Nenhuma instância do Postgres foi encontrada nesse endereço. Baixe e instale o
                  PostgreSQL 18 em postgresql.org/download, confirme que o serviço está em
                  execução e tente testar de novo.
                </p>
              ) : null}
            </div>
          ) : null}
          {status === "tested" ? (
            <p role="status" className="text-sm text-mint-ink">
              Conexão bem-sucedida.
            </p>
          ) : null}

          <div className="mt-2 flex gap-3">
            <button
              type="submit"
              disabled={status === "testing"}
              className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink shadow-hard-sm disabled:opacity-60"
            >
              {status === "testing" ? "Testando…" : "Testar conexão"}
            </button>
            <button
              type="button"
              onClick={handleContinue}
              disabled={!canContinue}
              className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald shadow-hard-sm disabled:opacity-60"
            >
              {status === "saving" ? "Conectando…" : "Continuar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
