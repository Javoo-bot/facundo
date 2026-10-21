import { createServiceClient } from "@/lib/supabaseAdmin";
import {
  verifyTelnyxSignature,
  isSmsEventType,
  isPermanentSmsFailure,
} from "@/lib/telnyxWebhookGuard";
import { resolveFloristSmsPhone, countryToRegion } from "@/lib/phone";
import { ingestInbound } from "@/lib/conversations";

// Every Telnyx messaging event, in both directions. Telnyx posts all of them to
// the single webhook URL configured on the messaging profile, so this is one
// route rather than two.
//
// OUTBOUND (`message.sent` / `message.finalized`) — delivery receipts, the SMS
// counterpart of app/api/webhooks/resend. Until this existed we knew a text had
// been handed to Telnyx and nothing more. That was tolerable while SMS was a
// third hedge behind email and push; it stopped being tolerable when
// suppressing the offer email for 364 florists whose stored address wasn't
// their own made SMS their primary channel. Two outputs: a `sms_events` row for
// the funnel on /statistics, and — on a PERMANENT failure only — a stamp on the
// florist so we stop texting a number that cannot receive texts.
//
// INBOUND (`message.received`) — a florist replying to a recruiting text. A lot
// of small shops reply to a text rather than an email, so this is not a
// nice-to-have leg: without it, "yes, tell me more" sent as an SMS goes nowhere
// at all. Handed to lib/conversations.ts, same as inbound email.

/** Telnyx event types carrying a delivery receipt. Both carry
 *  `payload.to[].status`; finalized is the terminal one. */
const HANDLED_EVENTS = new Set(["message.sent", "message.finalized"]);

interface TelnyxRecipient {
  phone_number?: string;
  status?: string;
}
interface TelnyxError {
  code?: string | number;
  detail?: string;
}
interface TelnyxWebhook {
  data?: {
    event_type?: string;
    /** Telnyx's EVENT id — the idempotency key. Not the message id. */
    id?: string;
    occurred_at?: string;
    payload?: {
      /** The MESSAGE id, matching communications.provider_message_id. */
      id?: string;
      to?: TelnyxRecipient[];
      errors?: TelnyxError[];
      /** Inbound only. */
      text?: string;
      from?: { phone_number?: string };
      direction?: string;
    };
  };
}

export async function POST(request: Request): Promise<Response> {
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) return new Response("webhook not configured", { status: 500 });

  const payload = await request.text();
  const ok = verifyTelnyxSignature(
    payload,
    {
      "telnyx-signature-ed25519": request.headers.get("telnyx-signature-ed25519") ?? "",
      "telnyx-timestamp": request.headers.get("telnyx-timestamp") ?? "",
    },
    publicKey,
  );
  // Covers a bad signature and a timestamp outside the ±5 minute window, i.e.
  // a replayed capture of a request that was genuinely signed once. Replay
  // matters more here than for email: a replayed delivery_failed would silence
  // a florist's number.
  if (!ok) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(payload) as TelnyxWebhook;
  const eventType = body.data?.event_type ?? "";
  if (eventType === "message.received") return handleInbound(body);
  if (!HANDLED_EVENTS.has(eventType)) return new Response("ok", { status: 200 });

  // Telnyx sends one webhook per message, with per-recipient status inside.
  // Every offer SMS has exactly one recipient; taking the first is correct for
  // that and degrades to "record the first" rather than crashing if it ever
  // isn't.
  const recipientStatus = body.data?.payload?.to?.[0]?.status ?? "";
  if (!isSmsEventType(recipientStatus)) {
    // A status Telnyx added since this was written. Ignore rather than 5xx:
    // retrying would never produce a status we DO recognise, and the DB check
    // constraint would reject it anyway.
    return new Response("ok", { status: 200 });
  }

  const providerEventId = body.data?.id;
  if (!providerEventId) {
    // No event id means no idempotency key, and this table's whole
    // duplicate-suppression story rests on it. Better to drop the event than
    // to let provider retries multiply rows in the funnel.
    console.error("telnyx webhook: event with no data.id — dropped");
    return new Response("ok", { status: 200 });
  }

  const errors = body.data?.payload?.errors ?? [];
  const errorCodes = errors.map((e) => String(e.code ?? "")).filter(Boolean);

  const admin = createServiceClient();
  const messageId = body.data?.payload?.id ?? null;
  let communication:
    | { id: string; audience: string; florist_id: string | null; to_address: string | null; test_mode: boolean }
    | null = null;
  if (messageId) {
    const { data } = await admin
      .from("communications")
      .select("id, audience, florist_id, to_address, test_mode")
      .eq("provider", "telnyx")
      .eq("provider_message_id", messageId)
      .maybeSingle();
    communication = data ?? null;
  }

  // `ignoreDuplicates` on the unique provider_event_id — a retry of an event we
  // already stored is a no-op rather than a second row inflating the funnel.
  const { error } = await admin.from("sms_events").upsert(
    {
      provider_event_id: providerEventId,
      communication_id: communication?.id ?? null,
      event_type: recipientStatus,
      error_code: errorCodes[0] ?? null,
      error_detail: errors[0]?.detail ?? null,
      occurred_at: body.data?.occurred_at ?? new Date().toISOString(),
      raw: body,
    },
    { onConflict: "provider_event_id", ignoreDuplicates: true },
  );

  if (error) {
    // 5xx so the provider retries into a write that either succeeds or, once
    // the row exists, does nothing. Same reasoning as the Resend route.
    console.error(`telnyx webhook: insert failed for event=${providerEventId} (${recipientStatus})`, error.message);
    return new Response("insert failed", { status: 500 });
  }

  await markNumberUndeliverable(admin, communication, recipientStatus, errorCodes);

  return new Response("ok", { status: 200 });
}

