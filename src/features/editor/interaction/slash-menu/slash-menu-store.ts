/**
 * Ponte entre o plugin do ProseMirror (`slash-menu-extension.ts`, que não é
 * React) e o `EditorOverlay` que desenha o popup (`SlashMenuOverlay.tsx`,
 * que é). O plugin escreve aqui em `onStart`/`onUpdate`/`onKeyDown`; o
 * overlay só lê, pelo hook. Um `useState` local no componente não serviria:
 * quem decide a navegação por seta é o `onKeyDown` do `Suggestion`, que roda
 * fora de qualquer render React.
 */
import { create } from "zustand";

/**
 * Cópia dos campos de posição de um `DOMRect`, não a referência - o objeto
 * que o TipTap devolve em `clientRect()` é recalculado a cada chamada e não
 * teria por que sobreviver até o próximo render do overlay.
 */
export interface SlashMenuRect {
  left: number;
  top: number;
  bottom: number;
}

function toRect(rect: DOMRect | null): SlashMenuRect | null {
  if (!rect) return null;
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

interface SlashMenuState {
  active: boolean;
  query: string;
  rect: SlashMenuRect | null;
  /** `null` = "primeiro item visível" - resolvido por quem lê o estado, não aqui. */
  highlightedId: string | null;
  open(query: string, rect: DOMRect | null): void;
  update(query: string, rect: DOMRect | null): void;
  close(): void;
  setHighlightedId(id: string | null): void;
}

export const useSlashMenuStore = create<SlashMenuState>((set) => ({
  active: false,
  query: "",
  rect: null,
  highlightedId: null,
  open: (query, rect) => set({ active: true, query, rect: toRect(rect), highlightedId: null }),
  // Reseta o destaque a cada tecla: a lista filtrada muda, e o item que
  // estava realçado pode nem aparecer mais nela.
  update: (query, rect) => set({ query, rect: toRect(rect), highlightedId: null }),
  close: () => set({ active: false, query: "", rect: null, highlightedId: null }),
  setHighlightedId: (id) => set({ highlightedId: id }),
}));
