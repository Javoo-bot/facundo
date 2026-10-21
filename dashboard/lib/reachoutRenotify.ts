import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/email";
import { sendPushToFlorist } from "@/lib/push";
import { sendSms } from "@/lib/sms";
import { logCommunication } from "@/lib/communications";
import { resolveOfferVars } from "@/lib/offerVars";
import { emailSkipReason, smsSkipReason } from "@/lib/offerChannels";
import {
  orderResendable,
  renotifyBlockReason,
  allowedChannels,
  OFFER_CHANNELS,
  type OfferChannel,
  type RenotifyBlockReason,
} from "@/lib/reachout";
import { buildOfferEmailContent } from "@/lib/offerEmailContent";
import { buildOfferSmsContent } from "@/lib/offerSmsContent";
import { shorten } from "@/lib/shortLinkMint";
import type { OrderStatus } from "@/lib/orderStatus";

// Re-deliver a LIVE offer — "the florist says they never got it".
//
// This is deliberately NOT part of lib/reachoutSend.ts::sendOffer. That function
// exists to CLAIM an assignment: it CASes the row from a sendable state to
// `sent`, rewrites expiry and decline fields, and rolls the claim back if the
// send fails. Its whole reason for being is that exactly one caller may ever win
// a claim, so a cron tick and a double-click can't double-send.
//
// Re-notifying changes NO state. Same offer, same `offer_expires_at`, same
// `sent_at` — the message simply goes out again. There is nothing to claim and
// nothing to roll back, so giving it a claim would mean a fourth way to mutate
// assignment status purely to share code, and every future reader of that ladder
// would have to work out which claim applies. See lib/reachout.ts for the
// predicate pair that partitions the state space between the two operations.
//
// The one exception is `resetWindow`, which IS a write and is CAS-guarded.

export type ChannelOutcome =
  | { channel: OfferChannel; status: "sent" }
  | { channel: OfferChannel; status: "skipped"; reason: string }
  | { channel: OfferChannel; status: "failed"; reason: string };

export interface RenotifyResult {
  ok: boolean;
  /** Set only when nothing was attempted at all. */
  error?: RenotifyBlockReason | "assignment-not-found" | "not-sendable" | string;
  results?: ChannelOutcome[];
  testMode?: boolean;
  testShop?: boolean;
  /** Present when resetWindow moved the deadline. */
  expiresAt?: string;
  to?: string | null;
}

export interface RenotifyOpts {
  /** Which legs to fire. Defaults to all three; intersected with the
   *  settings-level gates (email_offer_enabled / sms_offer_enabled). */
  channels?: readonly OfferChannel[];
  /** Give the florist a fresh full reply window. Off by default: the wave
   *  engine auto-advances on `offer_expires_at`, so moving it silently delays
   *  the next florist being tried while the customer's delivery deadline does
   *  not move. */
  resetWindow?: boolean;
}

/** The `communications.kind` each channel writes, and therefore the kind the
 *  cooldown reads back. `offer` covers the original send from sendOffer, so a
 *  re-notify one second after the first send is correctly rate-limited. */
const KIND_BY_CHANNEL: Record<OfferChannel, string[]> = {
  email: ["offer", "offer_renotify"],
  sms: ["offer_sms", "offer_sms_renotify"],
  push: ["offer_push", "offer_push_renotify"],
};
const CHANNEL_COLUMN: Record<OfferChannel, string> = { email: "email", sms: "sms", push: "push" };

type Admin = ReturnType<typeof createServiceClient>;

/** Last successful send per channel for this assignment, for the cooldown. */
async function lastSentByChannel(admin: Admin, assignmentId: string): Promise<Record<OfferChannel, string | null>> {
  const out: Record<OfferChannel, string | null> = { email: null, sms: null, push: null };
  const { data } = await admin
    .from("communications")
    .select("channel, kind, created_at")
    .eq("assignment_id", assignmentId)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(200);
  for (const row of data ?? []) {
    for (const ch of OFFER_CHANNELS) {
      if (out[ch] != null) continue;
      if (row.channel === CHANNEL_COLUMN[ch] && KIND_BY_CHANNEL[ch].includes(row.kind as string)) {
        out[ch] = row.created_at as string;
      }
    }
  }
  return out;
}

