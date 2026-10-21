import { requireAllowedUser } from "@/lib/apiAuth";
import { sweepCxAlerts } from "@/lib/cxAlerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pages a human when CX attention work (dashboard/lib/cxAttention.ts) has
// crossed into SLA-breaching / high-urgency territory and no one has been
// alerted recently (dashboard/lib/cxAlerts.ts owns the throttle). Called by
// the ingest-worker cron (shared OUTBOX_SECRET header, same pattern as
// /api/outbox/drain and /api/orders/waves/tick) or manually by an
// allow-listed staff session.
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireAllowedUser();
    if (!gate.ok) return gate.res;
  }

  const result = await sweepCxAlerts();
  return Response.json({ ok: true, ...result });
}
