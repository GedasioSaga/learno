/**
 * Fixtures compartilhados pelos testes de `select`/`multi_select` — não
 * termina em `.test.ts`, então o vitest não o coleta como suíte própria, só
 * como helper importado pelas duas pastas (a mesma peça é dona das duas).
 *
 * `optionByLabel`/`optionAt` existem para os testes nunca precisarem de `!`
 * (non-null assertion, regra 2 — cada ocorrência exigiria comentário e um
 * fixture com o rótulo/índice errado deve falhar com mensagem legível, não
 * com "Cannot read properties of undefined").
 */
import type { RecordRow } from "../../contract";
import type { PropertyDescriptor } from "../../core/property-spec";
import { addOption, type SelectOption, type SelectPropertyConfig } from "./option-model";

export function configWith(...labels: string[]): SelectPropertyConfig {
  let config: SelectPropertyConfig = { options: [] };
  for (const label of labels) config = addOption(config, label).config;
  return config;
}

export function optionByLabel(config: SelectPropertyConfig, label: string): SelectOption {
  const option = config.options.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`fixture de teste inválido: opção "${label}" não existe em config.options`);
  return option;
}

export function optionAt(config: SelectPropertyConfig, index: number): SelectOption {
  const option = config.options[index];
  if (!option) throw new Error(`fixture de teste inválido: não há opção no índice ${index}`);
  return option;
}

export function propertyFixture<TConfig>(
  config: TConfig,
  overrides: Partial<PropertyDescriptor<TConfig>> = {},
): PropertyDescriptor<TConfig> {
  return { id: "prop-1", databaseId: "db-1", name: "Matéria", type: "select", config, position: "a0", ...overrides };
}

export function recordFixture(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: "rec-1",
    title: "Registro de teste",
    icon: null,
    parentId: null,
    position: "a0",
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    values: {},
    matchedColorRuleIds: [],
    ...overrides,
  };
}
