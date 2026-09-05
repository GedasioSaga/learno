/**
 * Discovered by `core/discover-extensions.ts`'s `import.meta.glob` - the
 * pattern it matches is the literal filename `register.ts`, so this file
 * stays `.ts` (not `.tsx`) even though it mounts a React overlay; the
 * overlay is built with `createElement` instead of JSX for that reason -
 * see the README on why nothing here may import from `../../index`.
 */
import { createElement } from "react";
import { registerBlockSpec, registerEditorOverlay } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import "./bookmark.css";
import { bookmarkBlockSpec } from "./bookmark-spec";
import { BookmarkNode } from "./bookmark-node";
import { BookmarkPasteMenu } from "./paste-menu";
import { BookmarkPastePlugin } from "./paste-plugin";

registerBlockExtension([BookmarkNode, BookmarkPastePlugin]);
registerBlockSpec(bookmarkBlockSpec);

registerEditorOverlay({
  id: "blocks:bookmark:pasteMenu",
  render: (editor) => createElement(BookmarkPasteMenu, { editor }),
});
