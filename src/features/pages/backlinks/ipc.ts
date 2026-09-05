/**
 * FUN-044/FUN-045: wrapper fino para `list_backlinks`/`list_outgoing_links`
 * (`src-tauri/src/ipc/block_commands.rs`) — os dois comandos existem no
 * backend, mas `src/lib/ipc.ts` ainda não os espelha. Esse arquivo é
 * compartilhado entre os 21 construtores desta rodada e está fora da pasta
 * que esta peça (pages-backlinks) está autorizada a editar, então o wrapper
 * mora aqui por enquanto — ver `core_gaps` no relatório desta rodada sobre
 * migrá-lo para lá depois.
 *
 * Os campos já chegam em camelCase: `BacklinkRow`/`OutgoingLinkRow`
 * (`src-tauri/src/db/backlinks.rs`) usam `#[serde(rename_all = "camelCase")]`,
 * diferente de `PageRow` em `src/lib/ipc.ts` (sem `rename_all`, por isso fica
 * em snake_case) — não há tradução de forma nenhuma a fazer aqui.
 */
import { invoke } from "@tauri-apps/api/core";
import { AppError, type AppErrorPayload } from "../../../lib/ipc";

function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  // Seguro: já checamos acima que é um objeto não-nulo; isto só amplia o tipo
  // pra poder sondar `kind`/`message` sem afirmar que eles existem.
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/** Mesma forma de `call()` em `src/lib/ipc.ts` — duplicada, não importada, porque essa função não é exportada de lá. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (isAppErrorPayload(error)) throw new AppError(error);
    throw error;
  }
}

/** Espelha `db::backlinks::BacklinkRow`. */
export interface BacklinkRow {
  sourceBlockId: string;
  sourcePageId: string;
  sourcePageTitle: string;
  /** Trecho do bloco de origem, já cortado no servidor (ver `SNIPPET_MAX_CHARS` em `db::backlinks`). */
  sourceSnippet: string;
  targetPageId: string;
}

/** Espelha `db::backlinks::OutgoingLinkRow` — a direção inversa, não usada pelo rodapé de FUN-044, mas parte do mesmo par de comandos. */
export interface OutgoingLinkRow {
  sourceBlockId: string;
  targetPageId: string;
  targetPageTitle: string;
}

/** FUN-044: todo bloco, em qualquer página ativa, que menciona ou linka `pageId`. */
export function listBacklinks(pageId: string): Promise<BacklinkRow[]> {
  return call<BacklinkRow[]>("list_backlinks", { pageId });
}

/** O que `pageId` linka — espelhado por completude do wrapper, não consumido pelo rodapé de backlinks. */
export function listOutgoingLinks(pageId: string): Promise<OutgoingLinkRow[]> {
  return call<OutgoingLinkRow[]>("list_outgoing_links", { pageId });
}
