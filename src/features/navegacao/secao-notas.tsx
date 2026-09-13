import { EmptyState } from "../../components/EmptyState";
import { PageTree } from "../pages/PageTree";
import { PageWorkspace } from "../pages/PageWorkspace";
import { usePageTreeStore } from "../pages/store";

/**
 * A seção Notas — a árvore de páginas e o editor que já existiam, reenquadrados
 * no contrato de seção. Nada de `features/pages` mudou; o que mudou é onde
 * ele mora: antes era o app inteiro, agora é uma das sete abas.
 *
 * O `nav[aria-label="Páginas"]` com `data-slot="page-tree"` continua
 * existindo, com o mesmo nome, porque dez specs e2e esperam por ele na
 * abertura do app (`e2e/specs/*.e2e.mjs`). Trocar o rótulo é quebrar todos.
 */
export function PainelDeNotas() {
  return (
    <nav aria-label="Páginas" data-slot="page-tree" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
      <PageTree />
    </nav>
  );
}

export function ConteudoDeNotas() {
  const selectedPageId = usePageTreeStore((state) => state.selectedPageId);

  if (selectedPageId === null) {
    return (
      <EmptyState
        title="Bem-vindo ao Learno"
        description="Escolha ou crie uma página na barra lateral para começar a estudar."
      />
    );
  }
  return <PageWorkspace pageId={selectedPageId} />;
}
