import { useEffect, useState } from "react";

/**
 * Alterna classes em dois passos para uma entrada realmente animar, em vez
 * de já montar no estado final: monta com `entered=false` (escala/opacidade
 * de partida) e, no quadro seguinte, vira `true` (Emil Kowalski: easing de
 * entrada é sempre ease-out, e a escala de partida é 0.9–0.95, nunca 0).
 * Fechar não anima — cai direto pra `false` junto com `open`, porque um
 * popover/diálogo some do layout no mesmo instante em que some da tela.
 */
export function useOpenTransition(open: boolean): boolean {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return entered;
}
