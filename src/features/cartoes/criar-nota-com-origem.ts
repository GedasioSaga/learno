/**
 * `create_note` (`src-tauri/src/ipc/deck_commands.rs`) já aceita
 * `sourceBlockId`/`sourceTextFrozen` — a Fase 1 desta peça ligou os dois
 * campos até `NoteRepository::create_with_source` (INT-003/INT-009). O que
 * falta é só o transporte: `createNote` em `src/lib/ipc.ts` ainda manda os
 * quatro argumentos antigos, e essa peça é o TRANSPORTE compartilhado, fora
 * da pasta que esta rodada está autorizada a editar — mudar a assinatura de
 * `createNote` ali é para relatar, não para fazer sozinho (ver o pedido).
 *
 * Mesma situação, e mesma solução, de `src/features/pages/backlinks/ipc.ts`:
 * um wrapper fino aqui, direto no `invoke`, até alguém portar os dois campos
 * novos para `createNote` em `src/lib/ipc.ts`. `NoteRow`/`NoteFieldValues`
 * continuam vindo de lá — só a função que assina a chamada é local.
 */
import { invoke } from "@tauri-apps/api/core";
import { AppError, type AppErrorPayload, type NoteFieldValues, type NoteRow } from "../../lib/ipc";

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

/**
 * `createNote` de `src/lib/ipc.ts` mais os dois campos de origem
 * (INT-003/INT-009). `sourceBlockId`/`sourceTextFrozen` nulos reproduzem
 * exatamente o comportamento antigo — uma nota comum, sem procedência.
 */
export function criarNotaComOrigem(
  deckId: string,
  noteTypeId: string,
  fieldValues: NoteFieldValues,
  tags: string[],
  sourceBlockId: string | null,
  sourceTextFrozen: string | null,
): Promise<NoteRow> {
  return call<NoteRow>("create_note", { deckId, noteTypeId, fieldValues, tags, sourceBlockId, sourceTextFrozen });
}
