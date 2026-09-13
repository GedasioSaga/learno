import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Estado =
  | { fase: "aviso" }
  | { fase: "baixando"; baixado: number; total: number | null }
  | { fase: "erro"; mensagem: string };

/**
 * Vigia de atualização: no boot consulta o `latest.json` do release mais
 * recente no GitHub (endpoint em `tauri.conf.json`) e, havendo versão nova,
 * mostra um aviso no canto. "Atualizar agora" baixa o instalador assinado,
 * aplica e reinicia o app.
 *
 * Silencioso em qualquer falha do check (sem rede, repo sem release ainda,
 * rodando em `tauri dev`): update é conveniência, não pode virar erro toda vez
 * que o app abre offline. Erro só aparece depois que a pessoa pediu para
 * atualizar.
 */
export function AtualizadorBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "aviso" });

  useEffect(() => {
    let ativo = true;
    check()
      .then((u) => {
        if (ativo && u) setUpdate(u);
      })
      .catch(() => {});
    return () => {
      ativo = false;
    };
  }, []);

  if (!update) return null;
  const versao = update.version;

  async function instalar() {
    if (!update) return;
    let baixado = 0;
    let total: number | null = null;
    setEstado({ fase: "baixando", baixado, total });
    try {
      await update.downloadAndInstall((evento) => {
        if (evento.event === "Started") total = evento.data.contentLength ?? null;
        if (evento.event === "Progress") baixado += evento.data.chunkLength;
        setEstado({ fase: "baixando", baixado, total });
      });
      await relaunch();
    } catch (e) {
      setEstado({ fase: "erro", mensagem: String(e) });
    }
  }

  const porcentagem =
    estado.fase === "baixando" && estado.total
      ? Math.min(100, Math.round((estado.baixado / estado.total) * 100))
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-md border border-border bg-surface-raised px-4 py-3 text-sm text-ink shadow-hard-sm"
    >
      {estado.fase === "aviso" && (
        <div className="flex items-center justify-between gap-3">
          <p>
            Nova versão <span className="font-medium text-amber-ink">v{versao}</span> disponível
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={instalar}
              className="rounded-sm bg-emerald px-3 py-1 text-xs font-medium text-on-emerald"
            >
              Atualizar agora
            </button>
            <button
              type="button"
              onClick={() => setUpdate(null)}
              className="rounded-sm border border-border px-3 py-1 text-xs font-medium text-ink-muted"
            >
              Depois
            </button>
          </div>
        </div>
      )}

      {estado.fase === "baixando" && (
        <>
          <p>
            Baixando v{versao}
            {porcentagem !== null ? ` — ${porcentagem}%` : "…"} O Learno reinicia sozinho ao terminar.
          </p>
          <div
            role="progressbar"
            aria-label="Progresso do download da atualização"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={porcentagem ?? undefined}
            className="h-1.5 overflow-hidden rounded-sm bg-surface-sunken"
          >
            <div
              className="h-full bg-emerald transition-[width] duration-150 ease-out"
              style={{ width: `${porcentagem ?? 100}%` }}
            />
          </div>
        </>
      )}

      {estado.fase === "erro" && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-terracotta-ink">Atualização falhou: {estado.mensagem}</p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={instalar}
              className="rounded-sm bg-emerald px-3 py-1 text-xs font-medium text-on-emerald"
            >
              Tentar de novo
            </button>
            <button
              type="button"
              onClick={() => setUpdate(null)}
              className="rounded-sm border border-border px-3 py-1 text-xs font-medium text-ink-muted"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
