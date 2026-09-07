/**
 * DBS-001: NodeView do bloco "database inline" — envolve o `DatabaseContainer`
 * compartilhado (`src/features/databases/container`) em `mode="inline"`.
 *
 * A fonte real: `useDatabase` (`src/features/databases/loader`), que compõe
 * `get_database` + `list_properties` + `list_views` + `list_records` e
 * devolve o estado de três fases que o contêiner já esperava. Este arquivo
 * é a costura — não desenha nada por conta própria.
 *
 * `errorMessage` é erro de ESCRITA (célula que não salvou, registro que não
 * nasceu): aparece abaixo da database, sem derrubar a tabela, porque o
 * carregador já recarregou a verdade do banco antes de avisar.
 */
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { DatabaseContainer } from "../../../databases/container";
import type { DatabaseContainerActions } from "../../../databases/container";
import { useDatabase } from "../../../databases/loader/use-database";
import { NODE_NAME } from "./node";

export function DatabaseBlockView({ node, ref }: ReactNodeViewProps<HTMLDivElement>) {
  const databaseId = typeof node.attrs.databaseId === "string" ? node.attrs.databaseId : null;
  const { state, mutations, errorMessage, addProperty } = useDatabase(databaseId);

  const actions: DatabaseContainerActions = mutations
    ? {
        onCreateRecord: () => void mutations.createRecord(),
        // Devolve a promessa: o diálogo de configuração (Fórmula) espera o
        // resultado antes de fechar. Um tipo sem diálogo ignora o retorno.
        onAddProperty: (type, name, config) => addProperty(type, name, config),
      }
    : {};

  return (
    <NodeViewWrapper
      ref={ref}
      className="ed-block ed-database-inline"
      data-block-type={NODE_NAME}
      data-block-id={typeof node.attrs.id === "string" ? node.attrs.id : undefined}
      contentEditable={false}
    >
      <DatabaseContainer state={state} mode="inline" actions={actions} mutations={mutations} />
      {errorMessage ? (
        <p role="alert" className="px-2 py-1 text-xs text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
    </NodeViewWrapper>
  );
}
