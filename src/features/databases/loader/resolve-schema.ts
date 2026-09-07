/**
 * A tradução PURA entre o que o IPC devolve (`src/lib/ipc.ts`: `DatabaseRow`,
 * `DatabasePropertyRow`, `DatabaseViewRow`, `DatabaseRecord`) e o que os
 * registros de `core/` consomem (`PropertyDescriptor`, `ViewDescriptor`,
 * `RecordRow`). Separado de `use-database.ts` para ser testável sem mock de
 * `invoke` — mesma separação I/O-fora-da-lógica de `container/types.ts`.
 *
 * Não existe `get_database_schema` no Rust, e não precisa: o schema é
 * `get_database` + `list_properties` + `list_views`, três comandos que já
 * estavam registrados sem nenhuma tela chamá-los.
 */
import type { DatabasePropertyRow, DatabaseRecord, DatabaseRow, DatabaseViewRow } from "../../../lib/ipc";
import type { Database, RecordRow } from "../contract";
import type { DatabaseSchema } from "../container/types";
import type { PropertyDescriptor } from "../core/property-spec";
import type { ViewDescriptor } from "../core/view-spec";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `config` chega como `unknown` do fio; o contrato promete um objeto. Um blob corrompido vira `{}` — uma linha ruim não derruba a view. */
function asConfig(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

export function toDatabase(row: DatabaseRow): Database {
  return {
    id: row.id,
    containerPageId: row.containerPageId,
    name: row.name,
    isLocked: row.isLocked,
    config: asConfig(row.config),
    dataVersion: row.dataVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPropertyDescriptor(row: DatabasePropertyRow): PropertyDescriptor {
  return {
    id: row.id,
    databaseId: row.databaseId,
    name: row.name,
    type: row.propertyType,
    config: asConfig(row.config),
    position: row.position,
  };
}

export function toViewDescriptor(row: DatabaseViewRow): ViewDescriptor {
  return {
    id: row.id,
    databaseId: row.databaseId,
    name: row.name,
    type: row.viewType,
    config: asConfig(row.config),
    position: row.position,
  };
}

/**
 * `DatabaseRecord { page, values: [] }` -> `RecordRow`. Os valores viram um
 * mapa por `propertyId`; uma propriedade sem linha simplesmente NÃO entra no
 * mapa (I1: ausência é o vazio — nunca `null` explícito aqui).
 *
 * `parentId` é o sub-item (DBS-118), que nenhum comando expõe ainda —
 * `page.parent_id` é o pai na ÁRVORE de páginas, outra coisa. Fica `null`.
 * `matchedColorRuleIds` é avaliado pelo pipeline de consulta (§8), que não
 * existe: vazio.
 */
export function toRecordRow(record: DatabaseRecord): RecordRow {
  const values: RecordRow["values"] = {};
  // Uma linha com `value` literalmente `null` não deveria existir (o CHECK
  // de 0017 proíbe), mas dado gravado fora do caminho Rust ou corrompido
  // pode chegar assim. Tratar como AUSENTE espelha a escrita otimista de
  // `use-database.ts`, que remove a chave em `null` — as duas pontas
  // precisam concordar sobre o que "vazio" é.
  for (const value of record.values) if (value.value !== null) values[value.propertyId] = value.value;
  return {
    id: record.page.id,
    title: record.page.title,
    icon: record.page.icon,
    parentId: null,
    position: record.page.position,
    createdAt: record.page.created_at,
    updatedAt: record.page.updated_at,
    values,
    matchedColorRuleIds: [],
  };
}

/** Ordem fracionária (`position`) é texto comparável — a mesma técnica de `Block.position`. */
function byPosition<T extends { position: string }>(a: T, b: T): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

export function resolveSchema(database: DatabaseRow, properties: DatabasePropertyRow[], views: DatabaseViewRow[]): DatabaseSchema {
  return {
    database: toDatabase(database),
    properties: properties.map(toPropertyDescriptor).sort(byPosition),
    views: views.map(toViewDescriptor).sort(byPosition),
  };
}

export function resolveRecords(records: DatabaseRecord[]): RecordRow[] {
  return records.map(toRecordRow).sort(byPosition);
}
