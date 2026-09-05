/**
 * Abrir/fechar um painel da barra de ferramentas, com fecho automático ao
 * clicar fora — mesmo padrão de `ColorMenuButton`
 * (`src/features/editor/marks/color/ColorMenuButton.tsx`). Extraído aqui
 * porque a barra de ferramentas de view tem QUATRO painéis (filtro/ordenar/
 * agrupar/propriedades) repetindo a mesma regra — abstração com ≥3 usos
 * reais (regra 10).
 */
import { useEffect, useRef, useState, type RefObject } from "react";

export interface TogglePanel {
  open: boolean;
  toggle(): void;
  close(): void;
  /** Anexar ao contêiner (botão + painel) — cliques dentro dele nunca fecham o painel. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useTogglePanel(): TogglePanel {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      // `Event.target` é `EventTarget | null` por ser compartilhado com
      // eventos não-DOM; um `pointerdown` real do navegador sempre mira um
      // `Node` — estreitando um tipo que a lib do DOM deixa solto demais,
      // não contornando um `unknown` genuíno.
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return {
    open,
    toggle: () => setOpen((value) => !value),
    close: () => setOpen(false),
    containerRef,
  };
}
