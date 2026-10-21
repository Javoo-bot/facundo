import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { notifyFloristOfIssue } from "@/lib/issueComms";
import { sendPushToFlorist } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CX posts a message to an issue thread → flags it unread for the florist,
// emails + pushes the florist. Reused shape mirrors the florist reply route.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let b: { issueId?: string; body?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const body = (b.body ?? "").trim();
  if (!b.issueId || !body) return jsonError("issueId and a message are required.", 400);

  const admin = createServiceClient();
  const { data: issue } = await admin.from("order_issues")
    .select("id, order_id, assignment_id").eq("id", b.issueId).single();
  if (!issue) return jsonError("Issue not found.", 404);

  await admin.from("issue_messages").insert({
    issue_id: issue.id, order_id: issue.order_id, assignment_id: issue.assignment_id,
    author_role: "cx", author: gate.email, body,
  });
  await admin.from("order_issues").update({ florist_unread: true, cx_unread: false }).eq("id", issue.id);

  // Notify the florist (email + push), best-effort.
  const [{ data: ord }, assignment] = await Promise.all([
    admin.from("orders").select("order_name").eq("id", issue.order_id).single(),
    issue.assignment_id
      ? admin.from("order_assignments").select("florist_id").eq("id", issue.assignment_id).single()
      : Promise.resolve({ data: null }),
  ]);
  const floristId = assignment.data?.florist_id ?? null;
  let floristEmail: string | null = null;
  let floristLocale: string | null = null;
  if (floristId) {
    const { data: f } = await admin.from("florists").select("email, locale").eq("id", floristId).single();
    floristEmail = f?.email ?? null;
    floristLocale = f?.locale ?? null;
  }
  if (issue.assignment_id) {
    await notifyFloristOfIssue({
      assignmentId: issue.assignment_id, floristEmail, floristLocale, orderName: ord?.order_name ?? null,
      floristId, orderId: issue.order_id, issueId: issue.id, actor: gate.email,
      body, kind: "reply",
    });
  }
  if (floristId) {
    await sendPushToFlorist(
      floristId,
      {
        title: "Facundo replied about your order",
        body: body.length > 80 ? body.slice(0, 77) + "…" : body,
        url: issue.assignment_id ? `/florist/orders/${issue.assignment_id}` : "/florist",
      },
      { kind: "issue_push", orderId: issue.order_id, assignmentId: issue.assignment_id ?? null, issueId: issue.id, actor: gate.email }
    ).catch(() => {});
  }

  return Response.json({ ok: true });
}
