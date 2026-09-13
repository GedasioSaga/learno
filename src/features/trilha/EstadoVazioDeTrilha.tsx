import { useTrilhaStore } from "./store";

/**
 * O convite de quem nunca criou uma Trilha. Diferente de `EmptyState`
 * (`src/components/EmptyState.tsx`): aquele não tem espaço para uma ação —
 * aqui existe um botão de verdade, então em vez de forçar o componente
 * genérico a virar outra coisa, este arquivo escreve o próprio, pequeno.
 */
export function EstadoVazioDeTrilha() {
  const criarPrimeiraTrilha = useTrilhaStore((state) => state.criarPrimeiraTrilha);
  const errorMessage = useTrilhaStore((state) => state.errorMessage);
  const status = useTrilhaStore((state) => state.status);

  const criando = status === "carregando";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span aria-hidden="true" className="text-4xl" style={{ imageRendering: "pixelated" }}>
        🧭
      </span>
      <h2 className="font-display text-lg text-ink">Nenhuma trilha ainda</h2>
      <p className="max-w-sm text-sm text-ink-muted">
        Uma trilha é um caminho de estudo: etapas ligadas por flechas de pré-requisito, nunca por data. Crie a primeira para
        começar a desenhar o que vem antes do quê.
      </p>
      <button
        type="button"
        onClick={() => void criarPrimeiraTrilha()}
        disabled={criando}
        className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
      >
        {criando ? "Criando…" : "Criar minha primeira trilha"}
      </button>
      {errorMessage ? (
        <p role="alert" className="max-w-sm text-sm text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
