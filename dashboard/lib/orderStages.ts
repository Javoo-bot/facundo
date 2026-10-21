// Display stage model for the staff order page. Maps the granular 12-value
// `OrderStatus` onto the 6 legible journey stages the order page renders as a
// horizontal stepper, and defines the *guardrailed* set of statuses a staff
// member may set by hand (broader than the strict automatic `canTransition`,
// but not a free-for-all).
//
// Pure module (no React, no IO) so it's unit-testable and safe to import from
// both server routes and client components.

import type { OrderStatus } from "./orderStatus";

export type StageId = "created" | "matched" | "outreach" | "fulfilment" | "delivery" | "delivered";

export interface Stage {
  id: StageId;
  label: string;
  /** The order statuses that live under this display stage. */
  statuses: OrderStatus[];
}

// Labels are written for a CX operator reading the stepper cold, not for the
// engineer who named the statuses: they say what HAPPENED, in the order it
// happens, so the row reads as a sentence about the order rather than as
// jargon. "Fulfilment" in particular named a phase nobody outside this codebase
// uses, and covered the moment the florist says yes — which is the single thing
// CX most needs to see at a glance. The `id`s are unchanged and are what every
// other module keys off; only the words moved.
export const STAGES: Stage[] = [
  { id: "created", label: "Order received", statuses: ["received"] },
  { id: "matched", label: "Florists found", statuses: ["matched"] },
  { id: "outreach", label: "Offer sent", statuses: ["reaching_out"] },
  { id: "fulfilment", label: "Order accepted", statuses: ["accepted", "in_production", "ready"] },
  { id: "delivery", label: "On the way", statuses: ["out_for_delivery"] },
  { id: "delivered", label: "Delivered", statuses: ["delivered", "paid", "closed"] },
];

/** Which display stage a status belongs to — or an overlay marker for the two
 *  off-path states (`escalated` keeps the order "somewhere" but ambiguous;
 *  `cancelled` is terminal). */
export function stageOf(status: OrderStatus): StageId | "escalated" | "cancelled" {
  if (status === "escalated") return "escalated";
  if (status === "cancelled") return "cancelled";
  const s = STAGES.find((st) => st.statuses.includes(status));
  return s ? s.id : "created";
}

export function stageIndex(id: StageId): number {
  return STAGES.findIndex((s) => s.id === id);
}

// Canonical linear order of the happy-path statuses — used to classify a
// transition as forward vs backward. `escalated`/`cancelled` are off this line.
const STATUS_ORDER: OrderStatus[] = [
  "received", "matched", "reaching_out", "accepted",
  "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed",
];

export type MoveDirection = "forward" | "back" | "flag";

export function moveDirection(from: OrderStatus, to: OrderStatus): MoveDirection {
  if (to === "escalated" || to === "cancelled") return "flag";
  const a = STATUS_ORDER.indexOf(from);
  const b = STATUS_ORDER.indexOf(to);
  if (a === -1 || b === -1) return "flag"; // from a terminal/off-path state (reopen)
  return b > a ? "forward" : "back";
}

// Sensible staff-only back-steps, keyed by the current status. These are *not*
// in the strict `canTransition` machine (which is forward-only bar
// accepted→reaching_out); they exist so CX can correct a premature advance.
const BACK_MOVES: Partial<Record<OrderStatus, OrderStatus[]>> = {
  matched: ["received"],
  reaching_out: ["matched"],
  accepted: ["reaching_out"], // reassignment: hand the order back to outreach
  in_production: ["accepted"],
  ready: ["in_production"],
  out_for_delivery: ["ready"],
  delivered: ["out_for_delivery"],
  paid: ["delivered"],
};

// Explicit "reopen" allowances out of the two terminal states.
const REOPEN: Partial<Record<OrderStatus, OrderStatus[]>> = {
  closed: ["delivered"],
  cancelled: ["reaching_out"],
};

const TERMINAL: OrderStatus[] = ["closed", "cancelled"];

export interface StaffMove {
  status: OrderStatus;
  direction: MoveDirection;
}

/** The guardrailed set of statuses a staff member may set from `current`:
 *  forward canTransition targets, sensible back-steps, escalate/cancel from any
 *  live state, and explicit reopen out of terminal. The current status is never
 *  returned. `direction` drives the UI's confirm behaviour (back/flag confirm). */
export function staffSettableStatuses(current: OrderStatus): StaffMove[] {
  const set = new Set<OrderStatus>();

  // Forward: the immediate next status on the happy-path line (mirrors the
  // strict machine's linear FORWARD edges without importing it, so this stays a
  // testable leaf module). Branching back-edges are covered by BACK_MOVES.
  const i = STATUS_ORDER.indexOf(current);
  if (i !== -1 && i < STATUS_ORDER.length - 1) set.add(STATUS_ORDER[i + 1]);
  for (const t of BACK_MOVES[current] ?? []) set.add(t);
  for (const t of REOPEN[current] ?? []) set.add(t);
  if (!TERMINAL.includes(current)) {
    set.add("escalated");
    set.add("cancelled");
  }
  set.delete(current);

  return Array.from(set)
    .map((status) => ({ status, direction: moveDirection(current, status) }))
    .sort((a, b) => {
      // flags (escalate/cancel) last; otherwise by linear status order.
      if (a.direction === "flag" && b.direction !== "flag") return 1;
      if (b.direction === "flag" && a.direction !== "flag") return -1;
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    });
}

export function canStaffSet(from: OrderStatus, to: OrderStatus): boolean {
  return staffSettableStatuses(from).some((m) => m.status === to);
}
