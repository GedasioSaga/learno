import { useEffect, useState } from "react";
import { AppError, deckForecast, type DeckForecastDay } from "../../lib/ipc";
import { useCartoesStore } from "./store";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

const DIAS_DA_PREVISAO = 30;

/** "seg", "23/03" — o rótulo de uma barra, sem depender de hover pra ser lido. */
function rotulosDoDia(diaISO: string): { semana: string; data: string } {
  // `diaISO` é "YYYY-MM-DD" local (contrato de `DeckForecastDay.data`); construir
  // a partir dos componentes, não `new Date(diaISO)`, que o motor lê como UTC
  // meia-noite e pode voltar um dia no fuso local.
  const [ano, mes, dia] = diaISO.split("-").map(Number);
  const data = new Date(ano, mes - 1, dia);
  const semana = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(data).replace(".", "");
  const dataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(data);
  return { semana, data: dataCurta };
}

/**
 * A aba Painel: quantos cartões vencem em cada um dos próximos 30 dias —
 * o `deckForecast` que existia no contrato e nunca tinha chamador.
 *
 * Barras com o número escrito embaixo, não só uma dica de hover: a
 * informação inteira já está em texto visível, então não precisa de mouse
 * nem de um mecanismo de acessibilidade à parte para chegar nela.
 */
export function PainelDePrevisao() {
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);

  const [status, setStatus] = useState<"carregando" | "pronto" | "erro">("carregando");
  const [dias, setDias] = useState<DeckForecastDay[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setStatus("carregando");
    setErrorMessage(null);
    deckForecast(deckSelecionadoId, DIAS_DA_PREVISAO)
      .then((resultado) => {
        if (cancelado) return;
        setDias(resultado);
        setStatus("pronto");
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        setErrorMessage(messageFor(error, "Não foi possível carregar a previsão."));
        setStatus("erro");
      });
    return () => {
      cancelado = true;
    };
  }, [deckSelecionadoId]);

  if (status === "carregando") {
    return <p className="p-6 text-sm text-ink-muted">Carregando previsão…</p>;
  }

  if (status === "erro") {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage}
      </p>
    );
  }

  const maximo = Math.max(1, ...dias.map((d) => d.quantidade));
  const total = dias.reduce((soma, d) => soma + d.quantidade, 0);

  if (total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <h2 className="font-display text-xl text-ink">Nada vencendo nos próximos {DIAS_DA_PREVISAO} dias</h2>
        <p className="max-w-sm text-sm text-ink-muted">Sem cartões agendados para essa janela — a fila está em dia.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h2 className="font-display text-xl text-ink">Previsão de vencimentos</h2>
        <p className="mt-1 text-sm text-ink-muted">
          {total} {total === 1 ? "cartão" : "cartões"} nos próximos {DIAS_DA_PREVISAO} dias
        </p>
      </div>

      <div className="flex min-h-40 flex-1 items-end gap-1 overflow-x-auto pb-1" role="list" aria-label="Cartões a vencer por dia">
        {dias.map((diaDoForecast) => {
          const { semana, data } = rotulosDoDia(diaDoForecast.data);
          const alturaPercentual = Math.max(4, (diaDoForecast.quantidade / maximo) * 100);
          return (
            <div key={diaDoForecast.data} role="listitem" className="flex min-w-9 flex-1 flex-col items-center gap-1">
              <span className="text-xs tabular-nums text-ink">{diaDoForecast.quantidade}</span>
              <div className="flex h-24 w-full items-end">
                <div
                  className={diaDoForecast.quantidade > 0 ? "w-full rounded-t-sm bg-emerald" : "w-full rounded-t-sm bg-surface-sunken"}
                  style={{ height: `${alturaPercentual}%` }}
                />
              </div>
              <span className="text-[10px] uppercase text-ink-muted">{semana}</span>
              <span className="text-[10px] text-ink-muted">{data}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
