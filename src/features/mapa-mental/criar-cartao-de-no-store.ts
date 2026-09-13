import { create } from "zustand";

interface CriarCartaoDeNoState {
  aberto: boolean;
  /** Rótulo do nó no instante do clique — vira o texto congelado do cartão. */
  rotulo: string;
  abrir: (rotulo: string) => void;
  fechar: () => void;
}

/**
 * Ponte entre o botão "Criar cartão" de `CartaoNode` — dentro do canvas do
 * `@xyflow/react`, um nó por instância, sem um lugar óbvio para guardar
 * "qual cartão abrir" — e o formulário que `ConteudoDeMapaMental` monta uma
 * vez só. Mesmo papel que `src/features/editor/synced/delete-confirm-store.ts`
 * cumpre entre uma ação fora do React e o overlay que a atende.
 *
 * Só o RÓTULO viaja, nunca o id do nó: um nó de mapa mental não é um bloco
 * (`mindmap_nodes` não tem `source_block_id` nem qualquer FK para
 * `blocks(id)`), então o cartão nascido daqui nunca tem link de volta — ver
 * o comentário de `blocoOrigemId` em `CriarCartaoDeOrigem`
 * (`src/features/cartoes/CriarCartaoDeOrigem.tsx`).
 */
export const useCriarCartaoDeNoStore = create<CriarCartaoDeNoState>((set) => ({
  aberto: false,
  rotulo: "",
  abrir: (rotulo) => set({ aberto: true, rotulo }),
  fechar: () => set({ aberto: false, rotulo: "" }),
}));
