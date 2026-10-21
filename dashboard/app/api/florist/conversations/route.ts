import { currentFlorist } from "@/lib/floristAuth";
import { jsonError } from "@/lib/apiAuth";
import { postFloristMessage } from "@/lib/supportThread";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The florist asks a question about one of their orders, from inside the app.
//
// Thin on purpose: authentication here, authorisation and everything else in
// lib/supportThread.ts, which the order page also reads through. The one thing
// this file must not do is trust `assignmentId` — it arrives from a browser,
// and postFloristMessage re-checks that it belongs to the signed-in florist
// before a single row is written.
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  let b: { assignmentId?: string; text?: string };
  try {
    b = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  if (!b.assignmentId || !b.text) return jsonError("assignmentId and text required.", 400);

  const result = await postFloristMessage(me.floristId, b.assignmentId, b.text);
  if (!result.ok) {
    // "not-found" covers both a missing assignment and someone else's, on
    // purpose: telling an attacker which one it was is a membership oracle over
    // the assignment table.
    const status = result.error === "not-found" ? 404 : result.error === "too-long" || result.error === "empty" ? 400 : 500;
    return jsonError(result.error ?? "Failed.", status);
  }

  return Response.json({
    ok: true,
    conversationId: result.conversationId,
    reply: result.reply ?? null,
    escalated: result.escalated ?? false,
  });
}
