import { useEffect, useRef, useState } from "react";
import type { DeckRow } from "../../lib/ipc";
import { ContadoresBadge } from "./ContadoresBadge";
import { useCartoesStore } from "./store";
import { displayDeckName } from "./tree-utils";

interface DeckTreeRowProps {
  deck: DeckRow;
  depth: number;
  hasChildren: boolean;
}

/** Cada 14px de recuo é um nível de profundidade — a árvore de baralhos costuma ser mais rasa que a de páginas. */
const INDENT_PER_DEPTH_PX = 14;

/**
 * Uma linha da árvore de baralhos: expandir/recolher, selecionar, renomear
 * (duplo clique, mesmo gesto de `PageTreeItem`), criar subbaralho e apagar —
 * os dois últimos só aparecem no hover/foco, por não serem ação de alta
 * frequência (§9.2 do DESIGN-TOKENS).
 */
export function DeckTreeRow({ deck, depth, hasChildren }: DeckTreeRowProps) {
  const expandedIds = useCartoesStore((state) => state.expandedIds);
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const contagens = useCartoesStore((state) => state.contagens);
  const pendingFocusId = useCartoesStore((state) => state.pendingFocusId);
  const toggleExpanded = useCartoesStore((state) => state.toggleExpanded);
  const selectDeck = useCartoesStore((state) => state.selectDeck);
  const renameDeck = useCartoesStore((state) => state.renameDeck);
  const deleteDeck = useCartoesStore((state) => state.deleteDeck);
  const createDeck = useCartoesStore((state) => state.createDeck);
  const consumePendingFocus = useCartoesStore((state) => state.consumePendingFocus);
  const irPara = useCartoesStore((state) => state.irPara);

  const expanded = expandedIds.has(deck.id);
  const selected = deck.id === deckSelecionadoId;
  const contagem = contagens.get(deck.id);

  const [renomeando, setRenomeando] = useState(false);
  const [rascunho, setRascunho] = useState(deck.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renomeando) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renomeando]);

  function iniciarRenomeio() {
    setRascunho(deck.name);
    setRenomeando(true);
  }

  // O baralho nasce pelo "+" já em modo de edição do nome — a linha só
  // existe no DOM a partir deste render, então é aqui (não em `createDeck`)
  // que a intenção guardada em `pendingFocusId` vira, de fato, edição.
  // `iniciarRenomeio`/`consumePendingFocus` ficam fora da lista de
  // dependências de propósito (mesmo padrão de `PageTreeItem`): são recriadas
  // a cada render sem nunca mudar de comportamento, e incluí-las dispararia
  // o efeito de novo sem nenhuma mudança real de estado para reagir.
  useEffect(() => {
    if (pendingFocusId === deck.id) {
      iniciarRenomeio();
      consumePendingFocus(deck.id);
    }
  }, [pendingFocusId, deck.id]);

  async function confirmarRenomeio() {
    setRenomeando(false);
    const nome = rascunho.trim();
    if (nome === "" || nome === deck.name) return;
    await renameDeck(deck.id, nome);
  }

  async function apagar() {
    const confirmado = window.confirm(`Apagar o baralho "${displayDeckName(deck)}"? Isto não pode ser desfeito.`);
    if (!confirmado) return;
    await deleteDeck(deck.id);
  }

  async function criarSubbaralho() {
    await createDeck("Novo baralho", deck.id);
  }

  return (
    <div
      style={{ paddingLeft: depth * INDENT_PER_DEPTH_PX }}
      className={`group flex items-center gap-1 rounded-sm py-1 pr-1 text-sm
        ${selected ? "bg-surface-sunken text-ink" : "text-ink hover:bg-surface-sunken/60"}`}
    >
      <button
        type="button"
        onClick={() => toggleExpanded(deck.id)}
        aria-label={hasChildren ? (expanded ? `Recolher ${displayDeckName(deck)}` : `Expandir ${displayDeckName(deck)}`) : undefined}
        className={`grid size-5 shrink-0 place-items-center rounded-sm text-ink-muted transition-transform duration-150 ease-out
          ${expanded ? "rotate-90" : ""} ${hasChildren ? "" : "invisible"}`}
      >
        ▶
      </button>

      {renomeando ? (
        <input
          ref={inputRef}
          value={rascunho}
          onChange={(event) => setRascunho(event.currentTarget.value)}
          onBlur={() => void confirmarRenomeio()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setRenomeando(false);
              setRascunho(deck.name);
            }
          }}
          aria-label={`Nome do baralho ${displayDeckName(deck)}`}
          className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-1 py-0.5 text-sm text-ink"
        />
      ) : (
        <button type="button" onClick={() => selectDeck(deck.id)} onDoubleClick={iniciarRenomeio} className="min-w-0 flex-1 truncate text-left">
          {displayDeckName(deck)}
        </button>
      )}

      {contagem ? <ContadoresBadge contagens={contagem} /> : null}

      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => void criarSubbaralho()}
          aria-label={`Adicionar subbaralho em ${displayDeckName(deck)}`}
          className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-ink"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            // A tela de opções é de UM baralho: selecionar antes garante que
            // ela abre para este, não para o que estava selecionado.
            selectDeck(deck.id);
            irPara("opcoes");
          }}
          aria-label={`Opções de ${displayDeckName(deck)}`}
          className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-ink"
        >
          ⚙
        </button>
        <button
          type="button"
          onClick={() => void apagar()}
          aria-label={`Apagar ${displayDeckName(deck)}`}
          className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-terracotta-ink"
        >
          🗑
        </button>
      </span>
    </div>
  );
}
