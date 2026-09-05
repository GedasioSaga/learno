/**
 * A camada 2 de EDT-050/EDT-051/EDT-033: traduz o gesto de mouse (alça
 * arrastável à direita de cada bloco - ver `drag.css`) em chamadas de
 * `node-move.ts`/`drop-zone.ts`/`../../blocks/columns/column-commands.ts` -
 * a árvore em si não muda nada aqui, só decide QUAL primitiva chamar e com
 * QUAIS ids, a partir da zona que `dropZoneFor` resolve: reordenar
 * (`reorderBlock`), aninhar (`nestBlockUnderSibling`) ou colunas lado a
 * lado (`wrapBlocksInColumns`). Não coberto por teste de unidade de
 * propósito: depende de `dragstart`/`dragover`/`drop` reais e de
 * `getBoundingClientRect()`, que só existem com layout de verdade (ver
 * `e2e/specs/drag-blocks.e2e.mjs`).
 *
 * A alça é uma `Decoration.widget` (não um NodeView) porque um NodeView
 * pertenceria ao nó `Block` do core (`core/schema.ts`) - fora do alcance
 * desta pasta. Colocada em `pos + 1` (o primeiro instante dentro do
 * wrapper, antes do seu próprio `blockContent`), ela nasce como o primeiro
 * filho de `.ed-block-wrapper` no DOM - por isso `drag.css` só precisa de
 * `position: absolute` nela e `position: relative` no wrapper.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import "./drag.css";
import { moveBlockAmongSiblings } from "./keyboard-move";
import { NODE_NAMES } from "../../core/node-names";
import { wrapBlocksInColumns } from "../../blocks/columns/column-commands";
import { dropZoneFor } from "./drop-zone";
import { nestBlockUnderSibling, reorderBlock } from "./node-move";

/** MIME próprio do editor pro payload nativo de `DataTransfer` - só usado por `dragstart` (dragover/drop dependem do estado do plugin, não deste valor, porque a maioria dos navegadores não deixa ler `dataTransfer` fora de `dragstart`/`drop`). */
const DRAG_DATA_FORMAT = "application/x-learno-block-id";

/** Estado do plugin: o id do bloco sendo arrastado, ou `null` fora de um drag. Guardado via `Transaction.setMeta`, não em variável de módulo - várias instâncias de editor (várias páginas) não compartilhariam um drag em andamento por acidente. */
const dragPluginKey = new PluginKey<string | null>("interactionDragHandle");

function closestBlockWrapper(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>(".ed-block-wrapper");
}

/** Id do bloco que este wrapper representa - lido do `data-block-id` do seu próprio filho de conteúdo (`core/schema.ts`'s `idAttribute`), nunca de um descendente aninhado mais fundo. */
function ownBlockId(wrapperEl: HTMLElement): string | null {
  return wrapperEl.querySelector<HTMLElement>(":scope > [data-block-id]")?.dataset.blockId ?? null;
}

function createHandle(blockId: string): HTMLElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "ed-drag-handle";
  handle.draggable = true;
  handle.contentEditable = "false";
  handle.setAttribute("role", "button");
  handle.setAttribute("aria-label", "Arrastar bloco");
  handle.dataset.dragHandleId = blockId;
  handle.dataset.testid = "block-drag-handle";
  handle.textContent = "⠿";
  return handle;
}

/** Uma alça por bloco (grupo `"block"`), em qualquer profundidade - inclui os aninhados sob `childBlocks`, que também podem ser arrastados. */
function handleDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== NODE_NAMES.block) return true;
    const id = node.firstChild?.attrs.id;
    if (typeof id === "string") {
      decorations.push(Decoration.widget(pos + 1, () => createHandle(id), { side: -1, key: `drag-handle:${id}` }));
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

export const BlockDragHandle = Extension.create({
  name: "interactionDragHandle",

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": () => moveBlockAmongSiblings(this.editor, "up"),
      "Mod-Shift-ArrowDown": () => moveBlockAmongSiblings(this.editor, "down"),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin<string | null>({
        key: dragPluginKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(dragPluginKey);
            return meta === undefined ? value : (meta as string | null);
          },
        },
        props: {
          decorations(state) {
            return handleDecorations(state.doc);
          },
          handleDOMEvents: {
            dragstart(view: EditorView, event: DragEvent) {
              const handle =
                event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".ed-drag-handle") : null;
              const id = handle?.dataset.dragHandleId;
              if (!handle || !id) return false;
              event.dataTransfer?.setData(DRAG_DATA_FORMAT, id);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              view.dispatch(view.state.tr.setMeta(dragPluginKey, id));
              return false;
            },
            dragover(view: EditorView, event: DragEvent) {
              if (!dragPluginKey.getState(view.state)) return false;
              if (!closestBlockWrapper(event.target)) return false;
              // Sem isto o navegador recusa o `drop` por padrão (é a mesma
              // regra de qualquer alvo HTML5 de drag-and-drop).
              event.preventDefault();
              return true;
            },
            drop(view: EditorView, event: DragEvent) {
              const sourceId = dragPluginKey.getState(view.state);
              if (!sourceId) return false;
              const wrapperEl = closestBlockWrapper(event.target);
              const targetId = wrapperEl ? ownBlockId(wrapperEl) : null;
              if (!wrapperEl || !targetId) return false;

              event.preventDefault();
              const zone = dropZoneFor(event.clientX, event.clientY, wrapperEl.getBoundingClientRect());
              if (zone.kind === "nest") {
                nestBlockUnderSibling(editor, sourceId, targetId);
              } else if (zone.kind === "columns") {
                // targetId = bloco já no lugar onde soltou (vira a coluna
                // esquerda); sourceId = bloco arrastado (vira a direita) -
                // mesma ordem que a assinatura de wrapBlocksInColumns exige.
                wrapBlocksInColumns(editor, targetId, sourceId);
              } else {
                reorderBlock(editor, sourceId, targetId, zone.edge);
              }
              view.dispatch(view.state.tr.setMeta(dragPluginKey, null));
              return true;
            },
            dragend(view: EditorView) {
              if (dragPluginKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(dragPluginKey, null));
              return false;
            },
          },
        },
      }),
    ];
  },
});
