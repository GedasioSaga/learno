/**
 * Loads a page's blocks into a ProseMirror doc on open, and turns edits back
 * into `apply_block_changes` batches on a debounce - the "camada fina" this
 * hook sits on (`blocksApi`) is the only thing that changes once the real
 * backend lands.
 */
import type { JSONContent } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageId } from "../contract";
import { blocksApi } from "./blocks-api";
import { type FlatBlock, blocksToDoc, diffToChanges, docToFlatBlocks } from "./serialize";

export type BlocksDocumentStatus = "loading" | "ready" | "error";

/**
 * Debounce between the last keystroke and the autosave batch actually going
 * out. Long enough that a fast typist doesn't spam `apply_block_changes` on
 * every character; short enough that closing the page a moment later (Fase
 * 1's crash-recovery journal is a *separate*, more frequent write - see
 * `PLT-005`/`useAutosaveDraft` - this is the confirmed-save path) doesn't
 * lose the last few words.
 */
const SAVE_DEBOUNCE_MS = 600;

export interface UseBlocksDocumentResult {
  status: BlocksDocumentStatus;
  errorMessage: string | null;
  /** The doc to hand `useEditor({ content })` once `status === "ready"` - `null` otherwise. */
  initialContent: JSONContent | null;
  /** Call on every editor transaction; debounces internally. */
  scheduleSave: (doc: JSONContent) => void;
  /** Saves immediately, bypassing the debounce - used on unmount/page switch and by tests. */
  flush: () => Promise<void>;
}

export function useBlocksDocument(pageId: PageId): UseBlocksDocumentResult {
  const [status, setStatus] = useState<BlocksDocumentStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initialContent, setInitialContent] = useState<JSONContent | null>(null);

  const previousFlatRef = useRef<FlatBlock[]>([]);
  const pendingDocRef = useRef<JSONContent | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const doc = pendingDocRef.current;
    if (!doc) return;
    pendingDocRef.current = null;
    const current = docToFlatBlocks(doc);
    const changes = diffToChanges(pageId, previousFlatRef.current, current);
    if (changes.length === 0) return;
    await blocksApi.apply_block_changes(changes);
    previousFlatRef.current = current;
  }, [pageId]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);
    setInitialContent(null);

    blocksApi
      .list_page_blocks(pageId)
      .then((blocks) => {
        if (cancelled) return;
        const doc = blocksToDoc(blocks);
        // Round-tripping the freshly loaded blocks through the same
        // doc->FlatBlock path edits go through keeps the "last known saved
        // state" baseline in exactly the shape `diffToChanges` compares
        // against, instead of a second hand-written conversion that could
        // drift from it.
        //
        // The empty page is the exception, and getting it wrong cost this
        // project every block a user ever typed: `blocksToDoc([])` invents a
        // placeholder paragraph so the cursor has somewhere to land, and
        // round-tripping *that* would enter the placeholder into the baseline
        // as already-saved. The first keystroke would then diff into an
        // `update` for a row the backend never created, which it rejects
        // ("bloco ativo <uuid>" - `src-tauri/src/db/blocks.rs`), so nothing
        // was ever persisted. An empty page's baseline is empty: the
        // placeholder is a block the editor still owes the backend.
        previousFlatRef.current = blocks.length === 0 ? [] : docToFlatBlocks(doc);
        setInitialContent(doc);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "Não foi possível carregar o conteúdo da página.");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      if (saveTimeoutRef.current !== null) clearTimeout(saveTimeoutRef.current);
      // Flush whatever this page had pending before moving on - to the next
      // page, or off the screen entirely - rather than dropping it.
      void flush();
    };
  }, [pageId, flush]);

  const scheduleSave = useCallback(
    (doc: JSONContent) => {
      pendingDocRef.current = doc;
      if (saveTimeoutRef.current !== null) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return { status, errorMessage, initialContent, scheduleSave, flush };
}
