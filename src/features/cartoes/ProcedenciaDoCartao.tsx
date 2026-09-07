import type { NoteRow } from "../../lib/ipc";
import { useNavegacaoStore } from "../navegacao/store";
import { usePageTreeStore } from "../pages/store";
import { displayTitle } from "../pages/tree-utils";
import { paginaDoBloco } from "./origem-do-cartao";

interface ProcedenciaDoCartaoProps {
  note: Pick<NoteRow, "sourceBlockId" | "sourceTextFrozen">;
}

/**
 * "de: <página>" no rodapé da Sessão de Estudo — o que fecha o circuito da
 * integração (item 3 do briefing desta peça): o cartão deixa de ser uma
 * ilha, e mostra de onde veio.
 *
 * Três casos, na ordem em que este componente os resolve:
 *
 * 1. `sourceBlockId` presente E `origem-do-cartao.ts` já viu, nesta
 *    instalação, de que página esse bloco é (gravado no instante em que o
 *    cartão nasceu — ver `CriarCartaoDeOrigem`) → clicável, navega até lá.
 * 2. `sourceBlockId` presente mas SEM página conhecida (o cartão veio de
 *    outra instalação, ou nasceu antes desta peça existir) → cai para o
 *    caso 3 em vez de inventar um link.
 * 3. Só `sourceTextFrozen` (o bloco foi apagado — INT-009 zera
 *    `sourceBlockId` e preserva o texto — ou a origem nunca teve bloco, como
 *    um nó de mapa mental) → só texto, nunca um link para lugar nenhum.
 *
 * Sem nenhum dos dois campos (nota comum, sem origem): não renderiza nada.
 */
export function ProcedenciaDoCartao({ note }: ProcedenciaDoCartaoProps) {
  const pageId = note.sourceBlockId ? paginaDoBloco(note.sourceBlockId) : null;
  const pagina = usePageTreeStore((state) => (pageId ? state.pagesById.get(pageId) : undefined));

  if (pageId && pagina) {
    return (
      <button
        type="button"
        onClick={() => {
          useNavegacaoStore.getState().irPara("notas");
          usePageTreeStore.getState().selectPage(pageId);
        }}
        className="text-xs text-ink-muted underline decoration-dotted underline-offset-2 transition-colors duration-150 ease-out hover:text-ink"
      >
        de: {displayTitle(pagina)}
      </button>
    );
  }

  if (note.sourceTextFrozen) {
    return <p className="text-xs text-ink-muted">de: “{note.sourceTextFrozen}”</p>;
  }

  return null;
}
