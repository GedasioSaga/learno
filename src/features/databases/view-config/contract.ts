/**
 * `ViewConfig` e as formas de consulta que uma view guarda no blob jsonb de
 * `database_views.config` (arquitetura §8, decisão (d) da fundação: blob
 * lido e escrito INTEIRO, nenhuma consulta do pipeline olha dentro dele).
 *
 * DIVERGÊNCIA (ver `divergencias_da_arquitetura` no relatório desta peça): a
 * §8 atribui este arquivo a `src/features/databases/query/contract.ts`, da
 * peça dona do pipeline de consulta (`open_view_query`/`predicate.rs`), que
 * ainda não existe nesta rodada — mesma divergência já registrada por
 * `core/view-spec.ts` (`ViewRenderContext`) e por `RecordRow` em
 * `../contract.ts`. Os tipos abaixo são cópia LITERAL da §8: quando
 * `query/contract.ts` existir, ele deve virar a fonte e este arquivo deve
 * IMPORTAR de lá em vez de redeclarar — duas declarações do mesmo formato
 * divergem na primeira propriedade nova que uma esquecer, e ninguém avisa.
 * Até lá, `view-config/` (pasta exclusiva desta peça) precisa de algo contra
 * o que compilar.
 */
import type { AggregationKind, FilterOperator, PropertyId, PropertyValue, TemplateId } from "../contract";

export interface FilterCondition {
  kind: "condition";
  propertyId: PropertyId;
  operator: FilterOperator;
  /** Ausente em `isEmpty`/`isNotEmpty`/`isChecked`/`isNotChecked` — esses operadores não comparam com nada. */
  value?: PropertyValue;
}

export interface FilterGroup {
  kind: "group";
  connective: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

export interface SortSpec {
  /** `null` = ordem manual do usuário (`pages.position`). */
  propertyId: PropertyId | null;
  direction: "asc" | "desc";
}

export interface GroupSpec {
  propertyId: PropertyId;
  hideEmpty: boolean;
  order: "ascending" | "descending" | "manual";
  manualOrder?: string[];
}

export interface ColorRule {
  id: string;
  when: FilterGroup;
  target: { kind: "row" } | { kind: "property"; propertyId: PropertyId };
  /** Token do sistema visual, nunca hex. */
  color: string;
}

/** DBS-054: os três estados de visibilidade de uma coluna, por view. */
export type ColumnVisibilityMode = "always" | "hide_when_empty" | "never";

/**
 * O blob de `database_views.config` inteiro (DBS-053). Toda chave que
 * referencia uma propriedade usa `PropertyId`, NUNCA índice de coluna — com
 * índice, apagar a 2ª propriedade desloca a largura de todas as seguintes em
 * silêncio. Todo leitor deste blob INTERSECTA com a lista viva de
 * propriedades da database: uma entrada citando um id apagado é TOLERADA
 * (ver `orphans.ts`), nunca motivo de a view quebrar.
 */
export interface ViewConfig {
  filter: FilterNode | null;
  sorts: SortSpec[];
  group: GroupSpec | null;
  colorRules: ColorRule[];
  columnOrder: PropertyId[];
  columnWidths: Record<PropertyId, number>;
  columnVisibility: Record<PropertyId, ColumnVisibilityMode>;
  footers: Record<PropertyId, AggregationKind | null>;
  frozenUpTo: PropertyId | null;
  defaultTemplateId?: TemplateId | null;
  interactionFilter?: "parentsOnly" | "subItemsOnly" | "both";
  subItemDisplay?: "nestedToggle" | "flattened" | "cardProperty";
  /** Layout específico do tipo de view (ex.: cor de fundo do Board por coluna). Opaco aqui de propósito — cada `views/<tipo>/register.ts` interpreta o seu próprio formato. */
  layout?: Record<string, unknown>;
}
