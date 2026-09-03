import { useEffect, useState } from "react";

/**
 * Atrasa o eco de `value` em `delayMs` — a paleta de busca (FUN-037) usa isto
 * para não disparar uma consulta a cada tecla digitada, sem impedir o usuário
 * de continuar digitando enquanto a busca anterior ainda está em voo.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
