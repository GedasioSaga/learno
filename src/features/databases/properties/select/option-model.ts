/**
 * O modelo de opção compartilhado por `select` e `multi_select` — as DUAS
 * pastas exclusivas desta peça (P3). Vive aqui porque `select` é a forma
 * "base" (um id) e `multi_select` é a mesma forma numa lista; as duas
 * moram na mesma peça, então uma fonte só evita duas implementações que
 * discordam da primeira opção nova.
 *
 * CONTRATO PUBLICADO (arquitetura §6: "select/status/multi_select guardam
 * o ID da opção, nunca o rótulo") — como o Board e a Trilha (TRL-007, "raias
 * nomeadas por propriedade de agrupamento") consultam a lista na ordem da
 * config, LITERALMENTE:
 *
 * ```ts
 * import { listOptionsInOrder, type SelectPropertyConfig } from
 *   "src/features/databases/properties/select/option-model";
 *
 * const options = listOptionsInOrder(property.config as SelectPropertyConfig);
 * // options[0] é a primeira coluna do Board / a primeira raia da Trilha.
 * // `MultiSelectPropertyConfig` (abaixo) tem a MESMA forma — o mesmo helper
 * // serve as duas propriedades sem un cast extra.
 * ```
 *
 * NUNCA reordene `config.options` na leitura (nem alfabético, nem por id):
 * a ordem do array JÁ É a ordem de exibição — é o "configOrder" que
 * `PropertySpec.sort` declara (`core/property-spec.ts`). Mudar a ordem é
 * escrever um array novo com `reorderOptions`, não ordenar ao ler.
 *
 * Um id que não resolve a nenhuma opção (a opção foi apagada, mas o valor
 * do registro nunca é reescrito sozinho — arquitetura §6) NÃO é removido
 * daqui: `resolveDisplayOption` devolve `null` para esse caso, e quem
 * renderiza (`OptionTag`) mostra o chip "apagado" em vez de fazer sumir o
 * dado ou explodir.
 */
import type { OptionId } from "../../contract";

/**
 * Paleta PRÓPRIA desta peça — `src/styles/theme.css` não é arquivo meu para
 * editar (regra 9: pasta exclusiva), então as cores da opção moram em
 * `option-colors.css`, ao lado. Onde a marca já tem uma cor (âmbar, hortelã,
 * esmeralda, terracota, marrom) ela é REUSADA; "gray"/"blue"/"purple" são
 * tons novos na mesma saturação baixa do resto do tema (ver o CSS).
 */
export const SELECT_OPTION_COLORS = [
  "gray",
  "brown",
  "amber",
  "mint",
  "emerald",
  "terracotta",
  "blue",
  "purple",
] as const;

export type SelectOptionColor = (typeof SELECT_OPTION_COLORS)[number];

export const DEFAULT_SELECT_OPTION_COLOR: SelectOptionColor = "gray";

export interface SelectOption {
  /** Opaco — NUNCA o rótulo. Renomear a opção nunca muda este id (é o que impede reescrever 50.000 linhas ao renomear). */
  id: OptionId;
  label: string;
  color: SelectOptionColor;
}

/** Forma de `database_properties.config` para `select`. */
export interface SelectPropertyConfig {
  options: SelectOption[];
}

/**
 * `multi_select` usa a MESMA forma — duas listas independentes, uma por
 * propriedade (cada propriedade tem seu próprio `config.options`; não é a
 * mesma lista compartilhada entre uma select e uma multi_select da mesma
 * database). Nome próprio só para o call site ficar autoexplicativo.
 */
export type MultiSelectPropertyConfig = SelectPropertyConfig;

function newOptionId(): OptionId {
  return crypto.randomUUID();
}

/** A ÚNICA leitura correta da lista de opções, na ordem que a UI mostra (Board, Trilha, o próprio seletor da célula). */
export function listOptionsInOrder(config: SelectPropertyConfig): readonly SelectOption[] {
  return config.options;
}

export function findOption(config: SelectPropertyConfig, id: OptionId): SelectOption | undefined {
  return config.options.find((option) => option.id === id);
}

/** `id` -> opção viva, ou `null` para o caso "opção apagada" (arquitetura §6: nunca some em silêncio, nunca explode). */
export function resolveDisplayOption(config: SelectPropertyConfig, id: OptionId): SelectOption | null {
  return findOption(config, id) ?? null;
}

export function addOption(
  config: SelectPropertyConfig,
  label: string,
  color: SelectOptionColor = DEFAULT_SELECT_OPTION_COLOR,
): { config: SelectPropertyConfig; option: SelectOption } {
  const option: SelectOption = { id: newOptionId(), label, color };
  return { config: { options: [...config.options, option] }, option };
}

export function renameOption(config: SelectPropertyConfig, id: OptionId, label: string): SelectPropertyConfig {
  return { options: config.options.map((option) => (option.id === id ? { ...option, label } : option)) };
}

export function recolorOption(config: SelectPropertyConfig, id: OptionId, color: SelectOptionColor): SelectPropertyConfig {
  return { options: config.options.map((option) => (option.id === id ? { ...option, color } : option)) };
}

/**
 * Remove a opção da LISTA de opções. Não toca em `database_record_values` —
 * um valor já gravado apontando para este id vira órfão de propósito
 * (arquitetura §6, mesmo raciocínio de "propriedade sobrevivente marcada
 * broken" para relação): apagar o dado do registro seria dano irreversível
 * que ninguém pediu. `resolveDisplayOption` é quem torna esse órfão visível
 * em vez de sumido.
 */
export function removeOption(config: SelectPropertyConfig, id: OptionId): SelectPropertyConfig {
  return { options: config.options.filter((option) => option.id !== id) };
}

/**
 * Reordena pela lista de ids dada. Um id que não está mais em `config` é
 * ignorado; uma opção existente que faltou em `orderedIds` (chamador com
 * bug, ou lista parcial) não é destruída — vai para o final, na ordem
 * original, em vez de desaparecer da propriedade.
 */
export function reorderOptions(config: SelectPropertyConfig, orderedIds: readonly OptionId[]): SelectPropertyConfig {
  const byId = new Map(config.options.map((option) => [option.id, option] as const));
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter((option): option is SelectOption => option !== undefined);
  const reorderedIds = new Set(reordered.map((option) => option.id));
  const missing = config.options.filter((option) => !reorderedIds.has(option.id));
  return { options: [...reordered, ...missing] };
}
