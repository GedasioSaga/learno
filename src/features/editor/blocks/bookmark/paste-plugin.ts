/**
 * EDT-030: a bare URL pasted onto an empty block doesn't decide for the
 * user - it records the pending choice (this plugin's own state, keyed by
 * `bookmarkPasteKey`) and returns `true` from `handlePaste` so nothing gets
 * inserted yet. `paste-menu.tsx` reads that state to render the two
 * choices; picking one calls `confirmBookmarkCard` or `confirmInlineLink`
 * below, which is what actually inserts something.
 *
 * `handlePaste` chains with the other builders' paste handlers exactly as
 * the README describes: returning `false` for anything that isn't a bare
 * URL (existing text in the block, a non-empty selection, non-URL content)
 * leaves the paste for whoever handles it next - the media builder's own
 * image/file paste included.
 *
 * The condition itself lives in `bookmarkPasteDecision`, a pure function of
 * `(EditorState, clipboard text reader)` rather than the raw DOM
 * `ClipboardEvent` - jsdom (this project's test environment) has no
 * `ClipboardEvent` implementation at all, so a test can't construct one to
 * drive `handlePaste` through the DOM. Factoring the actual decision out
 * means the one thing worth testing here doesn't need one either; only the
 * one-line `props.handlePaste` wrapper below touches the real event.
 */
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { insertBlockHere } from "../../core/commands";
import { parseSafeUrl } from "./bookmark-card";
import { BOOKMARK_NODE_NAME } from "./constants";
import type { BookmarkMetadata } from "./metadata";

export interface PendingBookmarkPaste {
  url: string;
  pos: number;
}

/** The one piece of `ClipboardEvent` the decision actually needs - real `DataTransfer.getData` satisfies this structurally, no cast required. */
export interface ClipboardTextSource {
  getData(format: string): string | null;
}

export const bookmarkPasteKey = new PluginKey<PendingBookmarkPaste | null>("bookmarkPaste");

/**
 * `null` for anything that isn't "paste a bare URL onto an empty block":
 * selection not collapsed, the block already has text, or the clipboard's
 * plain-text payload isn't - trimmed, whole - a `http(s)` URL (rejects
 * `javascript:`/`data:` the same way `parseSafeUrl` always does, and rejects
 * "check this out: https://…" just as much as a non-URL, since only a bare
 * URL paste is what EDT-030 describes).
 */
export function bookmarkPasteDecision(state: EditorState, clipboard: ClipboardTextSource): PendingBookmarkPaste | null {
  const raw = clipboard.getData("text/plain")?.trim() ?? "";
  if (!raw) return null;
  const url = parseSafeUrl(raw);
  if (!url) return null;

  const { $from, empty } = state.selection;
  if (!empty) return null;
  if ($from.parent.type.spec.group !== "blockContent") return null;
  if ($from.parent.content.size !== 0) return null;

  return { url: url.toString(), pos: $from.pos };
}

export function clearPendingBookmarkPaste(editor: Editor): void {
  if (!bookmarkPasteKey.getState(editor.state)) return;
  editor.view.dispatch(editor.state.tr.setMeta(bookmarkPasteKey, null));
}

/** "Criar bookmark" - the pending URL becomes a bookmark card in place of the empty block it was pasted onto. */
export function confirmBookmarkCard(editor: Editor, pending: PendingBookmarkPaste, metadata: BookmarkMetadata): boolean {
  const created = insertBlockHere(editor, BOOKMARK_NODE_NAME, {
    url: pending.url,
    title: metadata.title,
    description: metadata.description,
    favicon: metadata.favicon,
  });
  if (!created) clearPendingBookmarkPaste(editor);
  return created;
}

/** "Criar link/menção" - the pending URL becomes inline text carrying the `link` mark, in the same block, instead of a card. */
export function confirmInlineLink(editor: Editor, pending: PendingBookmarkPaste): boolean {
  // `marks/link` (a different builder's folder, built in parallel) may not
  // be registered yet - degrade to plain unlinked text rather than throw;
  // once it registers `link`, this starts producing a real hyperlink with
  // no change needed here (the check is dynamic, against the live schema).
  const linkMarkAvailable = Boolean(editor.schema.marks.link);
  const created = linkMarkAvailable
    ? editor.commands.insertContent({ type: "text", text: pending.url, marks: [{ type: "link", attrs: { href: pending.url } }] })
    : editor.commands.insertContent({ type: "text", text: pending.url });
  if (!created) clearPendingBookmarkPaste(editor);
  return created;
}

/** "Cancelar" - paste the URL back as ordinary text, the way it would have landed had this plugin not intercepted it. */
export function confirmPlainTextPaste(editor: Editor, pending: PendingBookmarkPaste): boolean {
  const created = editor.commands.insertContent({ type: "text", text: pending.url });
  if (!created) clearPendingBookmarkPaste(editor);
  return created;
}

export const BookmarkPastePlugin = Extension.create({
  name: "bookmarkPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: bookmarkPasteKey,
        state: {
          init: (): PendingBookmarkPaste | null => null,
          apply(tr, value) {
            // `Transaction.getMeta` is typed `any` regardless of the key's
            // own `PluginKey<T>` generic (prosemirror-state doesn't thread
            // it through) - every value ever passed to `setMeta` on this key
            // is either a `PendingBookmarkPaste` or `null` (see every call
            // site of `setMeta(bookmarkPasteKey, ...)` below and in
            // `paste-menu.tsx`), so this narrows back to what's actually put in.
            const meta = tr.getMeta(bookmarkPasteKey) as PendingBookmarkPaste | null | undefined;
            if (meta !== undefined) return meta;
            // An edit elsewhere while the menu is up (the user kept typing
            // instead of choosing) dismisses it rather than leaving a menu
            // pointing at a position that may no longer mean the same thing.
            if (value && tr.docChanged) return null;
            return value;
          },
        },
        props: {
          handlePaste(view, event) {
            if (!event.clipboardData) return false;
            const decision = bookmarkPasteDecision(view.state, event.clipboardData);
            if (!decision) return false;
            view.dispatch(view.state.tr.setMeta(bookmarkPasteKey, decision));
            return true;
          },
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Escape: () => {
        const pending = bookmarkPasteKey.getState(this.editor.state);
        if (!pending) return false;
        confirmPlainTextPaste(this.editor, pending);
        return true;
      },
    };
  },
});
