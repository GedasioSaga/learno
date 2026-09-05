/**
 * State for the mini-calendar (EDT-045's "clicável para editar num
 * mini-calendário") - separate from `date-mention-suggestion-store.ts` on
 * purpose: that one drives the popup while a mention is still being typed,
 * this one drives editing a chip that already exists. Different trigger
 * (mousedown on the chip vs the "@" `Suggestion` plugin), different
 * lifecycle, so sharing one store would mean the two have to agree on
 * fields neither fully needs.
 */
import { create } from "zustand";

interface DateMentionCalendarRect {
  left: number;
  bottom: number;
}

function toRect(rect: DOMRect): DateMentionCalendarRect {
  return { left: rect.left, bottom: rect.bottom };
}

interface DateMentionCalendarState {
  /** The `mentionDate` node's position in the doc - `null` means the calendar is closed. */
  pos: number | null;
  /** The chip's current date, or `null` for one somehow inserted without ever resolving one. */
  iso: string | null;
  rect: DateMentionCalendarRect | null;
  open(pos: number, iso: string | null, anchorRect: DOMRect): void;
  close(): void;
}

export const useDateMentionCalendarStore = create<DateMentionCalendarState>((set) => ({
  pos: null,
  iso: null,
  rect: null,
  open: (pos, iso, anchorRect) => set({ pos, iso, rect: toRect(anchorRect) }),
  close: () => set({ pos: null, iso: null, rect: null }),
}));
