/**
 * Estado de seleção múltipla de blocos (EDT-053/054): uma `NodeSelection` do
 * ProseMirror só cobre UM nó por vez, então vários blocos irmãos destacados
 * juntos não cabem na seleção nativa - precisam de estado próprio, guardado
 * num plugin (não em `Selection`), com decorações pintando cada `Block`
 * wrapper selecionado.
 *
 * API pública deste módulo, para outro código (mouse, teclado, clipboard -
 * todos aqui mesmo - e, em tese, qualquer outro builder) consultar ou mudar
 * a seleção sem conhecer o plugin por baixo:
 *   - `getSelectedBlockIds(editor)` - os ids selecionados, em ordem de documento.
 *   - `isBlockSelected(editor, id)`
 *   - `setSelectedBlockIds(editor, ids)` - substitui a seleção inteira.
 *   - `clearBlockSelection(editor)`
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NODE_NAMES } from "../../core/node-names";

export interface BlockSelectionState {
  /** Ids selecionados, em ordem de documento. Vazio = nenhuma seleção múltipla ativa. */
  ids: readonly string[];
}

export const EMPTY_BLOCK_SELECTION: BlockSelectionState = { ids: [] };

export const blockSelectionPluginKey = new PluginKey<BlockSelectionState>("learno-block-selection");

/** Classe aplicada a cada `.ed-block-wrapper` cujo id está selecionado - ver `selection.css`. */
const SELECTED_CLASS = "ed-block-wrapper--selected";

function decorationsFor(doc: PMNode, ids: readonly string[]): DecorationSet {
  if (ids.length === 0) return DecorationSet.empty;
  const idSet = new Set(ids);
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== NODE_NAMES.block) return true;
    const blockId = node.firstChild?.attrs.id;
    if (typeof blockId === "string" && idSet.has(blockId)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: SELECTED_CLASS }));
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Guarda o conjunto selecionado via `Transaction.setMeta`, nunca em variável
 * de módulo - várias instâncias de editor (várias páginas) não
 * compartilhariam uma seleção por acidente, e o estado viaja com a
 * transação como o resto do doc.
 *
 * Qualquer transação que muda o doc ou a seleção de texto SEM passar essa
 * meta explicitamente invalida uma seleção múltipla que já existia -
 * digitar, clicar sem Shift, ou qualquer comando de outro builder limpa a
 * seleção de blocos automaticamente, sem cada um deles precisar saber que
 * ela existe.
 */
export const BlockSelectionStatePlugin = new Plugin<BlockSelectionState>({
  key: blockSelectionPluginKey,
  state: {
    init: () => EMPTY_BLOCK_SELECTION,
    apply(tr, previous) {
      // `Transaction.getMeta` devolve `any` na própria assinatura da lib
      // (prosemirror-state) - não um `unknown` que exigiria checar o
      // formato, então nenhum cast é necessário aqui: só quem chama
      // `setSelectedBlockIds`/`deleteSelectedBlocks`/etc. escreve essa meta,
      // sempre no formato certo.
      const meta = tr.getMeta(blockSelectionPluginKey);
      if (meta) return meta;
      if (tr.docChanged || tr.selectionSet) return EMPTY_BLOCK_SELECTION;
      return previous;
    },
  },
  props: {
    decorations(state) {
      return decorationsFor(state.doc, blockSelectionPluginKey.getState(state)?.ids ?? []);
    },
  },
});

export function getSelectedBlockIds(editor: Editor): readonly string[] {
  return blockSelectionPluginKey.getState(editor.state)?.ids ?? [];
}

export function isBlockSelected(editor: Editor, blockId: string): boolean {
  return getSelectedBlockIds(editor).includes(blockId);
}

export function setSelectedBlockIds(editor: Editor, ids: readonly string[]): void {
  const tr = editor.state.tr.setMeta(blockSelectionPluginKey, { ids } satisfies BlockSelectionState);
  editor.view.dispatch(tr);
}

export function clearBlockSelection(editor: Editor): void {
  if (getSelectedBlockIds(editor).length === 0) return;
  setSelectedBlockIds(editor, []);
}
