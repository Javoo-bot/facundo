import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/email";
import { sendPushToFlorist } from "@/lib/push";
import { sendSms } from "@/lib/sms";
import { logCommunication } from "@/lib/communications";
import { resolveOfferVars } from "@/lib/offerVars";
import { orderResendable, allowedChannels, OFFER_CHANNELS, type OfferChannel } from "@/lib/reachout";
import { emailSkipReason, smsSkipReason, floristUnreachable, type ChannelSkipReason } from "@/lib/offerChannels";
import { shorten } from "@/lib/shortLinkMint";
import { warmLineItemTranslations } from "@/lib/translations/lineItems";
import { isLocale } from "@/lib/i18n";
import type { OrderStatus } from "@/lib/orderStatus";
import {
  buildOfferEmailContent,
  formatOfferWhen,
  formatOfferReplyWindow,
  formatOfferDeliverBy,
  type OfferEmailVars,
} from "./offerEmailContent.ts";
import { buildOfferSmsContent } from "./offerSmsContent.ts";
import { pauseRecruitingFor } from "@/lib/sequences/enrol";

// Re-exported so existing callers (dashboard/app/api/settings/message-overrides/preview/route.ts)
// keep importing from "@/lib/reachoutSend" unchanged — the actual implementation
// lives in ./offerEmailContent.ts (no "@/" imports there, so it's unit-testable
// directly via plain `node --test`; see lib/reachoutSend.test.mjs).
export { buildOfferEmailContent, formatOfferWhen, formatOfferReplyWindow, formatOfferDeliverBy, type OfferEmailVars };

export interface SendOfferResult {
  ok: boolean;
  error?: string;
  testMode?: boolean;
  expiresAt?: string;
  // The address that WOULD/DID actually receive the email (test inbox in test
  // mode, else the florist's real address) and the locale it was rendered in.
  // Populated on success from the same resolver the preview route uses, so
  // the resend route's 200 response can echo back exactly what was sent.
  to?: string | null;
  locale?: string;
  /** Set only alongside `error: "florist-unreachable"` — which channel block
   *  made this shop a dead end, for the audit trail the wave engine writes. */
  skipReason?: ChannelSkipReason | null;
}

export interface SendOfferOpts {
  /** Which legs to fire, intersected with the settings-level gates
   *  (`email_offer_enabled` / `sms_offer_enabled`). Defaults to all three.
   *
   *  Applied AFTER the atomic claim below, never before — the claim is what
   *  makes double-sending impossible, and it must not depend on which channels
   *  a caller happened to ask for. "Some legs fire, some don't" is already
   *  established behaviour here: a settings toggle can leave a send push-only. */
  channels?: readonly OfferChannel[];
  // Widens the atomic claim to also reopen a declined/expired/lapsed-live
  // assignment (see the two-statement CAS below) instead of only claiming a
  // fresh candidate/queued row. Only ever passed by the staff "Re-send offer"
  // action (app/api/orders/reachout/route.ts, action:"resend") — the wave
  // engine (lib/waves.ts) and the plain "send" action never pass it, so
  // nothing auto-resends to a florist who already said no.
  resend?: boolean;
}

// Send an offer to a candidate florist: email (test-mode gated) + outreach audit
// + push, and set the assignment `sent` with a BINDING `offer_expires_at` so the
// wave engine can auto-advance when it lapses. Shared by the manual reach-out
// route (actor = CX, including the "resend" action), the auto-advance cron
// (actor = 'system'), and the approval executors.
//
// The assignment is CLAIMED atomically BEFORE the email goes out, so an
// overlapping cron tick or a double-clicked manual send/resend can never
// double-send: exactly one caller wins the claim; everyone else gets
// `not-sendable`. If the email then fails we roll the claim back (CAS-guarded
// so a florist who accepted in the meantime is never clobbered) so the wave
// retries it.
//
// Every send-time variable (settings, florist, order, locale, overrides,
// variant, expiry) is resolved ONCE by lib/offerVars.ts::resolveOfferVars —
// the exact same function the preview-before-resend route calls with
// `mintUnsubscribeToken: false` — so a staff preview can never drift from
// what this function actually sends.
type Admin = ReturnType<typeof createServiceClient>;

