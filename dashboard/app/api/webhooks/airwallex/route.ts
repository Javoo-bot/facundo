// Airwallex webhook receiver — closes the money loop: authorization/clearing,
// declines, reissues and dispute updates land here and move the payout + audit.
//
// SECURITY: the raw body is signature-verified (verifyWebhook) BEFORE parsing.
// Idempotent: the Airwallex event id is a PK in airwallex_events, so a redelivery
// is a no-op. Defensive: unknown event types are recorded and 200'd (never 500),
// so Airwallex doesn't retry-storm us over something we simply don't handle.
//
// OBSERVABILITY: every inbound delivery gets exactly one `external_ops` row —
// including a REJECTED one. Before this, a delivery that failed verification
// (wrong/missing signature, stale timestamp, or `AIRWALLEX_WEBHOOK_SECRET`
// simply unset) left zero trace anywhere: not in `airwallex_events` (that
// insert only happens after verification), not in any log a human would
// think to check. That made "Airwallex never registered our endpoint" and
// "Airwallex calls us and we 401 every delivery" indistinguishable from our
// side — see the 2026-09-04 investigation on lib/lifecycle.ts's
// `pay-state-stale` branch. logExternalOp is best-effort (swallows its own
// failures) and is never allowed to change the response — see webhookLogOp.ts.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { verifyWebhook } from "@/lib/airwallex/webhookVerify";
import { mapWebhookEvent } from "@/lib/airwallex/webhookMap";
import { webhookLogOp } from "@/lib/airwallex/webhookLogOp";
import { logExternalOp } from "@/lib/externalOps";
import { captureError } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Awaited (not fire-and-forget) so the row is actually written before the
// serverless function suspends — but never let it affect the response:
// logExternalOp already swallows its own failures, and the extra .catch()
// here is belt-and-suspenders on top of that.
async function logWebhook(input: Parameters<typeof webhookLogOp>[0]): Promise<void> {
  await logExternalOp(webhookLogOp(input)).catch(() => {});
}

export async function POST(request: Request): Promise<Response> {
  // Read the UNMODIFIED body first — the signature is over the raw bytes.
  const raw = await request.text();
  const timestamp = request.headers.get("x-timestamp");
  const signature = request.headers.get("x-signature");
  const secret = process.env.AIRWALLEX_WEBHOOK_SECRET;

  const v = verifyWebhook(raw, timestamp, signature, secret);
  if (!v.ok) {
    await logWebhook({ ok: false, statusCode: 401, error: v.reason });
    return new Response(`invalid signature: ${v.reason}`, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook JSON is untyped
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    await logWebhook({ ok: false, statusCode: 400, error: "bad-json" });
    return new Response("bad json", { status: 400 });
  }

  await logWebhook({ ok: true, statusCode: 200, eventName: event?.name ?? null, eventId: event?.id ?? null });

  const admin = createServiceClient();

  // Idempotency: first write of this event id wins; a redelivery unique-violates.
  const eventId: string | null = event?.id ?? null;
  if (eventId) {
    const { error } = await admin.from("airwallex_events").insert({ id: eventId, type: event?.name ?? null });
    if (error?.code === "23505") return new Response("ok (duplicate)", { status: 200 });
    // Any other insert error: log and continue — failing to record the dedupe
    // row must not drop the event (Airwallex would retry on a non-200 anyway).
    if (error) captureError("airwallex.webhook.dedupe", error);
  }

  const mapped = mapWebhookEvent(event, new Date().toISOString());

  // Locate the payout by the card that generated the event.
  let payoutId: string | null = null;
  if (mapped.cardId) {
    const { data: p } = await admin.from("payouts").select("id").eq("provider_ref", mapped.cardId).maybeSingle();
    payoutId = p?.id ?? null;
    if (payoutId && mapped.payoutPatch) {
      await admin
        .from("payouts")
        .update({ ...mapped.payoutPatch, updated_at: new Date().toISOString() })
        .eq("id", payoutId);
    }
  }

  await admin.from("payment_events").insert({
    payout_id: payoutId,
    type: mapped.eventType,
    payload: { name: event?.name ?? null, txnId: mapped.txnId, cardId: mapped.cardId, disputeStatus: mapped.disputeStatus },
  });

  // A decline is a payout-failure class — page at launch.
  if (mapped.eventType === "declined") {
    captureError("payout.declined", new Error(`card declined (card ${mapped.cardId}, txn ${mapped.txnId})`));
  }

  return new Response("ok", { status: 200 });
}
