/**
 * EDT-033, caminho de teclado: `Mod-Alt-2` chama o mesmo comando que o item
 * "Duas colunas" do menu `/` (ver `register.ts`) - "2" por mnemônica ("duas
 * colunas", o único layout que esta peça cobre). Não colide com nada em
 * `core/keymap.ts` (Enter/Tab/Shift-Tab/Backspace) nem com `marks/script`
 * (Ctrl+./Ctrl+, nativos do Subscript/Superscript).
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
