/**
 * The "@" dropdown for EDT-045 - the `EditorOverlay` registered from
 * `register.ts`. Doesn't decide keyboard navigation itself (that's the
 * `Suggestion` inside `date-mention-node.ts`, which runs before any React
 * render); only reads `date-mention-suggestion-store.ts` and draws, plus a
 * mouse click as the second way to pick a candidate - same split as
 * `interaction/slash-menu/SlashMenuOverlay.tsx`.
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { exitSuggestion } from "@tiptap/suggestion";
import "./mention-date.css";
import { dateCandidatesFor } from "./date-parsing";
import { insertDateMention, mentionDateSuggestionPluginKey } from "./date-mention-node";
import { useDateMentionSuggestionStore } from "./date-mention-suggestion-store";

interface DateMentionSuggestionOverlayProps {
  editor: Editor;
}

export function DateMentionSuggestionOverlay({ editor }: DateMentionSuggestionOverlayProps) {
  const active = useDateMentionSuggestionStore((state) => state.active);
  const query = useDateMentionSuggestionStore((state) => state.query);
  const rect = useDateMentionSuggestionStore((state) => state.rect);
  const range = useDateMentionSuggestionStore((state) => state.range);
  const highlightedId = useDateMentionSuggestionStore((state) => state.highlightedId);
  const listRef = useRef<HTMLDivElement>(null);

  const candidates = dateCandidatesFor(query, new Date());
  const activeId = highlightedId ?? candidates[0]?.id ?? null;

  // Clicar fora fecha: a `Suggestion` do TipTap só cuida disso sozinha
  // quando renderizada pelo `mount()` dela (ver o .d.ts do pacote) - este
  // overlay é montado pelo registro do core, não por aquele mecanismo, então
  // precisa do próprio listener - mesmo motivo documentado em
  // `SlashMenuOverlay.tsx`.
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (listRef.current?.contains(target)) return;
      exitSuggestion(editor.view, mentionDateSuggestionPluginKey);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [active, editor]);

  if (!active || !rect || !range) return null;

  function choose(candidateId: string) {
    if (!range) return;
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    insertDateMention(editor, range, candidate.iso);
    exitSuggestion(editor.view, mentionDateSuggestionPluginKey);
  }

  return (
    <div
      ref={listRef}
      className="ed-mention-date-suggestion"
      style={{ left: rect.left, top: rect.bottom }}
      role="listbox"
      aria-label="Sugestões de data"
      aria-activedescendant={activeId ? `ed-mention-date-suggestion-item-${activeId}` : undefined}
    >
      {candidates.length === 0 ? (
        <p className="ed-mention-date-suggestion__empty">Nenhuma data encontrada</p>
      ) : (
        candidates.map((candidate) => (
          <button
            key={candidate.id}
            id={`ed-mention-date-suggestion-item-${candidate.id}`}
            type="button"
            role="option"
            aria-selected={candidate.id === activeId}
            className={
              candidate.id === activeId
                ? "ed-mention-date-suggestion__item ed-mention-date-suggestion__item--active"
                : "ed-mention-date-suggestion__item"
            }
            // onMouseDown, não onClick: o clique tiraria o foco do editor
            // antes do handler rodar, perdendo o range da sugestão.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(candidate.id);
            }}
          >
            {candidate.label}
          </button>
        ))
      )}
    </div>
  );
}
