/**
 * EDT-045's date vocabulary: resolving what the user typed after "@" into an
 * actual calendar date, and formatting a date back for display. Pure
 * functions only - no ProseMirror, no TipTap - so the matching/resolution
 * logic is testable with `vi.setSystemTime` without spinning up an editor
 * (see `date-parsing.test.ts`), and `date-mention-node.ts` is the only file
 * that wires this to the "@" trigger.
 *
 * The one hard rule this file exists to enforce: a resolved date is always
 * stored as an ISO string (`toIsoDateString`), never the text the user
 * typed. "amanhã" typed today has to become "2026-09-04" on disk, because
 * Fase 4's due-date filtering reads the ISO attr, not the label.
 */

/** One thing the "@" popup can offer, given what's been typed so far. */
export interface DateCandidate {
  /** Unique among the candidates for one query - used as the list key and to track which row is highlighted. */
  id: string;
  /** The resolved date, `toIsoDateString` - what actually gets stored on the chip. */
  iso: string;
  /** What the popup row shows - never the raw typed text. */
  label: string;
}

const RELATIVE_TERMS: ReadonlyArray<{ normalized: string; display: string; offsetDays: number }> = [
  { normalized: "hoje", display: "Hoje", offsetDays: 0 },
  { normalized: "amanha", display: "Amanhã", offsetDays: 1 },
  { normalized: "ontem", display: "Ontem", offsetDays: -1 },
];

const WEEKDAYS: ReadonlyArray<{ normalized: string; display: string; index: number }> = [
  { normalized: "domingo", display: "domingo", index: 0 },
  { normalized: "segunda", display: "segunda", index: 1 },
  { normalized: "terca", display: "terça", index: 2 },
  { normalized: "quarta", display: "quarta", index: 3 },
  { normalized: "quinta", display: "quinta", index: 4 },
  { normalized: "sexta", display: "sexta", index: 5 },
  { normalized: "sabado", display: "sábado", index: 6 },
];

const MONTH_NAMES_PT_BR: readonly string[] = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

// "hoje"/"amanha"/"ontem" have distinct first letters, so a single typed
// character is already unambiguous; a weekday needs more before it stops
// colliding with ordinary words ("seg" is still common prose, "s" is worse).
const MIN_WEEKDAY_QUERY_LENGTH = 3;
const MAX_DATE_CANDIDATES = 6;

export function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

// U+0300-U+036F: the combining-diacritical-marks block NFD splits an
// accent into ("á" -> "a" + U+0301) - named as a constant, since the two
// boundary characters are otherwise invisible/indistinguishable pasted
// directly into a regex literal.
const COMBINING_DIACRITIC_START = 0x0300;
const COMBINING_DIACRITIC_END = 0x036f;

function stripDiacritics(value: string): string {
  return Array.from(value.normalize("NFD"))
    .filter((char) => {
      const codePoint = char.codePointAt(0);
      return codePoint === undefined || codePoint < COMBINING_DIACRITIC_START || codePoint > COMBINING_DIACRITIC_END;
    })
    .join("");
}

/** Accent/case-insensitive matching key for a typed query or a term - "Próxima" and "proxima" have to compare equal. */
function normalize(value: string): string {
  return stripDiacritics(value.trim().toLowerCase());
}

/**
 * `date.toISOString()` converts to UTC first, which silently shifts the
 * calendar day near midnight in any timezone west of UTC - exactly the bug a
 * "date mention" can least afford, since the day is the whole point. This
 * reads the local calendar fields directly instead.
 */
export function toIsoDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDateString(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const date = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
  return Number.isNaN(date.getTime()) ? null : date;
}

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** "04/09/2026" - purely numeric, so it needs no locale month-name data (unlike `monthLabelPtBR`, which spells its own out instead of trusting that data to be present). */
export function formatDatePtBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = parseIsoDateString(iso);
  return date ? DATE_LABEL_FORMATTER.format(date) : "";
}

