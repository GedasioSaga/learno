/**
 * EDT-053 (arrasto na margem) e EDT-054 (Shift+clique) - os dois gestos de
 * mouse que escrevem em `selection-state.ts`. Não testado por unidade de
 * propósito: os dois dependem de `getBoundingClientRect()`/hit-testing reais
 * (jsdom, o ambiente do vitest deste projeto, não faz layout de verdade -
 * mesmo raciocínio de `e2e/specs/page-tree-drag-and-drop.e2e.mjs`), e o
 * checklist já marca ambos como `e2e-webdriverio` (`docs/CHECKLIST.md`) -
 * ver `e2e/specs/block-selection.e2e.mjs`. `resolveSelectionRangeIds`
 * (`selection-commands.ts`), a lógica de "quais blocos entram no range" -
 * ancora, alvo atual e a árvore, ids em ordem de documento -, É pura e tem
 * teste próprio, aninhamento cruzado e gesto invertido inclusos.
 *
 * Convivência com outros builders na mesma faixa esquerda do bloco: a alça
 * de arrastar (`interaction/drag`, EDT-050/051, classe `.ed-drag-handle`) e
 * o gatilho de "turn into" (`interaction/turn-into`, classe
 * `.ed-block-handle__trigger`) já ocupam esse espaço com seus próprios
 * `<button>`. Este módulo nunca intercepta um mousedown que aterrissa num
 * controle interativo real (`button`, `a`, `[role="button"]`,
 * `[draggable="true"]`) - devolve `false` e deixa o clique original
 * acontecer, do jeito que o README pede pra `handlePaste` ("o primeiro que
 * devolve `true` vence"), aplicado aqui a mousedown. "Margem" é só o espaço
 * genuinamente vazio à esquerda da própria caixa do `Block` wrapper
 * (`event.clientX` menor que o `left` do wrapper) - nunca uma largura em
 * pixels fixa que pudesse encostar no botão de outro builder.
 *
 * Esse espaço não existia sozinho, e por isso o gesto de EDT-053 era código
 * morto: medido no WebView2, `.ed-root` começava no MESMO x do primeiro
 * wrapper, e a faixa vazia à esquerda era o padding do container rolável de
 * `Editor.tsx` - fora do editor, onde nenhum mousedown chega ao ProseMirror.
 * "À esquerda do wrapper" e "dentro do editor" eram condições que nunca
 * valiam juntas. `selection.css` estica `.ed-root` para dentro dessa faixa
 * (sem mover a coluna de texto um pixel) e é isso que dá ao gesto um lugar
 * onde acontecer; `wrapperAtVerticalPosition` é quem diz a que bloco um
 * ponto dessa calha pertence.
 */
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { resolveSelectionRangeIds } from "./selection-commands";
import { currentBlockNode } from "../../core/commands";
import { getSelectedBlockIds, setSelectedBlockIds } from "./selection-state";

const INTERACTIVE_SELECTOR = 'button, a, [role="button"], [draggable="true"]';

function blockWrapperOf(target: Element): Element | null {
  return target.closest(".ed-block-wrapper");
}

/**
 * O wrapper cuja faixa vertical contém `clientY` - para um ponteiro que está
 * na calha à esquerda dos blocos (`selection.css`), onde não existe wrapper
 * nenhum sob o cursor e portanto `blockWrapperOf` devolve `null`.
 *
 * Devolve `null` quando `clientY` não cai em bloco nenhum (o espaço vazio
 * abaixo do último bloco, por exemplo) - é isso que deixa um clique ali
 * seguir para o ProseMirror e posicionar o cursor no fim do documento, em vez
 * de virar seleção.
 *
 * Blocos aninhados: a faixa de um pai contém a dos filhos, e a ordem de
 * documento de `querySelectorAll` faz o PAI vencer. É o que a calha deve
 * fazer - arrastar na margem seleciona o bloco de topo com tudo dentro, não
 * um filho isolado.
 */
function wrapperAtVerticalPosition(view: EditorView, clientY: number): Element | null {
  for (const wrapper of view.dom.querySelectorAll(".ed-block-wrapper")) {
    const rect = wrapper.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return wrapper;
  }
  return null;
}

