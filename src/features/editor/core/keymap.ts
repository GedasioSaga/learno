/**
 * Wires `commands.ts` into actual key combos. Kept separate from
 * `commands.ts` so that file stays pure tree-surgery, testable without
 * touching the keyboard-shortcut registration surface at all.
 */
import { Extension } from "@tiptap/core";
import { handleBackspace, handleEnter, handleShiftTab, handleTab } from "./commands";

export const BlockKeymap = Extension.create({
  name: "blockKeymap",
  addKeyboardShortcuts() {
    return {
      Enter: () => handleEnter(this.editor),
      Tab: () => handleTab(this.editor),
      "Shift-Tab": () => handleShiftTab(this.editor),
      Backspace: () => handleBackspace(this.editor),
    };
  },
});
