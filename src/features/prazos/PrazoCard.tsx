import { useState } from "react";
import { formatarDataDoPrazo, nivelDeUrgencia, rotuloDeContagem, SIMBOLO_DE_URGENCIA, type NivelDeUrgencia } from "./format";
import type { PrazoComContagem } from "./ipc";
import { usePrazosStore } from "./store";

const COR_DO_NIVEL: Record<NivelDeUrgencia, string> = {
  vencido: "text-terracotta-ink",
  hoje: "text-amber-ink",
  proximo: "text-ink",
  distante: "text-ink-muted",
};

interface PrazoCardProps {
  prazo: PrazoComContagem;
  /** `null` quando o prazo não tem baralho ligado, OU quando tem mas o nome não pôde ser resolvido (ex.: baralho na lixeira) — nos dois casos a linha simplesmente não aparece, nunca um nome inventado. */
  nomeDoBaralho: string | null;
  tituloDaPagina: string | null;
  onEditar: () => void;
}

/** Um prazo na lista: título, o que ele cobra (quando houver), contagem regressiva e as ações. */
export function PrazoCard({ prazo, nomeDoBaralho, tituloDaPagina, onEditar }: PrazoCardProps) {
  const concluir = usePrazosStore((state) => state.concluir);
  const remover = usePrazosStore((state) => state.remover);
  const [processando, setProcessando] = useState<"concluir" | "remover" | null>(null);

  const nivel = nivelDeUrgencia(prazo.diasRestantes);

  async function handleConcluir() {
    setProcessando("concluir");
    try {
      await concluir(prazo.id);
      // Sem `finally`: dando certo, `concluir` recarrega a lista e este
      // cartão some dela — setar `processando=null` aqui seria um
      // `setState` num componente que já não está mais montado (mesmo
      // raciocínio de `BlocoCard.handleRemover`).
    } catch {
      setProcessando(null);
    }
  }

  async function handleRemover() {
    const confirmado = window.confirm(`Apagar o prazo "${prazo.title}"? Isto não pode ser desfeito.`);
    if (!confirmado) return;
    setProcessando("remover");
    try {
      await remover(prazo.id);
    } catch {
      setProcessando(null);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 shadow-hard-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{prazo.title}</p>
          <p className="text-xs text-ink-muted">{formatarDataDoPrazo(prazo.dueLocalDate)}</p>
          {nomeDoBaralho ? <p className="mt-1 text-xs text-ink-muted">Baralho: {nomeDoBaralho}</p> : null}
          {tituloDaPagina ? <p className="mt-1 text-xs text-ink-muted">Página: {tituloDaPagina}</p> : null}
        </div>

        <span className={`flex shrink-0 items-center gap-1.5 text-sm font-medium ${COR_DO_NIVEL[nivel]}`}>
          <span aria-hidden="true">{SIMBOLO_DE_URGENCIA[nivel]}</span>
          {rotuloDeContagem(prazo.diasRestantes)}
        </span>
      </div>

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onEditar}
          disabled={processando !== null}
          className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised active:scale-97 disabled:pointer-events-none disabled:opacity-60"
        >
          Editar
        </button>
        <button
          type="button"
          onClick={() => void handleConcluir()}
          disabled={processando !== null}
          className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised active:scale-97 disabled:pointer-events-none disabled:opacity-60"
        >
          {processando === "concluir" ? "Concluindo…" : "Concluir"}
        </button>
        <button
          type="button"
          onClick={() => void handleRemover()}
          disabled={processando !== null}
          aria-label={`Apagar prazo ${prazo.title}`}
          className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised hover:text-terracotta-ink active:scale-97 disabled:pointer-events-none disabled:opacity-60"
        >
          {processando === "remover" ? "Apagando…" : "Apagar"}
        </button>
      </div>
    </li>
  );
}