/**
 * O id do bloco que este wrapper representa - lido do seu próprio filho de
 * conteúdo (`data-block-id`, de `core/schema.ts`'s `idAttribute`), nunca de
 * um descendente aninhado mais fundo.
 *
 * `:scope > [data-block-id]`, não `firstElementChild`: `interaction/drag`
 * insere a alça de arrastar como uma `Decoration.widget` em `pos + 1`, o que
 * a torna o PRIMEIRO filho de `.ed-block-wrapper` no DOM (o próprio
 * `drag-extension.ts` documenta isso, e é o que `drag.css` depende). Com
 * `firstElementChild` esta função devolvia a alça - um `<button>` sem
 * `data-block-id` -, então `null`, então TODO mousedown daqui saía por
 * `if (!id) return false`: EDT-053 e EDT-054 nunca selecionavam nada com os
 * dois builders montados juntos, embora cada um passasse no seu próprio
 * teste. `drag-extension.ts` usa exatamente este seletor pelo mesmo motivo.
 */
function ownBlockId(wrapperEl: Element): string | null {
  const id = wrapperEl.querySelector(":scope > [data-block-id]")?.getAttribute("data-block-id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function currentCursorBlockId(editor: Editor): string | null {
  const id = currentBlockNode(editor)?.attrs.id;
  return typeof id === "string" ? id : null;
}

export interface SelectionMouseHandlers {
  mousedown(view: EditorView, event: MouseEvent): boolean;
  /** Chamado quando a extensão é destruída - solta os listeners de `window` de um arrasto em andamento, se houver. */
  destroy(): void;
}

export function createSelectionMouseHandlers(editor: Editor): SelectionMouseHandlers {
  let dragAnchorId: string | null = null;

  function onDragMove(event: MouseEvent) {
    if (!dragAnchorId) return;
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    // Durante um arrasto de margem o ponteiro segue DENTRO da calha, onde o
    // hit-test devolve `.ed-root` e não um wrapper - por isso o mesmo
    // fallback por faixa vertical do `mousedown`. Sem ele o arrasto marcava
    // só o bloco de partida e ignorava o resto do caminho.
    const wrapperEl =
      (hovered instanceof Element ? blockWrapperOf(hovered) : null) ??
      wrapperAtVerticalPosition(editor.view, event.clientY);
    const hoveredId = wrapperEl ? ownBlockId(wrapperEl) : null;
    if (!hoveredId) return;
    const range = resolveSelectionRangeIds(editor.state.doc, dragAnchorId, hoveredId);
    if (range) setSelectedBlockIds(editor, range);
  }

  function stopDragging() {
    dragAnchorId = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", stopDragging);
  }

  return {
    mousedown(view, event) {
      if (event.button !== 0) return false; // só o botão principal inicia seleção
      const target = event.target;
      if (!(target instanceof Element)) return false;
      if (target.closest(INTERACTIVE_SELECTOR)) return false; // nunca rouba o clique de um botão de outro builder

      // Dentro de um bloco, o wrapper vem do próprio alvo; na calha à
      // esquerda (EDT-053) não há wrapper sob o cursor, e ele vem da faixa
      // vertical. A checagem de `clientX` mais abaixo é que decide qual dos
      // dois casos é este - um clique dentro da caixa continua devolvendo
      // `false` e virando cursor normal.
      const wrapperEl = blockWrapperOf(target) ?? wrapperAtVerticalPosition(view, event.clientY);
      if (!wrapperEl) return false;
      const id = ownBlockId(wrapperEl);
      if (!id) return false;

      if (event.shiftKey) {
        // EDT-054: estende a partir do bloco 1 já selecionado, ou do bloco
        // do cursor quando ainda não havia seleção múltipla nenhuma.
        const anchor = getSelectedBlockIds(editor)[0] ?? currentCursorBlockId(editor);
        if (!anchor) return false;
        const range = resolveSelectionRangeIds(editor.state.doc, anchor, id);
        if (!range) return false;
        event.preventDefault();
        setSelectedBlockIds(editor, range);
        return true;
      }

      const rect = wrapperEl.getBoundingClientRect();
      if (event.clientX >= rect.left) return false; // dentro da caixa do bloco - deixa o clique posicionar o cursor normalmente

      event.preventDefault();
      dragAnchorId = id;
      setSelectedBlockIds(editor, [id]);
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", stopDragging);
      return true;
    },
    destroy: stopDragging,
  };
}
