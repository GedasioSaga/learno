/**
 * DBS-004 — registra o tipo de propriedade `"text"` (`property_type`
 * persistido). Descoberto automaticamente por
 * `src/features/databases/core/discover-extensions.ts`; nada importa este
 * arquivo diretamente (mesmo mecanismo do editor de blocos, ver seu
 * README).
 *
 * `valueShape: "text"` casa com o fixture compartilhado
 * (`src-tauri/tests/fixtures/property_values.json`, caso `text_valid_short`)
 * e com o espelho Rust (`src-tauri/src/db/record_values.rs`): o jsonb
 * persistido é sempre uma string — ver o cabeçalho de `rich-text-value.ts`
 * para a decisão completa de como negrito/etc. cabem dentro dela.
 */
import { registerPropertySpec, type PropertySpec } from "../../core/property-spec";
import { renderRichTextValue } from "./RichTextCell";
import { renderRichTextEditor } from "./RichTextEditor";
import {
  decodeRichText,
  encodeRichText,
  flattenPlainText,
  isEmptyRichTextValue,
  normalizeRichTextValue,
  wrapPlainText,
  type RichTextConfig,
  type RichTextValue,
} from "./rich-text-value";

export const TEXT_PROPERTY_TYPE = "text";

const textPropertySpec: PropertySpec<RichTextValue, RichTextConfig> = {
  type: TEXT_PROPERTY_TYPE,
  label: "Texto",
  icon: "📝",

  valueShape: "text",
  defaultConfig: {},
  isEmpty: (value) => isEmptyRichTextValue(value),
  normalize: (value) => normalizeRichTextValue(value),
  parse: (raw) => decodeRichText(raw),
  serialize: (value) => encodeRichText(value),

  renderValue: renderRichTextValue,
  renderEditor: renderRichTextEditor,

  filterOperators: ["is", "isNot", "contains", "doesNotContain", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  sort: "text",
  aggregations: ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText: (value) => flattenPlainText(value),
  parsePlainText: (text) => wrapPlainText(text),
};

registerPropertySpec(textPropertySpec);
