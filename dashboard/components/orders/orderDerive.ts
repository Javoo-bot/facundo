// Shared derivation helpers for the Orders list + detail screens. Kept out of
// lib/** (read-only for this lane) — colocated with the screens that use them.
import type { AssignmentStatus, OrderStatus } from "@/lib/orderStatus";
import { formatDateTimeNoYear } from "./format.ts";
import type { CandidateEngagement } from "@/lib/candidateEngagement";

interface AssignmentLike {
  status: AssignmentStatus;
  florist_id: string;
  rank: number | null;
}

const INACTIVE: AssignmentStatus[] = ["declined", "expired", "reassigned", "released"];

/** The assignment staff currently care about for an order: the accepted one,
 * else the leading still-active candidate (lowest rank, nulls last). Mirrors
 * the selection logic in app/api/orders/reassign/route.ts so the UI's notion
 * of "current florist" matches what reassignment actually operates on. */
export function findLeadingAssignment<T extends AssignmentLike>(assignments: T[]): T | null {
  const accepted = assignments.find((a) => a.status === "accepted");
  if (accepted) return accepted;
  const active = assignments.filter((a) => !INACTIVE.includes(a.status));
  if (active.length === 0) return null;
  return active.reduce<T | null>((best, a) => {
    if (best == null) return a;
    if (a.rank == null) return best;
    if (best.rank == null) return a;
    return a.rank < best.rank ? a : best;
  }, null);
}

const ACCEPTED: AssignmentStatus[] = ["accepted", "delivered"];

/** The one assignment that counts as "the assignment" for display purposes —
 * a florist who has actually accepted (or gone on to deliver). Deliberately
 * NARROWER than `findLeadingAssignment`: a candidate that's merely been sent
 * an offer, or opened it, is a reach-out in progress, not an assignment (see
 * the Orders list Florist/Payout column and the Order detail top vitals +
 * Assignment card, which both use this). `findLeadingAssignment` still backs
 * reassignment/matching logic elsewhere — this only changes what's SHOWN as
 * "the florist". */
export function findAcceptedAssignment<T extends AssignmentLike>(assignments: T[]): T | null {
  return assignments.find((a) => ACCEPTED.includes(a.status)) ?? null;
}

const DONE_STATUSES: OrderStatus[] = ["delivered", "paid", "closed", "cancelled"];

/** SLA severity of an order's delivery deadline — null once the order is
 * past the "still needs delivering" phase, or when delivery_at is null/
 * unparsable (never NaN math). Thresholds mirror components/ui/SlaDot.tsx. */
export function deliverySeverity(status: OrderStatus, deliveryAt: string | null): "crit" | "warn" | null {
  if (DONE_STATUSES.includes(status)) return null;
  if (!deliveryAt) return null;
  const ms = new Date(deliveryAt).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 30 * 60 * 1000) return "crit";
  if (diff <= 2 * 60 * 60 * 1000) return "warn";
  return null;
}

/** Orders that belong in the "needs attention" bucket: escalated, or an
 * undelivered order whose SLA is already critical. */
export function isAttention(status: OrderStatus, deliveryAt: string | null): boolean {
  return status === "escalated" || deliverySeverity(status, deliveryAt) === "crit";
}

// delivered/paid/closed are the forward path through an order that WAS
// delivered (closed is only reachable via paid, which is only reachable via
// delivered — see lib/orderStatus.ts's FORWARD map). cancelled is a separate
// terminal branch where delivery never happened, so it reads "—" rather than
// "Done" below.
const DELIVERED_STATUSES: OrderStatus[] = ["delivered", "paid", "closed"];

/** Compact "time left to deliver" for the Orders list — a future
 * `delivery_at` renders as `3d left` / `6h left` / `<1h left`; a past one on
 * an order still in flight renders `Overdue`; an order that has already gone
 * through delivery renders `Done`; anything else (cancelled, no delivery_at,
 * unparsable date) renders `—`. */
export function deliveryCountdown(status: OrderStatus, deliveryAt: string | null): string {
  if (DELIVERED_STATUSES.includes(status)) return "Done";
  if (status === "cancelled") return "—";
  if (!deliveryAt) return "—";
  const ms = new Date(deliveryAt).getTime();
  if (Number.isNaN(ms)) return "—";
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "Overdue";
  const hours = diffMs / (60 * 60 * 1000);
  if (hours < 1) return "<1h left";
  if (hours < 24) return `${Math.round(hours)}h left`;
  return `${Math.round(hours / 24)}d left`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ONE concise deadline signal for scanning — deliberately replaces showing
 * both a full delivery date/time AND a separate countdown (flower delivery is
 * always near-term, so the year is never useful and the two together are
 * redundant). `Today 18:00` / `Tomorrow 10:00` within the next day, a weekday
 * short-form (`Mon 15:00`) out to a week, then a dateless-year fallback
 * beyond that. `Overdue` past the deadline while still in flight; `Done` once
 * delivery has actually happened; `—` for cancelled/unknown. Pair with
 * `deliverySeverity` for the chip's urgency tone. */
export function deliveryDeadlineLabel(status: OrderStatus, deliveryAt: string | null): string {
  if (DELIVERED_STATUSES.includes(status)) return "Done";
  if (status === "cancelled") return "—";
  if (!deliveryAt) return "—";
  const ms = new Date(deliveryAt).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms <= Date.now()) return "Overdue";
  const time = new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dayDiff = Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86_400_000);
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff >= 2 && dayDiff <= 6) {
    const weekday = new Date(ms).toLocaleDateString([], { weekday: "short" });
    return `${weekday} ${time}`;
  }
  return formatDateTimeNoYear(deliveryAt);
}

