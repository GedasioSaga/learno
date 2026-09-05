/**
 * DBS-017 — Checkbox: campo booleano simples. Esta é a peça de I1 que a
 * própria arquitetura nomeia por extenso (arquitetura §2): "Checkbox nunca
 * grava `false`. 50.000 cards desmarcados são 0 linhas, não 50.000."
 *
 * IMPORTANTE — checkbox NÃO é a exceção nomeada de I1. A exceção
 * ("`false` é valor legítimo") é da FÓRMULA booleana (`property_type ==
 * "formula"`), não do checkbox — ver o comentário de
 * `src-tauri/src/db/record_values.rs::normalize`, que grava exatamente essa
 * distinção por `property_type`. Por isso `isEmpty` aqui trata `false` como
 * vazio, ao contrário do `spec_test_checkbox` ilustrativo de
 * `core/property-spec.test.ts` (um test double que não implementa este
 * tipo de verdade — o próprio cabeçalho daquele arquivo diz isso).
 */
import type { PropertySpec } from "../../core/property-spec";
import { CheckboxCellEditor, CheckboxCellValue } from "./checkbox-cell";

/** Sem opções nesta fase — DBS-017 não pede cor customizável. */
export type CheckboxConfig = Record<string, never>;

export const checkboxPropertySpec: PropertySpec<boolean, CheckboxConfig> = {
  type: "checkbox",
  label: "Checkbox",
  icon: "☑",
  valueShape: "boolean",
  defaultConfig: {},

  // I1, especializado para checkbox: só `true` conta como valor presente.
  // `false`/`null`/`undefined` são todos "vazio" — sem isso DBS-054 (hide
  // when empty) e DBS-130 (count empty) discordariam de I1 na mesma tela.
  isEmpty: (value) => value !== true,
  // O caminho de escrita (I4): desmarcar APAGA a linha, nunca grava `false`.
  // Mirror exato de `record_values.rs::normalize("checkbox", ...)`.
  normalize: (value) => (value === true ? true : null),
  // TOTAL: qualquer coisa que não seja literalmente `true` — inclusive
  // `undefined` de uma propriedade AUSENTE do mapa (I1) — mostra desmarcado.
  parse: (raw) => raw === true,
  serialize: (value) => value,

  renderValue: (ctx) => CheckboxCellValue(ctx),
  renderEditor: (ctx) => CheckboxCellEditor(ctx),

  filterOperators: ["isChecked", "isNotChecked"],
  // sort_num gerado por 0017 faz CASE boolean WHEN true THEN 1 ELSE 0
  // (docs/FASE-3-SCHEMA.sql) — checkbox ordena como número, nunca como texto.
  sort: "num",
  aggregations: ["count_all", "count_values", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText: (value) => (value === true ? "Sim" : ""),
};
