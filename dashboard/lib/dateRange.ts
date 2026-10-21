// Calendar arithmetic for the statistics date-range picker.
//
// Every function speaks the same currency as StatsRange: an inclusive ISO day
// string, `YYYY-MM-DD`. No Date parsing of strings anywhere below — the
// arithmetic is done on the parts — because `new Date("2026-09-04")` is parsed
// as UTC midnight and `toISOString()` renders back in UTC, so round-tripping
// through them in a timezone ahead of UTC loses a day.
//
// ---- "Today" means the MADRID day, on every machine.
//
// Facundo trades on Spanish time, and since 2026-09-04 the statistics RPCs
// interpret their date range in Europe/Madrid too (supabase/migrations/
// 2026-09-04-stats-ranges-in-madrid.sql). Three clocks therefore have to agree:
// the database, the Node process rendering the server component, and the
// browser. Only the first was ever guaranteed — Cloudflare runs the dashboard
// in UTC while the person reading it is in Madrid, so a machine-local "today"
// would have the server defaulting to yesterday's date for the first two hours
// of every working day, and the browser disagreeing with it.
//
// So `todayIso()` asks for the Madrid day explicitly rather than reading the
// host's clock. That is the one place `Intl` is used, with a fixed timeZone and
// the `en-CA` locale, whose short date format IS `YYYY-MM-DD`.
//
// It is deliberately NOT the viewer's own timezone: the numbers on this page
// get quoted between people, and two colleagues saying "yesterday" to each
// other must mean the same day.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monday-first, matching the European convention the rest of the backoffice
 * uses (and Shopify's own picker under an es/en-GB locale). */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A `Date` → `YYYY-MM-DD` read from the HOST's calendar fields. Used by the
 * month-grid arithmetic below, which builds its Dates from parts and so is
 * already in host-local terms; for "what day is it" use `todayIso()`, which is
 * pinned to Madrid. */
export function isoLocalDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The calendar day it is in Madrid at instant `d`, whatever the host clock is
 * set to. `en-CA` renders `YYYY-MM-DD`, which is the shape every other function
 * here expects. */
export function isoMadridDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function todayIso(now: Date = new Date()): string {
  return isoMadridDay(now);
}

export function yesterdayIso(now: Date = new Date()): string {
  return addDays(todayIso(now), -1);
}

/** Split an ISO day into its parts. Returns `null` for anything malformed —
 * every caller here is fed either our own output or a URL param, and a bad URL
 * must degrade rather than throw. */
export function parseIsoDay(iso: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Days in a 1-indexed month. Day 0 of the next month is the last of this one. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Shift an ISO day by `n` days, staying on the local calendar (a `Date`
 * built from parts is local, and `setDate` handles month/year rollover and DST
 * for us). */
export function addDays(iso: string, n: number): string {
  const p = parseIsoDay(iso);
  if (!p) return iso;
  const d = new Date(p.year, p.month - 1, p.day);
  d.setDate(d.getDate() + n);
  return isoLocalDay(d);
}

/** Inclusive length of a range, in days. `from > to` gives 0 rather than a
 * negative — callers use this for a label, not for arithmetic. */
export function rangeLengthDays(from: string, to: string): number {
  const a = parseIsoDay(from);
  const b = parseIsoDay(to);
  if (!a || !b) return 0;
  const ms = new Date(b.year, b.month - 1, b.day).getTime() - new Date(a.year, a.month - 1, a.day).getTime();
  if (ms < 0) return 0;
  return Math.round(ms / 86_400_000) + 1;
}

/** `{ year, month }` shifted by whole months, 1-indexed, with year rollover. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

/**
 * The grid a month is drawn on: whole Monday-started weeks covering the month,
 * with `null` in the leading/trailing cells that belong to a neighbour. Six
 * weeks are never forced — a month that fits in five gets five, so the popover
 * doesn't grow an empty row.
 */
export function monthMatrix(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7; // JS weeks start Sunday; ours start Monday.
  const total = daysInMonth(year, month);
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(`${year}-${pad(month)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** `2026-09-04` → `4 Sep 2026`; the year is dropped when it is the current one,
 * which is the common case and the noisiest part of the label. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const p = parseIsoDay(iso);
  if (!p) return iso;
  const stem = `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
  return p.year === now.getFullYear() ? stem : `${stem} ${p.year}`;
}

/**
 * What the closed trigger button says. "Today" and "Yesterday" are named rather
 * than dated — that is the whole point of naming them — and any other range
 * reads as its endpoints, collapsed to one date when they're the same day.
 */
export function formatRangeLabel(from: string, to: string, now: Date = new Date()): string {
  const today = todayIso(now);
  if (from === today && to === today) return "Today";
  const yest = yesterdayIso(now);
  if (from === yest && to === yest) return "Yesterday";
  if (from === to) return formatDay(from, now);
  return `${formatDay(from, now)} – ${formatDay(to, now)}`;
}

/** Which of the three buttons is lit for a given range. Anything that isn't
 * exactly today or exactly yesterday is "custom" — including a 7-day window
 * ending today, which used to be a preset and is now just a range someone
 * picked. */
export function presetForRange(from: string, to: string, now: Date = new Date()): "today" | "yesterday" | "custom" {
  const today = todayIso(now);
  if (from === today && to === today) return "today";
  const yest = yesterdayIso(now);
  if (from === yest && to === yest) return "yesterday";
  return "custom";
}

/**
 * Whether the picker may offer a given day.
 *
 * Two reasons to refuse, and they are the same refusal to the person clicking:
 * the day is in the future, or we have nothing recorded for it (before the
 * first order, or a genuine gap like 2026-07-25 in production, which sits
 * between trading days on the 24th and the 26th).
 *
 * `activeDays === null` means "we could not find out" — the RPC is missing or
 * failed — and it deliberately allows every past day rather than none. A
 * calendar that refuses every date because a query broke is a locked door; one
 * that offers a day with nothing in it just shows an empty page that says so.
 */
export function isDaySelectable(
  iso: string,
  activeDays: ReadonlySet<string> | null,
  now: Date = new Date()
): boolean {
  if (iso > todayIso(now)) return false;
  // Today is ALWAYS offerable, even before its first order of the morning has
  // landed. It is the picker's default range, so blocking it would open the
  // control on a day it refuses to let you choose; and "nothing yet today" is a
  // fact worth being able to look at, not an invalid question.
  if (iso === todayIso(now)) return true;
  if (!activeDays) return true;
  return activeDays.has(iso);
}

/** The most recent selectable day at or before `iso`, or `null` if there is
 * none. Used to keep a range's endpoints off blocked days when the URL carries
 * one — a hand-edited link, or a range saved before the data was trimmed. */
export function lastSelectableOnOrBefore(
  iso: string,
  activeDays: ReadonlySet<string> | null,
  now: Date = new Date()
): string | null {
  if (!activeDays) return iso <= todayIso(now) ? iso : todayIso(now);
  let best: string | null = null;
  for (const d of activeDays) {
    if (d <= iso && (best === null || d > best)) best = d;
  }
  return best;
}
