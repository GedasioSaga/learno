import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AppError, defaultExportFileName, exportPageMarkdown } from "../../lib/ipc";

interface ExportMarkdownButtonProps {
  pageId: string;
  pageTitle: string;
}

type Status = "idle" | "exporting" | "done" | "error";

/**
 * FUN-023: exports the current page to a standalone `.md` file. The save
 * dialog's suggested name always goes through `defaultExportFileName`
 * (backed by `sanitize_filename` in Rust), so a title with characters
 * Windows rejects in a filename never reaches the dialog unsanitized.
 */
export function ExportMarkdownButton({ pageId, pageTitle }: ExportMarkdownButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleExport() {
    setStatus("exporting");
    setMessage(null);
    try {
      const suggestedName = await defaultExportFileName(pageTitle);
      const targetPath = await save({
        defaultPath: suggestedName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });

      // The user closed the dialog without choosing a file — not an error,
      // just nothing left to do.
      if (targetPath === null) {
        setStatus("idle");
        return;
      }

      await exportPageMarkdown(pageId, targetPath);
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof AppError || error instanceof Error ? error.message : "Não foi possível exportar a página.");
    }
  }

  // `inline-flex`, e não `flex flex-col`: este botão mora numa barra de ações
  // ao lado de outros, e um contêiner de bloco o esticava para a largura
  // inteira do cabeçalho — o controle mais raramente usado da tela virava o
  // maior. O status aparece ao lado, não abaixo, pelo mesmo motivo.
  return (
    <span className="inline-flex items-center gap-2">
      {/* Texto visível curto, nome acessível inteiro: numa barra de ações ao
          lado de "Histórico", a palavra "Exportar" basta para o olho, mas um
          leitor de tela anuncia o botão fora desse contexto e "Exportar" sozinho
          não diz exportar o quê, para qual formato. */}
      <button
        type="button"
        aria-label="Exportar como Markdown"
        disabled={status === "exporting"}
        onClick={() => void handleExport()}
        className="rounded-sm px-2 py-1 text-sm text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-ink disabled:pointer-events-none disabled:opacity-50"
      >
        {status === "exporting" ? "Exportando…" : "Exportar"}
      </button>
      {status === "done" ? (
        <span role="status" className="text-xs text-mint-ink">
          Página exportada.
        </span>
      ) : null}
      {status === "error" && message ? (
        <span role="alert" className="max-w-48 truncate text-xs text-terracotta-ink" title={message}>
          {message}
        </span>
      ) : null}
    </span>
  );
}
