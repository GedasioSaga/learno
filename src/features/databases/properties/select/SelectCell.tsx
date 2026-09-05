/**
 * `renderValue`/`renderEditor` de `select` (DBS-007). Separado de
 * `select-spec.ts` pelo mesmo motivo de `bookmark-spec.ts`/`BookmarkNode` no
 * editor: o spec fica sem JSX, só o componente carrega `.tsx`.
 */
import type { ReactNode } from "react";
import type { OptionId } from "../../contract";
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import { OptionPickerList } from "./OptionPickerList";
import { OptionTag } from "./OptionTag";
import { findOption, type SelectPropertyConfig } from "./option-model";

export function renderSelectValue({ value, property }: CellRenderContext<OptionId, SelectPropertyConfig>): ReactNode {
  if (!value) return null;
  return <OptionTag option={findOption(property.config, value) ?? null} />;
}

export function renderSelectEditor(ctx: CellEditContext<OptionId, SelectPropertyConfig>): ReactNode {
  const { value, property, commit, close } = ctx;

  function clear() {
    // "" normaliza para `null` no spec (I1) — apaga a linha, célula volta a vazia.
    commit("");
    close();
  }

  return (
    <div className="db-select-editor">
      {value ? (
        <div className="db-option-tag-row" aria-label="Seleção atual">
          <OptionTag option={findOption(property.config, value) ?? null} onRemove={clear} />
        </div>
      ) : null}
      <OptionPickerList
        options={property.config.options}
        selectedIds={value ? new Set([value]) : new Set()}
        ariaLabel={`Escolher ${property.name}`}
        multiple={false}
        onToggle={(id) => {
          // DBS-007: escolher outra opção SUBSTITUI a anterior — natural aqui
          // porque o valor de "select" é um escalar (um id só), não uma soma.
          commit(id);
          close();
        }}
      />
    </div>
  );
}
