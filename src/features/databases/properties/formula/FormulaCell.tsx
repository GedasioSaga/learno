/**
 * A célula de uma coluna de Fórmula: conteúdo inline, somente leitura (a
 * view é dona da caixa). Três estados, todos honestos:
 *
 * - valor calculado: número/texto/data/lista formatados; booleano vira um
 *   checkbox desabilitado, como a célula de Checkbox em modo leitura;
 * - vazio (`null`): nada — a mesma ausência de qualquer outra célula;
 * - erro: a expressão da coluna não compila (o Rust devolveu `null` para
 *   TODO registro). Mostra "fórmula inválida" com a mensagem do Rust no
 *   `title` — nunca uma coluna em branco fingindo estar vazia.
 */
import type { PropertyDescriptor } from "../../core/property-spec";
import { formatFormulaValue, isFormulaErrorValue, type FormulaConfig, type FormulaValue } from "./formula-value";
import "./formula.css";

interface FormulaCellValueProps {
  value: FormulaValue;
  property: PropertyDescriptor<FormulaConfig>;
}

export function FormulaCellValue({ value, property }: FormulaCellValueProps) {
  if (value === null || value === undefined) return null;

  if (isFormulaErrorValue(value)) {
    return (
      <span className="db-cell-formula db-cell-formula--error" title={value.formulaError}>
        <span aria-hidden="true">⚠</span> fórmula inválida
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <input
        type="checkbox"
        className="db-cell-checkbox"
        checked={value}
        disabled
        onChange={() => {}}
        aria-label={`${property.name}: ${value ? "sim" : "não"}`}
      />
    );
  }

  return <span className={typeof value === "number" ? "db-cell-formula db-cell-number" : "db-cell-formula"}>{formatFormulaValue(value)}</span>;
}
