/**
 * Ajuda só de teste: acha a posição real (ProseMirror) de uma palavra digitada
 * e aplica negrito nela via comandos de verdade do editor — evita adivinhar
 * aritmética de posição à mão (frágil: depende de quantos nós de abertura o
 * schema tem antes do texto), no mesmo espírito de `startOfBlock` em
 * `src/features/editor/blocks/code/code-block.test.ts`, que também busca a
 * posição via `descendants` em vez de contar offset manualmente.
 */
import type { Editor } from "@tiptap/core";

export function boldSelectionAroundWord(editor: Editor, word: string): void {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from !== -1) return false;
    if (node.isText && typeof node.text === "string") {
      const index = node.text.indexOf(word);
      if (index !== -1) {
        from = pos + index;
        to = from + word.length;
      }
    }
    return true;
  });
  if (from === -1) throw new Error(`palavra "${word}" não encontrada no doc do editor de teste`);
  editor.commands.setTextSelection({ from, to });
  editor.commands.toggleBold();
}
