/**
 * DBS-045 — filtro simples por propriedade. Escolhe UMA propriedade, UM
 * operador (só os que `PropertySpec.filterOperators` declara pra ela — a
 * consulta é DECLARATIVA, arquitetura §6, nunca um predicado que este painel
 * inventaria) e, quando o operador pede, um valor. "Aplicar" substitui a
 * árvore de filtro inteira por essa condição — é o que `applySimpleFilter`
 * faz; filtro composto continua possível via `filter-builder.ts`, só não
 * tem UI aqui.
 */
import { useId, useState } from "react";
import type { FilterOperator, PropertyId, PropertyValue } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import { specForPropertyType } from "../core/property-spec";
import { applySimpleFilter, clearFilter } from "./filter-builder";
import type { FilterCondition, ViewConfig } from "./contract";

const OPERATORS_WITHOUT_VALUE: ReadonlySet<FilterOperator> = new Set(["isEmpty", "isNotEmpty", "isChecked", "isNotChecked"]);

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "é",
  isNot: "não é",
  contains: "contém",
  doesNotContain: "não contém",
  startsWith: "começa com",
  endsWith: "termina com",
  gt: "maior que",
  gte: "maior ou igual a",
  lt: "menor que",
  lte: "menor ou igual a",
  isBefore: "antes de",
  isAfter: "depois de",
  isOnOrBefore: "em ou antes de",
  isOnOrAfter: "em ou depois de",
  isWithin: "dentro de",
  isChecked: "está marcado",
  isNotChecked: "não está marcado",
  isEmpty: "está vazio",
  isNotEmpty: "não está vazio",
  containsAny: "contém algum de",
  containsAll: "contém todos de",
};

interface FilterPanelProps {
  properties: readonly PropertyDescriptor[];
  config: ViewConfig;
  onChange(next: ViewConfig): void;
}

function currentSimpleCondition(config: ViewConfig): FilterCondition | null {
  return config.filter !== null && config.filter.kind === "condition" ? config.filter : null;
}

/**
 * Duck typing deliberado: `PropertySpec.config` não tem uma forma comum de
 * "lista de opções nomeadas" entre select/multi_select/status — cada um
 * define a sua própria. Isto é um palpite honesto pra oferecer um `<select>`
 * quando bate, nunca uma verdade do contrato; qualquer forma que não bata
 * cai pro texto livre abaixo, sem lançar.
 */
function extractOptionChoices(rawConfig: unknown): { id: string; label: string }[] | null {
  if (typeof rawConfig !== "object" || rawConfig === null) return null;
  // `as` seguro aqui: já confirmamos acima que é um objeto não-nulo; isto só
  // amplia o tipo pra sondar `options` sem afirmar que a forma é garantida.
  const candidate = rawConfig as Record<string, unknown>;
  const options = candidate.options;
  if (!Array.isArray(options)) return null;
  const choices: { id: string; label: string }[] = [];
  for (const rawOption of options) {
    if (typeof rawOption !== "object" || rawOption === null) return null;
    // Mesma razão do `as` acima.
    const option = rawOption as Record<string, unknown>;
    const id = option.id;
    const label = option.name ?? option.label;
    if (typeof id !== "string" || typeof label !== "string") return null;
    choices.push({ id, label });
  }
  return choices;
}

