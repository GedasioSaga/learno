/**
 * DBS-001: NodeView do bloco "database inline" — envolve o `DatabaseContainer`
 * compartilhado (`src/features/databases/container`) em `mode="inline"`.
 *
 * DIVERGÊNCIA registrada no relatório desta peça (S2): nenhuma peça
 * publicou ainda como resolver um `databaseId` num schema de verdade — nem
 * `get_database_schema` está implementado do lado Rust (`src-tauri/src/ipc`
 * não o expõe nesta rodada, e nenhum arquivo define a forma de
 * `DatabaseSchemaRow`). Até essa fonte existir, este NodeView sempre
 * devolve `status: "error"` explicando isso — "TOTAL, nunca lança" também
 * vale pra UI: um bloco não pode derrubar o editor por falta de dado, e
 * fingir "carregado" seria pior que admitir o estado. Quando a fonte real
 * existir, troque só a construção de `state` abaixo.
 */
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { DatabaseContainer } from "../../../databases/container";
import type { DatabaseContainerState } from "../../../databases/container";
import { NODE_NAME } from "./node";

export function DatabaseBlockView({ node, ref }: ReactNodeViewProps<HTMLDivElement>) {
  const databaseId = typeof node.attrs.databaseId === "string" ? node.attrs.databaseId : null;

  const state: DatabaseContainerState = {
    status: "error",
    message:
      databaseId === null
        ? "Este bloco de database ainda não foi vinculado a uma database."
        : "Esta database ainda não pode ser carregada: o comando que lê seu esquema não existe nesta rodada da Fase 3.",
  };

  return (
    <NodeViewWrapper
      ref={ref}
      className="ed-block ed-database-inline"
      data-block-type={NODE_NAME}
      data-block-id={typeof node.attrs.id === "string" ? node.attrs.id : undefined}
      contentEditable={false}
    >
      <DatabaseContainer state={state} mode="inline" />
    </NodeViewWrapper>
  );
}