/** Coarse, human-rounded duration label — never live/second-precision.
 * <1m → "<1m"; <1h → "40m"; <24h → "5h"; <7d → "2d"; ≥7d → "1w 3d" (or "2w" with no remainder). */
export function roundedDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const minutes = clamped / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = clamped / 3_600_000;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(clamped / 86_400_000);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  const remDays = days % 7;
  return remDays > 0 ? `${weeks}w ${remDays}d` : `${weeks}w`;
}

/** "In system" — how long since the order was created. "—" for missing/unparsable dates. */
export function orderAgeLabel(createdAt: string | null, now: number = Date.now()): string {
  if (!createdAt) return "—";
  const ms = new Date(createdAt).getTime();
  if (Number.isNaN(ms)) return "—";
  return roundedDuration(now - ms);
}

/** "Due in" — coarse countdown to delivery_at, mirroring deliveryDeadlineLabel's
 * done/cancelled/unknown handling but rendering a rounded duration instead of a
 * clock time. Past-due (still in flight) reads "Overdue 5h" style. */
export function dueInLabel(status: OrderStatus, deliveryAt: string | null, now: number = Date.now()): string {
  if (DELIVERED_STATUSES.includes(status)) return "Done";
  if (status === "cancelled") return "—";
  if (!deliveryAt) return "—";
  const ms = new Date(deliveryAt).getTime();
  if (Number.isNaN(ms)) return "—";
  const diff = ms - now;
  if (diff <= 0) return `Overdue ${roundedDuration(-diff)}`;
  return roundedDuration(diff);
}

function stringField(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

interface DeliveryLocationLike {
  delivery_address: Record<string, unknown> | null;
  delivery_area: string | null;
}

/** City for the Orders list — prefers the structured `delivery_address.city`
 * Shopify gives us, falling back to the first `·`-joined segment of
 * `delivery_area` (written as `[city, province].join(" · ")`, see
 * ingest-worker/src/shopify.ts) for rows missing the structured field. */
export function deriveCity(order: DeliveryLocationLike): string {
  const city = stringField(order.delivery_address?.city);
  if (city) return city;
  const [first] = (order.delivery_area ?? "").split("·");
  return stringField(first) ?? "—";
}

/** Country for the Orders list — prefers `delivery_address.country`/
 * `country_code` (Shopify's ISO country code). `delivery_area`'s segment
 * after `·` is actually a province/state, not a country, so it's only used
 * as a last-resort fallback when the structured field is missing. */
export function deriveCountry(order: DeliveryLocationLike): string {
  const addr = order.delivery_address;
  const country = stringField(addr?.country) ?? stringField(addr?.country_code);
  if (country) return country;
  const parts = (order.delivery_area ?? "").split("·");
  return parts.length > 1 ? stringField(parts[1]) ?? "—" : "—";
}

interface ReachoutAssignmentLike {
  id: string;
  status: AssignmentStatus;
}

export interface ReachoutStats {
  sent: number;
  opened: number;
  clicked: number;
  signedIn: number;
  declined: number;
}

// Statuses that only exist once an offer actually went out — i.e. "sent" is
// true even without engagement evidence (a florist who never opens the offer
// is still a florist we sent it to).
const SENT_OR_LATER: AssignmentStatus[] = ["sent", "opened", "declined", "expired", "accepted", "reassigned", "delivered", "released"];

/** Reach-outs stats bar counts: sent/opened straight from the assignment
 * status (reliable even without an engagement lookup — see
 * lib/candidateEngagement.ts, which is a best-effort join over auth/delivery
 * logs and may be entirely absent), clicked/signed-in from the finer-grained
 * `CandidateEngagement` trail (there's no assignment-status equivalent for
 * those), and declined from the assignment status per the design brief. */
export function reachoutStats<T extends ReachoutAssignmentLike>(
  assignments: T[],
  engagement?: Record<string, CandidateEngagement>
): ReachoutStats {
  let sent = 0, opened = 0, clicked = 0, signedIn = 0, declined = 0;
  for (const a of assignments) {
    const e = engagement?.[a.id];
    if (e?.at.sent || SENT_OR_LATER.includes(a.status)) sent++;
    if (e?.at.opened || a.status === "opened" || a.status === "accepted" || a.status === "delivered") opened++;
    if (e?.at.clicked) clicked++;
    if (e?.at.signed_in) signedIn++;
    if (a.status === "declined") declined++;
  }
  return { sent, opened, clicked, signedIn, declined };
}