/** "Setembro de 2026" - the mini-calendar's header. */
export function monthLabelPtBR(date: Date): string {
  return `${capitalize(MONTH_NAMES_PT_BR[date.getMonth()])} de ${date.getFullYear()}`;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

/** The next date landing on `targetWeekday` (0=domingo..6=sábado), always strictly after `from` - "próxima segunda" said on a Monday means next week's, not today. */
function nextWeekday(from: Date, targetWeekday: number): Date {
  const delta = (targetWeekday - from.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

function relativeTermCandidates(query: string, today: Date): DateCandidate[] {
  return RELATIVE_TERMS.filter((term) => term.normalized.startsWith(query)).map((term) => {
    const iso = toIsoDateString(addDays(today, term.offsetDays));
    return { id: `relative:${term.normalized}`, iso, label: `${term.display} · ${formatDatePtBR(iso)}` };
  });
}

/**
 * Only the "próxima/próximo <dia da semana>" form (EDT-045's own example) -
 * deliberately not a bare weekday name alone, which would be indistinguishable
 * from someone just typing that common Portuguese word ("segunda" as in
 * "segunda opção") rather than mentioning a date.
 */
function weekdayCandidates(query: string, today: Date): DateCandidate[] {
  const match = /^proxim[ao]\s+(\S*)$/.exec(query);
  if (!match) return [];
  const weekdayQuery = match[1].replace(/-?feira$/, "");
  if (weekdayQuery.length < MIN_WEEKDAY_QUERY_LENGTH) return [];
  return WEEKDAYS.filter((weekday) => weekday.normalized.startsWith(weekdayQuery)).map((weekday) => {
    const iso = toIsoDateString(nextWeekday(today, weekday.index));
    return { id: `weekday:${weekday.normalized}`, iso, label: `Próxima ${weekday.display}-feira · ${formatDatePtBR(iso)}` };
  });
}

const ABSOLUTE_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;

/** "dd/mm" or "dd/mm/yyyy" (or 2-digit year). No year given defaults to the current one - deliberately no "roll to next year if already past" guess, since that would silently change what the user typed into something else. */
function absoluteDateCandidates(query: string, today: Date): DateCandidate[] {
  const match = ABSOLUTE_DATE_PATTERN.exec(query);
  if (!match) return [];
  const [, dayStr, monthStr, yearStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  const year = yearStr ? (yearStr.length === 2 ? 2000 + Number(yearStr) : Number(yearStr)) : today.getFullYear();
  const date = new Date(year, month - 1, day);
  // `Date` normalizes an invalid day (31/02) into the next month instead of
  // throwing - reject rather than silently insert a different day than typed.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return [];
  const iso = toIsoDateString(date);
  return [{ id: `absolute:${iso}`, iso, label: formatDatePtBR(iso) }];
}

/**
 * What the "@" popup offers for a typed query, or `[]` when nothing about it
 * reads as a date - the signal `date-mention-node.ts`'s `shouldShow` uses to
 * stay silent so a page-mention builder sharing the same "@" trigger isn't
 * fought over every keystroke.
 */
export function dateCandidatesFor(rawQuery: string, now: Date): DateCandidate[] {
  const query = normalize(rawQuery);
  if (!query) return [];
  const today = startOfDay(now);
  return [
    ...relativeTermCandidates(query, today),
    ...weekdayCandidates(query, today),
    ...absoluteDateCandidates(query, today),
  ].slice(0, MAX_DATE_CANDIDATES);
}

export interface CalendarDay {
  date: Date;
  iso: string;
  inCurrentMonth: boolean;
}

/** A 6-week grid covering `reference`'s month, padded with the trailing/leading days of its neighbours - what a normal month calendar UI shows. */
export function buildMonthGrid(reference: Date): CalendarDay[][] {
  const firstOfMonth = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const weeks: CalendarDay[][] = [];
  let cursor = gridStart;
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      days.push({ date: cursor, iso: toIsoDateString(cursor), inCurrentMonth: cursor.getMonth() === reference.getMonth() });
      cursor = addDays(cursor, 1);
    }
    weeks.push(days);
  }
  return weeks;
}
