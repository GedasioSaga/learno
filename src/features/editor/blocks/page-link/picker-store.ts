/**
 * Estado de UI do seletor de página do item "Link para página" (EDT-017) -
 * só "está aberto?" e "o que foi digitado", nunca a lista de páginas em si
 * (essa continua só em `usePageTreeStore`, a mesma fonte que a sidebar lê,
 * para nunca ter duas cópias da árvore de páginas divergindo). Escopado a
 * este construtor: nada fora de `blocks/page-link/` lê ou escreve aqui.
 */
import { create } from "zustand";

interface PageLinkPickerState {
  isOpen: boolean;
  query: string;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
}

export const usePageLinkPickerStore = create<PageLinkPickerState>((set) => ({
  isOpen: false,
  query: "",
  open: () => set({ isOpen: true, query: "" }),
  close: () => set({ isOpen: false, query: "" }),
  setQuery: (query) => set({ query }),
}));
