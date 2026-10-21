import { requireRole, jsonError } from "@/lib/apiAuth";
import { approveApproval, rejectApproval } from "@/lib/approvalExecutors";
import { parseChannels } from "@/lib/reachout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Act on a pending step-mode approval (semi mode) of ANY kind. Staff-gated.
//   approve                 → fire the step (send offer/email, match, writeback, …)
//   approve + subject/body  → "request changes": fire with the edited email draft
//   reject / skip           → decline the step (offer → try the next candidate)
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { approvalId?: string; action?: "approve" | "reject" | "skip"; subject?: string; body?: string; reason?: string; channels?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const { approvalId, action } = body;
  if (!approvalId || !action) return jsonError("approvalId and action are required.", 400);

  if (action === "approve") {
    const edits = body.subject != null || body.body != null ? { subject: body.subject, body: body.body } : undefined;
    // Channels picked in the send-confirm dialog; omitted keeps every enabled
    // channel firing, which is what this route did before the dialog existed.
    const channels = parseChannels(body.channels) ?? undefined;
    const r = await approveApproval(approvalId, gate.email, edits, channels);
    if (!r.ok) {
      if (r.error === "not-pending") return jsonError("This step was already handled.", 409);
      if (r.error === "no-test-email") return jsonError("Test mode is on but no valid test email is set (Settings).", 400);
      if (r.error === "florist-no-email") return jsonError("Florist has no email address.", 400);
      return jsonError(`Action failed: ${r.error}`, 502);
    }
    return Response.json({ ok: true });
  }

  if (action === "reject" || action === "skip") {
    const r = await rejectApproval(approvalId, gate.email, body.reason);
    if (!r.ok) return jsonError(r.error === "not-pending" ? "This step was already handled." : `Reject failed: ${r.error}`, r.error === "not-pending" ? 409 : 500);
    return Response.json({ ok: true });
  }

  return jsonError("Unknown action.", 400);
}
