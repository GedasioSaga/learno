import { mesDe, rotuloDoMes } from "./dinheiro";
import { BOTAO_SECUNDARIO } from "./estilos";
import { useFinancasStore, type SubAbaDeFinancas } from "./store";

const SUB_ABAS: { valor: SubAbaDeFinancas; rotulo: string }[] = [
  { valor: "visao-geral", rotulo: "Visão geral" },
  { valor: "lancamentos", rotulo: "Lançamentos" },
  { valor: "renda-e-fixos", rotulo: "Renda e fixos" },
];

/**
 * Título, o mês aberto (‹ mês ›) e as sub-abas. O mês fica acima das
 * sub-abas de propósito: ele vale para as três, e é isso que as liga.
 *
 * Sub-abas como `<button aria-pressed>`, mesmo motivo de
 * `cronograma/SeletorDeVisao.tsx`: `role="tab"` promete navegação por seta
 * que este grupo não implementa.
 */
export function CabecalhoDeFinancas() {
  const mes = useFinancasStore((state) => state.mes);
  const subAba = useFinancasStore((state) => state.subAba);
  const deslocarMes = useFinancasStore((state) => state.deslocarMes);
  const definirMes = useFinancasStore((state) => state.definirMes);
  const definirSubAba = useFinancasStore((state) => state.definirSubAba);

  const mesDeHoje = mesDe(new Date());

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Finanças</h1>

        <div className="flex items-center gap-1.5" role="group" aria-label="Mês">
          <button
            type="button"
            onClick={() => void deslocarMes(-1)}
            aria-label="Mês anterior"
            className={BOTAO_SECUNDARIO}
          >
            ‹
          </button>
          <p className="min-w-44 text-center text-sm font-medium text-ink first-letter:uppercase" aria-live="polite">
            {rotuloDoMes(mes)}
          </p>
          <button
            type="button"
            onClick={() => void deslocarMes(1)}
            aria-label="Próximo mês"
            className={BOTAO_SECUNDARIO}
          >
            ›
          </button>
          {mes !== mesDeHoje ? (
            <button type="button" onClick={() => void definirMes(mesDeHoje)} className={BOTAO_SECUNDARIO}>
              Mês atual
            </button>
          ) : null}
        </div>
      </div>

      <div
        role="group"
        aria-label="Parte de Finanças"
        className="inline-flex self-start rounded-sm border border-border bg-surface p-0.5"
      >
        {SUB_ABAS.map((opcao) => {
          const ativo = subAba === opcao.valor;
          return (
            <button
              key={opcao.valor}
              type="button"
              aria-pressed={ativo}
              onClick={() => definirSubAba(opcao.valor)}
              className={`rounded-sm px-3 py-1 text-sm transition duration-150 ease-out motion-reduce:transition-none ${
                ativo ? "bg-surface-raised font-medium text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {opcao.rotulo}
            </button>
          );
        })}
      </div>
    </header>
  );
}
