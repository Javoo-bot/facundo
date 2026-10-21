import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { reassignOrder } from "@/lib/reassignOrder";
import { clawbackForOrder } from "@/lib/payout";
import { notifyFloristOfIssue } from "@/lib/issueComms";
import { sendPushToFlorist } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["substitute", "reassign", "redeliver", "clawback", "cancel", "dismiss"] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_SUMMARY: Record<Action, string> = {
  substitute: "Substitution approved",
  reassign: "Reassigned to another florist",
  redeliver: "Redelivery arranged",
  clawback: "Payout adjusted",
  cancel: "Order cancelled",
  dismiss: "Marked resolved",
};

// CX resolves an open order issue. The action drives the side effect; the issue
// is then marked resolved with the action recorded. Reassign/redeliver reuse the
// shared reassignOrder (race-locked); clawback/cancel unwind money via
// clawback_order. Money-affecting actions stay idempotent.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { issueId?: string; action?: string; resolution?: string; newTotal?: number };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.issueId || !body.action) return jsonError("issueId and action required.", 400);
  if (!(ACTIONS as readonly string[]).includes(body.action)) return jsonError("Unknown action.", 400);
  const action = body.action as Action;

  const admin = createServiceClient();
  const { data: issue } = await admin.from("order_issues")
    .select("id, order_id, assignment_id, status").eq("id", body.issueId).single();
  if (!issue) return jsonError("Issue not found.", 404);
  if (issue.status === "resolved") return jsonError("Issue already resolved.", 409);

  // Side effect per action.
  if (action === "reassign" || action === "redeliver") {
    const r = await reassignOrder(issue.order_id, gate.email);
    if (!r.ok) return jsonError(r.error ?? "Reassign failed.", 409);
  } else if (action === "clawback") {
    await clawbackForOrder(issue.order_id, body.newTotal ?? null).catch(() => {});
  } else if (action === "cancel") {
    // Only cancel a non-terminal order; log + claw back ONLY if it actually changed
    // (a stale "Cancel" on an already-closed order must not reclaim its payouts).
    const { data: cancelledRows } = await admin.from("orders").update({ status: "cancelled" })
      .eq("id", issue.order_id).not("status", "in", "(cancelled,closed)").select("id");
    if (!cancelledRows || cancelledRows.length === 0) {
      return jsonError("Order is already closed or cancelled.", 409);
    }
    await admin.from("order_events").insert({ order_id: issue.order_id, type: "status:cancelled", payload: { via: "issue" }, actor: gate.email });
    await clawbackForOrder(issue.order_id, null).catch(() => {});
  } else if (action === "substitute") {
    await admin.from("order_events").insert({ order_id: issue.order_id, type: "substitution_approved", actor: gate.email });
  }
  // dismiss → no side effect.

  await admin.from("order_issues").update({
    status: "resolved",
    resolution_action: action,
    resolution: body.resolution ?? null,
    resolved_by: gate.email,
    resolved_at: new Date().toISOString(),
    florist_unread: true, // the florist should see the resolution
    cx_unread: false,
  }).eq("id", body.issueId);
  await admin.from("order_events").insert({
    order_id: issue.order_id, type: "issue_resolved", actor: gate.email,
    payload: { issue_id: body.issueId, action },
  });

  // Post the resolution into the thread + notify the florist (email + push).
  const summary = `${ACTION_SUMMARY[action]}${body.resolution ? `: ${body.resolution}` : "."}`;
  await admin.from("issue_messages").insert({
    issue_id: issue.id, order_id: issue.order_id, assignment_id: issue.assignment_id,
    author_role: "system", author: gate.email, body: summary,
  });
  if (issue.assignment_id) {
    const [{ data: ord }, { data: a }] = await Promise.all([
      admin.from("orders").select("order_name").eq("id", issue.order_id).single(),
      admin.from("order_assignments").select("florist_id").eq("id", issue.assignment_id).single(),
    ]);
    let floristEmail: string | null = null;
    let floristLocale: string | null = null;
    if (a?.florist_id) {
      const { data: f } = await admin.from("florists").select("email, locale").eq("id", a.florist_id).single();
      floristEmail = f?.email ?? null;
      floristLocale = f?.locale ?? null;
    }
    await notifyFloristOfIssue({
      assignmentId: issue.assignment_id, floristEmail, floristLocale, orderName: ord?.order_name ?? null,
      floristId: a?.florist_id ?? null, orderId: issue.order_id, issueId: issue.id, actor: gate.email,
      body: summary, kind: "resolved",
    });
    if (a?.florist_id) {
      await sendPushToFlorist(
        a.florist_id,
        {
          title: "Your issue was resolved",
          body: summary.length > 80 ? summary.slice(0, 77) + "…" : summary,
          url: `/florist/orders/${issue.assignment_id}`,
        },
        { kind: "issue_push", orderId: issue.order_id, assignmentId: issue.assignment_id, issueId: issue.id, actor: gate.email }
      ).catch(() => {});
    }
  }

  return Response.json({ ok: true });
}