// Shared claim-rollback: restores an assignment row to its exact pre-claim
// state (from the snapshot `a` read before the claim), CAS-guarded on
// `.eq("status","sent")` so a florist who accepted in the gap is never
// clobbered — used both when the post-claim order re-check below finds the
// order no longer resendable, and when the send itself fails afterward.
async function rollbackClaim(admin: Admin, assignmentId: string, a: { status: string; offer_expires_at: string | null; sent_at: string | null; decline_reason: string | null; decline_detail: string | null; withdrawn_at: string | null }): Promise<void> {
  await admin.from("order_assignments")
    .update({
      status: a.status,
      offer_expires_at: a.offer_expires_at ?? null,
      sent_at: a.sent_at ?? null,
      decline_reason: a.decline_reason ?? null,
      decline_detail: a.decline_detail ?? null,
      // Restored alongside the rest: the claim clears `withdrawn_at`, so a
      // rollback that left it null would silently un-withdraw an offer whose
      // re-send never actually went out.
      withdrawn_at: a.withdrawn_at ?? null,
    })
    .eq("id", assignmentId).eq("status", "sent");
}

export async function sendOffer(assignmentId: string, actor: string, opts?: SendOfferOpts): Promise<SendOfferResult> {
  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments").select("*").eq("id", assignmentId).single();
  if (!a) return { ok: false, error: "assignment-not-found" };

  const r = await resolveOfferVars(admin, a, { mintUnsubscribeToken: true, mintMagicToken: true });
  // Only OUR misconfiguration aborts the whole send. `no-test-email` is that:
  // test mode is on and there is nowhere to redirect to, so nothing may go out
  // on any channel.
  //
  // `florist-no-email` is NOT that, and treating it as such was a bug. The shop
  // is real, wants the order, and its Maps-sourced phone is its own — exactly
  // the situation offerVars.ts already reasons about for a network-owned,
  // shared or bounced address, all of which suppress the email leg alone and
  // let the offer hedge to SMS + push. A shop that simply never had an address
  // is the same case, and aborting on it made every phone-only florist
  // unreachable: on order #2000020 (Vrbovec, HR) 23 florists with working
  // numbers got an email-skipped row and no SMS attempt at all. That market has
  // 37 florists and 5 websites, so email-only reachability is the exception
  // there, not the rule.
  //
  // It falls through to emailSkipReason below, which already returns
  // `florist-no-email` and suppresses just the email leg.
  if (r.blockingError === "no-test-email") {
    await logCommunication({
      channel: "email", audience: "florist", kind: "offer", orderId: a.order_id, floristId: a.florist_id,
      assignmentId, testMode: r.testMode, status: "skipped", provider: "resend", error: r.blockingError, actor,
    });
    return { ok: false, error: r.blockingError };
  }

  const nowIso = new Date().toISOString();
  const claimUpdate = {
    status: "sent",
    sent_at: nowIso,
    offer_expires_at: r.expiresAt,
    // Cleared on every claim (no-op for the plain candidate/queued → sent
    // path, where these are already null) so a resent row never shows a
    // stale decline note next to a fresh Sent badge — see
    // app/api/florist/respond/route.ts's decline→accept precedent.
    decline_reason: null,
    decline_detail: null,
    // INVARIANT: a live offer is never a withdrawn one. Staff Withdraw stamps
    // `withdrawn_at` and drops the row to `expired` (app/api/orders/reachout),
    // and `expired` is resendable — so without this, a Withdraw → Re-send put
    // the offer back on the table as `sent` with the stamp still set. The
    // florist got a real offer email and a detail page with NO Accept button,
    // because lib/lateAccept.ts refuses on `withdrawn_at` before it looks at
    // anything else. A re-send IS staff saying "this offer is back on", so the
    // withdrawal it reverses has to be cleared with it.
    withdrawn_at: null,
  };

  let claimed: { id: string } | null = null;
  if (opts?.resend) {
    // Two sequential CAS UPDATEs, each atomic — at most one wins. Folded into
    // THIS claim (rather than a separate reopen-then-send) so a wave-cron
    // tick landing in between can never steal the send and re-offer with
    // actor:"system"/via:"auto" — see lib/lifecycle.ts's reachout-resend
    // branch for the full rationale.
    const { data: wonDeclinedOrExpired } = await admin
      .from("order_assignments")
      .update(claimUpdate)
      .eq("id", assignmentId)
      .in("status", ["declined", "expired"])
      .select("id")
      .maybeSingle();
    claimed = wonDeclinedOrExpired ?? null;
    if (!claimed) {
      // Lapsed live offer (sent/opened past its OWN binding expiry) — the
      // `.lt` re-checks that expiry at claim time, matching the same
      // fix lib/waves.ts's expire step now applies, so a resend can't race a
      // wave tick that read the row as stale microseconds earlier.
      const { data: wonLapsed } = await admin
        .from("order_assignments")
        .update(claimUpdate)
        .eq("id", assignmentId)
        .in("status", ["sent", "opened"])
        .lt("offer_expires_at", nowIso)
        .select("id")
        .maybeSingle();
      claimed = wonLapsed ?? null;
    }
    if (!claimed) {
      // WITHDRAWN live offer (sent/opened, expiry still in the future). The CAS
      // ladder is the SOLE authority and must mirror `resendBlockReason`
      // exactly — that predicate now returns null for a withdrawn row whatever
      // its expiry says, so without this arm the Re-send button would render
      // and then 409 "not-sendable", which is precisely the button/API
      // disagreement this file exists to prevent. A separate statement rather
      // than an `.or()` on the arm above, to keep each CAS a single atomic
      // condition in the established style.
      const { data: wonWithdrawn } = await admin
        .from("order_assignments")
        .update(claimUpdate)
        .eq("id", assignmentId)
        .in("status", ["sent", "opened"])
        .not("withdrawn_at", "is", null)
        .select("id")
        .maybeSingle();
      claimed = wonWithdrawn ?? null;
    }
  } else {
    const { data: won } = await admin
      .from("order_assignments")
      .update({ status: "sent", sent_at: nowIso, offer_expires_at: r.expiresAt })
      .eq("id", assignmentId)
      .in("status", ["candidate", "queued"]) // CAS: skip if already sent/accepted/expired
      .select("id")
      .maybeSingle();
    claimed = won ?? null;
  }
  if (!claimed) return { ok: false, error: "not-sendable" };

  if (opts?.resend) {
    // SIBLING-ACCEPT GUARD. The assignment-level CAS above only proves THIS
    // row was still declined/expired/lapsed at claim time — it says nothing
    // about the ORDER. resolveOfferVars makes ~6 sequential DB round trips
    // before the claim fires, and the route's own orders.status pre-check ran
    // even earlier than that. In that whole window a DIFFERENT florist's
    // assignment on the same order can be accepted: the accept action's
    // "expire the other candidates" sweep (app/api/orders/reachout/route.ts)
    // only touches ["candidate","queued","sent","opened"] — it deliberately
    // never reaches into declined/expired siblings, because before resend
    // existed those were dead ends. Now one is a live re-offer target, so an
    // accept landing in the gap would otherwise let this claim succeed and
    // email a real florist for an order someone else already holds.
    // Re-check the order's resendability AFTER the claim, BEFORE any
    // notification goes out, and roll the claim back if it's no longer
    // resendable — closing the hole rather than merely shrinking it.
    // RESIDUAL WINDOW (unavoidable without a DB transaction spanning both
    // tables): an accept can still land between THIS read and the email/push
    // below. That's the same single-round-trip race every other CAS in this
    // file already accepts; it's no longer the multi-round-trip window the
    // finding was about.
    const { data: ordNow } = await admin.from("orders").select("status, deleted_at").eq("id", a.order_id).single();
    const orderStatusNow = (ordNow?.status ?? "received") as OrderStatus;
    const orderDeletedAtNow = ordNow?.deleted_at ?? null;
    if (!orderResendable(orderStatusNow, orderDeletedAtNow)) {
      await rollbackClaim(admin, assignmentId, a);
      return { ok: false, error: "not-sendable" };
    }
  }

  // Per-send channel mask, resolved AFTER the claim (see SendOfferOpts.channels).
  // A channel the caller didn't ask for is treated exactly like one a settings
  // toggle disabled — the offer still went out via the claim above.
  const wanted = allowedChannels(opts?.channels?.length ? opts.channels : OFFER_CHANNELS, {
    emailEnabled: r.offerEmailEnabled,
    smsEnabled: r.smsOfferEnabled,
  });
  const wantEmail = wanted.includes("email");
  const wantSms = wanted.includes("sms");
  const wantPush = wanted.includes("push");

  // Why the email leg won't fire, if it won't — the settings toggle is off,
  // this caller didn't select the channel, or the florist unsubscribed
  // (permanently) or snoozed (temporarily) via app/florist/unsubscribe.
  // Unsubscribe gates only the email leg; the offer still went out via the
  // atomic claim above and whatever other legs are enabled.
  //
  // The rule itself lives in lib/offerChannels.ts so the send-confirm dialog
  // can show CX the same answer BEFORE sending, rather than a third copy that
  // drifts. `blockingError` is already handled by the early return above, so
  // by here it is always null and the predicate's first branch is inert.
  //
  // No `outreach` row for a skip: that table's status is DB-constrained to
  // 'sent'/'failed' (no 'skipped'), so the unified communications log is the
  // record of this decision rather than a misleading 'failed' outreach row.
  // Did anything actually REACH the florist? Only email and SMS can answer:
  // sendPushToFlorist returns void, so push success is unobservable, and a push
  // to a stale subscription is exactly the silent non-delivery this guard
  // exists to catch. See the all-legs-failed check below.
  let emailDelivered = false;
  let smsDelivered = false;

  const emailSkip = emailSkipReason(r, wantEmail);
  if (emailSkip) {
    await logCommunication({
      channel: "email", audience: "florist", kind: "offer", orderId: a.order_id, floristId: a.florist_id,
      assignmentId, testMode: r.testMode, status: "skipped", provider: "resend",
      error: emailSkip, actor,
    });
  } else {
    // ---- Localized offer chrome, rendered from the resolver's variables. ----
    const { subject, html, bodyText } = buildOfferEmailContent(r.locale, r.overrides, r.vars);

    // Non-null here: `to` is null exactly when a blockingError was set, and
    // both of those values make emailSkipReason non-null — `no-test-email`
    // returned above, `florist-no-email` took the skip branch — so this else
    // is only reached with a real address.
    const to = r.to!;
    const sent = await sendEmail({
      to, from: r.from, subject, body: bodyText, html,
      headers: {
        "List-Unsubscribe": `<mailto:${r.supportEmail}>, <${r.vars.unsubscribeUrl}>`,
      },
      // A reply must reach a person. See lib/replyToken.ts::chooseReplyTo.
      fallbackReplyTo: r.supportEmail,
      context: {
        orderId: a.order_id, operation: "offer_email",
        audience: "florist", kind: "offer", floristId: a.florist_id, assignmentId, testMode: r.testMode, actor,
      },
    });
    await admin.from("outreach").insert({
      florist_id: a.florist_id, channel: "email", status: sent.ok ? "sent" : "failed",
      intended_address: r.intended, to_address: to, test_mode: r.testMode, subject, body: bodyText,
      provider_message_id: sent.ok ? sent.id : null, error: sent.ok ? null : sent.error, sent_by: actor,
    });
    emailDelivered = sent.ok;
    if (!sent.ok) {
      // Roll the claim back to its prior sendable state so the wave retries it and CX
      // cold-wave detection still fires — but only if WE still own the 'sent' row (a
      // florist accepting in the gap flips it to 'accepted'; don't clobber that).
      // Also restores decline_reason/decline_detail: the claim above nulled
      // them unconditionally, so a failed RESEND must put them back or a
      // declined row would be left with no reason and, worse, parked back in
      // a sendable state where an auto-mode tick could re-offer it every 60s.
      await rollbackClaim(admin, assignmentId, a);
      return { ok: false, error: sent.error };
    }
  }

  // ---- SMS leg: a THIRD hedge alongside email + push. ----
  // Best-effort, exactly like push: a failed SMS must NEVER call
  // rollbackClaim. Only the email leg is authoritative — rolling back a
  // successfully-emailed offer because Telnyx had an outage would re-offer an
  // order the florist already received. Closes lib/lifecycle.ts's
  // `reachout-comms-fail` branch (now `status: "handled"`, updated in Task 8),
  // and `reachout-no-sms-phone` below covers the missing-phone skip case.
  // Same predicate the confirm dialog shows CX before they send — the ordering
  // that makes test mode mirror live behaviour is documented on the function
  // (lib/offerChannels.ts::smsSkipReason).
  const smsSkip = smsSkipReason(r, wantSms);

  if (smsSkip) {
    await logCommunication({
      channel: "sms", audience: "florist", kind: "offer_sms", orderId: a.order_id, floristId: a.florist_id,
      assignmentId, testMode: r.testMode, status: "skipped", provider: "telnyx", error: smsSkip, actor,
    }).catch(() => {});
  } else {
    // SHORTENED FOR SMS ONLY. The two full URLs are 77 + 109 characters, which
    // pushes every locale to three billed segments; 43-char short links bring
    // that to two (lib/offerSmsContent.test.mjs pins the budget). Email keeps
    // the full URLs, so `resolveOfferVars` still mints ONE magic token per send
    // and both channels carry the same credential — the SMS just presents it
    // shortened. `shorten` falls back to the full URL on any failure, so a
    // shortener problem costs a segment, never the offer.
    const smsOrderUrl = await shorten(admin, r.vars.orderUrl, {
      kind: "magic", floristId: a.florist_id, assignmentId,
    });
    const smsUnsubscribeUrl = await shorten(admin, `${r.vars.unsubscribeUrl}&channel=sms`, {
      kind: "unsubscribe", floristId: a.florist_id, assignmentId,
    });
    const smsBody = buildOfferSmsContent(r.locale, r.overrides, {
      city: r.vars.city,
      payoutPrice: a.payout_price ?? null,
      replyWindow: r.vars.replyWindow,
      // Same fact the email uses, resolved once in resolveOfferVars: the two
      // channels must not describe different deals for the same offer.
      singlePayment: r.singlePayment,
      // Absolute florist-local deadline, or null -> the SMS falls back to the
      // relative countdown. Resolved once by resolveOfferVars, so the SMS and
      // the email can never quote different deadlines for the same offer.
      deadlineTime: r.vars.deadlineTime,
      variant: r.vars.variant,
      floristName: r.vars.floristName,
      // The same magic URL the email CTA carries, shortened above —
      // resolveOfferVars minted the token once for this send, so the two
      // channels can't drift onto different tokens.
      orderUrl: smsOrderUrl,
      // The SMS opt-out link must land on the channel-aware unsubscribe
      // route with channel=sms, so tapping it only silences texts, not
      // order emails — see app/api/florist/unsubscribe/route.ts. Appends
      // to (never replaces) the URL resolveOfferVars already minted, so the
      // email leg's URL and the test-mode placeholder-token substitution
      // are untouched — `&` is correct, the URL already carries `?locale=…`.
      // Shortened above, AFTER the channel param is appended, so the short code
      // resolves to the sms-scoped opt-out and not the email one.
      unsubscribeUrl: smsUnsubscribeUrl,
    });
    const smsSent = await sendSms({
      to: r.smsTo!,
      body: smsBody,
      context: {
        orderId: a.order_id, operation: "offer_sms",
        audience: "florist", kind: "offer_sms", floristId: a.florist_id,
        assignmentId, testMode: r.testMode, actor,
      },
    }).catch(() => ({ ok: false as const, error: "sms-threw" }));
    smsDelivered = smsSent.ok;
  }

  // ---- Did the offer actually go anywhere? ----
  // Every leg is individually allowed to fail soft — that is deliberate, and
  // each reason is recorded on the communications row. But when they ALL fail,
  // nothing reached this florist, and marking the assignment `sent` would be a
  // lie with consequences: it burns a live offer window, and the wave engine
  // treats the florist as contacted and moves on rather than re-offering.
  //
  // Seen on order #2000022 (Val-de-Moder, FR): Telnyx went out of funds
  // mid-session, so 12 SMS failed and 3 had no number; every one of those
  // florists had no email and no push subscription, and all 15 assignments were
  // recorded `sent` having reached nobody.
  //
  // So roll the claim back exactly as a hard email failure does, leaving the
  // row `candidate` for the wave to retry. Push is not counted: it returns void
  // (unobservable) and a push to a stale subscription is the same silent
  // non-delivery this guard exists to catch.
  if (!emailDelivered && !smsDelivered) {
    await rollbackClaim(admin, assignmentId, a);
    // Two very different situations wear the same "nothing was delivered", and
    // the wave engine has to tell them apart: a shop we simply cannot reach
    // (skip it, offer the next one) versus an outage of ours (leave the order
    // alone and retry the same shop). `floristUnreachable` is the one place
    // that rule lives — see its comment for why the Val-de-Moder Telnyx outage
    // must NOT be treated as fifteen unreachable florists.
    if (floristUnreachable(emailSkip, smsSkip)) {
      return { ok: false, error: "florist-unreachable", skipReason: emailSkip ?? smsSkip ?? null };
    }
    return { ok: false, error: "no-channel-delivered" };
  }

  // Deliberately excludes `escalated` (see ORDER_RESENDABLE_STATUSES in
  // lib/reachout.ts) — a resend on an escalated order is demoted back to
  // reaching_out by the ROUTE, after this function returns ok, not here.
  await admin.from("orders").update({ status: "reaching_out" }).eq("id", a.order_id).in("status", ["matched", "received", "reaching_out"]);
  await admin.from("order_events").insert({
    order_id: a.order_id, type: "outreach_sent",
    payload: { assignmentId, test_mode: r.testMode, expires_at: r.expiresAt, via: actor === "system" ? "auto" : "manual", resend: !!opts?.resend },
    actor,
  });
  // A live order PREEMPTS recruiting. Without this, a prospect mid-funnel could
  // get "we have an order for you" and "join our network" in the same hour,
  // which reads as two departments who don't talk. The run is PAUSED, not
  // stopped: if the order goes elsewhere, lib/sequences/reconcile.ts resumes it
  // at the same step rather than restarting the pitch. Best-effort — a
  // bookkeeping failure must never hold up a real order.
  //
  // Sits BELOW the "did the offer reach anyone?" guard on purpose: an offer that
  // reached nobody returns early, so a send that silently failed can no longer
  // pause a prospect's recruiting funnel for an order they were never told about.
  await pauseRecruitingFor(admin, a.florist_id, null).catch(() => 0);
  if (wantPush) {
    await sendPushToFlorist(
      a.florist_id,
      {
        title: "New Facundo order",
        body: `${r.order?.delivery_area ?? "New area"} · your payout €${a.payout_price ?? "—"}`,
        url: `/florist/orders/${a.id}`,
      },
      { kind: "offer_push", orderId: a.order_id, assignmentId, testMode: r.testMode, actor }
    ).catch(() => {});
  }

  // Warm this order's line-item translations for the locale we just sent in,
  // so the offer page the florist is about to open is a cache hit rather than a
  // 10-second model call in the middle of their page load
  // (lib/translations/lineItems.ts explains why the model can't run in a
  // render). Deliberately LAST: every message has already gone out, so this
  // delays nothing the florist is waiting on, only the response to whoever
  // triggered the send. Awaited rather than floated because a floating promise
  // is cancelled when the Worker isolate tears down — the same silent no-op the
  // short-link hit counter shipped with. It cannot throw.
  if (isLocale(r.locale)) await warmLineItemTranslations(admin, a.order_id, r.locale);

  return { ok: true, testMode: r.testMode, expiresAt: r.expiresAt, to: r.to, locale: r.locale };
}
