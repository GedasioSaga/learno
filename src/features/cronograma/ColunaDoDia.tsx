import { useState } from "react";
import type { DiaDaSemana } from "../../lib/ipc";
import { BlocoCard } from "./BlocoCard";
import { abreviacaoDoDia, hojeLocal, rotuloCurtoDoDia } from "./date-utils";
import { NovoBlocoForm } from "./NovoBlocoForm";

interface ColunaDoDiaProps {
  dia: DiaDaSemana;
}

/** Uma coluna da faixa de sete dias: cabeçalho do dia, os blocos planejados, o realizado, e "+ bloco". */
export function ColunaDoDia({ dia }: ColunaDoDiaProps) {
  const [criando, setCriando] = useState(false);
  const ehHoje = dia.data === hojeLocal();

  return (
    <div
      data-slot="coluna-do-dia"
      className={`flex min-w-0 flex-col gap-2 rounded-md border p-3 ${
        ehHoje ? "border-amber bg-surface-raised" : "border-border bg-surface"
      }`}
    >
      {/* `aria-current="date"` no cabeçalho — sem isso a coluna de hoje só se
          distingue por cor/peso de fonte, invisível para leitor de tela. */}
      <div aria-current={ehHoje ? "date" : undefined} className="flex items-baseline justify-between gap-1">
        <span className={`text-xs uppercase tracking-wide ${ehHoje ? "font-semibold text-ink" : "font-medium text-ink-muted"}`}>
          {abreviacaoDoDia(dia.data)}
        </span>
        <span className="text-xs text-ink-muted">{rotuloCurtoDoDia(dia.data)}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {dia.blocos.length === 0 ? (
          <p className="text-xs text-ink-muted">Nada planejado.</p>
        ) : (
          dia.blocos.map((bloco) => <BlocoCard key={bloco.id} bloco={bloco} />)
        )}
      </div>

      <p className="text-xs text-ink-muted">Realizado: {dia.minutosRealizados} min</p>

      {criando ? (
        <NovoBlocoForm dia={dia.data} onFechar={() => setCriando(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setCriando(true)}
          aria-label={`Adicionar bloco em ${rotuloCurtoDoDia(dia.data)}`}
          className="rounded-sm border border-dashed border-border px-2 py-1.5 text-xs text-ink-muted transition duration-150 ease-out hover:border-solid hover:bg-surface-raised hover:text-ink active:scale-97"
        >
          + bloco
        </button>
      )}
    </div>
  );
}
