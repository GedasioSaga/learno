/**
 * A ponte entre a linha crua de `database_views` (`../contract.ts`'s
 * `DatabaseView`, com `config: Record<string, unknown>`) e o `ViewConfig`
 * tipado que o resto desta pasta manipula. Nenhuma função aqui fala com o
 * Postgres — persistir a `DatabaseView` devolvida é trabalho de quem tem o
 * comando Tauri (fora desta pasta exclusiva; ver `divergencias_da_arquitetura`
 * no relatório desta peça). O que garante DBS-053 NESTA camada é
 * `withViewConfig` nunca mutar `view`: cada view chega e sai como um objeto
 * próprio, então duas views não podem compartilhar, por referência, o mesmo
 * `config`.
 */
import type { DatabaseView } from "../contract";
import { parseViewConfig, serializeViewConfig } from "./codec";
import type { ViewConfig } from "./contract";

export function readViewConfig(view: Pick<DatabaseView, "config">): ViewConfig {
  return parseViewConfig(view.config);
}

/** `view` com o config substituído por `next` — devolve um objeto NOVO, nunca muta `view`. */
export function withViewConfig(view: DatabaseView, next: ViewConfig): DatabaseView {
  return { ...view, config: serializeViewConfig(next) };
}

/** Lê, aplica `updater` sobre o `ViewConfig` tipado, devolve a `DatabaseView` já com o blob serializado de volta — o padrão que cada painel da barra de ferramentas segue para commitar uma mudança. */
export function updateViewConfig(view: DatabaseView, updater: (config: ViewConfig) => ViewConfig): DatabaseView {
  return withViewConfig(view, updater(readViewConfig(view)));
}
