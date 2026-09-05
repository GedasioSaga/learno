/**
 * O corpo do seletor de opções — compartilhado por `renderEditor` de
 * `select` (escolha única) e de `multi_select` (escolha múltipla). `multiple`
 * só muda `aria-multiselectable` e cabe ao chamador decidir o que `onToggle`
 * faz com o id (substituir vs. adicionar/remover) — este componente não tem
 * opinião sobre isso.
 */
import type { ReactNode } from "react";
import type { OptionId } from "../../contract";
import type { SelectOption } from "./option-model";

interface OptionPickerListProps {
  options: readonly SelectOption[];
  selectedIds: ReadonlySet<OptionId>;
  onToggle: (id: OptionId) => void;
  /** "Escolher <nome da propriedade>" — o rótulo acessível do `listbox`. */
  ariaLabel: string;
  /** `select` = false (uma escolha substitui a anterior); `multi_select` = true. */
  multiple: boolean;
}

export function OptionPickerList({ options, selectedIds, onToggle, ariaLabel, multiple }: OptionPickerListProps): ReactNode {
  return (
    <ul role="listbox" aria-label={ariaLabel} aria-multiselectable={multiple} className="db-option-picker">
      {options.map((option) => {
        const selected = selectedIds.has(option.id);
        return (
          <li key={option.id} role="presentation">
            <button type="button" role="option" aria-selected={selected} className="db-option-picker__item" onClick={() => onToggle(option.id)}>
              <span className="db-option-tag" data-color={option.color}>
                {option.label}
              </span>
              {selected ? <span aria-hidden="true">✓</span> : null}
            </button>
          </li>
        );
      })}
      {options.length === 0 ? <li className="db-option-picker__empty">Nenhuma opção cadastrada ainda.</li> : null}
    </ul>
  );
}
