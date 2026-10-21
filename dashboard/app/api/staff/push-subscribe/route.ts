import { requireAllowedUser } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff-side counterpart of /api/florist/push-subscribe — registers this
// device for CX alert pushes (dashboard/lib/cxAlerts.ts). Allow-list gated
// (not florist-gated): any signed-in staff member can opt this device in.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAllowedUser();
  if (!gate.ok) return gate.res;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw PushSubscription JSON from the browser
  let sub: any;
  try {
    sub = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!sub?.endpoint || !sub?.keys) return Response.json({ error: "Invalid subscription." }, { status: 400 });

  await createServiceClient()
    .from("staff_push_subscriptions")
    .upsert({ email: gate.email.toLowerCase(), endpoint: sub.endpoint, keys: sub.keys }, { onConflict: "endpoint" });

  return Response.json({ ok: true });
}
