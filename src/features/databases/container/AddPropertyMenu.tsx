/**
 * DBS-002 "+ Propriedade": o menu de TIPO de uma coluna nova, montado a
 * partir do registro de `core/property-spec.ts` — só tipos que este build
 * sabe desenhar entram, na ordem de registro. A propriedade nasce com o
 * rótulo do tipo como nome ("Texto", "Data"), como no Notion; renomear
 * ainda não tem tela (dívida declarada em `comandos-alcancaveis.test.ts`).
 *
 * Continua PURO: quem cria de verdade é `onPick`, passado por quem monta a
 * tela (`useDatabase().addProperty`).
 */
import { useId } from "react";
import type { PropertyType } from "../../../lib/ipc";
import { collectPropertySpecs } from "../core/property-spec";
import { useTogglePanel } from "../view-config/use-toggle-panel";

interface AddPropertyMenuProps {
  disabled: boolean;
  /** Título explicativo quando desabilitado (DBS-002: database bloqueada). */
  disabledTitle?: string;
  onPick(type: PropertyType, name: string): void;
}

/** Os 15 tipos que o Rust aceita (`VALID_PROPERTY_TYPES`) — o registro pode conhecer um tipo que o backend recusa, ou vice-versa; só a interseção vira botão. */
const BACKEND_TYPES: ReadonlySet<string> = new Set<PropertyType>([
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "files",
  "person",
  "formula",
  "relation",
  "rollup",
  "created_time",
  "last_edited_time",
]);

export function AddPropertyMenu({ disabled, disabledTitle, onPick }: AddPropertyMenuProps) {
  const { open, toggle, close, containerRef } = useTogglePanel();
  const panelId = useId();
  const choices = collectPropertySpecs().filter((spec) => BACKEND_TYPES.has(spec.type));

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        + Propriedade
      </button>
      {open ? (
        <ul
          id={panelId}
          role="menu"
          aria-label="Tipo da nova propriedade"
          className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-md border border-border bg-surface p-1 shadow-hard"
        >
          {choices.map((spec) => (
            <li key={spec.type} role="presentation">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onPick(spec.type as PropertyType, spec.label);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-ink hover:bg-surface-raised"
              >
                <span aria-hidden="true" className="w-5 text-center">
                  {spec.icon}
                </span>
                {spec.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
