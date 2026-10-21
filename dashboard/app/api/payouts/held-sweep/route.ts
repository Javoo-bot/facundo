import { requireAllowedUser } from "@/lib/apiAuth";
import { sweepHeldPayouts } from "@/lib/payout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Releases HELD delivery-leg payouts whose only reason was the operator's
// delivery-gate toggle, now that it's back off — see lib/payout.ts::sweepHeldPayouts.
// Called by the ingest-worker cron (shared OUTBOX_SECRET) and manually by staff,
// same auth pattern as /api/outbox/drain.
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireAllowedUser();
    if (!gate.ok) return gate.res;
  }

  const result = await sweepHeldPayouts();
  return Response.json({ ok: true, ...result });
}
