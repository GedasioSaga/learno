/**
 * DBS-010/011/012 — Data: um tipo, três chaves de config (dia; dia+hora via
 * `includeTime`; intervalo via `hasEnd`). A forma do valor é I5
 * (`docs/FASE-3-ARQUITETURA.md` §2); a formatação pt-BR mora em
 * `date-format-pt-br.ts`, o vazio/canonização/texto puro em `date-value.ts`,
 * e o parser/serializador ISO de largura fixa — reusado pela Trilha e pelo
 * Calendário — em `date-iso.ts`.
 */
import type { PropertySpec } from "../../core/property-spec";
import { DateCellEditor, DateCellValue } from "./date-cell";
import {
  DEFAULT_DATE_CONFIG,
  isEmptyDateValue,
  normalizeDateValue,
  parseDateValue,
  toPlainTextDateValue,
  type DateConfig,
  type DateFieldValue,
} from "./date-value";

export const datePropertySpec: PropertySpec<DateFieldValue, DateConfig> = {
  type: "date",
  label: "Data",
  icon: "📅",
  valueShape: "date",
  defaultConfig: DEFAULT_DATE_CONFIG,

  // I1 aplicada a Data: só é vazio quando não há sequer um `start` válido.
  isEmpty: (value) => isEmptyDateValue(value),
  // I1 no caminho de escrita: um `start` fora da forma ISO nunca chega ao
  // Postgres — `normalizeDateValue` devolve `null` (apaga a linha) em vez
  // de deixar `chk_drv_iso_date_shape` estourar como erro de SQL cru.
  normalize: (value) => normalizeDateValue(value),
  // TOTAL: jsonb corrompido vira `null`, o mesmo vazio da ausência da linha.
  parse: (raw) => parseDateValue(raw),
  // Identidade: `DateFieldValue` já é exatamente a forma jsonb esperada
  // (só `start`/`end` string, nunca campo extra) — `parseDateValue` garante
  // isso na entrada, então não há nada a converter na saída.
  serialize: (value) => value,

  renderValue: (ctx) => DateCellValue(ctx),
  renderEditor: (ctx) => DateCellEditor(ctx),

  filterOperators: ["is", "isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isWithin", "isEmpty", "isNotEmpty"],
  // A coluna gerada `sort_text` (`docs/FASE-3-SCHEMA.sql`) guarda
  // `value ->> 'start'` para todo valor-objeto — I2 proíbe ordenar por
  // `value` diretamente. `dateSortKey` (`date-value.ts`) é o espelho
  // client-side desta mesma chave.
  sort: "text",
  grouping: { strategy: "date_bucket" },
  aggregations: [
    "count_all",
    "count_values",
    "count_unique",
    "count_empty",
    "count_not_empty",
    "percent_empty",
    "percent_not_empty",
    "earliest_date",
    "latest_date",
    "date_range",
  ],

  // Determinística, sem locale (arquitetura §6) — espelhada em
  // `record_values.rs` e verificada contra `property_values.json`.
  toPlainText: (value) => toPlainTextDateValue(value),
};
