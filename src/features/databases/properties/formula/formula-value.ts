/**
 * A forma em memória do valor de uma coluna de Fórmula, e as operações
 * puras que `formulaPropertySpec` (`formula-spec.tsx`) precisa — separadas
 * do spec para serem testáveis sem React, o mesmo corte de `date-value.ts`.
 *
 * Uma fórmula NUNCA tem linha em `database_record_values`: o valor é
 * calculado pelo Rust (`evaluate_formula_column`) e injetado no mapa
 * `RecordRow.values` pelo carregador (`loader/use-database.ts`). O JSON que
 * chega é `Value::to_json()` (`src-tauri/src/formula/core/types.rs`): número,
 * texto, booleano, `{ start, end }` de data, `{ name, email }` de pessoa, id
 * de página, lista de qualquer um desses, ou `null` para vazio.
 *
 * O caso honesto que este arquivo existe para nomear: quando a expressão de
 * uma coluna NÃO compila (sintaxe, tipo, ou referência a outra fórmula —
 * DBS-084, fora do escopo), o Rust devolve `null` para TODO registro, sem
 * erro. "Coluna inteira vazia" seria mentira; o carregador então grava
 * [`formulaErrorValue`] no lugar, e a célula mostra o erro que o Rust
 * reportou em `validate_formula` — nunca uma mensagem inventada aqui.
 */
import type { DateValue } from "../../contract";
import { formatDateValuePtBr } from "../date/date-format-pt-br";
import { isEmptyDateValue } from "../date/date-value";
import { formatNumberValue } from "../number/number-spec";

/** A `database_properties.config` de uma fórmula — a chave que `evaluate_formula_column` lê (`load_formula_expression`). */
export interface FormulaConfig {
  expression: string;
}

export const DEFAULT_FORMULA_CONFIG: FormulaConfig = { expression: "" };

/** A chave do sentinela de erro. Nenhum `Value::to_json()` produz um objeto com ela (data tem `start`/`end`, pessoa tem `name`/`email`). */
const ERROR_KEY = "formulaError";

export interface FormulaErrorValue {
  /** A mensagem do primeiro diagnóstico que o Rust devolveu. */
  formulaError: string;
}

/** Marca um valor de célula como "a fórmula desta coluna não compila" — gravado só pelo carregador, nunca pelo Rust. */
export function formulaErrorValue(message: string): FormulaErrorValue {
  return { [ERROR_KEY]: message };
}

export function isFormulaErrorValue(value: unknown): value is FormulaErrorValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>)[ERROR_KEY] === "string";
}

/** `TValue` do spec: o JSON cru do Rust (`null` = vazio) ou o sentinela de erro. */
export type FormulaValue = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateShape(value: unknown): value is DateValue {
  return isRecord(value) && !isEmptyDateValue(value);
}

function isPersonShape(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

/**
 * I1 aplicada a Fórmula: `0`, `false` e `""` são VALORES (uma fórmula
 * booleana devolve `false` de verdade — a exceção nomeada em
 * `ValueShape`). Vazio é `null`/`undefined`, uma lista sem itens (a mesma
 * convenção de `multi_select`/`files`, que tratam `[]` como vazio — sem
 * isso "ocultar se vazia" divergiria entre uma lista calculada e uma
 * gravada) e o erro de compilação, porque não há valor a mostrar.
 */
export function isEmptyFormulaValue(value: unknown): boolean {
  if (value === null || value === undefined || isFormulaErrorValue(value)) return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * O texto que a célula mostra. TOTAL: qualquer forma que não seja
 * reconhecida vira o JSON dela, nunca um `throw`. Booleano é tratado pela
 * célula (desenha um checkbox), não aqui — este é o caminho de TEXTO.
 */
export function formatFormulaValue(value: unknown): string {
  if (value === null || value === undefined || isFormulaErrorValue(value)) return "";
  if (typeof value === "number") return Number.isFinite(value) ? formatNumberValue(value, "plain") : "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.map(formatFormulaValue).filter((item) => item.length > 0).join(", ");
  if (isDateShape(value)) return formatDateValuePtBr(value);
  if (isPersonShape(value)) return value.name;
  return JSON.stringify(value);
}

/**
 * Determinística, sem locale (CSV/busca) — o contrato de `toPlainText`.
 * Número sai como `String(n)` (ponto decimal), data como o ISO cru.
 */
export function formulaValueToPlainText(value: unknown): string {
  if (value === null || value === undefined || isFormulaErrorValue(value)) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (Array.isArray(value)) return value.map(formulaValueToPlainText).filter((item) => item.length > 0).join(", ");
  if (isDateShape(value)) return typeof value.end === "string" ? `${value.start} → ${value.end}` : value.start;
  if (isPersonShape(value)) return value.name;
  return JSON.stringify(value);
}

/**
 * jsonb -> FormulaValue. TOTAL e (quase) identidade: o valor já vem no
 * formato final do Rust; `undefined` (propriedade ausente do mapa) vira
 * `null`, o vazio canônico.
 */
export function parseFormulaValue(raw: unknown): FormulaValue {
  return raw === undefined ? null : raw;
}

/** `config` cru -> `FormulaConfig`. TOTAL: sem `expression` de texto vira `""`, que a célula trata como "fórmula não configurada". */
export function parseFormulaConfig(raw: unknown): FormulaConfig {
  if (isRecord(raw) && typeof raw.expression === "string") return { expression: raw.expression };
  return DEFAULT_FORMULA_CONFIG;
}
