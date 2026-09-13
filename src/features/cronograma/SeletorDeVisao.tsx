import { useCronogramaStore, type VisaoDoCronograma } from "./store";

const OPCOES: { valor: VisaoDoCronograma; rotulo: string }[] = [
  { valor: "colunas", rotulo: "Colunas" },
  { valor: "grade", rotulo: "Grade" },
];

/**
 * Alterna entre a visão de Colunas (uma lista por dia, a original) e a
 * visão de Grade (faixa de horário × dia) — as duas convivem, a escolha é
 * lembrada entre sessões (`store.ts`, `localStorage`).
 *
 * Dois `<button>` com `aria-pressed`, não `role="radio"`: um `role="radio"`
 * de verdade exige navegação por seta do teclado dentro do grupo (o padrão
 * ARIA de "radiogroup"), que este par de botões não implementa — declarar o
 * papel sem o comportamento é pior que não declarar. `aria-pressed` describe
 * exatamente o que este controle é (um par de botões de alternância) e não
 * promete nada que o teclado não entrega: Tab foca cada botão, Enter/Espaço
 * ativa — comportamento nativo de `<button>`, de graça.
 */
export function SeletorDeVisao() {
  const visao = useCronogramaStore((state) => state.visao);
  const definirVisao = useCronogramaStore((state) => state.definirVisao);

  return (
    <div
      role="group"
      aria-label="Visão do cronograma"
      className="inline-flex rounded-sm border border-border bg-surface p-0.5"
    >
      {OPCOES.map((opcao) => {
        const ativo = visao === opcao.valor;
        return (
          <button
            key={opcao.valor}
            type="button"
            aria-pressed={ativo}
            onClick={() => definirVisao(opcao.valor)}
            className={`rounded-sm px-3 py-1 text-sm transition duration-150 ease-out ${
              ativo ? "bg-surface-raised font-medium text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {opcao.rotulo}
          </button>
        );
      })}
    </div>
  );
}
