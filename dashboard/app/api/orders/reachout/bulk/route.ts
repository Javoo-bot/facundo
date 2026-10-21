import { requireRole, jsonError } from "@/lib/apiAuth";
import { sendOffer } from "@/lib/reachoutSend";
import { parseChannels } from "@/lib/reachout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Offer one order to SEVERAL candidates at once — the "open this up to
// everybody who hasn't been asked yet" action on the staff order page.
//
// NO PREVIEW, deliberately. The preview route + SendOfferDialog put a rendered
// email in front of every single send, which is right when you are contacting
// one florist and pure friction when you are contacting five with the
// identical message. The batch still confirms — who, how many, which channels
// — it just doesn't render the same mail five times.
//
// Each id goes through the SAME sendOffer as a single send, so every offer
// gets its own atomic claim. That matters: a candidate someone else just sent
// to loses its claim and comes back `not-sendable` while the rest still go
// out. Partial success is the normal case, not an error, so this returns 200
// with a per-assignment result rather than failing the whole batch.
const MAX_BATCH = 25;

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { assignmentIds?: unknown; channels?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  const ids = Array.isArray(body.assignmentIds)
    ? body.assignmentIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (!ids.length) return jsonError("assignmentIds is required.", 400);
  // A ceiling rather than silent truncation: asking for more than this is a
  // mistake worth surfacing, not something to quietly half-do.
  if (ids.length > MAX_BATCH) return jsonError(`Too many at once (max ${MAX_BATCH}).`, 400);

  const channels = parseChannels(body.channels) ?? undefined;

  // Sequential, not Promise.all: each send fans out to email/SMS/push, and
  // firing 25 of those concurrently would stack round trips against the
  // providers for no operator-visible gain.
  const results: { assignmentId: string; ok: boolean; error?: string }[] = [];
  for (const assignmentId of ids) {
    const r = await sendOffer(assignmentId, gate.email, channels ? { channels } : undefined);
    results.push({ assignmentId, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }

  return Response.json({
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
