/**
 * DBS-007 — Propriedade Seleção (select). `valueShape: "option"` (contract.ts
 * §6): o valor é o ID de uma opção, NUNCA o rótulo — renomear uma opção
 * troca `config.options`, não as 50.000 linhas que apontam para ela.
 *
 * `isEmpty`/`normalize` seguem I1 à risca (nunca `!value`): um id órfão
 * (opção apagada) NÃO é tratado como lixo de tipo — ele existe como string
 * não-vazia — mas conta como vazio pra fins de filtro/agregação, porque não
 * há rótulo nem cor pra mostrar (arquitetura §6). `normalize` é o ponto de
 * validação "TS-only" que `record_values.rs` deliberadamente NÃO faz (ele só
 * cobre a metade genérica de I1) — um id que não existe em `config.options`
 * nunca é escrito.
 */
import type { OptionId } from "../../contract";
import type { PropertySpec } from "../../core/property-spec";
import { renderSelectEditor, renderSelectValue } from "./SelectCell";
import { findOption, type SelectPropertyConfig } from "./option-model";

export const SELECT_PROPERTY_TYPE = "select";

/** DBS-117: "Board recusa acima disto e EXPLICA — nunca trava nem renderiza vazio." Número de opções acima do qual agrupar em colunas deixa de fazer sentido visualmente. */
const MAX_GROUPING_OPTIONS = 50;

export const selectPropertySpec: PropertySpec<OptionId, SelectPropertyConfig> = {
  type: SELECT_PROPERTY_TYPE,
  label: "Seleção",
  icon: "◉",

  valueShape: "option",
  defaultConfig: { options: [] },

  isEmpty(value, config) {
    if (typeof value !== "string" || value.length === 0) return true;
    // Órfão conta como vazio (arquitetura §6) — sem opção viva não há o que mostrar/agregar, mesmo que a linha exista.
    return findOption(config, value) === undefined;
  },

  normalize(value, config) {
    if (typeof value !== "string" || value.length === 0) return null;
    return findOption(config, value) ? value : null;
  },

  parse(raw) {
    return typeof raw === "string" ? raw : "";
  },

  serialize(value) {
    return value;
  },

  renderValue: renderSelectValue,
  renderEditor: renderSelectEditor,

  filterOperators: ["is", "isNot", "isEmpty", "isNotEmpty"],
  sort: "configOrder",
  grouping: { strategy: "option", maxGroups: MAX_GROUPING_OPTIONS },
  aggregations: ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText(value, config) {
    if (value === null || value === undefined) return "";
    const option = findOption(config, value);
    return option ? option.label : "";
  },

  parsePlainText(text, config) {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const match = config.options.find((option) => option.label.localeCompare(trimmed, "pt-BR", { sensitivity: "base" }) === 0);
    return match ? match.id : null;
  },
};
