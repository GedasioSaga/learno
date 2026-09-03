import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { BackupSettings, RecoveryBanner } from "./features/backup";
import { ImportApkgSection } from "./features/import";
import { CheckDatabaseSection } from "./features/integrity";
import { SearchPalette } from "./features/search";
import { PageTree } from "./features/pages/PageTree";
import { PageWorkspace } from "./features/pages/PageWorkspace";
import { usePageTreeStore } from "./features/pages/store";
import { getAppConfig, TOGGLE_THEME_EVENT, type AppConfig } from "./lib/ipc";
import { useThemeStore } from "./lib/theme-store";

type LoadState =
  | { status: "loading" }
  | { status: "needs-setup" }
  // `AppConfig` existe no store, mas a senha nunca é persistida (ver o
  // comentário do tipo em `src/lib/ipc.ts`) — esta execução do processo
  // ainda não chamou `connectDatabase`, então nenhum comando de IPC que
  // precise do banco funciona ainda. `config` prefila host/porta/banco/
  // usuário na tela de reconexão; só a senha falta.
  | { status: "needs-reconnect"; config: AppConfig }
  | { status: "ready" }
  | { status: "load-failed"; message: string };

function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    // O tema em si já foi aplicado em main.tsx, antes do primeiro paint. Este
    // efeito só liga o item "Alternar tema" do menu nativo (src-tauri/src/lib.rs):
    // ele emite um evento em vez de mudar o DOM ele mesmo, porque o estado do
    // tema mora no lado React — o Rust só avisa que o clique aconteceu.
    const unlisten = listen(TOGGLE_THEME_EVENT, () => {
      useThemeStore.getState().toggle();
    }).catch(() => {
      // Sem runtime Tauri (ex.: testes em jsdom) — o botão da UI continua funcionando.
      return undefined;
    });

    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getAppConfig()
      .then((config) => {
        if (cancelled) return;
        // Ter `AppConfig` salvo não significa ter conexão: a senha nunca
        // toca o disco, então toda abertura do processo — não só a
        // primeira — precisa passar pela tela que a recolhe antes de
        // liberar o resto do app (ver PLT-002).
        setState(config ? { status: "needs-reconnect", config } : { status: "needs-setup" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Não foi possível ler a configuração salva.";
        setState({ status: "load-failed", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    // Tela em branco por uma fração de segundo seria pior que isto: o
    // usuário sabe que o app está fazendo algo, não que travou.
    return (
      <div className="flex h-screen items-center justify-center bg-paper text-sm text-ink-muted">
        Carregando…
      </div>
    );
  }

  if (state.status === "load-failed") {
    return (
      <div className="flex h-screen items-center justify-center bg-paper px-6 text-center">
        <div>
          <h1 className="font-display text-xl text-ink">Não deu para abrir a configuração</h1>
          <p role="alert" className="mt-2 text-sm text-terracotta-ink">
            {state.message}
          </p>
        </div>
      </div>
    );
  }

  if (state.status === "needs-setup") {
    return <FirstRunWizard mode="setup" onComplete={() => setState({ status: "ready" })} />;
  }

  if (state.status === "needs-reconnect") {
    return (
      <FirstRunWizard
        mode="reconnect"
        savedConfig={state.config}
        onComplete={() => setState({ status: "ready" })}
      />
    );
  }

  return <Workspace />;
}

/**
 * Só existe separado de `App` para poder chamar `usePageTreeStore` — um hook
 * de store não pode ser condicional, e os retornos antecipados acima
 * (carregando/erro/assistente) tornariam a chamada condicional se ficasse
 * dentro do próprio `App`.
 */
function Workspace() {
  const selectedPageId = usePageTreeStore((state) => state.selectedPageId);
  const selectPage = usePageTreeStore((state) => state.selectPage);
  const rename = usePageTreeStore((state) => state.rename);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // Mesmo padrão de `MoveToDialog`: `showModal`/`close` existem de verdade
    // no WebView2, mas o jsdom dos testes de componente não os implementa.
    const dialog = settingsDialogRef.current;
    if (!dialog) return;
    if (isSettingsOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
  }, [isSettingsOpen]);

  return (
    <>
      {/* PLT-005: the only place in the app that actually shows a recovered
          draft to the user — without this, `useAutosaveRecovery` is never
          called and the feature, though functional in `backup::autosave`,
          is unreachable from the UI. Restoring navigates to the page AND
          writes `entry.title` back via `rename`: in Phase 1 the title is
          the only editable surface that exists (see the placeholder in
          `PageWorkspace`), so it — not a block editor that doesn't exist
          yet — is what needs to come back on reopening after a crash.
          `rename` rejecting propagates from here into `RecoveryBanner`'s
          `onClick`, which is why it keeps the draft on disk instead of
          discarding it. */}
      <RecoveryBanner
        onRestore={(entry) => {
          selectPage(entry.page_id);
          return rename(entry.page_id, entry.title);
        }}
      />
      <AppShell sidebar={<PageTree />}>
        {selectedPageId ? (
          <PageWorkspace pageId={selectedPageId} />
        ) : (
          <EmptyState
            title="Bem-vindo ao Learno"
            description="Escolha ou crie uma página na barra lateral para começar a estudar."
          />
        )}
      </AppShell>
      {/* FUN-037: sobreposta a qualquer tela, ativada por Ctrl/Cmd+K — fica
          fora do `main` do AppShell de propósito, já que não é conteúdo da
          página atual. */}
      <SearchPalette onNavigate={selectPage} />

      <button
        type="button"
        aria-label="Configurações"
        onClick={() => setSettingsOpen(true)}
        className="fixed bottom-4 right-4 z-30 grid size-10 place-items-center rounded-full border border-border bg-surface text-lg shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0"
      >
        <span aria-hidden="true">⚙️</span>
      </button>

      {/* PLT-011/PLT-013: único ponto de entrada real de `BackupSettings` —
          sem isto, o comando de backup manual (correto e testado em
          `backup::dump`) fica só acionável a partir do próprio teste do
          componente, nunca pelo usuário do app rodando de verdade. */}
      <dialog
        ref={settingsDialogRef}
        aria-label="Configurações"
        className="w-[min(32rem,90vw)] rounded-sm border border-border bg-paper p-6 text-ink shadow-hard-sm backdrop:bg-ink/40"
        onClose={() => setSettingsOpen(false)}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg text-ink">Configurações</h2>
          <button
            type="button"
            aria-label="Fechar configurações"
            onClick={() => setSettingsOpen(false)}
            className="rounded-sm px-2 py-1 text-sm text-ink-muted"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">
          <BackupSettings />
        </div>

        {/* PLT-014: único ponto de entrada real de `CheckDatabaseSection` —
            sem isto, a verificação de integridade (correta e testada em
            `db::integrity::IntegrityRepository`) ficava acionável só a
            partir do próprio teste do repositório, nunca por uma ação do
            usuário rodando o app de verdade. */}
        <div className="mt-6 border-t border-border pt-6">
          <h2 className="font-display text-lg text-ink">Verificar banco de dados</h2>
          <div className="mt-4">
            <CheckDatabaseSection />
          </div>
        </div>

        {/* PLT-004: único ponto de entrada real do import de `.apkg` — sem
            isto, `import_apkg` (comprovadamente funcional contra o sidecar
            Python empacotado) não tinha seletor de arquivo nem botão que o
            alcançasse a partir da UI; um grep por "apkg" em `src/` não
            achava nada além deste comentário. */}
        <div className="mt-6 border-t border-border pt-6">
          <h2 className="font-display text-lg text-ink">Importar do Anki</h2>
          <div className="mt-4">
            <ImportApkgSection />
          </div>
        </div>
      </dialog>
    </>
  );
}

export default App;
