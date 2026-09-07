/**
 * O registro de tipos de view — mesmo padrão de `property-spec.ts` (que por
 * sua vez segue `core/block-spec.ts` da Fase 2), para `table`/`board`/`list`/
 * `calendar`. Você cria `src/features/databases/views/<seu-tipo>/register.ts`,
 * chama `registerViewSpec()`, e não importa esse arquivo de lugar nenhum —
 * `discover-extensions.ts` o carrega por `import.meta.glob`.
 *
 * `ViewRenderContext` nasceu mínimo (só a view e as propriedades — N1) e foi
 * estendido AQUI, não em cada `views/<tipo>/register.ts`, quando a primeira
 * view de verdade (Tabela) precisou de dados: `records` são os registros
 * já resolvidos para `RecordRow` (arquitetura §8) e `mutations` é o que a
 * view pode ESCREVER. Os dados ainda não vêm do pipeline de consulta
 * (`open_view_query`/`fetch_view_window`, §8, que continua sem existir):
 * vêm de `list_records` inteiro, carregado por `src/features/databases/
 * loader/`. Quando o pipeline existir, é este contexto que muda — as views
 * continuam recebendo `records`.
 */
import type { ReactNode } from "react";
import type { DatabaseId, PropertyId, PropertyValue, RecordId, RecordRow, ViewId } from "../contract";
import type { PropertyDescriptor } from "./property-spec";

/** Uma escrita de célula pedida por uma view. `value: null` = limpar (I1: o Rust apaga a linha). */
export interface RecordValueChange {
  recordId: RecordId;
  propertyId: PropertyId;
  value: PropertyValue | null;
}

/**
 * O que uma view pode mudar. Cada método é o caminho ÚNICO para aquela
 * escrita: `applyValueChanges` desemboca em `apply_record_value_changes`
 * (I4, o único caminho autorizado a tocar `database_record_values`);
 * `renameRecord` muda `pages.title` (o título do registro é a própria
 * página, 0007); `createRecord` cria a página-registro. Ausente do contexto
 * (`mutations: null`) => a view é somente-leitura e NÃO oferece controle
 * de edição nenhum — controle que não faz nada é defeito, não rascunho.
 */
export interface ViewMutations {
  applyValueChanges(changes: readonly RecordValueChange[]): Promise<void>;
  renameRecord(recordId: RecordId, title: string): Promise<void>;
  /** Devolve o id do registro novo, para a view levar o foco até ele. */
  createRecord(): Promise<RecordId>;
}

/** O que uma ação de ESTRUTURA devolve: em erro, a mensagem do backend, para a tela que pediu decidir o que mostrar. */
export type PropertyActionResult = { ok: true } | { ok: false; message: string };

/**
 * O que uma view pode mudar na ESTRUTURA da database — o menu do cabeçalho
 * de coluna (renomear, mudar o tipo, editar a configuração, mover, apagar).
 * Separado de `ViewMutations` porque a régua é outra: `mutations` escreve
 * VALOR e nunca é bloqueada por `isLocked` (DBS-002); isto muda o schema e
 * chega `null` quando a database está bloqueada, e aí a view não oferece
 * menu nenhum — controle que não faz nada é defeito, não rascunho.
 *
 * `editConfig` é a única entrada que não escreve: pede a quem montou a view
 * para abrir o formulário de configuração do tipo (`renderConfigForm`) com
 * o valor atual — o mesmo diálogo da criação, agora com um id de verdade.
 * A view só o oferece para tipos que TÊM formulário.
 */
export interface PropertyActions {
  rename(propertyId: PropertyId, name: string): Promise<PropertyActionResult>;
  changeType(propertyId: PropertyId, newType: string): Promise<PropertyActionResult>;
  /** `afterPropertyId` nulo põe a propriedade em primeiro. */
  reorder(propertyId: PropertyId, afterPropertyId: PropertyId | null): Promise<PropertyActionResult>;
  delete(propertyId: PropertyId): Promise<PropertyActionResult>;
  editConfig(property: PropertyDescriptor): void;
}

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
  /** Todos os registros da database, já como `RecordRow` (propriedade ausente de `values` == vazia, I1). */
  records: readonly RecordRow[];
  /** `null` = somente-leitura (ver `ViewMutations`). */
  mutations: ViewMutations | null;
  /** `null` = estrutura intocável (database bloqueada, ou ninguém ligou as ações) — sem menu de coluna. */
  propertyActions: PropertyActions | null;
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
