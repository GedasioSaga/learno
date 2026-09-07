/**
 * O canal de erro do item "/database". Existe porque `SlashMenuItem.run`
 * é síncrono e a criação é assíncrona: quando `createDatabase`/`createView`
 * falha, o `run` já devolveu `true` e não há mais ninguém para avisar. Um
 * `.catch(() => undefined)` aqui seria o defeito clássico — a ação
 * "não faz nada" aos olhos do usuário, que tenta de novo. Escopado a este
 * construtor, mesmo padrão de `../page-link/picker-store.ts`.
 */
import { create } from "zustand";

interface DatabaseInsertErrorState {
  message: string | null;
  report(message: string): void;
  dismiss(): void;
}

export const useDatabaseInsertErrorStore = create<DatabaseInsertErrorState>((set) => ({
  message: null,
  report: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}));
