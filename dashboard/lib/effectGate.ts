import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { buildApprovalRow } from "@/lib/approvalKinds";
import type { OrderApprovalKind, ApprovalPreview } from "@/lib/types";

// The semi-automatic seam. Every system-initiated, side-effecting transition flows
// through gateEffect. In workflow_mode='semi' it FILES a previewed order_approvals
// row (a human approves/edits/rejects before anything fires); in 'manual'/'auto' it
// runs the real effect inline (today's behavior). The executor (approvalExecutors.ts)
// reconstructs the deferred call from `kind` + `payload` on approve.
//
// Money is deliberately NOT gated here — the 70%/30% legs keep their existing
// payouts.status='held' hold/release path (payout.ts). See the design doc.

export type WorkflowMode = "manual" | "semi" | "auto";

export async function currentWorkflowMode(admin = createServiceClient()): Promise<WorkflowMode> {
  const { data } = await admin.from("app_settings").select("workflow_mode").eq("id", 1).single();
  return (data?.workflow_mode as WorkflowMode | undefined) ?? "manual";
}

export interface EffectSpec<T> {
  kind: OrderApprovalKind;
  orderId: string;
  assignmentId?: string | null;
  /** Stable per-effect identity — the partial-unique key that stops overlapping
   *  ticks/retries from filing the same pending approval twice. */
  dedupeKey: string;
  /** What the cockpit / order-page panel render. */
  preview: ApprovalPreview;
  /** What the executor needs to run this on approve. */
  payload: Record<string, unknown>;
  /** Editable draft (emails only); carried onto the approval for the edit UI. */
  draftSubject?: string | null;
  draftBody?: string | null;
  /** The real effect — run inline in manual/auto; reconstructed by the executor in semi. */
  execute: () => Promise<T>;
}

export type GateResult<T> =
  | { pending: true; approvalId: string | null }
  | { pending: false; result: T };

// Gate one effect. In semi: insert a pending approval (CAS-deduped, 23505 = another
// writer filed it first = benign) and return without firing. Otherwise: execute now.
export async function gateEffect<T>(spec: EffectSpec<T>): Promise<GateResult<T>> {
  const admin = createServiceClient();
  const mode = await currentWorkflowMode(admin);
  if (mode !== "semi") return { pending: false, result: await spec.execute() };

  const { data, error } = await admin
    .from("order_approvals")
    .insert(buildApprovalRow({
      kind: spec.kind,
      orderId: spec.orderId,
      assignmentId: spec.assignmentId,
      dedupeKey: spec.dedupeKey,
      preview: spec.preview,
      payload: spec.payload,
      draftSubject: spec.draftSubject,
      draftBody: spec.draftBody,
    }))
    .select("id")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") return { pending: true, approvalId: null }; // already filed
    captureError("effectGate.file", error);
    // Filing failed for a real reason — don't silently drop the effect; run it inline
    // so the step still happens (degrade to auto for this one effect) rather than stall.
    return { pending: false, result: await spec.execute() };
  }
  return { pending: true, approvalId: data?.id ?? null };
}