/**
 * A florist texted us back. Hand it to the conversation layer, which dedupes on
 * the provider event id and decides whether the CX agent may answer.
 */
async function handleInbound(body: TelnyxWebhook): Promise<Response> {
  const p = body.data?.payload ?? {};
  // Defensive: an outbound echo must never be treated as a florist replying to
  // us, or the agent would answer its own message.
  if (p.direction && p.direction !== "inbound") return new Response("ok", { status: 200 });

  const from = p.from?.phone_number ?? "";
  const text = p.text ?? "";
  if (!from) return new Response("ok", { status: 200 });

  const result = await ingestInbound({
    channel: "sms",
    // Telnyx's own event id, stable across retries.
    providerEventId: body.data?.id ?? p.id ?? `telnyx:${from}:${text.slice(0, 32)}`,
    provider: "telnyx",
    fromAddress: from,
    toAddress: p.to?.[0]?.phone_number ?? null,
    subject: null,
    bodyText: text,
    headers: null,
  });

  // 5xx so Telnyx retries into the same idempotent ingest rather than dropping
  // a florist's reply on the floor.
  if (!result.ok) return new Response("ingest failed", { status: 500 });
  return new Response("ok", { status: 200 });
}

/**
 * Stamp `florists.sms_undeliverable_at` so later offers stop texting a number
 * that cannot receive texts.
 *
 * The same four-condition narrowness as the email bounce handler, for the same
 * reason — silencing a channel for a florist who is actually reachable costs us
 * orders:
 *
 *   1. PERMANENT failures only, per Telnyx's own "do not retry" classification
 *      (lib/telnyxWebhookGuard.ts::PERMANENT_SMS_ERROR_CODES). A temporary
 *      failure is a phone that's off or a carrier hiccup; an unrecognised code
 *      keeps the channel open.
 *   2. Florist-audience only.
 *   3. Not a test-mode send — that went to the staff test phone, so a failure
 *      is about OUR number, not the florist's.
 *   4. The florist's CURRENT number must still match the one that failed. A
 *      staff correction landing between the send and a retried webhook must not
 *      condemn the new number.
 *
 * Condition 4 needs care that the email version didn't: the recipient is stored
 * on the communications row as the resolved E.164 address, while the florist
 * row holds three separate raw columns (phone_mobile / phone_web / phone_maps).
 * Matching against `to_address` alone would never match. So the check is "does
 * the number this florist would be texted TODAY still resolve to the one that
 * failed" — which is what `resolveFloristSmsPhone` answers.
 */
async function markNumberUndeliverable(
  admin: ReturnType<typeof createServiceClient>,
  communication: { audience: string; florist_id: string | null; to_address: string | null; test_mode: boolean } | null,
  status: string,
  errorCodes: readonly string[],
): Promise<void> {
  if (!communication?.florist_id) return;
  if (communication.audience !== "florist") return;
  if (communication.test_mode) return;
  if (!communication.to_address) return;
  if (status !== "delivery_failed" && status !== "sending_failed") return;
  if (!isPermanentSmsFailure(errorCodes)) return;

  const { data: florist } = await admin
    .from("florists")
    .select("id, phone_mobile, phone_web, phone_maps, city_id")
    .eq("id", communication.florist_id)
    .maybeSingle();
  if (!florist) return;

  // `countryToRegion`, not the raw `cities.country` — resolveFloristSmsPhone
  // wants an ISO region code, and this must resolve the number exactly the way
  // lib/offerVars.ts did when it sent, or the comparison below never matches
  // and the stamp silently never fires.
  let region: string | null = null;
  if (florist.city_id) {
    const { data: city } = await admin.from("cities").select("country").eq("id", florist.city_id).maybeSingle();
    region = countryToRegion(city?.country ?? null);
  }
  const current = resolveFloristSmsPhone(florist, region);
  if (!current || current !== communication.to_address) return;

  const { error } = await admin
    .from("florists")
    .update({ sms_undeliverable_at: new Date().toISOString() })
    .eq("id", communication.florist_id);
  if (error) {
    console.error(`telnyx webhook: could not flag undeliverable number for florist=${communication.florist_id}`, error.message);
  }
}
