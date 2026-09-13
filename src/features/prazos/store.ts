import { create } from "zustand";
import { AppError } from "../../lib/ipc";
import {
  atualizarPrazo as ipcAtualizarPrazo,
  criarPrazo as ipcCriarPrazo,
  listarPrazos,
  removerPrazo as ipcRemoverPrazo,
  type PrazoPatchInput,
  type PrazosListados,
} from "./ipc";

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface PrazosState {
  status: LoadStatus;
  errorMessage: string | null;
  listagem: PrazosListados | null;

  load: () => Promise<void>;
  criar: (title: string, dueLocalDate: string, deckId?: string | null) => Promise<void>;
  atualizar: (prazoId: string, patch: PrazoPatchInput) => Promise<void>;
  concluir: (prazoId: string) => Promise<void>;
  remover: (prazoId: string) => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

export const usePrazosStore = create<PrazosState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  listagem: null,

  load: async () => {
    // Mesma guarda de `features/cronograma/store.ts`: React 19 StrictMode
    // roda o efeito de montagem duas vezes em dev, e sem isto a segunda
    // chamada dispararia uma rodada de `listarPrazos` concorrente e inútil.
    if (get().status === "loading") return;
    set({ status: "loading", errorMessage: null });
    try {
      const listagem = await listarPrazos();
      set({ status: "ready", listagem });
    } catch (error) {
      set({ status: "error", errorMessage: messageFor(error, "Não foi possível carregar os prazos.") });
    }
  },

  criar: async (title, dueLocalDate, deckId) => {
    try {
      await ipcCriarPrazo(title, dueLocalDate, deckId ?? null);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível criar o prazo.") });
      throw error;
    }
    await get().load();
  },

  atualizar: async (prazoId, patch) => {
    try {
      await ipcAtualizarPrazo(prazoId, patch);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível salvar o prazo.") });
      throw error;
    }
    await get().load();
  },

  concluir: async (prazoId) => {
    try {
      await ipcAtualizarPrazo(prazoId, { status: "concluido" });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível concluir o prazo.") });
      throw error;
    }
    await get().load();
  },

  remover: async (prazoId) => {
    try {
      await ipcRemoverPrazo(prazoId);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível apagar o prazo.") });
      throw error;
    }
    await get().load();
  },
}));
