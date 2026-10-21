// Pure helpers for step-mode (semi) approvals — no I/O, no `@/` alias, so they're
// unit-testable and shared by the gate (effectGate), the executor (approvalExecutors),
// and the UI (ApprovalPanel). The classification here is the single source of truth for
// "which kinds are emails", "which block the loop", and "how a reject is recorded".

export type ApprovalKind =
  | "match" | "offer" | "reassign" | "escalate" | "writeback"
  | "client_assigned" | "client_on_the_way" | "client_delivered"
  // Ask a shop that accepted, then went quiet, for a photo. Not loop-advancing:
  // the order is already placed and stays placed — this is a nudge, not a step.
  | "chase_photo";

export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  "match", "offer", "reassign", "escalate", "writeback",
  "client_assigned", "client_on_the_way", "client_delivered", "chase_photo",
];

// Kinds whose approval carries an editable email draft (subject/body).
export function isEmailKind(kind: string): boolean {
  return kind === "offer" || kind === "client_assigned" || kind === "client_on_the_way" || kind === "client_delivered";
}

// Kinds that block the order from advancing (vs. side notifications). Used to rank
// urgency — a stuck match/offer/reassign/escalate should shout louder than an email.
export function isLoopAdvancing(kind: string): boolean {
  return kind === "match" || kind === "offer" || kind === "reassign" || kind === "escalate";
}

// How a rejection is recorded: an offer historically moves to 'skipped' (try-next
// semantics — the wave promotes the next candidate); every other kind is 'rejected'.
export function rejectStatusFor(kind: string): "skipped" | "rejected" {
  return kind === "offer" ? "skipped" : "rejected";
}

// The order_approvals row for a gated effect (pure — the gate inserts what this
// returns). Kept here so the row shape (esp. the per-effect dedupe_key that guards
// double-filing) is tested in isolation.
export interface ApprovalRowSpec {
  kind: ApprovalKind;
  orderId: string;
  assignmentId?: string | null;
  dedupeKey: string;
  preview: unknown;
  payload: unknown;
  draftSubject?: string | null;
  draftBody?: string | null;
}

export function buildApprovalRow(spec: ApprovalRowSpec): Record<string, unknown> {
  return {
    order_id: spec.orderId,
    assignment_id: spec.assignmentId ?? null,
    kind: spec.kind,
    status: "pending",
    dedupe_key: spec.dedupeKey,
    preview: spec.preview,
    payload: spec.payload,
    draft_subject: spec.draftSubject ?? null,
    draft_body: spec.draftBody ?? null,
    created_by: "system",
  };
}
