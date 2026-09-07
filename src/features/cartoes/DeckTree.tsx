import { useEffect } from "react";
import { ContadoresBadge } from "./ContadoresBadge";
import { DeckTreeRow } from "./DeckTreeRow";
import { useCartoesStore } from "./store";

/** Um galho da árvore: os filhos de `parentId`, recursivamente. */
function Galho({ parentId, depth }: { parentId: string | null; depth: number }) {
  const childrenIndex = useCartoesStore((state) => state.childrenIndex);
  const expandedIds = useCartoesStore((state) => state.expandedIds);
  const filhos = childrenIndex.get(parentId) ?? [];

  if (filhos.length === 0) return null;

  return (
    <ul>
      {filhos.map((deck) => {
        const netos = childrenIndex.get(deck.id) ?? [];
        return (
          <li key={deck.id}>
            <DeckTreeRow deck={deck} depth={depth} hasChildren={netos.length > 0} />
            {netos.length > 0 && expandedIds.has(deck.id) ? <Galho parentId={deck.id} depth={depth + 1} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * O painel da seção Cartões: "Todos os baralhos" (a coleção inteira) no topo,
 * a árvore de baralhos reais embaixo, e "Novo baralho" no rodapé — o mesmo
 * esqueleto de `PageTree` (favoritos/árvore/rodapé), com baralhos em vez de
 * páginas e sem arrastar-e-soltar (não pedido para esta seção).
 */
export function PainelDeCartoes() {
  const status = useCartoesStore((state) => state.status);
  const errorMessage = useCartoesStore((state) => state.errorMessage);
  const load = useCartoesStore((state) => state.load);
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const contagens = useCartoesStore((state) => state.contagens);
  const selectDeck = useCartoesStore((state) => state.selectDeck);
  const createDeck = useCartoesStore((state) => state.createDeck);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading" || status === "idle") {
    return <p className="px-4 py-3 text-sm text-ink-muted">Carregando baralhos…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar os baralhos."}
      </p>
    );
  }

  const contagemTotal = contagens.get(null);

  return (
    <nav aria-label="Baralhos" data-slot="deck-tree" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
      <button
        type="button"
        onClick={() => selectDeck(null)}
        className={`flex items-center gap-1 rounded-sm px-2 py-1.5 text-left text-sm
          ${deckSelecionadoId === null ? "bg-surface-sunken text-ink" : "text-ink hover:bg-surface-sunken/60"}`}
      >
        <span className="min-w-0 flex-1 truncate font-medium">Todos os baralhos</span>
        {contagemTotal ? <ContadoresBadge contagens={contagemTotal} /> : null}
      </button>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto border-t border-hairline pt-1">
        <Galho parentId={null} depth={0} />
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => void createDeck("Novo baralho", null)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
            transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97"
        >
          <span aria-hidden="true">+</span> Novo baralho
        </button>
      </div>

      {errorMessage ? (
        <p role="alert" className="px-2 pt-2 text-xs text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
    </nav>
  );
}
