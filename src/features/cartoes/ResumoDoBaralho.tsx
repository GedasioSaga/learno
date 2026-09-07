import { useCartoesStore } from "./store";
import { displayDeckName } from "./tree-utils";

/**
 * A tela de resumo de um baralho (ou de "Todos os baralhos"): nome, os três
 * contadores por extenso e as duas ações — Estudar e Criar cartão. É a tela
 * padrão de `ConteudoDeCartoes` (`tela === "resumo"`).
 */
export function ResumoDoBaralho() {
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const decksById = useCartoesStore((state) => state.decksById);
  const contagens = useCartoesStore((state) => state.contagens);
  const irPara = useCartoesStore((state) => state.irPara);

  const deck = deckSelecionadoId ? decksById.get(deckSelecionadoId) : null;
  const nome = deck ? displayDeckName(deck) : "Todos os baralhos";
  const contagem = contagens.get(deckSelecionadoId ?? null);
  const total = contagem ? contagem.novos + contagem.aprendendo + contagem.revisar : null;

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div>
        <h2 className="font-display text-2xl text-ink">{nome}</h2>
        {contagem ? (
          <p className="mt-1 text-sm text-ink-muted">
            {contagem.novos} novos · {contagem.aprendendo} aprendendo · {contagem.revisar} para revisar
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Carregando contagens…</p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => irPara("estudo")}
          disabled={total === null || total === 0}
          className="rounded-sm bg-emerald px-6 py-3 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
        >
          Estudar
        </button>
        <button
          type="button"
          onClick={() => irPara("criar")}
          className="rounded-sm border border-border bg-surface px-6 py-3 text-sm text-ink transition hover:bg-surface-raised active:scale-97"
        >
          Criar cartão
        </button>
        {deck ? (
          <button
            type="button"
            onClick={() => irPara("opcoes")}
            className="rounded-sm border border-border bg-surface px-6 py-3 text-sm text-ink transition hover:bg-surface-raised active:scale-97"
          >
            Opções do baralho
          </button>
        ) : null}
      </div>

      {total === 0 ? (
        <p className="text-sm text-ink-muted">Nada para estudar aqui agora. Volte mais tarde ou crie um cartão novo.</p>
      ) : null}
    </div>
  );
}
