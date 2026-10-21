/** Turns the stored `florists.business_hours` jsonb into the seven per-day rows
 * the join form edits, and back again.
 *
 * WHY this exists: `business_hours` has no enforced schema. Staff-entered data
 * uses GROUPED keys — `{"mon_fri":"09:00-20:00","sat":"09:00-15:00"}`, see
 * supabase/seed/2026-07-13-florist-demo.sql and the `dayLabel` note in
 * components/florist/floristOps.ts — while the join form writes per-day keys.
 * The old form only understood per-day keys and silently dropped everything
 * else, so the grid rendered blank for exactly the florists whose hours we
 * already knew. Expanding grouped keys here is what makes "pre-filled if we
 * know them" actually true.
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it —
 * same constraint as lib/phone.ts and lib/floristTime.ts. Pure: no I/O, no
 * Date.now().
 */

export const HOUR_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type HourDay = (typeof HOUR_DAYS)[number];
export type BusinessHours = Partial<Record<HourDay, string>>;

/** The weekday block the form summarises as one row. Saturday and Sunday are
 * broken out because that is where florists actually differ. */
export const WEEKDAYS: readonly HourDay[] = ["mon", "tue", "wed", "thu", "fri"];

export const DEFAULT_OPEN = "09:00";
export const DEFAULT_CLOSE = "19:00";

export interface DayRow {
  day: HourDay;
  closed: boolean;
  open: string;
  close: string;
  /** The SECOND opening block, for a day with a midday closure — the
   * Mediterranean lunch break, which is the normal shape of a florist's day in
   * ES/FR/IT/PT and therefore in most of our markets. Null when the shop is
   * open straight through, which is the common case elsewhere.
   *
   * Stored as a second range on the same value: "09:00-13:00,16:00-20:00".
   * `business_hours` is schema-less jsonb, so this needed no migration — only
   * this module, the form that edits it, and the validator that guards it. */
  open2: string | null;
  close2: string | null;
}

const TIME_RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Splits a stored value into its one or two ranges, or null if any part of it
 * is unparseable. All-or-nothing on purpose: half-understanding "09:00-13:00,
 * garbage" and storing just the morning would quietly shorten a shop's day. */
export function parseRanges(value: string): { open: string; close: string }[] | null {
  const parts = value.trim().split(",");
  if (parts.length > 2) return null;
  const out: { open: string; close: string }[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!TIME_RANGE_RE.test(trimmed)) return null;
    out.push({ open: trimmed.slice(0, 5), close: trimmed.slice(6, 11) });
  }
  // Ordered and non-overlapping, so the two blocks describe a real day.
  if (out.length === 2 && out[1].open <= out[0].close) return null;
  return out;
}

function dayIndex(day: string): number {
  return (HOUR_DAYS as readonly string[]).indexOf(day);
}

/** Expands one stored key into the days it covers.
 *
 * Handles a bare day ("sat"), an explicit range ("mon_fri", "sat_sun"), and
 * wrap-around ranges ("sun_thu") — a real if uncommon shape for shops that
 * close midweek. Returns an empty array for anything we don't recognise, which
 * the caller drops: an unparseable key must not become a fabricated row. */
export function expandDayKey(key: string): HourDay[] {
  const parts = key.toLowerCase().trim().split("_").filter(Boolean);
  if (parts.length === 1) {
    const i = dayIndex(parts[0]);
    return i === -1 ? [] : [HOUR_DAYS[i]];
  }
  if (parts.length !== 2) return [];
  const from = dayIndex(parts[0]);
  const to = dayIndex(parts[1]);
  if (from === -1 || to === -1) return [];
  const out: HourDay[] = [];
  // Inclusive walk forward, wrapping at Sunday. Bounded by the week length, so
  // from === to yields the single day rather than looping.
  for (let n = 0; n < HOUR_DAYS.length; n++) {
    const i = (from + n) % HOUR_DAYS.length;
    out.push(HOUR_DAYS[i]);
    if (i === to) break;
  }
  return out;
}

