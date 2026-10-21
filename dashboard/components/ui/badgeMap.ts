import type { OrderStatus, AssignmentStatus } from "../../lib/orderStatus.ts";
import { ORDER_STATUS_LABEL, ASSIGNMENT_STATUS_LABEL } from "../../lib/orderStatus.ts";

export type BadgeInfo = { cls: string; label: string };

// Status badges follow the per-stage hues of the hybrid scheme (lib/orderVisual.ts),
// so a badge's colour reads as its pipeline stage. delivered keeps bloom and paid
// keeps accent-green (settled) by convention; escalated is the only crit badge.
const ORDER_CLS: Record<OrderStatus, string> = {
  received: "badge-created", matched: "badge-matched", reaching_out: "badge-outreach",
  accepted: "badge-fulfilment", in_production: "badge-fulfilment", ready: "badge-fulfilment",
  out_for_delivery: "badge-delivery", delivered: "badge-bloom", paid: "badge-accent", closed: "badge-neutral",
  escalated: "badge-crit", cancelled: "badge-neutral",
};
const ASSIGN_CLS: Record<AssignmentStatus, string> = {
  candidate: "badge-neutral", queued: "badge-neutral", sent: "badge-warn", opened: "badge-amber",
  declined: "badge-crit", expired: "badge-neutral", accepted: "badge-accent",
  reassigned: "badge-warn", delivered: "badge-bloom", released: "badge-warn",
};
const SOURCE_CLS: Record<string, string> = { existing: "badge-accent", known: "badge-warn", new: "badge-bloom" };

export function orderStatusBadge(s: OrderStatus): BadgeInfo { return { cls: ORDER_CLS[s], label: ORDER_STATUS_LABEL[s] }; }
export function assignmentStatusBadge(s: AssignmentStatus): BadgeInfo { return { cls: ASSIGN_CLS[s], label: ASSIGNMENT_STATUS_LABEL[s] }; }
export function sourceBadge(source: string | null): BadgeInfo { return { cls: SOURCE_CLS[source ?? ""] ?? "badge-neutral", label: source ?? "—" }; }
