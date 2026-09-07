import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeckRow } from "../../lib/ipc";
import { DeckTreeRow } from "./DeckTreeRow";
import { ResumoDoBaralho } from "./ResumoDoBaralho";
import { useCartoesStore } from "./store";

/**
 * A costura entre a tela de Opções e os dois lugares de onde se chega nela.
 * `toda-tela-e-alcancavel.test.ts` só cobre `ConteudoDe*`; uma subtela como
 * esta fica alcançável ou não pelos botões abaixo, e é isto que se prova.
 */
function deck(id: string, name: string): DeckRow {
  return {
    id,
    parentId: null,
    name,
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  useCartoesStore.setState({
    deckSelecionadoId: "ingles",
    decksById: new Map([["ingles", deck("ingles", "Inglês")]]),
    contagens: new Map([["ingles", { novos: 1, aprendendo: 0, revisar: 0 }]]),
    expandedIds: new Set(),
    pendingFocusId: null,
    tela: "resumo",
  });
});

describe("como se chega nas opções do baralho", () => {
  it("pelo botão 'Opções do baralho' no resumo de um baralho", async () => {
    const user = userEvent.setup();
    render(<ResumoDoBaralho />);

    await user.click(screen.getByRole("button", { name: "Opções do baralho" }));

    expect(useCartoesStore.getState().tela).toBe("opcoes");
  });

  it("'Todos os baralhos' não oferece opções, porque não é um baralho", () => {
    useCartoesStore.setState({ deckSelecionadoId: null });
    render(<ResumoDoBaralho />);

    expect(screen.queryByRole("button", { name: "Opções do baralho" })).not.toBeInTheDocument();
  });

  it("pela engrenagem na linha da árvore, que seleciona o baralho antes de abrir", async () => {
    useCartoesStore.setState({ deckSelecionadoId: null });
    const user = userEvent.setup();
    render(<DeckTreeRow deck={deck("ingles", "Inglês")} depth={0} hasChildren={false} />);

    await user.click(screen.getByRole("button", { name: "Opções de Inglês" }));

    expect(useCartoesStore.getState().deckSelecionadoId).toBe("ingles");
    expect(useCartoesStore.getState().tela).toBe("opcoes");
  });
});
