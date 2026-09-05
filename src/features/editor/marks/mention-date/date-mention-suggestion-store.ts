/**
 * Bridge between the ProseMirror-side `Suggestion` plugin
 * (`date-mention-node.ts`, not React) and the dropdown that draws it
 * (`DateMentionSuggestionOverlay.tsx`, which is React) - same split as
 * `interaction/slash-menu/slash-menu-store.ts`, and for the same reason:
 * the plugin's own `onStart`/`onUpdate`/`onKeyDown` run outside any React
 * render, so a component-local `useState` can't be where arrow-key
 * navigation lives.
 *
 * Stores `query`, not a resolved item list: `dateCandidatesFor` is pure and
 * cheap, so the overlay recomputes candidates from the query at render time
 * instead of this store caching a snapshot that could drift from it.
 */
import { create } from "zustand";

/** Copy of a `DOMRect`'s position fields, not the object itself - `clientRect()` hands back a fresh one on every call, nothing to keep a live reference to. */
export interface DateMentionSuggestionRect {
  left: number;
  top: number;
  bottom: number;
}

export interface DateMentionSuggestionRange {
  from: number;
  to: number;
}

function toRect(rect: DOMRect | null): DateMentionSuggestionRect | null {
  if (!rect) return null;
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

interface DateMentionSuggestionState {
  active: boolean;
  query: string;
  rect: DateMentionSuggestionRect | null;
  range: DateMentionSuggestionRange | null;
  /** `null` = "first visible candidate" - resolved by whoever reads the state, not here. */
  highlightedId: string | null;
  open(query: string, rect: DOMRect | null, range: DateMentionSuggestionRange): void;
  update(query: string, rect: DOMRect | null, range: DateMentionSuggestionRange): void;
  close(): void;
  setHighlightedId(id: string | null): void;
}

export const useDateMentionSuggestionStore = create<DateMentionSuggestionState>((set) => ({
  active: false,
  query: "",
  rect: null,
  range: null,
  highlightedId: null,
  open: (query, rect, range) => set({ active: true, query, rect: toRect(rect), range, highlightedId: null }),
  // Resets the highlight on every keystroke: the candidate list can change
  // shape entirely (a different weekday, a completed date format), and
  // whatever was highlighted may no longer be among them.
  update: (query, rect, range) => set({ query, rect: toRect(rect), range, highlightedId: null }),
  close: () => set({ active: false, query: "", rect: null, range: null, highlightedId: null }),
  setHighlightedId: (id) => set({ highlightedId: id }),
}));
