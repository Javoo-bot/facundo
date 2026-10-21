// Order + assignment state machines — mirror orders.status / order_assignments.status
// (text, check-constrained in supabase/migrations/2026-07-13-phase0-orders.sql).

export type OrderStatus =
  | "received" | "matched" | "reaching_out" | "accepted"
  | "in_production" | "ready" | "out_for_delivery" | "delivered" | "paid" | "closed"
  | "escalated" | "cancelled";

export const ORDER_STATUSES: OrderStatus[] = [
  "received", "matched", "reaching_out", "accepted",
  "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed",
  "escalated", "cancelled",
];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  received: "Received", matched: "Matched", reaching_out: "Reaching out",
  accepted: "Accepted", in_production: "In production", ready: "Ready",
  out_for_delivery: "Out for delivery", delivered: "Delivered", paid: "Paid",
  closed: "Closed", escalated: "Issue", cancelled: "Cancelled",
};

// Happy-path forward edges (spec §G). cancelled/escalated are added to every
// non-terminal state below.
const FORWARD: Partial<Record<OrderStatus, OrderStatus[]>> = {
  received: ["matched"],
  matched: ["reaching_out"],
  reaching_out: ["accepted"],
  accepted: ["in_production", "reaching_out"], // reassignment loops back
  in_production: ["ready"],
  ready: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
  delivered: ["paid"],
  paid: ["closed"],
};
const TERMINAL: OrderStatus[] = ["closed", "cancelled"];

export function isOrderStatus(v: unknown): v is OrderStatus {
  return typeof v === "string" && (ORDER_STATUSES as string[]).includes(v);
}

export function nextOrderStatuses(s: OrderStatus): OrderStatus[] {
  if (TERMINAL.includes(s)) return [];
  const forward = FORWARD[s] ?? [];
  return [...forward, "escalated", "cancelled"];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return nextOrderStatuses(from).includes(to);
}

/**
 * Where an order should sit once a refill has ACTUALLY added candidates, or
 * null to leave it exactly where it is.
 *
 * `received` is the plain first-match case. `escalated` is the one that costs
 * us when it is missed: that status means "we ran out of shops, a human owns
 * this now", and a refill that added someone has just made it untrue. Left
 * escalated, those fresh candidates are stranded — lib/waves.ts::advanceWaves
 * selects on ["matched", "reaching_out"] and never looks at an escalated order
 * again, so nothing offers them and the /operator row re-renders identically
 * after the click. That was a dead end for a CX operator who only has
 * /operator, /orders/[id]/call and /orders/[id]/reply: every control that
 * could rescue it lives on the full order page.
 *
 * Every other status returns null. An order already in reach-out, accepted or
 * in fulfilment must never be pulled backwards by a refill — including
 * `cancelled` and the terminal states, where a late refill has no business
 * reviving anything.
 *
 * Pure and exported here (rather than inlined in lib/candidateRefill.ts, which
 * pulls in `server-only` and the service-role client) so plain `node --test`
 * can cover the rule directly — the same reason cxAttentionRules.ts and
 * workingSetDecision.ts were split out.
 */
export function statusAfterRefill(current: OrderStatus): OrderStatus | null {
  return current === "received" || current === "escalated" ? "matched" : null;
}

export type AssignmentStatus =
  | "candidate" | "queued" | "sent" | "opened"
  | "declined" | "expired" | "accepted" | "reassigned" | "delivered" | "released";

export const ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  "candidate", "queued", "sent", "opened",
  "declined", "expired", "accepted", "reassigned", "delivered", "released",
];

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  candidate: "Candidate", queued: "Queued", sent: "Sent", opened: "Opened",
  declined: "Declined", expired: "Expired", accepted: "Accepted",
  reassigned: "Reassigned", delivered: "Delivered", released: "Given back",
};

export function isAssignmentStatus(v: unknown): v is AssignmentStatus {
  return typeof v === "string" && (ASSIGNMENT_STATUSES as string[]).includes(v);
}
