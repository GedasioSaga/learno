/**
 * O registro de tipos de view — mesmo padrão de `property-spec.ts` (que por
 * sua vez segue `core/block-spec.ts` da Fase 2), para `table`/`board`/`list`/
 * `calendar`. Você cria `src/features/databases/views/<seu-tipo>/register.ts`,
 * chama `registerViewSpec()`, e não importa esse arquivo de lugar nenhum —
 * `discover-extensions.ts` o carrega por `import.meta.glob`.
 *
 * Escopo desta rodada (N1): só o REGISTRO. A arquitetura (§8) não fecha uma
 * forma para "o que uma view recebe para se desenhar" — isso depende do
 * pipeline de consulta (`open_view_query`/`fetch_view_window`), que mora em
 * `src/features/databases/query/contract.ts`, arquivo de outra peça que
 * ainda não existe nesta rodada. Por isso `ViewRenderContext` aqui é
 * deliberadamente mínimo (a própria descrição da view + as propriedades
 * visíveis, nada de dados de consulta) — ver divergência N1 no relatório
 * desta peça. Quem construir a casca React de cada view (table/board/list/
 * calendar) vai precisar estender este contexto quando `query/contract.ts`
 * existir; quando isso acontecer, mude aqui, não em cada `views/<tipo>/register.ts`.
 */
import type { ReactNode } from "react";
import type { DatabaseId, ViewId } from "../contract";
import type { PropertyDescriptor } from "./property-spec";

/** A view tal como um spec a vê — não a linha crua de `database_views` (`contract.ts`'s `DatabaseView`, com `config: Record<string, unknown>`). */
export interface ViewDescriptor<TConfig = unknown> {
  id: ViewId;
  databaseId: DatabaseId;
  name: string;
  /** `database_views.view_type`. */
  type: string;
  config: TConfig;
  position: string;
}

export interface ViewRenderContext<TConfig> {
  view: ViewDescriptor<TConfig>;
  /** As propriedades da database, na ordem que a view mostra. O registro de view não decide colunas, só como desenhar sobre elas. */
  properties: readonly PropertyDescriptor[];
}

export interface ViewConfigFormContext<TConfig> {
  view: ViewDescriptor<TConfig>;
  commit(next: TConfig): void;
}

export interface ViewSpec<TConfig = unknown> {
  /** `database_views.view_type`. Único entre todos os construtores. */
  type: string;
  label: string;
  icon: string;
  defaultConfig: TConfig;
  /** Desenha o CORPO inteiro da view (a grade, as colunas do Board, ...) — ao contrário de `PropertySpec.renderValue`, que é só uma célula. */
  render(ctx: ViewRenderContext<TConfig>): ReactNode;
  renderConfigForm?(ctx: ViewConfigFormContext<TConfig>): ReactNode;
}

/** Erasure no limite do registro — mesma razão de `propertySpecs` em `property-spec.ts`. */
const viewSpecs = new Map<string, ViewSpec>();

/** Declare um tipo de view. Re-registrar o mesmo `type` substitui o spec anterior (hot reload é inofensivo). */
export function registerViewSpec<TConfig>(spec: ViewSpec<TConfig>): void {
  viewSpecs.set(spec.type, spec as ViewSpec);
}

/** Todo spec registrado, em ordem de registro. */
export function collectViewSpecs(): ViewSpec[] {
  return [...viewSpecs.values()];
}

/** O spec dono de um `view_type` persistido, ou `undefined` quando nada o reivindica. */
export function specForViewType(type: string): ViewSpec | undefined {
  return viewSpecs.get(type);
}

/** Test-only: apaga todo registro. Nunca chame de código de produção. */
export function resetViewSpecRegistryForTests(): void {
  viewSpecs.clear();
}
