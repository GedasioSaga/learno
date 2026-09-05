/**
 * EDT-031's "clicar num item leva ao heading": resolves a heading's current
 * position by id - never a position captured at the TOC's last render,
 * which any edit since then would have shifted - and places the cursor
 * there. Using the id (not the heading text) is what keeps this correct
 * when two headings share the same title.
 */
import type { Editor } from "@tiptap/core";
import { NODE_NAMES } from "../../core/node-names";

function positionOfHeading(editor: Editor, headingId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === NODE_NAMES.heading && node.attrs.id === headingId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Returns `false` when the heading no longer exists (removed since the
 * TOC's last render) instead of throwing - a click racing a deletion is a
 * silent no-op, and the TOC's own next re-render (already queued off the
 * same doc change) drops the stale item on its own.
 */
export function navigateToHeading(editor: Editor, headingId: string): boolean {
  const pos = positionOfHeading(editor, headingId);
  if (pos === null) return false;

  // +1 enters the heading's own text, the same convention `commands.ts`'s
  // block-content helpers use elsewhere in this editor.
  const applied = editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();

  // Belt-and-suspenders scroll: ProseMirror's own `scrollIntoView` command
  // above only guarantees the *cursor* is visible, which for a short heading
  // can already be true without the heading's top edge being visible in a
  // tall viewport. `nodeDOM` is not implemented by jsdom in this project's
  // test environment (see `vite.config.ts`), so this is guarded rather than
  // called unconditionally.
  const headingDom = editor.view.nodeDOM(pos);
  if (headingDom instanceof HTMLElement && typeof headingDom.scrollIntoView === "function") {
    headingDom.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return applied;
}
