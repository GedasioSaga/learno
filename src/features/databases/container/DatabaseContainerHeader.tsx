/**
 * DBS-001: em modo inline, Filtrar/Ordenar/+Novo (e Expandir) só aparecem
 * com o cabeçalho ativo — mouse OU teclado, por isso o estado vive em React
 * (`onMouseEnter`/`onFocus`) em vez de deixado só para `:hover` em CSS: um
 * usuário de teclado navegando por Tab também precisa enxergar os controles
 * antes de conseguir ativá-los, e o critério pede um evento observável em
 * teste, não um estado que só existe dentro do motor de CSS do browser real.
 *
 * DBS-002: em modo página inteira a barra fica sempre visível, como
 * qualquer cabeçalho de página comum — não teria sentido escondê-la atrás
 * de hover na própria página aberta. "+ Propriedade"/"+ View" desabilitam
 * quando `database.isLocked`; nenhum outro botão deste cabeçalho depende
 * disso, e o corpo da database (`DatabaseContainerBody`) nunca vê este
 * valor — é o que impede o bloqueio de estrutura de vazar para a edição de
 * valor por acidente.
 */
import { useState, type FocusEvent } from "react";
import type { Database } from "../contract";
import type { DatabaseContainerActions, DatabaseContainerMode } from "./types";

interface DatabaseContainerHeaderProps {
  database: Database;
  mode: DatabaseContainerMode;
  actions: DatabaseContainerActions;
  /** DBS-001: ausente em modo página inteira — "expandir" o que já é a página inteira não faz sentido. */
  onExpand?(): void;
}

const LOCKED_TITLE = "Database bloqueada contra alteração de estrutura";

export function DatabaseContainerHeader({ database, mode, actions, onExpand }: DatabaseContainerHeaderProps) {
  const [isActive, setIsActive] = useState(mode === "fullPage");

  function activate() {
    if (mode === "inline") setIsActive(true);
  }

  function deactivate() {
    if (mode === "inline") setIsActive(false);
  }

  // `relatedTarget` é o elemento que RECEBE o foco — sair de um botão do
  // cabeçalho para o botão vizinho não deve fechar a barra, só sair do
  // cabeçalho inteiro deve.
  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (mode !== "inline") return;
    // `relatedTarget` é tipado como `EventTarget | null` (a interface DOM
    // genérica); `Node.contains()` pede `Node | null`. Em foco de verdade
    // (mouse ou teclado) o elemento que recebe o foco É sempre um `Node` —
    // não há como um `EventTarget` não-Node ganhar foco no DOM.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsActive(false);
  }

  const showToolbar = mode === "fullPage" || isActive;
  const displayName = database.name || "Database sem título";

  return (
    <div
      className="flex items-center justify-between gap-2 px-2 py-1.5"
      onMouseEnter={activate}
      onMouseLeave={deactivate}
      onFocus={activate}
      onBlur={handleBlur}
    >
      <span className={mode === "fullPage" ? "font-display text-lg text-ink" : "truncate text-sm font-medium text-ink"}>
        {displayName}
      </span>

      {showToolbar ? (
        <div role="toolbar" aria-label={`Ações de ${displayName}`} className="flex items-center gap-1">
          {actions.onFilter ? (
            <button
              type="button"
              onClick={actions.onFilter}
              className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              Filtrar
            </button>
          ) : null}
          {actions.onSort ? (
            <button
              type="button"
              onClick={actions.onSort}
              className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              Ordenar
            </button>
          ) : null}
          {actions.onCreateRecord ? (
            <button
              type="button"
              onClick={actions.onCreateRecord}
              className="rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none"
            >
              + Novo
            </button>
          ) : null}
          {/* Texto visível já é nome acessível suficiente (botões acima) —
              regra do projeto é ARIA só quando não há elemento/rótulo nativo
              (§ "HTML semântico antes de ARIA"). Sem aria-label aqui: um
              rótulo diferente do texto visível quebraria "nome contém o
              rótulo visível" pra quem navega por comando de voz. */}
          <button
            type="button"
            onClick={actions.onAddProperty}
            disabled={database.isLocked || !actions.onAddProperty}
            title={database.isLocked ? LOCKED_TITLE : undefined}
            className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            + Propriedade
          </button>
          <button
            type="button"
            onClick={actions.onAddView}
            disabled={database.isLocked || !actions.onAddView}
            title={database.isLocked ? LOCKED_TITLE : undefined}
            className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            + View
          </button>
          {mode === "inline" && onExpand ? (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Abrir como página inteira"
              className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              ⤢
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
