/**
 * EDT-035/036/038/039: the five basic inline marks. StarterKit ships with
 * bold/italic/strike/code/underline turned off on purpose (`core/extensions.ts`)
 * so the mark itself and the toolbar button that toggles it are registered
 * from the same place - here, alongside `register.ts` and
 * `formatting-buttons.tsx`.
 *
 * Every mark below is the official `@tiptap/extension-*` package, unmodified
 * except for Strike, which needs one extra input rule (see below). Each
 * already ships its own Mod- keyboard shortcut and, for bold/italic/strike,
 * its own markdown input rule - see the `.d.ts`/`.js` read for this task.
 */
import { markInputRule } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Underline from "@tiptap/extension-underline";

/**
 * EDT-038 asks for a single tilde on each side ("~riscado~"); the official
 * Strike extension only recognizes a double tilde ("~~riscado~~") by
 * default. Extending it - instead of writing Strike from scratch - keeps its
 * Mod-Shift-S shortcut, its double-tilde rule (so both forms keep working)
 * and its paste rule.
 */
const singleTildeInputRegex = /(?:^|\s)(~(?!\s+~)([^~]+)~(?!\s+~))$/;

export const StrikeSingleOrDoubleTilde = Strike.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), markInputRule({ find: singleTildeInputRegex, type: this.type })];
  },
});

export const basicMarkExtensions = [Bold, Italic, StrikeSingleOrDoubleTilde, Code, Underline];
