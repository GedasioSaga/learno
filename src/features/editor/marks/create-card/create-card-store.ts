/**
 * Ponte entre os botões da barra de seleção (`CreateCardButton` e
 * `CreateClozeButton`, que leem seleção/bloco/página do `TiptapEditor` real,
 * fora do React) e o overlay que renderiza o formulário certo
 * (`CreateCardOverlay`) — mesmo papel que `synced/delete-confirm-store.ts`
 * cumpre entre uma ação e o diálogo que a atende.
 *
 * Dois formulários, uma store: `origem` abre `CriarCartaoDeOrigem` (cartão
 * comum, frente/verso); `lacuna` abre `CriarLacunaDeOrigem` (cartão de
 * lacuna). Abrir um zera o outro — nunca os dois ao mesmo tempo.
 */
import { create } from "zustand";
import type { OrigemDoCartao } from "../../../cartoes/CriarCartaoDeOrigem";
import type { OrigemDeLacuna } from "../../../cartoes/CriarLacunaDeOrigem";

interface CreateCardOverlayState {
  open: boolean;
  origem: OrigemDoCartao | null;
  lacuna: OrigemDeLacuna | null;
  abrir: (origem: OrigemDoCartao) => void;
  abrirLacuna: (lacuna: OrigemDeLacuna) => void;
  fechar: () => void;
}

export const useCreateCardOverlayStore = create<CreateCardOverlayState>((set) => ({
  open: false,
  origem: null,
  lacuna: null,
  abrir: (origem) => set({ open: true, origem, lacuna: null }),
  abrirLacuna: (lacuna) => set({ open: true, lacuna, origem: null }),
  fechar: () => set({ open: false, origem: null, lacuna: null }),
}));