function ValueInput({
  property,
  operator,
  value,
  onChange,
}: {
  property: PropertyDescriptor;
  operator: FilterOperator;
  value: PropertyValue | undefined;
  onChange(next: PropertyValue | undefined): void;
}) {
  if (OPERATORS_WITHOUT_VALUE.has(operator)) return null;

  const shape = specForPropertyType(property.type)?.valueShape;

  if (shape === "number") {
    return (
      <input
        type="number"
        aria-label="Valor do filtro"
        value={typeof value === "number" ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
      />
    );
  }

  if (shape === "date") {
    // I5: "YYYY-MM-DD" — exatamente o formato que `<input type="date">` produz nativamente.
    return (
      <input
        type="date"
        aria-label="Valor do filtro"
        value={typeof value === "string" ? value.slice(0, 10) : ""}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
        className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
      />
    );
  }

  if (shape === "option" || shape === "option_list") {
    const choices = extractOptionChoices(property.config);
    if (choices !== null) {
      return (
        <select
          aria-label="Valor do filtro"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          <option value="">Selecione…</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      );
    }
  }

  return (
    <input
      type="text"
      aria-label="Valor do filtro"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
    />
  );
}

export function FilterPanel({ properties, config, onChange }: FilterPanelProps) {
  const current = currentSimpleCondition(config);
  const hasCompoundFilter = config.filter !== null && current === null;
  const initialProperty = current !== null ? properties.find((property) => property.id === current.propertyId) : properties[0];

  const [propertyId, setPropertyId] = useState<PropertyId | null>(initialProperty?.id ?? null);
  const property = properties.find((candidate) => candidate.id === propertyId) ?? null;
  const operators = property ? (specForPropertyType(property.type)?.filterOperators ?? []) : [];

  const [operator, setOperator] = useState<FilterOperator | null>(current?.operator ?? operators[0] ?? null);
  const [value, setValue] = useState<PropertyValue | undefined>(current?.value);

  const propertySelectId = useId();
  const operatorSelectId = useId();

  function handlePropertyChange(nextId: PropertyId) {
    setPropertyId(nextId);
    const nextProperty = properties.find((candidate) => candidate.id === nextId);
    const nextOperators = nextProperty ? (specForPropertyType(nextProperty.type)?.filterOperators ?? []) : [];
    setOperator(nextOperators[0] ?? null);
    setValue(undefined);
  }

  function handleApply() {
    if (propertyId === null || operator === null) return;
    onChange(applySimpleFilter(config, propertyId, operator, OPERATORS_WITHOUT_VALUE.has(operator) ? undefined : value));
  }

  function handleClear() {
    setValue(undefined);
    onChange(clearFilter(config));
  }

  if (properties.length === 0) {
    return <p className="p-3 text-sm text-ink-muted">Esta database ainda não tem propriedade pra filtrar.</p>;
  }

  return (
    <div className="flex w-72 flex-col gap-2 p-3">
      {hasCompoundFilter ? (
        <p className="text-xs text-ink-muted">
          Um filtro personalizado está ativo. Aplicar aqui substitui ele por este filtro simples.
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={propertySelectId} className="text-xs font-medium text-ink-muted">
          Propriedade
        </label>
        <select
          id={propertySelectId}
          value={propertyId ?? ""}
          onChange={(event) => handlePropertyChange(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          {properties.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={operatorSelectId} className="text-xs font-medium text-ink-muted">
          Condição
        </label>
        <select
          id={operatorSelectId}
          value={operator ?? ""}
          // `as` seguro aqui: cada `<option>` abaixo é renderizada a partir
          // de `operators` (já um `FilterOperator[]`), então o valor que o
          // navegador devolve num `change` é sempre um dos literais do tipo.
          onChange={(event) => setOperator(event.target.value as FilterOperator)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          {operators.map((candidateOperator) => (
            <option key={candidateOperator} value={candidateOperator}>
              {OPERATOR_LABELS[candidateOperator]}
            </option>
          ))}
        </select>
      </div>
      {property !== null && operator !== null ? <ValueInput property={property} operator={operator} value={value} onChange={setValue} /> : null}
      <div className="mt-1 flex justify-between">
        <button type="button" onClick={handleClear} className="rounded px-2 py-1 text-sm text-ink-muted hover:bg-surface-sunken">
          Limpar filtro
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={propertyId === null || operator === null}
          className="rounded bg-emerald px-3 py-1 text-sm font-medium text-on-emerald disabled:opacity-50"
        >
          Aplicar filtro
        </button>
      </div>
    </div>
  );
}
