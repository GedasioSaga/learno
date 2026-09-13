/**
 * EDT-033, caminho de teclado: `Mod-Alt-2` chama o mesmo comando que o item
 * "Duas colunas" do menu `/` (ver `register.ts`) - "2" por mnemônica. Não
 * colide com nada em `core/keymap.ts` (Enter/Tab/Shift-Tab/Backspace) nem com
 * `marks/script` (Ctrl+./Ctrl+, nativos do Subscript/Superscript). "Três
 * colunas" (mesmo `register.ts`) não ganhou um `Mod-Alt-3` equivalente - não
 * foi pedido, e não há necessidade sem mouse tão forte quanto a de duas
 * colunas (o layout mais comum) para justificar mais um atalho global.
 */
import { Extension } from "@tiptap/core";
import { wrapCurrentBlockInColumns } from "./column-commands";

export const ColumnKeymap = Extension.create({
  name: "columnKeymap",
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-2": () => wrapCurrentBlockInColumns(this.editor),
    };
  },
});
