import { useCallback, useEffect, useState } from "react";
import { listPageVersions, restorePageVersion, type PageVersion } from "../../lib/ipc";

type Status = "loading" | "ready" | "error";

interface VersionHistoryState {
  status: Status;
  versions: PageVersion[];
  errorMessage: string | null;
  restoringId: string | null;
}

const INITIAL_STATE: VersionHistoryState = {
  status: "loading",
  versions: [],
  errorMessage: null,
  restoringId: null,
};

/**
 * FUN-035/FUN-036: carrega o histórico de uma página e expõe `restore`. O
 * backend sempre acrescenta um novo snapshot de restauração em vez de apagar
 * os existentes, então recarregar a lista depois de restaurar é a fonte da
 * verdade — nunca um cálculo otimista feito aqui no cliente.
 */
export function useVersionHistory(pageId: string) {
  const [state, setState] = useState<VersionHistoryState>(INITIAL_STATE);

  const load = useCallback(() => {
    setState((previous) => ({ ...previous, status: "loading", errorMessage: null }));
    return listPageVersions(pageId)
      .then((versions) => {
        setState({ status: "ready", versions, errorMessage: null, restoringId: null });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Não foi possível carregar o histórico.";
        setState({ status: "error", versions: [], errorMessage: message, restoringId: null });
      });
  }, [pageId]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (versionId: string) => {
      setState((previous) => ({ ...previous, restoringId: versionId, errorMessage: null }));
      try {
        await restorePageVersion(pageId, versionId);
        await load();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Não foi possível restaurar esta versão.";
        setState((previous) => ({ ...previous, restoringId: null, errorMessage: message }));
      }
    },
    [pageId, load],
  );

  return { ...state, restore };
}
