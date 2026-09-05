/**
 * DBS-005 — Número com formato: o valor jsonb guardado NUNCA muda com o
 * formato escolhido. `0.25` é sempre `0.25`; só a apresentação varia entre
 * "plain" (`0,25`), "percent" (`25%`) e "currency_brl" (`R$ 0,25`). Ver
 * `formatNumberValue` para a formatação e `number-cell.tsx` para as duas
 * metades de renderização (`renderValue`/`renderEditor`) que a consomem.
 *
 * I1 (arquitetura §2): `0` nunca é vazio. `isEmpty`/`normalize`/`parse` são
 * escritos contra essa armadilha de propósito — nenhum usa `!value`.
 */
import type { PropertySpec } from "../../core/property-spec";
import { NumberCellEditor, NumberCellValue } from "./number-cell";

export type NumberFormat = "plain" | "percent" | "currency_brl";

export interface NumberConfig {
  format: NumberFormat;
}

/** `TValue = number | null`: `null` é a representação em memória do vazio (célula sem linha em `database_record_values`). */
export type NumberValue = number | null;

/**
 * `Intl.NumberFormat` variando por `format`, nunca por avaliação numérica —
 * mudar de "plain" para "percent" muda só como `0.25` é lido, nunca o que é
 * gravado (isso é `normalize`, abaixo, que não olha `config` nenhuma).
 *
 * `toPlainText` (CSV/busca) deliberadamente NÃO passa por aqui: precisa ser
 * "determinística, sem locale variável" (arquitetura §6), e `Intl` varia por
 * build de ICU. Formatação bonita só entra na tela, nunca no texto puro.
 *
 * `Intl` em "pt-BR" separa símbolo de moeda e número com U+00A0 (espaço não
 * separável) em vez de um espaço comum — sem essa troca a célula devolveria
 * uma string que não bate byte a byte com o "R$ 0,25" literal do critério de
 * DBS-005, apesar de idêntica a olho nu. `String.fromCharCode(160)` evita
 * colocar o byte invisível direto no fonte.
 */
const NON_BREAKING_SPACE = new RegExp(String.fromCharCode(160), "g");

export function formatNumberValue(value: number, format: NumberFormat): string {
  const formatter = (options: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat("pt-BR", options).format(value).replace(NON_BREAKING_SPACE, " ");
  switch (format) {
    case "percent":
      return formatter({ style: "percent", maximumFractionDigits: 2 });
    case "currency_brl":
      return formatter({ style: "currency", currency: "BRL" });
    case "plain":
      return formatter({ maximumFractionDigits: 6 });
  }
}

/** Total: nunca lança, mesmo com `NaN`/`Infinity` (que a linguagem de fórmula, arquitetura §4, garante nunca produzir, mas um valor digitado à mão pode). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const numberPropertySpec: PropertySpec<NumberValue, NumberConfig> = {
  type: "number",
  label: "Número",
  icon: "#",
  valueShape: "number",
  defaultConfig: { format: "plain" },

  // I1: `0` nunca é vazio. `isFiniteNumber` decide sozinho — nunca `!value`.
  isEmpty: (value) => !isFiniteNumber(value),
  // I1 no caminho de escrita: qualquer coisa que não seja um número finito
  // (incluindo `NaN`/`Infinity`, que nem são JSON válido) apaga a linha.
  normalize: (value) => (isFiniteNumber(value) ? value : null),
  // TOTAL: um valor corrompido no jsonb (nunca deveria acontecer, já que
  // `normalize` é o único caminho de escrita — I4) vira `null`, o mesmo
  // "vazio" que a ausência da linha já significa — uma célula não pode
  // derrubar a view por causa disso.
  parse: (raw) => (isFiniteNumber(raw) ? raw : null),
  serialize: (value) => value,

  renderValue: (ctx) => NumberCellValue(ctx),
  renderEditor: (ctx) => NumberCellEditor(ctx),

  filterOperators: ["gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  sort: "num",
  aggregations: [
    "sum",
    "average",
    "median",
    "min",
    "max",
    "range",
    "count_all",
    "count_values",
    "count_empty",
    "count_not_empty",
    "percent_empty",
    "percent_not_empty",
  ],

  // Determinística de propósito — ver o comentário de `formatNumberValue`.
  toPlainText: (value) => (value === null ? "" : String(value)),
  parsePlainText: (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return isFiniteNumber(parsed) ? parsed : null;
  },
};
