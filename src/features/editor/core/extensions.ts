/**
 * The extension list every editor instance uses - factored out of
 * `Editor.tsx` so tests can build the exact same schema/keymap the real
 * editor runs, instead of a hand-trimmed stand-in that could drift from it.
 */
import type { AnyExtension } from "@tiptap/core";
import type { PageId } from "../contract";
import StarterKit from "@tiptap/starter-kit";
import { PageContext } from "./page-context";
import { collectRegisteredExtensions } from "./registry";
import { structuralNodes } from "./schema";
import { UniqueBlockIds } from "./unique-ids";
import { BlockKeymap } from "./keymap";

/**
 * `pageId` is optional so a test can build the real schema/keymap without a
 * page; every extension that needs it reads it through `pageIdOf` and has to
 * cope with `null` (see `page-context.ts`).
 */
export function buildEditorExtensions(options: { pageId?: PageId } = {}): AnyExtension[] {
  return [
    PageContext.configure({ pageId: options.pageId ?? null }),
    StarterKit.configure({
      document: false,
      paragraph: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      blockquote: false,
      horizontalRule: false,
      codeBlock: false,
      bold: false,
      italic: false,
      strike: false,
      code: false,
      underline: false,
      link: false,
      listKeymap: false,
      // Assumes a document that ends in a bare "paragraph" node directly
      // under "doc" - not true here (doc's children are `Block` wrappers,
      // see `schema.ts`) and throws inside its own `appendTransaction`
      // otherwise ("Called contentMatchAt on a node with invalid content").
      trailingNode: false,
    }),
    ...structuralNodes,
    UniqueBlockIds,
    BlockKeymap,
    ...collectRegisteredExtensions(),
  ];
}
