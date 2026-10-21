// The Control panel's table: its row shape, its filters, the one label it has
// to invent, and the single rule that decides when a human is needed.
//
// The panel answers exactly one question — WHICH ORDER DO I HANDLE FIRST? — for
// someone who has never seen this system before. Its columns and filters are
// Shopify's vocabulary (order number, destination, delivery date) plus the
// order's own status chip, because an operator opening the tab on a Monday
// morning already knows what those words mean.
//
// WHAT IS NOT HERE, deliberately:
//
//   - WHICH orders. That is lib/cxAttention.ts::gatherAttention — the same
//     prioritised, working-set-gated gather that feeds the sidebar badge. This
//     file only narrows and labels what that returns, so the badge and the table
//     can never disagree about how many things need a human.
//   - The RANKING. That is lib/operator.ts::byDeadline: most-overdue first, then
//     soonest. Ordering by the clock rather than by our urgency score is the
//     whole point — the operator can see a delivery date and cannot see a score,
//     so a list sorted by the invisible one reads as unsorted.
//   - The STATUS WORDS. Those are lib/orderVisual.ts::primaryChip, used verbatim
//     — the same function /orders calls, so one order reads identically on both
//     pages. See controlChip below.
//
// Pure and dependency-free apart from two same-directory imports that are
// themselves import-free, so plain `node --test` can exercise it — same
// convention as lib/callCard.ts and lib/orderVisual.ts.

import type { AssignmentStatus, OrderStatus } from "./orderStatus.ts";
import { primaryChip, type StatusChip } from "./orderVisual.ts";

/** The assignment facts this module reasons about. A structural subset of
 *  `order_assignments`, so tests build them by hand. */
export interface ControlAssignment {
  status: AssignmentStatus;
  withdrawnAt: string | null;
}

/** One row of the Control panel table, fully resolved on the server. */
export interface ControlRow {
  id: string;
  orderName: string | null;
  /** "Girona, ES" — built by components/orders/orderDerive.ts, the same
   *  derivation /orders uses, so the two cannot drift. */
  destination: string;
  /** Our workflow state. Feeds the status chip and half the button rule. */
  status: OrderStatus;
  deliveryAt: string | null;
  deliveryWindow: string | null;
  /** Every assignment on the order, for the chip and the button rule. */
  assignments: ControlAssignment[];
  /** Why this order is in the queue, in cxAttention's words. NOT rendered as a
   *  label: that vocabulary names actions the operator does not have on this
   *  page ("Approve offer to send", "Needs next florist"). It survives as the
   *  row's hover title, and it still colours the row. */
  reason: string;
  severity: "crit" | "warn";
}

// ── the status chip ────────────────────────────────────────────────────────

/**
 * The order's status, in production's own words.
 *
 * `primaryChip` is used VERBATIM — the same function `components/orders/
 * OrdersClient.tsx` calls for the /orders STATUS column. That is the point: the
 * same order must read identically on both pages, so an operator moving between
 * them is never asked to learn a second vocabulary for the same fact.
 *
 * There is deliberately NO fallback to the cxAttention reason when the chip
 * comes back calm. Those reasons name actions this page does not offer, and a
 * label that implies a button which is not there is worse than a calm word.
 * Measured on the real production working set (3 Sept 2026), the chip is loud
 * on 7 of 8 rows anyway.
 */
export function controlChip(row: Pick<ControlRow, "status" | "deliveryAt" | "assignments">, now?: number): StatusChip {
  return primaryChip(
    {
      status: row.status,
      delivery_at: row.deliveryAt,
      assignments: row.assignments.map((a) => ({ status: a.status })),
      candidateCount: row.assignments.length,
    },
    now
  );
}

// ── the button rule ────────────────────────────────────────────────────────

/**
 * Assignment states meaning "we emailed them and they never answered".
 *
 * Narrower than `lib/callCard.ts::CALLABLE_STATUSES`, which also carries
 * `accepted` and `delivered`. That set serves the call SCREEN, which is also
 * used to chase a shop that already said yes. This one serves the question the
 * flow diagram asks — who went silent — so:
 *
 *   `declined`            an answer, not a gap. Never phoned; with the payout
 *                         fixed there is no lever to reopen it with.
 *   `accepted`/`delivered` answers too. A shop that accepted and then went
 *                         quiet belongs to the chase_photo flow, not to
 *                         placing the order somewhere else.
 *   `candidate`/`queued`   never emailed, so there is nobody to ring.
 *   `reassigned`/`released` we withdrew the offer; not their answer to give.
 */
export const EMAILED_AND_SILENT: AssignmentStatus[] = ["sent", "opened", "expired"];

/** Did we email this shop and never hear back? */
export function isSilentAfterEmail(a: ControlAssignment): boolean {
  return !a.withdrawnAt && EMAILED_AND_SILENT.includes(a.status);
}

