/**
 * Mounts the block editor for one page: loads its blocks
 * (`use-blocks-document.ts`), renders them, and saves edits back on a
 * debounce. This is the piece `PageWorkspace.tsx` puts where "Conteúdo em
 * construção" used to be - see the README for why every node type it
 * renders lives in `schema.ts` rather than here.
 *
 * Besides the document itself it renders two things builders outside
 * `core/` contribute to: one selection toolbar holding every registered
 * `FormattingMenuItem`, and every registered `EditorOverlay` (the `/` menu
 * popup, a link editor, a caption dialog). Both come from `block-spec.ts`,
 * so no builder needs to edit this file to put UI on the screen - and there
 * is exactly one floating toolbar no matter how many builders add buttons
 * to it.
 */
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect } from "react";
import { EmptyState } from "../../../components/EmptyState";
import type { PageId } from "../contract";
import { collectEditorOverlays, collectFormattingMenuItems } from "./block-spec";
import "./editor.css";
import { ensureExtensionsDiscovered } from "./discover-extensions";
import { buildEditorExtensions } from "./extensions";
import { useBlocksDocument } from "./use-blocks-document";

// Runs once at module load: pulls in every other builder's `register.ts`
// (marks/, blocks/, interaction/, synced/) before `Editor` ever mounts.
ensureExtensionsDiscovered();

interface EditorProps {
  pageId: PageId;
}

export function Editor({ pageId }: EditorProps) {
  const { status, errorMessage, initialContent, scheduleSave, flush } = useBlocksDocument(pageId);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: status === "ready",
      // A single empty paragraph while loading - thrown away the moment
      // `initialContent` arrives, since `pageId`/`initialContent` are both
      // in the deps array below and changing either recreates the editor.
      content: initialContent ?? { type: "doc", content: [{ type: "paragraph" }] },
      extensions: buildEditorExtensions({ pageId }),
      onUpdate: ({ editor: current }) => {
        scheduleSave(current.getJSON());
      },
      editorProps: {
        attributes: {
          class: "ed-root",
          "aria-label": "Corpo da página",
        },
      },
    },
    [pageId, initialContent],
  );

  // A page switch (or the tab/window closing) has to flush whatever the
  // *previous* editor instance had pending before it unmounts - `useEffect`
  // cleanup captures this render's `flush`, which closes over this render's
  // `pageId` (see `use-blocks-document.ts`).
  useEffect(() => () => void flush(), [flush]);

  if (status === "error") {
    return (
      <EmptyState
        title="Não foi possível carregar o conteúdo"
        description={errorMessage ?? "Tente reabrir a página."}
      />
    );
  }

  if (!editor) return null;

  // Collected per render rather than once at module load: a `register.ts`
  // can register during its own lazy import, and re-collecting is a Map
  // read over a handful of entries.
  const formattingItems = collectFormattingMenuItems();
  const overlays = collectEditorOverlays();

  return (
    <>
      <EditorContent editor={editor} />
      {formattingItems.length > 0 && (
        <BubbleMenu editor={editor} options={{ placement: "top" }}>
          <div className="ed-toolbar" role="toolbar" aria-label="Formatação do texto">
            {formattingItems.map((item) => (
              <span key={item.id} className="ed-toolbar__item">
                {item.render(editor)}
              </span>
            ))}
          </div>
        </BubbleMenu>
      )}
      {overlays.map((overlay) => (
        <span key={overlay.id}>{overlay.render(editor)}</span>
      ))}
    </>
  );
}
