/**
 * As duas metades de renderização de `numberPropertySpec` (`number-spec.ts`).
 * `renderValue` é o conteúdo inline (a view é dona da caixa — `PropertySpec`,
 * arquitetura §6); `renderEditor` só aparece porque a propriedade tem essa
 * função — ausência dela é o sinal de "somente-leitura" para o resto do
 * pipeline.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import { formatNumberValue, type NumberConfig, type NumberValue } from "./number-spec";

export function NumberCellValue({ value, property }: CellRenderContext<NumberValue, NumberConfig>): ReactNode {
  if (value === null) return null;
  return <span className="db-cell-number">{formatNumberValue(value, property.config.format)}</span>;
}

/**
 * Input nativo `type="number"`: teclado numérico correto e as setas de
 * incremento do SO de graça, sem reinventar validação de dígito.
 * `commitAndClose` interpreta string vazia como "apagar" (I1) em vez de `0`.
 */
export function NumberCellEditor({ value, property, commit, close }: CellEditContext<NumberValue, NumberConfig>): ReactNode {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  const commitAndClose = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      commit(null);
      close();
      return;
    }
    const parsed = Number(trimmed);
    commit(Number.isFinite(parsed) ? parsed : null);
    close();
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      className="db-cell-number-input"
      aria-label={`Editar ${property.name}`}
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
