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

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={status === "exporting"}
        onClick={() => void handleExport()}
        className="rounded-sm border border-border bg-surface px-3 py-2 text-sm font-medium text-ink disabled:opacity-60"
      >
        {status === "exporting" ? "Exportando…" : "Exportar como Markdown"}
      </button>
      {status === "done" ? (
        <p role="status" className="text-sm text-mint-ink">
          Página exportada.
        </p>
      ) : null}
      {status === "error" && message ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {message}
        </p>
      ) : null}
    </div>
  );
}
