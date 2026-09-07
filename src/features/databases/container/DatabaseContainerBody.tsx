/**
 * Desenha o CORPO da database delegando ao registro de views (arquitetura
 * §6) — este componente nunca decide como uma Tabela ou um Board se
 * parecem, só escolhe qual view está ativa e entrega a ela exatamente
 * `{ view, properties, records, mutations }`, o `ViewRenderContext` que
 * `core/view-spec.ts` publica. Nenhum campo de bloqueio passa por aqui — DBS-002 bloqueia
 * estrutura no cabeçalho (`DatabaseContainerHeader`), nunca o corpo; como
 * `ViewRenderContext` nem tem um campo de bloqueio, é estruturalmente
 * impossível este componente vazar `isLocked` para dentro de uma célula.
 */
import { EmptyState } from "../../../components/EmptyState";
import type { RecordRow } from "../contract";
import { specForViewType, type ViewMutations } from "../core/view-spec";
import type { DatabaseSchema } from "./types";

interface DatabaseContainerBodyProps {
  schema: DatabaseSchema;
  records: readonly RecordRow[];
  mutations: ViewMutations | null;
  /** Ausente = a primeira view por posição — mesmo padrão de "primeira aba selecionada" de uma UI de abas comum. */
  activeViewId?: string;
}

export function DatabaseContainerBody({ schema, records, mutations, activeViewId }: DatabaseContainerBodyProps) {
  const view = (activeViewId ? schema.views.find((candidate) => candidate.id === activeViewId) : undefined) ?? schema.views[0];

  if (!view) {
    return <EmptyState title="Nenhuma view ainda" description="Esta database ainda não tem nenhuma view salva." />;
  }

  const spec = specForViewType(view.type);
  if (!spec) {
    return (
      <EmptyState
        title={`Tipo de view "${view.type}" desconhecido`}
        description={`A view "${view.name}" foi salva com um tipo que este app ainda não sabe desenhar.`}
      />
    );
  }

  return <>{spec.render({ view, properties: schema.properties, records, mutations })}</>;
}
