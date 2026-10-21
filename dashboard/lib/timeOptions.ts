/** Option list for the opening-hours time picker
 * (components/florist/TimeSelect.tsx).
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it —
 * same convention as lib/floristAccept.ts and lib/businessHours.ts. It lives
 * here rather than in the component because the component is TSX, which
 * node's type stripping can't load. */

/** Minutes between generated options. Thirty covers essentially every shop's
 * opening hour; anything finer turns the list into a scroll marathon for a
 * value nobody picks. An off-grid stored time is still offered — see
 * `timeOptions` — so the coarser grid can never silently round real data. */
export const STEP_MINUTES = 30;

const pad = (n: number) => String(n).padStart(2, "0");

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The half-hour grid across a full day, plus `value` if it isn't on it.
 *
 * That last part is the point: a shop whose stored hours say 09:15 — from the
 * ingest's scraped hours, or from before this control replaced the native time
 * input — must see its own time in the list, in the right place. Without it
 * the picker would present 09:00 or 09:30 as what we hold, and the florist
 * would have no way to tell it apart from a value they chose.
 *
 * A malformed or empty value contributes nothing; the caller renders whatever
 * it holds on the trigger regardless, so nothing is hidden either way. */
export function timeOptions(value: string): string[] {
  const grid: string[] = [];
  for (let m = 0; m < 24 * 60; m += STEP_MINUTES) grid.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  if (!HHMM.test(value) || grid.includes(value)) return grid;
  const at = grid.findIndex((t) => t > value);
  return at === -1 ? [...grid, value] : [...grid.slice(0, at), value, ...grid.slice(at)];
}
