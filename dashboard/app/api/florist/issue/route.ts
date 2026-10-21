import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { isOrderStatus } from "@/lib/orderStatus";
import { stageOf } from "@/lib/orderStages";
import { notifyCxOfIssue } from "@/lib/issueComms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISSUE_TYPES = [
  "missing_ingredient", "wrong_address", "out_of_range",
  "recipient_unavailable", "damaged_wrong_recipient", "other",
] as const;
type IssueType = (typeof ISSUE_TYPES)[number];

const ISSUE_LABEL: Record<IssueType, string> = {
  missing_ingredient: "Missing an ingredient",
  wrong_address: "Wrong address",
  out_of_range: "Out of my range",
  recipient_unavailable: "No one home",
  damaged_wrong_recipient: "Damaged / wrong recipient",
  other: "Other issue",
};

// Florist raises a problem on an accepted order. Opens an OPEN order_issues row
// (an overlay CX resolves) + seeds the thread with a first florist message +
// flags it unread for CX + emails CX. Does NOT flip orders.status — the order
// stays in its stage with a "needs attention" badge.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let b: { assignmentId?: string; type?: string; message?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!b.assignmentId || !b.type) return jsonError("assignmentId and type required.", 400);
  if (!(ISSUE_TYPES as readonly string[]).includes(b.type)) return jsonError("Unknown issue type.", 400);
  const type = b.type as IssueType;
  const message = (b.message ?? "").trim();

  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments")
    .select("id, order_id, florist_id, status").eq("id", b.assignmentId).single();
  if (!a || a.florist_id !== me.floristId) return jsonError("Not your order.", 403);
  if (a.status !== "accepted" && a.status !== "delivered") return jsonError("Order not in fulfilment.", 409);

  const { data: ord } = await admin.from("orders").select("status, order_name").eq("id", a.order_id).single();
  const stage = ord && isOrderStatus(ord.status) ? stageOf(ord.status) : null;

  const detail = message || ISSUE_LABEL[type];
  const { data: issue, error: insErr } = await admin.from("order_issues").insert({
    order_id: a.order_id,
    assignment_id: a.id,
    type,
    detail,
    stage,
    created_by: me.email,
    cx_unread: true, // CX has a new issue to see
  }).select("id").single();
  if (insErr || !issue) return jsonError("Could not report the problem.", 500);

  // Seed the thread with the florist's first message.
  await admin.from("issue_messages").insert({
    issue_id: issue.id, order_id: a.order_id, assignment_id: a.id,
    author_role: "florist", author: me.email, body: detail,
  });
  await admin.from("order_events").insert({
    order_id: a.order_id, type: `issue:${type}`, actor: me.email,
    payload: { assignment_id: a.id, issue_id: issue.id },
  });
  await notifyCxOfIssue({
    orderId: a.order_id, orderName: ord?.order_name ?? null, issueType: type,
    assignmentId: a.id, issueId: issue.id,
    body: detail, author: me.email,
  });

  return Response.json({ ok: true, issueId: issue.id });
}
