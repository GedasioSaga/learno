/**
 * "/database": a única porta de entrada para inserir um bloco de database
 * numa página. Cria a linha em `databases` (hospedada na página atual), a
 * primeira view ("Tabela", `table`) e só então insere o átomo com o
 * `databaseId` real — nunca um bloco apontando para uma database que não
 * existe (a FK de `database_views` rejeitaria o primeiro uso).
 *
 * São duas escritas sem transação (database, depois view). Se a segunda
 * falhar, este arquivo COMPENSA: apaga a database recém-criada
 * (`delete_database`) para não deixar uma órfã sem view no banco, e o erro
 * vai para a tela pelo `insert-error-store` — nunca engolido. Se a própria
 * compensação falhar, o aviso diz que a database ficou para trás.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { AppError, createDatabase, createView, deleteDatabase } from "../../../../lib/ipc";
import { usePageTreeStore } from "../../../pages/store";
import { insertBlockHere } from "../../core/commands";
import { useDatabaseInsertErrorStore } from "./insert-error-store";
import { NODE_NAME } from "./node";

export const DEFAULT_DATABASE_NAME = "Nova database";
export const DEFAULT_TABLE_VIEW_NAME = "Tabela";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

export async function createDatabaseAndInsert(editor: TiptapEditor): Promise<boolean> {
  const currentPageId = usePageTreeStore.getState().selectedPageId;
  if (!currentPageId) return false;
  const report = useDatabaseInsertErrorStore.getState().report;

  let databaseId: string;
  try {
    databaseId = (await createDatabase(currentPageId, DEFAULT_DATABASE_NAME)).id;
  } catch (error) {
    report(`Não foi possível criar a database: ${messageFor(error, "erro desconhecido")}.`);
    return false;
  }

  try {
    await createView(databaseId, DEFAULT_TABLE_VIEW_NAME, "table");
  } catch (error) {
    const reason = messageFor(error, "erro desconhecido");
    try {
      await deleteDatabase(databaseId);
      report(`Não foi possível criar a view Tabela (${reason}). A database foi desfeita; tente de novo.`);
    } catch {
      report(`Não foi possível criar a view Tabela (${reason}), e a database "${DEFAULT_DATABASE_NAME}" ficou no banco sem view.`);
    }
    return false;
  }

  if (editor.isDestroyed) return false;
  return insertBlockHere(editor, NODE_NAME, { databaseId });
}
