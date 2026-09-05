/**
 * As duas metades de renderização de `urlPropertySpec` (`url-spec.ts`).
 * `UrlCellValue` é o coração de DBS-018: clicar precisa abrir, NUNCA entrar
 * em edição — o oposto do que célula de texto/número faz ao ser clicada.
 * `<button>` nativo em vez de `<a>` crua pelo mesmo motivo documentado em
 * `editor/blocks/bookmark/open-url.ts` (âncora nativa não abre certo dentro
 * do WebView do Tauri) — e um `<button>` já é focável e acionável por
 * teclado sem ARIA extra (Enter/Espaço disparam `click` sozinhos).
 */
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import { hostnameOf, parseSafeUrl } from "../../../editor/blocks/bookmark/bookmark-card";
import { openBookmarkUrl } from "../../../editor/blocks/bookmark/open-url";
import type { UrlConfig, UrlValue } from "./url-spec";

export function UrlCellValue({ value }: CellRenderContext<UrlValue, UrlConfig>): ReactNode {
  if (value === null) return null;
  const safe = parseSafeUrl(value) !== null;
  const label = hostnameOf(value);

  const handleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    // DBS-018: um clique numa URL válida SEMPRE abre, nunca entra em edição —
    // intercepta o evento antes que a grade (dona da caixa/foco, arquitetura
    // §6) o trate como "começar a editar esta célula".
    event.preventDefault();
    event.stopPropagation();
    if (!safe) return; // esquema recusado (só http:/https: — ver parseSafeUrl); inerte por segurança
    void openBookmarkUrl(value);
  };

  return (
    <button type="button" className="db-cell-url" aria-label={`Abrir ${label} no navegador`} title={value} disabled={!safe} onClick={handleOpen}>
      {value}
    </button>
  );
}

/** Único jeito de MUDAR a URL — clicar no valor (acima) só abre. */
export function UrlCellEditor({ value, commit, close }: CellEditContext<UrlValue, UrlConfig>): ReactNode {
  const [draft, setDraft] = useState(value ?? "");

  const commitAndClose = () => {
    const trimmed = draft.trim();
    commit(trimmed.length > 0 ? trimmed : null);
    close();
  };

  return (
    <input
      type="url"
      className="db-cell-url-input"
      aria-label="Editar URL"
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitAndClose}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitAndClose();
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    />
  );
}
