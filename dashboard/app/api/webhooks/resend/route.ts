import { createServiceClient } from "@/lib/supabaseAdmin";
import { verifyResendSignature } from "@/lib/resendWebhookGuard";
import { recordEmailClick, recordEmailOpen, recordDeliveryFailure } from "@/lib/sequences/engagement";
import { isMachineClick, clickSignalsFromResend } from "@/lib/sequences/clickQuality";
import { isGenuineOpen, openSignalsFromResend } from "@/lib/sequences/openQuality";
import { trackRecruitEmailClicked, trackRecruitEmailOpened } from "@/lib/reachout/events";

const EVENT_MAP: Record<string, string> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("webhook not configured", { status: 500 });

  const payload = await request.text();
  // svix-id doubles as the idempotency key below — it's stable across retries
  // of the same event, and signature verification already requires it, so the
  // insert can never run without one.
  const svixId = request.headers.get("svix-id") ?? "";
  const ok = verifyResendSignature(payload, {
    "svix-id": svixId,
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  }, secret);
  // Covers both a bad signature and a timestamp outside the ±5 minute window,
  // i.e. a replayed capture of a request that was genuinely signed once.
  if (!ok) return new Response("invalid signature", { status: 401 });

  const body = JSON.parse(payload) as {
    type?: string;
    data?: {
      email_id?: string;
      // Hard vs soft bounce. Resend documents `data.type` as
      // 'permanent' | 'temporary'; some payloads nest it as
      // `data.bounce.type` with 'Permanent' | 'Transient'. Both are read
      // below, case-insensitively, so a shape change degrades to "don't
      // condemn the address" rather than to silencing a good one.
      type?: string;
      bounce?: { type?: string; subType?: string; message?: string };
    };
  };
  const eventType = body.type ? EVENT_MAP[body.type] : undefined;
  if (!eventType) return new Response("ok", { status: 200 }); // unrecognized event type — ignore, not an error

  const admin = createServiceClient();
  const emailId = body.data?.email_id ?? null;
  let communication:
    | { id: string; audience: string; kind: string | null; florist_id: string | null; to_address: string | null; test_mode: boolean }
    | null = null;
  if (emailId) {
    const { data } = await admin
      .from("communications")
      .select("id, audience, kind, florist_id, to_address, test_mode")
      .eq("provider", "resend")
      .eq("provider_message_id", emailId)
      .maybeSingle();
    communication = data ?? null;
  }
  const communicationId = communication?.id ?? null;
  // Only the recruiting funnel feeds the Reach Out events. An order offer to a
  // network florist is a different funnel with a different audience, and mixing
  // the two would make every recruiting conversion rate wrong.
  const isRecruiting =
    communication?.kind === "recruiting" || (communication?.kind ?? "").startsWith("recruit.");

  // `on conflict do nothing` on the unique provider_event_id (see
  // supabase/migrations/2026-08-05-email-events-idempotency.sql). A retry of an
  // event we already stored is a no-op rather than a second row inflating the
  // funnel on /statistics.
  const { error } = await admin
    .from("email_events")
    .upsert(
      { provider_event_id: svixId, communication_id: communicationId, event_type: eventType, raw: body },
      { onConflict: "provider_event_id", ignoreDuplicates: true },
    );

  if (error) {
    // Previously this logged and returned 200, which told Svix the event was
    // accepted and permanently lost it. Now that the insert is idempotent, a
    // 5xx is safe and correct: the provider retries into a write that either
    // succeeds or does nothing.
    console.error(`resend webhook: insert failed for svix-id=${svixId} (${eventType})`, error.message);
    return new Response("insert failed", { status: 500 });
  }

  // Drive the outreach funnel's branch switch from here rather than from the
  // tick. A click is what exits the no-engagement track, and the point of doing
  // it in the webhook is CANCELLATION: a florist who clicks minutes before a
  // scheduled cold touch must not then receive it. Awaited (not fire-and-forget)
  // because a floating promise is killed by the Worker isolate teardown — the
  // same reason app/[code]/route.ts awaits its hit count.
  //
  // Both calls swallow their own errors: the event is already durably stored,
  // and failing the webhook here would make Svix retry a write that succeeded.
  if (communicationId) {
    const occurredAt = new Date().toISOString();
    if (eventType === "clicked") {
      // A corporate link scanner opens every URL in every inbound email within
      // seconds of delivery, before a human has seen it. Counted as engagement
      // that would abandon the remaining cold touches AND send a florist "I can
      // see someone from your shop opened the link I sent" — a claim about them
      // that is false and that they can tell is false.
      //
      // The delivered timestamp comes from the `delivered` event we already
      // store for this same message; the user agent is read out of THIS payload
      // and never stored, so `short_links`' no-IP/no-UA decision is untouched.
      const { data: delivered } = await admin
        .from("email_events")
        .select("occurred_at")
        .eq("communication_id", communicationId)
        .eq("event_type", "delivered")
        .order("occurred_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const signals = clickSignalsFromResend(body);
      const machine = isMachineClick({
        ...signals,
        clickedAt: signals.clickedAt ?? occurredAt,
        deliveredAt: (delivered?.occurred_at as string | undefined) ?? null,
      });
      // The event itself is still stored either way — the click happened, and
      // /statistics should be able to show scanner traffic rather than pretend
      // it doesn't exist. What a machine does NOT get to do is move the funnel.
      if (!machine) await recordEmailClick(admin, communicationId, occurredAt);
      // BOTH judgements reach PostHog, machine ones included: the gap between
      // them is the scanner traffic, and it is the most useful thing this event
      // can say about a step whose click rate looks too good.
      if (communication?.florist_id && isRecruiting) {
        await trackRecruitEmailClicked(communication.florist_id, { machine, testMode: communication.test_mode });
      }
    } else if (eventType === "opened") {
      // The open equivalent of the scanner filter above, and it matters more
      // here than it looks: the same-day recruiting funnel BRANCHES on opens at
      // 3½ hours, where Apple/Gmail prefetch — which fires within seconds of
      // delivery — would otherwise be the majority of the signal. Prod was
      // reporting 1,560 opens against 1,068 deliveries when this shipped.
      //
      // Same shape as the click branch: the event is stored either way, so
      // /statistics can still show the inflation; what a prefetch does not get
      // to do is move the funnel.
      const { data: delivered } = await admin
        .from("email_events")
        .select("occurred_at")
        .eq("communication_id", communicationId)
        .eq("event_type", "delivered")
        .order("occurred_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const signals = openSignalsFromResend(body);
      // How many opens this message already has, INCLUDING the one just stored.
      // Two separated opens are positive evidence of a reader even when the
      // first was too early to trust: a prefetch fires once, at delivery.
      const { count: openCount } = await admin
        .from("email_events")
        .select("id", { count: "exact", head: true })
        .eq("communication_id", communicationId)
        .eq("event_type", "opened");

      const genuine = isGenuineOpen({
        openedAt: signals.openedAt ?? occurredAt,
        deliveredAt: (delivered?.occurred_at as string | undefined) ?? null,
        openCount: openCount ?? 1,
      });
      if (genuine) {
        await recordEmailOpen(admin, communicationId, occurredAt);
      }
      if (communication?.florist_id && isRecruiting) {
        await trackRecruitEmailOpened(communication.florist_id, { genuine, testMode: communication.test_mode });
      }
    } else if (eventType === "bounced" || eventType === "complained") {
      await recordDeliveryFailure(admin, communicationId, eventType);
    }
  }
  if (eventType === "bounced") await markFloristAddressDead(admin, communication, body.data);

  return new Response("ok", { status: 200 });
}

/**
 * A florist's address hard-bounced: stamp `email_bounced_at` so later offers
 * skip the email leg and hedge to SMS + push
 * (lib/offerChannels.ts::emailSkipReason).
 *
 * Closes the gap lib/lifecycle.ts's `reachout-comms-fail` branch called out as
 * future work — before this, a dead address stayed on the row and every wave
 * re-sent into it, which is what happened to Flower Market Demo's
 * ruedubac@flowermarket-demo.com on 2026-08-06.
 *
 * Deliberately narrow — four conditions, each of which prevents condemning an
 * address that is actually fine:
 *
 *   1. PERMANENT bounces only. A temporary one is a full mailbox or a greylist,
 *      and silencing email over it would cost us a reachable florist. An
 *      unrecognised/absent type is treated as temporary, so an unexpected
 *      payload shape fails safe.
 *   2. Florist-audience only. A client or CX bounce says nothing about a shop.
 *   3. Not a test-mode send — that went to the staff test inbox, so a bounce
 *      is about OUR inbox, not the florist's address.
 *   4. The florist's CURRENT email must still equal the address that bounced.
 *      A staff correction landing between the send and the (retried, possibly
 *      much later) webhook must not mark the NEW address dead. This is the
 *      reason the update filters on `email` rather than just `id`.
 *
 * Best-effort by construction: a failure here is logged, never surfaced. The
 * event row is already committed by the time this runs, so returning a 5xx
 * would make the provider retry an insert that is now a no-op while never
 * re-reaching this code path with a different outcome.
 */
async function markFloristAddressDead(
  admin: ReturnType<typeof createServiceClient>,
  communication: { audience: string; florist_id: string | null; to_address: string | null; test_mode: boolean } | null,
  data: { type?: string; bounce?: { type?: string } } | undefined,
): Promise<void> {
  if (!communication?.florist_id) return;
  if (communication.audience !== "florist") return;
  if (communication.test_mode) return;
  if (!communication.to_address) return;

  const bounceType = (data?.type ?? data?.bounce?.type ?? "").toLowerCase();
  if (bounceType !== "permanent") return;

  const { error } = await admin
    .from("florists")
    .update({ email_bounced_at: new Date().toISOString() })
    .eq("id", communication.florist_id)
    .eq("email", communication.to_address);
  if (error) {
    console.error(`resend webhook: could not flag bounced address for florist=${communication.florist_id}`, error.message);
  }
}