export async function renotifyOffer(
  assignmentId: string,
  actor: string,
  opts?: RenotifyOpts
): Promise<RenotifyResult> {
  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments").select("*").eq("id", assignmentId).single();
  if (!a) return { ok: false, error: "assignment-not-found" };

  const { data: ord0 } = await admin.from("orders").select("status, deleted_at").eq("id", a.order_id).single();
  const lastSent = await lastSentByChannel(admin, assignmentId);

  const requested = opts?.channels?.length ? opts.channels : OFFER_CHANNELS;

  // Gate each requested channel on its own cooldown, but block the whole
  // operation on the order/assignment reasons — those aren't per-channel.
  const stateBlock = renotifyBlockReason(
    { status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null },
    (ord0?.status ?? "received") as OrderStatus,
    ord0?.deleted_at ?? null,
    null
  );
  if (stateBlock) return { ok: false, error: stateBlock };

  const r = await resolveOfferVars(admin, a, { mintUnsubscribeToken: true, mintMagicToken: true });
  if (r.blockingError) return { ok: false, error: r.blockingError };

  // SIBLING-ACCEPT GUARD. resolveOfferVars makes several sequential round trips,
  // and the pre-check above ran before them. In that window a DIFFERENT florist's
  // assignment on this order can be accepted — and unlike sendOffer we hold no
  // claim, so nothing else would stop us emailing an offer for an order someone
  // else already holds. Re-read both immediately before any leg fires.
  //
  // RESIDUAL WINDOW: an accept can still land between this read and the sends
  // below. That is the same single-round-trip race every CAS in
  // lib/reachoutSend.ts already accepts.
  const [{ data: ordNow }, { data: asgNow }] = await Promise.all([
    admin.from("orders").select("status, deleted_at").eq("id", a.order_id).single(),
    admin.from("order_assignments").select("status, offer_expires_at, withdrawn_at").eq("id", assignmentId).single(),
  ]);
  if (!orderResendable((ordNow?.status ?? "received") as OrderStatus, ordNow?.deleted_at ?? null)) {
    return { ok: false, error: "not-sendable" };
  }
  const stillLive = renotifyBlockReason(
    // Re-read includes `withdrawn_at` so a Withdraw landing in the gap since
    // the pre-check aborts the re-notify — same reasoning as the sibling
    // accept this guard was written for.
    { status: (asgNow?.status ?? a.status) as typeof a.status, offer_expires_at: asgNow?.offer_expires_at ?? null, withdrawn_at: asgNow?.withdrawn_at ?? null },
    (ordNow?.status ?? "received") as OrderStatus,
    ordNow?.deleted_at ?? null,
    null
  );
  if (stillLive) return { ok: false, error: stillLive };

  // ---- The only write: optionally hand the florist a fresh full window. ----
  // CAS-guarded on the row still being live, so a florist who accepted in the
  // gap is never clobbered. Uses the same expiry resolveOfferVars computed for
  // this send, so a reset window matches what a fresh send would have granted.
  let expiresAt: string | undefined;
  if (opts?.resetWindow) {
    const { data: moved } = await admin
      .from("order_assignments")
      .update({ offer_expires_at: r.expiresAt })
      .eq("id", assignmentId)
      .in("status", ["sent", "opened"])
      .select("id")
      .maybeSingle();
    if (moved) expiresAt = r.expiresAt;
  }

  const enabled = allowedChannels(requested, {
    emailEnabled: r.offerEmailEnabled,
    smsEnabled: r.smsOfferEnabled,
  });
  const results: ChannelOutcome[] = [];
  const skip = (channel: OfferChannel, reason: string) => results.push({ channel, status: "skipped", reason });

  for (const channel of requested) {
    if (!enabled.includes(channel)) {
      skip(channel, "disabled-by-settings");
      continue;
    }
    const cooldown = renotifyBlockReason(
      { status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null },
      (ordNow?.status ?? "received") as OrderStatus,
      ordNow?.deleted_at ?? null,
      lastSent[channel]
    );
    if (cooldown === "cooling-down") {
      skip(channel, "cooling-down");
      continue;
    }

    if (channel === "email") {
      // Was an inline re-implementation of the opt-out/snooze rule, which meant
      // the "one predicate, three callers" contract in lib/offerChannels.ts was
      // only true of two of them — and a nudge would happily re-send to an
      // address the offer path had already decided not to write to. Now it asks
      // the shared predicate, so the identity checks (network / shared /
      // bounced address) apply to nudges too.
      //
      // `wanted: true` throughout: the caller-selection and settings gates are
      // already applied above by `enabled`/`requested`, so passing false here
      // would just re-report those as this reason.
      const reason = emailSkipReason(r, true);
      if (reason) {
        skip(channel, reason);
        await logCommunication({
          channel: "email", audience: "florist", kind: "offer_renotify", orderId: a.order_id, floristId: a.florist_id,
          assignmentId, testMode: r.testMode, status: "skipped", provider: "resend", error: reason, actor,
        });
        continue;
      }
      const { subject, html, bodyText } = buildOfferEmailContent(r.locale, r.overrides, r.vars);
      const sent = await sendEmail({
        to: r.to!, from: r.from, subject, body: bodyText, html,
        headers: { "List-Unsubscribe": `<mailto:${r.supportEmail}>, <${r.vars.unsubscribeUrl}>` },
        context: {
          orderId: a.order_id, operation: "offer_email", audience: "florist", kind: "offer_renotify",
          floristId: a.florist_id, assignmentId, testMode: r.testMode, actor,
        },
      });
      results.push(sent.ok ? { channel, status: "sent" } : { channel, status: "failed", reason: sent.error ?? "send-failed" });
      continue;
    }

    if (channel === "sms") {
      // Same predicate sendOffer and the send-confirm dialog use — this used to
      // be a near-duplicate copy of the rules in lib/reachoutSend.ts. Reaching
      // here means the channel WAS selected (the loop skips unselected ones
      // above), so `wanted` is true. See lib/offerChannels.ts.
      const smsSkip = smsSkipReason(r, true);
      if (smsSkip) {
        skip(channel, smsSkip);
        await logCommunication({
          channel: "sms", audience: "florist", kind: "offer_sms_renotify", orderId: a.order_id, floristId: a.florist_id,
          assignmentId, testMode: r.testMode, status: "skipped", provider: "telnyx", error: smsSkip, actor,
        }).catch(() => {});
        continue;
      }
      // SHORTENED FOR SMS ONLY — same rule as the first send in
      // lib/reachoutSend.ts. The full URLs are 77 + 109 chars and push every
      // locale to three billed segments; 43-char short links bring that to two.
      // Email keeps the full URLs, so both channels still carry the one magic
      // token resolveOfferVars minted. `shorten` falls back to the full URL on
      // any failure, so a shortener problem costs a segment, never the re-send.
      const smsOrderUrl = await shorten(admin, r.vars.orderUrl, {
        kind: "magic", floristId: a.florist_id, assignmentId,
      });
      const smsUnsubscribeUrl = await shorten(admin, `${r.vars.unsubscribeUrl}&channel=sms`, {
        kind: "unsubscribe", floristId: a.florist_id, assignmentId,
      });
      const body = buildOfferSmsContent(r.locale, r.overrides, {
        city: r.vars.city,
        payoutPrice: a.payout_price ?? null,
        replyWindow: r.vars.replyWindow,
        deadlineTime: r.vars.deadlineTime,
        variant: r.vars.variant,
        floristName: r.vars.floristName,
        orderUrl: smsOrderUrl,
        unsubscribeUrl: smsUnsubscribeUrl,
      });
      const sent = await sendSms({
        to: r.smsTo!, body,
        context: {
          orderId: a.order_id, operation: "offer_sms", audience: "florist", kind: "offer_sms_renotify",
          floristId: a.florist_id, assignmentId, testMode: r.testMode, actor,
        },
      }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "sms-failed" }));
      results.push(sent.ok ? { channel, status: "sent" } : { channel, status: "failed", reason: sent.error ?? "sms-failed" });
      continue;
    }

    // push — `sendPushToFlorist` returns Promise<void> and writes its OWN
    // per-subscription outcome to `communications` (including the
    // "florist never installed the PWA" skip). So the only thing this layer can
    // honestly report is whether the call threw; "sent" here means "handed to
    // the push layer", and the communications log is the authoritative record of
    // what actually reached a device.
    let pushThrew = false;
    await sendPushToFlorist(
      a.florist_id,
      {
        title: "New Facundo order",
        body: `${r.order?.delivery_area ?? "New area"} · your payout €${a.payout_price ?? "—"}`,
        url: `/florist/orders/${a.id}`,
      },
      { kind: "offer_push_renotify", orderId: a.order_id, assignmentId, testMode: r.testMode, actor }
    ).catch(() => { pushThrew = true; });
    results.push(pushThrew ? { channel, status: "failed", reason: "push-failed" } : { channel, status: "sent" });
  }

  const anySent = results.some((x) => x.status === "sent");
  await admin.from("order_events").insert({
    order_id: a.order_id,
    type: "outreach_renotified",
    payload: {
      assignmentId,
      results,
      reset_window: !!opts?.resetWindow,
      expires_at: expiresAt ?? null,
      test_mode: r.testMode,
      test_shop: r.testShop,
      via: "manual",
    },
    actor,
  });

  return {
    ok: anySent,
    error: anySent ? undefined : "no-channel-sent",
    results,
    testMode: r.testMode,
    testShop: r.testShop,
    expiresAt,
    to: r.to,
  };
}
