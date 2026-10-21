import { requireAllowedUser } from "@/lib/apiAuth";
import { drainOutbox } from "@/lib/outboxDrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Drains the effects outbox. Called by the ingest-worker cron (with the shared
// OUTBOX_SECRET header) and manually by staff. System endpoint — auth is either
// the secret OR an allow-listed staff session.
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireAllowedUser();
    if (!gate.ok) return gate.res;
  }

  const result = await drainOutbox(50);
  return Response.json({ ok: true, ...result });
}
