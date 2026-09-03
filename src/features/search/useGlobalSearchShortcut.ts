import { useEffect } from "react";

/**
 * FUN-037: Ctrl (Windows/Linux) ou Cmd (macOS) + K abre a paleta de busca,
 * não importa o que está focado no momento — é o mesmo atalho em qualquer
 * tela do app, por isso escuta em `window` em vez de um elemento específico.
 */
export function useGlobalSearchShortcut(onOpen: () => void): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      event.preventDefault();
      onOpen();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpen]);
}
