/**
 * DBS-054 — visibilidade de propriedade por view, nos três estados: sempre
 * visível, oculta se vazia, sempre oculta. "Oculta se vazia" é a metade
 * arriscada: depende de I1 (arquitetura §2) — vazio é a AUSÊNCIA da linha em
 * `database_record_values`, nunca `!value`. Um Número `0` ou um Checkbox
 * `false` (de fórmula) SÃO valor, e a coluna tem que continuar aparecendo
 * pra eles mesmo com "Ocultar se vazio" ligado.
 */
import type { PropertyId } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import { specForPropertyType } from "../core/property-spec";
import type { RecordRow } from "../contract";
import type { ColumnVisibilityMode, ViewConfig } from "./contract";

/** Default de uma propriedade que a view nunca configurou: sempre visível — igual ao Notion, e igual ao resto do jsonb (chave ausente == "não decidido ainda", nunca "oculto"). */
export const DEFAULT_COLUMN_VISIBILITY: ColumnVisibilityMode = "always";

export function getColumnVisibilityMode(config: Pick<ViewConfig, "columnVisibility">, propertyId: PropertyId): ColumnVisibilityMode {
  return config.columnVisibility[propertyId] ?? DEFAULT_COLUMN_VISIBILITY;
}

export function setColumnVisibility(config: ViewConfig, propertyId: PropertyId, mode: ColumnVisibilityMode): ViewConfig {
  return { ...config, columnVisibility: { ...config.columnVisibility, [propertyId]: mode } };
}

/**
 * O núcleo de DBS-054: esta propriedade aparece para ESTE registro? "Sempre
 * visível"/"sempre oculta" nem olham o valor. "Oculta se vazia" segue I1 à
 * risca:
 *
 * 1. Propriedade AUSENTE de `record.values` == vazia (I1) — oculta.
 * 2. Presente: pergunta pro `PropertySpec.isEmpty()` do próprio tipo, NUNCA
 *    `!value` (isso comeria o `0` do Número e o `false` do Checkbox — o bug
 *    mais provável da fase, segundo a própria arquitetura).
 * 3. `property_type` sem spec registrado (build futuro/antigo lendo um tipo
 *    que ele não conhece): mostra por padrão — esconder um dado que não
 *    sabemos classificar é pior que mostrar um a mais.
 */
export function isPropertyVisibleForRecord(config: Pick<ViewConfig, "columnVisibility">, property: PropertyDescriptor, record: RecordRow): boolean {
  const mode = getColumnVisibilityMode(config, property.id);
  if (mode === "never") return false;
  if (mode === "always") return true;

  if (!(property.id in record.values)) return false; // ausente do mapa == vazio (I1)

  const spec = specForPropertyType(property.type);
  if (!spec) return true;

  return !spec.isEmpty(record.values[property.id], property.config);
}

/** As propriedades (na mesma ordem recebida) que devem aparecer para `record`, já filtradas pela visibilidade da view. */
export function resolveVisibleProperties(
  config: Pick<ViewConfig, "columnVisibility">,
  properties: readonly PropertyDescriptor[],
  record: RecordRow,
): PropertyDescriptor[] {
  return properties.filter((property) => isPropertyVisibleForRecord(config, property, record));
}
