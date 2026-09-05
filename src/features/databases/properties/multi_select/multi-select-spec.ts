/**
 * DBS-008 — Propriedade Multi-seleção. `valueShape: "option_list"`
 * (contract.ts §6): array de IDs de opção, nunca de rótulos.
 *
 * Diferença deliberada em relação a `select-spec.ts`: `normalize` aqui NÃO
 * valida cada id contra `config.options`. Um `commit(next)` de multi-select
 * manda o array INTEIRO, tocado ou não — se ele filtrasse ids órfãos a cada
 * escrita, remover UMA tag (`MultiSelectCell.remove`) apagaria em silêncio
 * qualquer outra tag já órfã que estivesse no mesmo array, violando
 * exatamente o que a arquitetura §6 proíbe ("nunca some em silêncio"). A
 * defesa contra lixo de tipo (não-string, string vazia, duplicata) continua;
 * a defesa contra id inexistente fica só do lado de quem ESCOLHE a opção
 * (`OptionPickerList` só lista ids que existem em `config.options`).
 */
import type { PropertySpec } from "../../core/property-spec";
import { renderMultiSelectEditor, renderMultiSelectValue } from "./MultiSelectCell";
import { findOption, type MultiSelectPropertyConfig } from "../select/option-model";

export const MULTI_SELECT_PROPERTY_TYPE = "multi_select";

/** Mesmo teto de `select-spec.ts` — ver o comentário lá (DBS-117). */
const MAX_GROUPING_OPTIONS = 50;

export const multiSelectPropertySpec: PropertySpec<string[], MultiSelectPropertyConfig> = {
  type: MULTI_SELECT_PROPERTY_TYPE,
  label: "Multi-seleção",
  icon: "☰",

  valueShape: "option_list",
  defaultConfig: { options: [] },

  isEmpty(value, config) {
    if (!Array.isArray(value) || value.length === 0) return true;
    // Vazio só quando TODO id é órfão — um único id vivo já basta pra ter algo de fato pra mostrar/agregar (arquitetura §6).
    return !value.some((id) => typeof id === "string" && findOption(config, id) !== undefined);
  },

  normalize(value) {
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of value) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      kept.push(raw);
    }
    return kept.length > 0 ? kept : null;
  },

  parse(raw) {
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  },

  serialize(value) {
    return value;
  },

  renderValue: renderMultiSelectValue,
  renderEditor: renderMultiSelectEditor,

  filterOperators: ["containsAny", "containsAll", "isEmpty", "isNotEmpty"],
  sort: "configOrder",
  grouping: { strategy: "option", maxGroups: MAX_GROUPING_OPTIONS },
  aggregations: ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText(value, config) {
    if (!value || value.length === 0) return "";
    return value
      .map((id) => findOption(config, id)?.label)
      .filter((label): label is string => typeof label === "string")
      .join(", ");
  },

  parsePlainText(text, config) {
    const labels = text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (labels.length === 0) return null;
    const ids = labels
      .map((label) => config.options.find((option) => option.label.localeCompare(label, "pt-BR", { sensitivity: "base" }) === 0)?.id)
      .filter((id): id is string => typeof id === "string");
    return ids.length > 0 ? ids : null;
  },
};
