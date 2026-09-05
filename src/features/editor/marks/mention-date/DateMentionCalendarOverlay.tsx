/**
 * The mini-calendar for EDT-045 - editing the date of a chip that already
 * exists, opened by clicking it (`date-mention-node.ts`'s NodeView). Separate
 * `EditorOverlay` from `DateMentionSuggestionOverlay.tsx` on purpose: one
 * edits text still being typed (the `Suggestion` plugin's own lifecycle),
 * this one edits an existing node by position - different triggers,
 * different stores (`date-mention-calendar-store.ts`).
 *
 * Keyboard: arrows move the *draft* day without touching the document yet
 * (so a stray Enter never commits something you were about to fix again
 * with one more arrow press); Enter commits; Escape cancels. Same
 * outside-click-closes pattern as the other two overlays in this folder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Editor } from "@tiptap/core";
import "./mention-date.css";
import { addDays, buildMonthGrid, formatDatePtBR, monthLabelPtBR, parseIsoDateString, toIsoDateString } from "./date-parsing";
import { useDateMentionCalendarStore } from "./date-mention-calendar-store";

const WEEKDAY_HEADER_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"];
const ARROW_KEY_DELTA_DAYS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

interface DateMentionCalendarOverlayProps {
  editor: Editor;
}

export function DateMentionCalendarOverlay({ editor }: DateMentionCalendarOverlayProps) {
  const pos = useDateMentionCalendarStore((state) => state.pos);
  const iso = useDateMentionCalendarStore((state) => state.iso);
  const rect = useDateMentionCalendarStore((state) => state.rect);
  const close = useDateMentionCalendarStore((state) => state.close);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Date>(() => parseIsoDateString(iso ?? "") ?? new Date());

  // Re-seeds the draft (and moves focus in) every time a *different* open
  // happens - `pos`/`iso` change together on `open()`, never independently.
  useEffect(() => {
    if (pos === null) return;
    setDraft(parseIsoDateString(iso ?? "") ?? new Date());
    containerRef.current?.focus();
  }, [pos, iso]);

  useEffect(() => {
    if (pos === null) return undefined;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [pos, close]);

  const monthLabel = useMemo(() => monthLabelPtBR(draft), [draft]);
  const weeks = useMemo(() => buildMonthGrid(draft), [draft]);
  const draftIso = toIsoDateString(draft);

  if (pos === null || rect === null) return null;

  function commit(date: Date) {
    if (pos === null) return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "date", toIsoDateString(date)));
    close();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = ARROW_KEY_DELTA_DAYS[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      setDraft((current) => addDays(current, delta));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  return (
    <div
      ref={containerRef}
      className="ed-mention-date-calendar"
      role="dialog"
      aria-label={`Editar data, atualmente ${formatDatePtBR(draftIso)}`}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{ left: rect.left, top: rect.bottom }}
    >
      <p className="ed-mention-date-calendar__month">{monthLabel}</p>
      <div className="ed-mention-date-calendar__weekdays" aria-hidden="true">
        {WEEKDAY_HEADER_LABELS.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
      <div className="ed-mention-date-calendar__grid">
        {weeks.map((week, weekIndex) => (
          <div className="ed-mention-date-calendar__week" key={weekIndex}>
            {week.map((day) => (
              <button
                key={day.iso}
                type="button"
                className={
                  "ed-mention-date-calendar__day" +
                  (day.inCurrentMonth ? "" : " is-outside") +
                  (day.iso === draftIso ? " is-selected" : "")
                }
                aria-label={formatDatePtBR(day.iso)}
                aria-pressed={day.iso === draftIso}
                onClick={() => commit(day.date)}
              >
                {day.date.getDate()}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
