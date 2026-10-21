import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { notifyCxOfIssue } from "@/lib/issueComms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Florist posts a message to an existing issue thread. Ownership-checked via the
// issue's assignment; flags the issue unread for CX; emails CX.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let b: { issueId?: string; body?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const body = (b.body ?? "").trim();
  if (!b.issueId || !body) return jsonError("issueId and a message are required.", 400);

  const admin = createServiceClient();
  const { data: issue } = await admin.from("order_issues")
    .select("id, order_id, assignment_id, type").eq("id", b.issueId).single();
  if (!issue || !issue.assignment_id) return jsonError("Issue not found.", 404);

  const { data: a } = await admin.from("order_assignments")
    .select("florist_id").eq("id", issue.assignment_id).single();
  if (!a || a.florist_id !== me.floristId) return jsonError("Not your issue.", 403);

  await admin.from("issue_messages").insert({
    issue_id: issue.id, order_id: issue.order_id, assignment_id: issue.assignment_id,
    author_role: "florist", author: me.email, body,
  });
  // Florist just posted → they've seen it; CX now has something unread.
  await admin.from("order_issues").update({ cx_unread: true, florist_unread: false }).eq("id", issue.id);

  const { data: ord } = await admin.from("orders").select("order_name").eq("id", issue.order_id).single();
  await notifyCxOfIssue({
    orderId: issue.order_id, orderName: ord?.order_name ?? null, issueType: issue.type,
    assignmentId: issue.assignment_id, issueId: issue.id,
    body, author: me.email,
  });

  return Response.json({ ok: true });
}
