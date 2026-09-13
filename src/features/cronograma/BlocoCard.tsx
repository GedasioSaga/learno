import { useState } from "react";
import type { BlocoPlanejado } from "../../lib/ipc";
import type { CorDaGrade } from "./cores";
import { formatarDuracao, rotuloDoBloco, ROTULO_DA_ATIVIDADE } from "./format";
import { useCronogramaStore } from "./store";

interface BlocoCardProps {
  bloco: BlocoPlanejado;
  /**
   * Cor da matéria, só quando o cartão está na faixa "sem horário" da Grade
   * (`GradeSemanal.tsx`): vira `data-cor`, e `cronograma-grade.css` pinta o
   * acento. A visão de Colunas não passa nada e o cartão fica como sempre.
   */
  cor?: CorDaGrade;
}

/** Um bloco planejado dentro da coluna do dia: horário, o que fazer, duração, e remover. */
export function BlocoCard({ bloco, cor }: BlocoCardProps) {
  const removerBloco = useCronogramaStore((state) => state.removerBloco);
  const [removendo, setRemovendo] = useState(false);

  async function handleRemover() {
    setRemovendo(true);
    try {
      await removerBloco(bloco.id);
      // Sem `finally`: se der certo, `removerBloco` recarrega a semana e este
      // cartão some da árvore — setar `removendo=false` aqui seria um
      // `setState` num componente que já não está mais montado.
    } catch {
      setRemovendo(false);
    }
  }

  const rotulo = rotuloDoBloco(bloco);
  // `startLocalTime` nasce `null` (o backend só decide o horário depois da
  // criação) — sem este `null`, o cartão mostrava literalmente "undefined".
  const cabecalho = bloco.startLocalTime ? `${bloco.startLocalTime} · ${rotulo}` : rotulo;
  const rotuloRemover = bloco.startLocalTime
    ? `Remover bloco de ${ROTULO_DA_ATIVIDADE[bloco.activity]} às ${bloco.startLocalTime}`
    : `Remover bloco de ${ROTULO_DA_ATIVIDADE[bloco.activity]}`;

  return (
    <div
      data-slot="bloco-card"
      data-cor={cor}
      className="flex items-start justify-between gap-2 rounded-sm border border-border bg-surface-sunken px-2 py-1.5"
    >
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink">{cabecalho}</p>
        <p className="text-xs text-ink-muted">{formatarDuracao(bloco)}</p>
      </div>
      {/* `relative` + `after:-inset-*`: o ✕ desenha pequeno, mas a área que
          reage cresce (≈36×42px, o mais perto de `--hit-min` que cabe sem
          invadir o cartão vizinho na faixa "sem horário" da Grade). */}
      <button
        type="button"
        onClick={() => void handleRemover()}
        disabled={removendo}
        aria-label={rotuloRemover}
        className="relative shrink-0 rounded-sm px-1 text-xs text-ink-muted transition duration-150 ease-out after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:text-terracotta-ink disabled:opacity-50"
      >
        ✕
      </button>
    </div>
  );
}
