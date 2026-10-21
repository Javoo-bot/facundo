// The single source of truth for order → colour and order → priority across the
// whole staff backoffice. Every list, row, and badge reads from here so the
// hybrid scheme (attention overrides stage hue) is uniform everywhere.
//
// Pure + import-free at runtime (only `import type`, which is erased) so it can
// be unit-tested under node's native type-stripping — the same pattern as
// lib/orderStages.ts and lib/cxAlertRules.ts. Time is injected (`now`) with a
// Date.now() default so tests are deterministic.
//
// Semantics mirror lib/cxAttention.ts (the server-side CX desk) but operate
// synchronously on one already-fetched order row: cxAttention gathers across
// tables for the CX queue; this classifies a single row for its colour + sort.

import { ORDER_STATUS_LABEL, type OrderStatus, type AssignmentStatus } from "./orderStatus.ts";

/** Row/stage tones. `crit`/`warn` are the attention overrides (red/amber);
 *  the rest are the muted per-stage hues; `done` is grey (closed/cancelled). */
export type Tone =
  | "crit" | "warn"
  | "created" | "matched" | "outreach" | "fulfilment" | "delivery" | "delivered"
  | "done";

// Each order status' muted stage hue (used when nothing needs attention).
// escalated/cancelled never reach here as a hue in practice (attention/terminal),
// but are mapped for totality.
const STAGE_HUE: Record<OrderStatus, Tone> = {
  received: "created",
  matched: "matched",
  reaching_out: "outreach",
  accepted: "fulfilment",
  in_production: "fulfilment",
  ready: "fulfilment",
  out_for_delivery: "delivery",
  delivered: "delivered",
  paid: "delivered",
  closed: "done",
  escalated: "crit",
  cancelled: "done",
};

/** The stage hue for a status, ignoring attention. */
export function stageHue(status: OrderStatus): Tone {
  return STAGE_HUE[status];
}

/** Minimal, structural shape this module classifies — a superset of what every
 *  caller already has on an order row. Extra fields are ignored. */
export interface OrderVisualInput {
  status: OrderStatus;
  delivery_at?: string | null;
  /** The order's assignments (any still-active offer keeps reach-out "live"). */
  assignments?: { status: AssignmentStatus }[] | null;
  /** Caller sets true when a payout leg is held / a delivery photo is in review
   *  — keeps a delivered order visible + amber until the money is settled. */
  moneyHeld?: boolean | null;
  /** Candidate count; a matched/received order with 0 means matching failed. */
  candidateCount?: number | null;
}

export interface Attention {
  attn: boolean;
  severity: "crit" | "warn" | null;
  reason: string | null;
}

const NONE: Attention = { attn: false, severity: null, reason: null };
const IN_FLIGHT: OrderStatus[] = ["accepted", "in_production", "ready", "out_for_delivery"];
const DONE_CLEAN: OrderStatus[] = ["delivered", "paid", "closed"];
// A "live" offer is one the florist can still act on. Matches cxAttention.ts's
// live set (["sent","opened"]) so the two agree — NOT `queued`, which in
// semi/step mode sits awaiting a human approval (cxAttention flags that
// separately), nor `candidate`. `accepted` is included defensively (a
// reaching_out order with an accepted assignment isn't stuck).
const LIVE_OFFER: AssignmentStatus[] = ["sent", "opened", "accepted"];

const HOUR = 60 * 60 * 1000;

// Shared literal so `secondaryChips` can recognize "the primary reason IS the
// payout hold" without re-deriving the predicate — see requiresAttention §3.
const PAYOUT_REASON = "Payout needs review";

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The single attention predicate: is this order blocked on a human or breaching
 *  an SLA, and how badly. Order of checks encodes precedence (most decisive
 *  first). Null-safe on every field. */
export function requiresAttention(o: OrderVisualInput, now: number = Date.now()): Attention {
  // 1. Escalated — a raised issue, always critical.
  if (o.status === "escalated") return { attn: true, severity: "crit", reason: "Escalated" };
  // 2. Cancelled — terminal, never attention.
  if (o.status === "cancelled") return NONE;
  // 3. Money stuck on ANY leg at ANY stage — held (photo in review) or a failed
  //    rail. The accept-leg payout issues while the order is still in fulfilment
  //    (long before `delivered`), so this must NOT be gated on delivered/paid:
  //    the caller sets `moneyHeld` from a held/failed payout on any assignment.
  if (o.moneyHeld) return { attn: true, severity: "warn", reason: PAYOUT_REASON };
  // 4. Otherwise a clean done order is settled.
  if (DONE_CLEAN.includes(o.status)) return NONE;
  // 5. Reaching out but no live offer (all candidates declined/expired) — stuck.
  if (o.status === "reaching_out" && o.assignments) {
    const live = o.assignments.some((a) => LIVE_OFFER.includes(a.status));
    if (!live) return { attn: true, severity: "crit", reason: "No live offer — needs next florist" };
  }
  // 6. Matched but zero candidates — matching produced nothing. (received is
  //    excluded: it's simply awaiting the matcher, not stuck.)
  if (o.status === "matched" && o.candidateCount === 0) {
    return { attn: true, severity: "crit", reason: "No florist matched" };
  }
  // 7. Delivery SLA on any remaining undelivered order.
  const dl = parseTime(o.delivery_at);
  if (dl != null) {
    const diff = dl - now;
    if (diff <= 0 && IN_FLIGHT.includes(o.status)) return { attn: true, severity: "crit", reason: "Overdue — past delivery window" };
    if (diff <= 0) return { attn: true, severity: "crit", reason: "Overdue" };
    if (diff <= 30 * 60 * 1000) return { attn: true, severity: "crit", reason: "Delivery SLA critical" };
    if (diff <= 2 * HOUR) return { attn: true, severity: "warn", reason: "Delivery due soon" };
  }
  return NONE;
}

