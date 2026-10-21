import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist(); if (!me) return jsonError("Not signed in.", 401);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw PushSubscription JSON from the browser
  let sub: any; try { sub = await request.json(); } catch { return jsonError("Invalid JSON.", 400); }
  if (!sub?.endpoint || !sub?.keys) return jsonError("Invalid subscription.", 400);
  await createServiceClient().from("push_subscriptions").upsert(
    { florist_id: me.floristId, endpoint: sub.endpoint, keys: sub.keys }, { onConflict: "endpoint" });
  return Response.json({ ok: true });
}
