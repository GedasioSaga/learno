/**
 * `renderValue`/`renderEditor` de `multi_select` (DBS-008). Reusa
 * `OptionTag`/`OptionPickerList` de `../select/` — a mesma peça (P3) é dona
 * das duas pastas, e o modelo de opção é idêntico (`../select/option-model`).
 */
import type { ReactNode } from "react";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import { OptionPickerList } from "../select/OptionPickerList";
import { OptionTag } from "../select/OptionTag";
import { findOption, type MultiSelectPropertyConfig } from "../select/option-model";

type MultiSelectValue = string[];

export function renderMultiSelectValue({ value, property }: CellRenderContext<MultiSelectValue, MultiSelectPropertyConfig>): ReactNode {
  if (!value || value.length === 0) return null;
  return (
    <span className="db-option-tag-row">
      {value.map((id) => (
        <OptionTag key={id} option={findOption(property.config, id) ?? null} />
      ))}
    </span>
  );
}

export function renderMultiSelectEditor(ctx: CellEditContext<MultiSelectValue, MultiSelectPropertyConfig>): ReactNode {
  const { value, property, commit } = ctx;
  const current = value ?? [];

  function remove(id: string) {
    // DBS-008, critério literal: cada tag é removível ISOLADAMENTE — remove
    // só este id, preserva os demais (inclusive um órfão não tocado).
    commit(current.filter((existing) => existing !== id));
  }

  function toggle(id: string) {
    commit(current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]);
  }

  return (
    <div className="db-multi-select-editor">
      {current.length > 0 ? (
        <div className="db-option-tag-row" aria-label={`Tags escolhidas de ${property.name}`}>
          {current.map((id) => (
            <OptionTag key={id} option={findOption(property.config, id) ?? null} onRemove={() => remove(id)} />
          ))}
        </div>
      ) : null}
      <OptionPickerList
        options={property.config.options}
        selectedIds={new Set(current)}
        ariaLabel={`Escolher ${property.name}`}
        multiple
        onToggle={toggle}
      />
    </div>
  );
}
