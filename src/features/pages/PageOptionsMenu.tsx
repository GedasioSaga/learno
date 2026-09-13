import { useId, useRef, useState } from "react";
import { usePosicaoAncorada } from "./use-posicao-ancorada";
import type { PageRow } from "../../lib/ipc";
import { ExportMarkdownButton } from "../backup";
import { hidePopoverSafely } from "./dom-compat";
import { FONTE_LABELS, FONTES_DA_PAGINA, usePagePreferencesStore, usePreferenciasDaPagina } from "./page-preferences-store";
import { usePageTreeStore } from "./store";
import { useOpenTransition } from "./use-open-transition";

interface PageOptionsMenuProps {
  page: PageRow;
  onRequestHistory: () => void;
  onRequestMoveTo: () => void;
}

/**
 * O "•••" do cabeçalho da página aberta — no modelo do Notion que o usuário
 * mostrou: fonte (FUN-017), texto pequeno (FUN-018), largura total (FUN-016)
 * e as ações que já existiam em `PageContextMenu` (duplicar, mover, lixeira),
 * mais histórico e exportar, que antes eram botões soltos no cabeçalho.
 *
 * Não é `role="menu"` como `PageContextMenu`: aqui dentro mora um radiogroup
 * de verdade e dois toggles, e ARIA de menu exigiria cada filho ser
 * `menuitem*` — forçar isso em um `<fieldset>` com `<input type="radio">`
 * seria pior a11y, não melhor. Cada controle fica o que já é nativamente
 * (fieldset+radio, button+aria-pressed, button comum), o mesmo raciocínio que
 * `EmojiIconPicker` já aplica ao próprio painel (também sem `role="menu"`).
 */
export function PageOptionsMenu({ page, onRequestHistory, onRequestMoveTo }: PageOptionsMenuProps) {
  const panelId = useId();
  const fonteGroupName = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const gatilhoRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const entered = useOpenTransition(open);
  usePosicaoAncorada(gatilhoRef, panelRef, open, { alinhamento: "fim" });

  const preferencias = usePreferenciasDaPagina(page.id);
  const definirFonte = usePagePreferencesStore((state) => state.definirFonte);
  const alternarTextoPequeno = usePagePreferencesStore((state) => state.alternarTextoPequeno);
  const alternarLarguraTotal = usePagePreferencesStore((state) => state.alternarLarguraTotal);
  const duplicate = usePageTreeStore((state) => state.duplicate);
  const trash = usePageTreeStore((state) => state.trash);

  function close() {
    hidePopoverSafely(panelRef.current);
  }

  return (
    <span className="relative inline-flex">
      <button
        ref={gatilhoRef}
        type="button"
        popoverTarget={panelId}
        popoverTargetAction="toggle"
        aria-label="Mais opções da página"
        className="grid size-8 place-items-center rounded-sm text-ink-muted transition-transform duration-150 ease-out hover:bg-surface-raised hover:text-ink active:scale-97"
      >
        ⋯
      </button>

      {/* Sem classe de posição: quem posiciona é `usePosicaoAncorada`, por
          medida, em `position: fixed`. Dentro da top layer do popover, o
          `absolute top-full` que estava aqui jogava o painel uma altura de
          janela inteira para baixo — fora da tela. */}
      <div
        id={panelId}
        ref={panelRef}
        popover="auto"
        onToggle={(event) => setOpen(event.newState === "open")}
        className={`z-10 w-64 origin-top-right rounded-md border border-border
          bg-surface p-1 shadow-hard transition duration-150 ease-out motion-reduce:transition-none
          ${entered ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
      >
        <fieldset className="m-0 border-0 p-2 pt-1.5">
          <legend className="px-0 text-xs font-medium text-ink-muted">Fonte</legend>
          <div className="mt-1.5 flex gap-1">
            {FONTES_DA_PAGINA.map((fonte) => {
              const selecionada = preferencias.fonte === fonte;
              return (
                <label
                  key={fonte}
                  className={`flex-1 cursor-pointer rounded-sm border px-2 py-1 text-center text-xs transition-colors duration-150 ease-out
                    ${selecionada ? "border-emerald bg-surface-raised text-ink" : "border-border text-ink-muted hover:bg-surface-sunken"}`}
                >
                  <input
                    type="radio"
                    name={`fonte-${fonteGroupName}`}
                    value={fonte}
                    checked={selecionada}
                    onChange={() => definirFonte(page.id, fonte)}
                    className="sr-only"
                  />
                  {FONTE_LABELS[fonte]}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="my-1 border-t border-hairline" />

        <ToggleItem
          label="Texto pequeno"
          pressed={preferencias.textoPequeno}
          onToggle={() => alternarTextoPequeno(page.id)}
        />
        <ToggleItem
          label="Largura total"
          pressed={preferencias.larguraTotal}
          onToggle={() => alternarLarguraTotal(page.id)}
        />

        <div className="my-1 border-t border-hairline" />

        <MenuButton
          onClick={() => {
            void duplicate(page.id);
            close();
          }}
        >
          Duplicar
        </MenuButton>
        <MenuButton
          onClick={() => {
            onRequestMoveTo();
            close();
          }}
        >
          Mover para...
        </MenuButton>
        <MenuButton
          onClick={() => {
            onRequestHistory();
            close();
          }}
        >
          Histórico
        </MenuButton>
        {/* `ExportMarkdownButton` cuida do próprio ciclo assíncrono (diálogo
            nativo de salvar, status "Exportando…"/"Página exportada.") — não
            fecha o menu sozinho de propósito, para o usuário ver o status
            aparecer antes do painel sumir. */}
        <div className="px-1 py-0.5">
          <ExportMarkdownButton pageId={page.id} pageTitle={page.title} />
        </div>
        <MenuButton
          destructive
          onClick={() => {
            void trash(page.id);
            close();
          }}
        >
          Mover para lixeira
        </MenuButton>
      </div>
    </span>
  );
}

function ToggleItem({ label, pressed, onToggle }: { label: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-sunken"
    >
      {label}
      <span aria-hidden="true" className={`text-xs ${pressed ? "text-emerald" : "text-ink-muted"}`}>
        {pressed ? "Sim" : "Não"}
      </span>
    </button>
  );
}

function MenuButton({
  children,
  onClick,
  destructive,
}: {
  children: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-sunken
        ${destructive ? "text-terracotta-ink" : "text-ink"}`}
    >
      {children}
    </button>
  );
}
