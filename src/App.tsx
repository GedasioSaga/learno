import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./components/AppShell";
import { BotaoDeIcone } from "./components/BotaoDeIcone";
import { RecoveryBanner } from "./features/backup";
import { AtualizadorBanner } from "./components/AtualizadorBanner";
import { ConteudoDeBiblioteca, PainelDeBiblioteca } from "./features/biblioteca";
import { ConteudoDeCronograma } from "./features/cronograma";
import { ConteudoDeFinancas } from "./features/financas";
import { ConteudoDeHoje } from "./features/hoje";
import { IconeConfiguracoes } from "./features/navegacao/icones";
import { ConteudoDeCartoes, PainelDeCartoes } from "./features/cartoes";
import { montarSecoes } from "./features/navegacao/catalogo";
import { ConteudoDeNotas, PainelDeNotas } from "./features/navegacao/secao-notas";
import { ConteudoDeMapaMental, PainelDeMapaMental } from "./features/mapa-mental";
import { useNavegacaoStore, type OrigemDaTroca } from "./features/navegacao/store";
import { SettingsScreen } from "./features/settings";
import { SearchPalette } from "./features/search";
import { ConteudoDeTrilha, PainelDeTrilha } from "./features/trilha";
import { usePageTreeStore } from "./features/pages/store";
import { openWorkspace, TOGGLE_THEME_EVENT } from "./lib/ipc";
import { useThemeStore } from "./lib/theme-store";

// Depois da migração para SQLite não existe mais estado intermediário entre
// "abrindo" e "pronto": o banco é um arquivo dentro da pasta de trabalho, e a
// pasta tem um padrão bom (a pasta de dados do app no sistema operacional).
// Sumiram com o Postgres o `needs-setup` (o assistente que coletava
// host/porta/usuário/banco) e o `needs-reconnect` (que existia só porque a
// senha nunca era persistida e precisava ser redigitada a cada abertura).
type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "load-failed"; message: string };

/**
 * As oito seções do app, ligadas às telas que existem.
 *
 * Para ligar uma seção nova: acrescente a entrada dela aqui —
 * `cartoes: { Painel: PainelDeCartoes, Conteudo: ConteudoDeCartoes }` — e
 * nada mais. Seção sem entrada continua no rail com o estado "em construção"
 * do catálogo (`features/navegacao/catalogo.tsx`).
 */
const SECOES = montarSecoes({
  hoje: { Conteudo: ConteudoDeHoje },
  notas: { Painel: PainelDeNotas, Conteudo: ConteudoDeNotas },
  cartoes: { Painel: PainelDeCartoes, Conteudo: ConteudoDeCartoes },
  "mapa-mental": { Painel: PainelDeMapaMental, Conteudo: ConteudoDeMapaMental },
  trilha: { Painel: PainelDeTrilha, Conteudo: ConteudoDeTrilha },
  cronograma: { Conteudo: ConteudoDeCronograma },
  financas: { Conteudo: ConteudoDeFinancas },
  biblioteca: { Painel: PainelDeBiblioteca, Conteudo: ConteudoDeBiblioteca },
});

function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    // O tema em si já foi aplicado em main.tsx, antes do primeiro paint. Este
    // efeito só liga o item "Alternar tema" do menu nativo (src-tauri/src/lib.rs):
    // ele emite um evento em vez de mudar o DOM ele mesmo, porque o estado do
    // tema mora no lado React — o Rust só avisa que o clique aconteceu.
    const unlisten = listen(TOGGLE_THEME_EVENT, () => {
      useThemeStore.getState().alternar();
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

    // PLT-002: abre o banco (criando o arquivo na primeira execução) e aplica
    // as migrações pendentes antes de liberar qualquer comando que precise
    // dele. Sem entrada nenhuma do usuário — é o que faz o app abrir e
    // funcionar numa máquina onde nunca rodou.
    openWorkspace()
      .then(() => {
        if (cancelled) return;
        setState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Não foi possível abrir o banco de dados.";
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
          <h1 className="font-display text-xl text-ink">Não deu para abrir o banco de dados</h1>
          <p role="alert" className="mt-2 text-sm text-terracotta-ink">
            {state.message}
          </p>
        </div>
      </div>
    );
  }

  return <Workspace />;
}

/**
 * Só existe separado de `App` para poder chamar as stores — um hook de store
 * não pode ser condicional, e os retornos antecipados acima (carregando/erro)
 * tornariam a chamada condicional se ficasse dentro do próprio `App`.
 */
function Workspace() {
  const selectPage = usePageTreeStore((state) => state.selectPage);
  const rename = usePageTreeStore((state) => state.rename);
  const irPara = useNavegacaoStore((estado) => estado.irPara);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);

  /**
   * Abrir uma página vinda de fora de Notas (busca global, faixa de
   * recuperação) precisa levar o app até a seção Notas primeiro — senão a
   * página fica selecionada na store e invisível atrás de outra aba.
   */
  function abrirPagina(pageId: string, origem: OrigemDaTroca) {
    irPara("notas", origem);
    selectPage(pageId);
  }

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
          abrirPagina(entry.page_id, "ponteiro");
          return rename(entry.page_id, entry.title);
        }}
      />
      <AppShell
        secoes={SECOES}
        acoes={
          <BotaoDeIcone rotulo="Configurações" onClick={() => setSettingsOpen(true)}>
            <IconeConfiguracoes />
          </BotaoDeIcone>
        }
      />
      {/* FUN-037: sobreposta a qualquer tela, ativada por Ctrl/Cmd+K — fica
          fora do `main` do AppShell de propósito, já que não é conteúdo da
          seção atual. Navegar por ela é gesto de teclado, então a troca de
          seção não anima. */}
      <SearchPalette onNavigate={(pageId) => abrirPagina(pageId, "teclado")} />
      <AtualizadorBanner />

      {/* Único ponto de entrada das Configurações. Cada seção lá dentro é o
          único caminho de UI para um comando que existe e funciona no backend
          — backup manual (PLT-011/013), pasta de trabalho (PLT-016),
          verificação de integridade (PLT-014) e import de `.apkg` (PLT-004).
          Este projeto já perdeu quatro features por elas existirem sem clique
          que as alcançasse; ver `docs/ACHADOS-FASE-3.md`. */}
      <dialog
        ref={settingsDialogRef}
        aria-label="Configurações"
        className="m-auto h-[min(40rem,85vh)] w-[min(52rem,92vw)] flex-col overflow-hidden rounded-md border border-border bg-paper p-0 text-ink shadow-hard open:flex backdrop:bg-ink/50"
        onClose={() => setSettingsOpen(false)}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2 className="font-display text-lg text-ink">Configurações</h2>
          <button
            type="button"
            aria-label="Fechar configurações"
            onClick={() => setSettingsOpen(false)}
            className="rounded-md px-2 py-1 text-sm text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-sunken hover:text-ink"
          >
            ✕
          </button>
        </div>
        <SettingsScreen />
      </dialog>
    </>
  );
}

export default App;