/** The seven rows to render, given whatever is stored.
 *
 * Unknown/unparseable values are ignored rather than guessed at. Days no stored
 * key covers fall back to the defaults: open 09:00–19:00 Monday to Saturday,
 * closed Sunday.
 *
 * When two keys cover the same day, the MORE SPECIFIC one wins — `{"mon_fri":
 * "09:00-20:00","wed":"10:00-14:00"}` means Wednesday is short, which is how
 * any human reads it. Resolving by key order instead would make the same data
 * mean different things depending on how the JSON happened to be serialised. */
export function toDayRows(stored: Record<string, unknown> | null | undefined): DayRow[] {
  const assigned = new Map<HourDay, DayRow>();

  const entries = Object.entries(stored ?? {})
    .map(([key, value]) => ({ key, value, days: expandDayKey(key) }))
    .filter((e) => e.days.length > 0)
    .sort((a, b) => a.days.length - b.days.length);

  for (const { value, days } of entries) {
    if (typeof value !== "string") continue;
    const raw = value.trim().toLowerCase();
    const isClosed = raw === "closed";
    const ranges = isClosed ? null : parseRanges(value);
    if (!isClosed && !ranges) continue;

    for (const day of days) {
      if (assigned.has(day)) continue;
      assigned.set(
        day,
        isClosed
          ? { day, closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE, open2: null, close2: null }
          : {
              day,
              closed: false,
              open: ranges![0].open,
              close: ranges![0].close,
              open2: ranges![1]?.open ?? null,
              close2: ranges![1]?.close ?? null,
            }
      );
    }
  }

  return HOUR_DAYS.map(
    (day) =>
      assigned.get(day) ?? {
        day,
        closed: day === "sun",
        open: DEFAULT_OPEN,
        close: DEFAULT_CLOSE,
        open2: null,
        close2: null,
      }
  );
}

/** True when all five weekdays share one state, so the form can collapse them
 * into a single "Open Mon–Fri" row. When they disagree the form opens the
 * per-day grid expanded instead — a summary row that averaged them away would
 * be a lie about data we actually hold. */
export function weekdaysAgree(rows: DayRow[]): boolean {
  const weekdayRows = rows.filter((r) => WEEKDAYS.includes(r.day));
  if (weekdayRows.length < WEEKDAYS.length) return false;
  const [first, ...rest] = weekdayRows;
  return rest.every(
    (r) =>
      r.closed === first.closed &&
      r.open === first.open &&
      r.close === first.close &&
      // A week where Monday has a lunch break and Tuesday doesn't is a week the
      // summary row would misrepresent, same as any other disagreement.
      r.open2 === first.open2 &&
      r.close2 === first.close2
  );
}

/** Rows → the per-day map we store. Closed days are kept explicitly ("closed")
 * rather than omitted: an absent day means "we don't know", and after a florist
 * has looked at this grid we do know. A row with a blank time is dropped —
 * that's the only genuinely unknown case left. */
export function toBusinessHours(rows: DayRow[]): BusinessHours | null {
  const value: BusinessHours = {};
  for (const row of rows) {
    if (row.closed) {
      value[row.day] = "closed";
    } else if (row.open && row.close) {
      const second = row.open2 && row.close2 ? `,${row.open2}-${row.close2}` : "";
      value[row.day] = `${row.open}-${row.close}${second}`;
    }
  }
  return Object.keys(value).length > 0 ? value : null;
}

/** Rows whose close time isn't after their open time. The server
 * (lib/floristAccept.ts) rejects these too; the form uses this to flag them
 * before a round trip. */
export function invalidRows(rows: DayRow[]): DayRow[] {
  return rows.filter((r) => {
    if (r.closed) return false;
    if (!r.open || !r.close || r.close <= r.open) return true;
    // A half-filled break — one of the two times set — is as unusable as a
    // backwards one, and much easier to leave behind by accident.
    if (!r.open2 !== !r.close2) return true;
    if (r.open2 && r.close2) {
      if (r.close2 <= r.open2) return true;
      // The afternoon must start after the morning ends, or the "break" is an
      // overlap and we cannot say when the shop is actually shut.
      if (r.open2 <= r.close) return true;
    }
    return false;
  });
}
