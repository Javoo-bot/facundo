import { requireAllowedUser } from "@/lib/apiAuth";
import { advanceWaves } from "@/lib/waves";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Advances the offer waves (expire lapsed offers, auto-promote the next candidate,
// escalate when exhausted). Called by the ingest-worker cron with the shared
// OUTBOX_SECRET header, or manually by an allow-listed staff session. System
// endpoint — auth is either the secret OR a staff session.
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireAllowedUser();
    if (!gate.ok) return gate.res;
  }

  const result = await advanceWaves();
  return Response.json({ ok: true, ...result });
}
