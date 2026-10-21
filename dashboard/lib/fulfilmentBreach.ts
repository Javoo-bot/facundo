// Pure detection logic for the accept-SLA auto-reoffer (lib/waves.ts): a
// florist accepted an order and then went dark (never delivered, no progress
// photo) — decide whether that's breached badly enough to auto-hand the
// order back to the wave for the next candidate. Kept dependency-free (no
// Supabase) so it's unit-testable; lib/waves.ts does the DB reads and calls
// reassignOrder when this returns true.

export interface FulfilmentBreachInput {
  /** The held assignment's binding SLA (order_assignments.sla_deadline_at) —
   *  set at match/candidate time as roughly delivery_at minus a lead time. */
  slaDeadlineAt: string | null;
  /** The order's requested delivery time (orders.delivery_at). */
  deliveryAt: string | null;
  /** True if a `ready_photo` or `delivered_photo` delivery_events row already
   *  exists for this assignment — any real progress means never auto-reoffer. */
  hasProgress: boolean;
  /** Injectable "now" (ms since epoch) so tests don't depend on wall-clock time. */
  nowMs: number;
  /** How close to `deliveryAt` counts as "no time left" even if the earlier
   *  sla_deadline_at was never set. Defaults to 1 hour. */
  bufferMs?: number;
}

const DEFAULT_BUFFER_MS = 60 * 60 * 1000; // 1 hour

/** True when an accepted-but-stalled assignment should be auto-handed back:
 *  no ready/delivered progress AND (past its binding SLA OR within a short
 *  buffer of the delivery deadline). Null timestamps never trigger a breach on
 *  their own — a missing signal isn't evidence of one. */
export function isFulfilmentSlaBreached(input: FulfilmentBreachInput): boolean {
  const { slaDeadlineAt, deliveryAt, hasProgress, nowMs, bufferMs = DEFAULT_BUFFER_MS } = input;
  if (hasProgress) return false;

  const slaBreached = slaDeadlineAt != null && !Number.isNaN(new Date(slaDeadlineAt).getTime())
    && new Date(slaDeadlineAt).getTime() < nowMs;
  const deliveryMs = deliveryAt != null ? new Date(deliveryAt).getTime() : NaN;
  const closeToDelivery = !Number.isNaN(deliveryMs) && deliveryMs - nowMs < bufferMs;

  return slaBreached || closeToDelivery;
}
