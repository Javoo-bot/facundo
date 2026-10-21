import { requireAllowedUser } from "@/lib/apiAuth";
import { runSequences } from "@/lib/sequences/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Advances the outreach funnel. Called by the ingest-worker cron (with the
// shared OUTBOX_SECRET header) and manually by staff. System endpoint — auth is
// either the secret OR an allow-listed staff session, same shape as
// /api/outbox/drain and /api/orders/waves/tick.
//
// Its own endpoint rather than another effect kind in the outbox drain, on
// purpose: a slow or looping sequence bug must not be able to degrade payout
// and Shopify-writeback processing, which is what sharing that drain would do.
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireAllowedUser();
    if (!gate.ok) return gate.res;
  }

  const result = await runSequences(50);
  return Response.json({ ok: true, ...result });
}
