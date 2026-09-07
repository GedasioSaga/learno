/**
 * `PropertySpec` do tipo "formula" (DBS-060+): a coluna calculada. Liga o
 * motor de fórmula do Rust (`src-tauri/src/formula/`) à tela pela primeira
 * vez — `list_formula_functions`, `validate_formula` e `preview_formula`
 * viviam em `REGISTRADOS_SEM_TELA` até esta peça.
 *
 * Duas decisões que moldam o arquivo:
 *
 * - **Sem `renderEditor`, de propósito.** Uma propriedade sem `renderEditor`
 *   é somente-leitura por contrato (`property-spec.ts`), e é assim que a
 *   célula de fórmula fica não-editável sem nenhum código especial na
 *   Tabela. `normalize` devolve `null` sempre: mesmo que algum caminho
 *   chamasse `commit`, nada seria gravado em `database_record_values`.
 * - **A expressão é `config`, não valor.** Mora em
 *   `database_properties.config.expression` (a chave que
 *   `load_formula_expression` lê no Rust). Só `create_property` aceita
 *   `config` hoje — não existe comando para alterar a config de uma
 *   propriedade existente — então o editor (`renderConfigForm`) roda na
 *   criação, e a fórmula de uma coluna já criada não é editável nesta
 *   rodada (ver o relato desta peça).
 *
 * Este arquivo não chama `registerPropertySpec` — quem faz isso é
 * `register.ts`, o único arquivo que `discover-extensions.ts` importa.
 */
import type { PropertySpec } from "../../core/property-spec";
import { FormulaCellValue } from "./FormulaCell";
import { FormulaConfigForm } from "./FormulaConfigForm";
import {
  DEFAULT_FORMULA_CONFIG,
  formulaValueToPlainText,
  isEmptyFormulaValue,
  parseFormulaValue,
  type FormulaConfig,
  type FormulaValue,
} from "./formula-value";

export const FORMULA_PROPERTY_TYPE = "formula";

export const formulaPropertySpec: PropertySpec<FormulaValue, FormulaConfig> = {
  type: FORMULA_PROPERTY_TYPE,
  label: "Fórmula",
  icon: "ƒ",

  // Uma fórmula não tem linha própria em `database_record_values`, então
  // nenhum SQL é traduzido a partir desta forma; "text" é o mais neutro do
  // conjunto fechado. `filterOperators` vazio pelo mesmo motivo: filtrar
  // por valor calculado precisa do pipeline de consulta (§8), que não
  // existe — e controle que não faz nada é defeito.
  valueShape: "text",
  defaultConfig: DEFAULT_FORMULA_CONFIG,

  isEmpty: (value) => isEmptyFormulaValue(value),
  // Nunca grava: a coluna é calculada. Ver o cabeçalho do arquivo.
  normalize: () => null,
  parse: (raw) => parseFormulaValue(raw),
  serialize: (value) => value,

  renderValue: (ctx) => <FormulaCellValue value={ctx.value} property={ctx.property} />,
  renderConfigForm: (ctx) => <FormulaConfigForm ctx={ctx} />,

  filterOperators: [],
  sort: "none",

  toPlainText: (value) => formulaValueToPlainText(value),
};
