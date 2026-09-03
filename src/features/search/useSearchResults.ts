import { useEffect, useRef, useState } from "react";
import { searchPages, type SearchResult } from "../../lib/ipc";
import { useDebouncedValue } from "./useDebouncedValue";

// 200ms: curto o bastante para parecer "ao vivo", longo o bastante para não
// disparar uma consulta por tecla enquanto o usuário ainda está digitando.
const DEBOUNCE_MS = 200;

export type SearchStatus = "idle" | "loading" | "ready" | "error";

interface SearchState {
  status: SearchStatus;
  results: SearchResult[];
  errorMessage: string | null;
}

const INITIAL_STATE: SearchState = { status: "idle", results: [], errorMessage: null };

/**
 * FUN-037: busca ao vivo sem travar a interface. `invoke()` já roda fora da
 * thread de UI; o que falta é (1) debounce, pra não inundar o backend a cada
 * tecla, e (2) descartar uma resposta atrasada de uma busca já abandonada —
 * sem isso, digitar rápido poderia deixar a tela mostrando o resultado de um
 * termo que o usuário já apagou.
 */
export function useSearchResults(query: string): SearchState {
  const debouncedQuery = useDebouncedValue(query.trim(), DEBOUNCE_MS);
  const [state, setState] = useState<SearchState>(INITIAL_STATE);
  const latestRequestId = useRef(0);

  useEffect(() => {
    if (debouncedQuery === "") {
      latestRequestId.current += 1;
      setState(INITIAL_STATE);
      return;
    }

    const requestId = ++latestRequestId.current;
    setState((previous) => ({ ...previous, status: "loading", errorMessage: null }));

    searchPages(debouncedQuery)
      .then((results) => {
        if (latestRequestId.current !== requestId) return;
        setState({ status: "ready", results, errorMessage: null });
      })
      .catch((error: unknown) => {
        if (latestRequestId.current !== requestId) return;
        const message = error instanceof Error ? error.message : "Não foi possível buscar.";
        setState({ status: "error", results: [], errorMessage: message });
      });
  }, [debouncedQuery]);

  return state;
}