/** Hybrid row tone: attention (crit/warn) overrides; else the stage hue. */
export function orderTone(o: OrderVisualInput, now?: number): Tone {
  const a = requiresAttention(o, now);
  if (a.severity === "crit") return "crit";
  if (a.severity === "warn") return "warn";
  return stageHue(o.status);
}

/** Triage priority: 0 requires attention · 1 awaiting acceptance · 2 in
 *  progress · 3 done. Drives the default Orders sort + the "hide completed"
 *  filter (completed === priority 3, which by construction excludes attention). */
export function orderPriority(o: OrderVisualInput, now?: number): 0 | 1 | 2 | 3 {
  if (requiresAttention(o, now).attn) return 0;
  const s = o.status;
  if (s === "received" || s === "matched" || s === "reaching_out") return 1;
  if (s === "accepted" || s === "in_production" || s === "ready" || s === "out_for_delivery") return 2;
  return 3;
}

/** A completed order that the Orders list hides by default. Delivered-with-held
 *  money is priority 0 (attention), so it is NOT completed and stays visible. */
export function isCompleted(o: OrderVisualInput, now?: number): boolean {
  return orderPriority(o, now) === 3;
}

/** Default Orders sort: priority asc, then delivery deadline asc (nulls last). */
export function compareOrders(a: OrderVisualInput, b: OrderVisualInput, now?: number): number {
  const pa = orderPriority(a, now);
  const pb = orderPriority(b, now);
  if (pa !== pb) return pa - pb;
  const da = parseTime(a.delivery_at);
  const db = parseTime(b.delivery_at);
  const na = da == null ? Infinity : da;
  const nb = db == null ? Infinity : db;
  if (na !== nb) return na - nb;
  return 0;
}

/** CSS class for a table row's tone stripe/tint (see design-system.css). */
export function toneRowClass(t: Tone): string {
  return `row-tone-${t}`;
}

/** CSS class for a `.badge-*` element in a given tone (see design-system.css).
 *  `done` has no dedicated badge hue — it reuses the neutral badge, matching
 *  how `closed`/`cancelled` were already styled before this module existed. */
export function toneBadgeClass(t: Tone): string {
  return t === "done" ? "badge-neutral" : `badge-${t}`;
}

/** A single labelled, toned chip — the shared shape for both the row's
 *  primary indicator and its demoted secondary notes. */
export interface StatusChip {
  label: string;
  tone: Tone;
}

/** The ONE primary signal a row should lead with: the attention reason when
 *  `requiresAttention` fires (colored crit/warn), else the plain stage label
 *  (colored by stage hue). Every other per-row signal — payment, SLA, etc. —
 *  is secondary and must not visually compete with this (see
 *  `secondaryChips`). Centralizing this in one pure helper keeps the "what's
 *  the headline status" decision out of JSX. */
export function primaryChip(o: OrderVisualInput, now?: number): StatusChip {
  const a = requiresAttention(o, now);
  if (a.attn) return { label: a.reason ?? "Needs attention", tone: a.severity === "crit" ? "crit" : "warn" };
  return { label: ORDER_STATUS_LABEL[o.status], tone: stageHue(o.status) };
}

/** Signals that are real but not already voiced by the primary chip — kept
 *  quiet (never crit/warn-red) so a scanning eye reads "needs attention
 *  because X" first and "also Y" second, rather than two equally loud
 *  indicators fighting for attention. Today this is just the payout-held
 *  flag: `requiresAttention` already PROMOTES it to the primary reason
 *  whenever it's the most decisive thing wrong with the order (see its §3),
 *  so it only surfaces here when something else (escalation) outranked it. */
export function secondaryChips(o: OrderVisualInput, now?: number): StatusChip[] {
  const chips: StatusChip[] = [];
  if (o.moneyHeld) {
    const a = requiresAttention(o, now);
    const isPrimaryReason = a.attn && a.reason === PAYOUT_REASON;
    if (!isPrimaryReason) chips.push({ label: "Payment held", tone: "warn" });
  }
  return chips;
}

// The one financial_status value Shopify orders normally settle at — the
// quiet default that isn't worth calling out on a row a staffer is scanning
// for what needs action.
const QUIET_FINANCIAL_STATUS = "paid";

/** Whether an order's payment state is worth a staffer's attention: a held/
 *  failed payout leg, or a Shopify `financial_status` other than the quiet
 *  "paid" default (refunded, voided, pending, etc). Null/missing status is
 *  NOT notable — most orders haven't had Shopify populate it yet and that's
 *  normal, not a blocker. Lets the Orders list/detail money cells stay muted
 *  for the common case and only speak up when something's actually stuck. */
export function paymentNeedsAttention(financialStatus: string | null | undefined, moneyHeld: boolean): boolean {
  if (moneyHeld) return true;
  if (!financialStatus) return false;
  return financialStatus.trim().toLowerCase() !== QUIET_FINANCIAL_STATUS;
}
