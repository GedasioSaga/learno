/**
 * EDT-050/EDT-051: os movimentos de "arrastar bloco" como funções puras
 * sobre a árvore ProseMirror - reordenar entre irmãos e aninhar sob um
 * irmão. O plugin de mouse (`drag-extension.ts`) e o atalho de teclado
 * (`keyboard-move.ts`) só decidem QUAL função chamar com QUAIS ids; a
 * cirurgia na árvore mora aqui, testável sem simular um gesto de mouse
 * (`node-move.test.ts`).
 *
 * Reusa o raciocínio de `core/commands.ts` (handleTab/handleShiftTab): um
 * bloco é sempre o wrapper `Block` dois níveis acima do texto do cursor, e
 * removê-lo de um `childBlocks` do qual ele é o único filho não pode ser um
 * delete simples - ProseMirror rejeita `"block+"` ficando vazio a meio de
 * transação e preenche sozinho (o mesmo bug que o comentário de
 * `handleShiftTab` documenta), o que nunca é o que um drag deveria produzir.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NODE_NAMES } from "../../core/node-names";

interface WrapperLocation {
  /** Posição logo antes do wrapper `Block` - o próprio início dele, por fora. */
  pos: number;
  node: PMNode;
}

/** Acha o wrapper `Block` cujo filho de conteúdo carrega este id, em qualquer profundidade. */
function findWrapper(doc: PMNode, blockId: string): WrapperLocation | null {
  let found: WrapperLocation | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === NODE_NAMES.block && node.firstChild?.attrs.id === blockId) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/** Verdadeiro se `blockId` existe em algum nível dentro de `wrapper` - não conta o próprio wrapper. */
function containsBlock(wrapper: PMNode, blockId: string): boolean {
  let found = false;
  wrapper.descendants((node) => {
    if (found) return false;
    if (node.type.name === NODE_NAMES.block && node.firstChild?.attrs.id === blockId) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** O `childBlocks` de um wrapper, se ele tiver um (é sempre o segundo filho, quando existe). */
function childBlocksOf(wrapper: PMNode): PMNode | null {
  return wrapper.childCount === 2 ? wrapper.lastChild : null;
}

/**
 * Onde apagar o wrapper que começa em `pos`: o próprio intervalo dele, a
 * menos que ele seja o único filho de um `childBlocks` - nesse caso o
 * container inteiro sai junto, para nunca deixar `"block+"` vazio a meio de
 * transação (ver o comentário de `handleShiftTab` em `core/commands.ts`
 * sobre por que isso importa: o auto-preenchimento do ProseMirror para essa
 * situação nunca é o resultado certo para um drag).
 */
function removalRange(doc: PMNode, pos: number, node: PMNode): { from: number; to: number } {
  const $pos = doc.resolve(pos);
  if ($pos.parent.type.name === NODE_NAMES.childBlocks && $pos.parent.childCount === 1) {
    return { from: $pos.before($pos.depth), to: $pos.after($pos.depth) };
  }
  return { from: pos, to: pos + node.nodeSize };
}

export type ReorderEdge = "before" | "after";

/**
 * EDT-050: move o bloco `sourceId` (com todos os seus próprios filhos, se
 * tiver) para ser irmão de `targetId`, imediatamente antes ou depois dele -
 * no container em que `targetId` já vive, seja ele o mesmo de `sourceId` ou
 * não. Recusa sem tocar no documento (retorna `false`) em três casos:
 * mesmo id dos dois lados; `targetId` está dentro da própria subárvore de
 * `sourceId` (viraria ciclo); o bloco já está exatamente nessa posição
 * (no-op).
 */
export function reorderBlock(editor: Editor, sourceId: string, targetId: string, edge: ReorderEdge): boolean {
  if (sourceId === targetId) return false;
  const { state } = editor;
  const source = findWrapper(state.doc, sourceId);
  const target = findWrapper(state.doc, targetId);
  if (!source || !target) return false;
  if (containsBlock(source.node, targetId)) return false;

  const sourceEnd = source.pos + source.node.nodeSize;
  const targetEnd = target.pos + target.node.nodeSize;
  if (edge === "before" && sourceEnd === target.pos) return false;
  if (edge === "after" && source.pos === targetEnd) return false;

  const { from, to } = removalRange(state.doc, source.pos, source.node);
  const tr = state.tr.delete(from, to);
  const insertAt = edge === "before" ? tr.mapping.map(target.pos) : tr.mapping.map(targetEnd);
  tr.insert(insertAt, source.node);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * EDT-051: torna `sourceId` o último filho (indentado) de `targetId`. As
 * mesmas duas recusas de `reorderBlock` (mesmo id; ciclo), mais o no-op de
 * `sourceId` já ser o último filho de `targetId`.
 */
export function nestBlockUnderSibling(editor: Editor, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return false;
  const { state } = editor;
  const source = findWrapper(state.doc, sourceId);
  const target = findWrapper(state.doc, targetId);
  if (!source || !target) return false;
  if (containsBlock(source.node, targetId)) return false;

  const targetChildBlocks = childBlocksOf(target.node);
  const lastChildId = targetChildBlocks?.lastChild?.firstChild?.attrs.id;
  if (lastChildId === sourceId) return false;

  const { from, to } = removalRange(state.doc, source.pos, source.node);
  const tr = state.tr.delete(from, to);
  const targetEndAfterDelete = tr.mapping.map(target.pos + target.node.nodeSize);

  // Dois deslocamentos diferentes, não o mesmo `-1` nos dois ramos - a
  // diferença importa e um teste (`node-move.test.ts`) pegou o erro quando
  // os dois usavam `-1`: `targetEndAfterDelete - 1` é a posição bem antes
  // da tag de fechamento do wrapper-alvo (onde um `childBlocks` NOVO entra,
  // como conteúdo dele); quando `childBlocks` já existe, ele é o próprio
  // último filho do wrapper, então SEU fim coincide com o fim do wrapper
  // menos a largura da tag de fechamento do wrapper (`-1` de novo) - por
  // isso entrar dentro dele exige mais um `-1` (`-2` ao todo). Sem o segundo
  // `-1`, o bloco solto entra como um terceiro item do conteúdo do wrapper
  // (`"blockContent childBlocks?"` não permite isso) em vez de como filho
  // de `childBlocks` - reproduz, sem testar antes, o mesmo raciocínio de
  // `handleTab` em `core/commands.ts`, que só testa o ramo "sem filhos"
  // ainda (ver `core_gaps` no relatório).
  if (targetChildBlocks) {
    tr.insert(targetEndAfterDelete - 2, source.node);
  } else {
    const wrapped = state.schema.nodes[NODE_NAMES.childBlocks].create(null, source.node);
    tr.insert(targetEndAfterDelete - 1, wrapped);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
