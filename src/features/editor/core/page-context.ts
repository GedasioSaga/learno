/**
 * Which page the editor instance is editing, readable from any extension.
 *
 * Several Fase 2 features are page-scoped and were blocked without this:
 * `create_synced_block_copy` needs a `placement.pageId` (EDT-073), a
 * link-to-page block has to reparent the target under *this* page (FUN-043),
 * and a media block writes into the page's own media subfolder. `Editor`
 * knows the `pageId`; extensions had no channel to it at all - no argument
 * to `buildEditorExtensions`, nothing in `editor.storage`, and the app has
 * no router to ask.
 *
 * A TipTap `Extension` with storage is the channel, because storage is
 * per-editor-instance (a second page open in a second editor gets its own),
 * which a module-level variable would not be.
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { PageId } from "../contract";

interface PageContextOptions {
  pageId: PageId | null;
}

interface PageContextStorage {
  pageId: PageId | null;
}

export const PAGE_CONTEXT_NAME = "learnoPageContext";

export const PageContext = Extension.create<PageContextOptions, PageContextStorage>({
  name: PAGE_CONTEXT_NAME,
  addOptions() {
    return { pageId: null };
  },
  addStorage() {
    return { pageId: this.options.pageId };
  },
});

/**
 * The page this editor is editing, or `null` outside a page (a test building
 * a bare editor, the loading instance before content arrives). Always handle
 * the `null`: an extension that assumes a page is open crashes the editor in
 * exactly the situation where nothing is open yet.
 */
export function pageIdOf(editor: Editor): PageId | null {
  // `editor.storage` is typed as the union of the storages TipTap knows about
  // at compile time, which cannot include an extension registered at
  // runtime - hence the indexed read through `unknown` rather than a cast
  // that would claim more than we know.
  const storages = editor.storage as unknown as Record<string, PageContextStorage | undefined>;
  const pageId = storages[PAGE_CONTEXT_NAME]?.pageId;
  return typeof pageId === "string" && pageId.length > 0 ? pageId : null;
}