/**
 * Should this row offer "Contact florist"?
 *
 * Straight off `docs/order-flow/3-system-order-to-florist.md`:
 *
 *     MORE{"Anyone left to ask?"} --> |yes| D["Emailed straight away"]
 *     MORE --> |no|  CALL["Nobody answered — the desk phones them"]
 *
 * So: call when there is nobody left to EMAIL, and call the shops that were
 * emailed and stayed silent.
 *
 * WHY `escalated` IS "NOBODY LEFT TO ASK". It is not a count of `candidate`
 * rows — that would disagree with the engine. Production carries orders with
 * thirteen untried candidates that will never be offered, because the wave
 * ceiling is `match_max_waves × match_top_n` and they are long past it. The
 * engine records its own answer to that question by escalating the order, with
 * the reason attached (`pool_exhausted`, `candidates_exhausted`,
 * `wave_ceiling`, `out_of_time`, `past_delivery_deadline`,
 * `accept_sla_breach_no_candidates` — see lib/waves.ts and lib/waveGuards.ts).
 * `advanceWaves()` then never selects that order again. Reading the status means
 * this panel and the wave engine cannot drift.
 *
 * A row that fails this shows NO button rather than a disabled one. Two ways it
 * gets there, and the operator's move differs: still emailing (not yours yet),
 * or escalated with everyone refused (open the order and find more florists,
 * which un-escalates it and hands it back to automation).
 */
export function showContactFlorist(row: Pick<ControlRow, "status" | "assignments">): boolean {
  if (row.status !== "escalated") return false;
  return row.assignments.some(isSilentAfterEmail);
}

// ── how long is left ───────────────────────────────────────────────────────

/**
 * Time to delivery, coarse on purpose.
 *
 * Days, or hours when it is tight. **Never minutes and never seconds.** The old
 * `hh:mm:ss` countdown ticked every second and was precise about something
 * nobody acts on to that precision: an operator deciding what to pick up next
 * needs "today" versus "next week", not "04:12:37". A number that changes every
 * second also drags the eye to whichever row happens to be counting.
 */
export function timeLeftLabel(deliveryAt: string | null | undefined, now: number = Date.now()): string {
  if (!deliveryAt) return "—";
  const at = Date.parse(deliveryAt);
  if (Number.isNaN(at)) return "—";
  const ms = at - now;
  if (ms <= 0) return "Overdue";
  const hours = ms / 3_600_000;
  if (hours < 1) return "Under an hour";
  if (hours < 24) {
    const h = Math.floor(hours);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(hours / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

// ── filters ────────────────────────────────────────────────────────────────

export interface ControlFilters {
  /** Substring of the order number. */
  order?: string;
  /** Exact destination, as rendered. */
  destination?: string | null;
  /** Selected status chip LABELS, empty = all. */
  status?: readonly string[];
  /** Inclusive calendar dates, `YYYY-MM-DD`. */
  from?: string | null;
  to?: string | null;
}

/** The calendar date part of an ISO instant, or null when there is no date. */
function isoDay(at: string | null): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Narrow the queue to what the operator asked for.
 *
 * Every clause is skipped when its filter is empty, so no filters means every
 * row — the panel's default is the whole queue, never an accidentally empty
 * table.
 *
 * A row with NO delivery date survives the date filters. It cannot be compared,
 * and dropping it would hide work: an order needing a human with no date is
 * more alarming than one with a date, not less.
 */
export function applyControlFilters<T extends ControlRow>(
  rows: readonly T[],
  filters: ControlFilters = {},
  now?: number
): T[] {
  const q = (filters.order ?? "").trim().toLowerCase();
  const dest = (filters.destination ?? "").trim();
  const statuses = filters.status ?? [];
  const from = (filters.from ?? "").trim() || null;
  const to = (filters.to ?? "").trim() || null;

  return rows.filter((r) => {
    if (q) {
      // The id is matched too so a row with no order number is still findable.
      const hay = `${r.orderName ?? ""} ${r.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (dest && r.destination !== dest) return false;
    if (statuses.length > 0 && !statuses.includes(controlChip(r, now).label)) return false;
    if (from || to) {
      const day = isoDay(r.deliveryAt);
      if (day != null) {
        if (from && day < from) return false;
        if (to && day > to) return false;
      }
    }
    return true;
  });
}

/** Distinct destinations on screen, alphabetical. "Options reflect this page
 *  only" — the same contract the /orders filters make. */
export function destinationOptions(rows: readonly ControlRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const d = r.destination.trim();
    if (d && d !== "—") seen.add(d);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Distinct status LABELS on screen — the strings the column actually shows, so
 *  ticking one cannot fail to match a visible row. */
export function statusOptions(rows: readonly ControlRow[], now?: number): string[] {
  const seen = new Set<string>();
  for (const r of rows) seen.add(controlChip(r, now).label);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** How many filters are actually narrowing the list — the "Clear filters"
 *  affordance only makes sense when this is above zero. */
export function activeFilterCount(filters: ControlFilters): number {
  return (
    ((filters.order ?? "").trim() ? 1 : 0) +
    ((filters.destination ?? "").trim() ? 1 : 0) +
    ((filters.status ?? []).length > 0 ? 1 : 0) +
    ((filters.from ?? "").trim() ? 1 : 0) +
    ((filters.to ?? "").trim() ? 1 : 0)
  );
}
