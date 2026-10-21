import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { captureError } from "@/lib/monitor";
import { logCommunication } from "@/lib/communications";
import { loadOverrides } from "@/lib/messageOverrides";
import { emailEnabled } from "@/lib/emailToggles";
import { smsEnabled } from "@/lib/smsToggles";
import { emailSkipReason, smsSkipReason, type ChannelVars } from "@/lib/offerChannels";
import { type Locale } from "@/lib/i18n";
import { resolveFloristSendLocale } from "@/lib/floristLocale";
import { resolveFloristSmsPhone, countryToRegion } from "@/lib/phone";
import { floristTimeZone } from "@/lib/floristTime";
import { formatOfferDeliverBy } from "@/lib/offerEmailContent";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";
import { orderDest } from "@/lib/floristMagicLink";
import { ensureUnsubscribeToken } from "@/lib/offerVars";
import { TEST_MODE_UNSUBSCRIBE_TOKEN } from "@/lib/unsubscribeChannel";
import { shorten } from "@/lib/shortLinkMint";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { buildAcceptConfirmEmail, buildAcceptConfirmSms } from "@/lib/acceptConfirmContent";
import { isSinglePayment } from "@/lib/payoutMath";

// "Thank you for accepting" — the confirmation a florist gets the moment they
// take an order, on email + SMS.
//
// WHY IT EXISTS. Accepting used to produce a message for everyone except the
// florist: the customer got the "assigned" notice (lib/clientComms.ts),
// Shopify got the write-back, CX got an order event — and the person who had
// just committed to making and delivering the bouquet got a screen change.
// This is the message that says thank you, states plainly that we trust them
// to deliver it correctly, and tells them what happens next (70% on the card
// now, photo in the app, 30% before delivery).
//
// BEST-EFFORT, ALWAYS. Called after the accept has already been committed
// (the CAS, the payout leg, the write-back). Nothing in here may throw or
// fail an accept — a florist must never lose an order because a courtesy
// message didn't send. Same contract and same shape as lib/issueComms.ts.
//
// REACHABILITY is decided by the SAME predicates the offer uses
// (lib/offerChannels.ts): a network/shared/bounced address, an opt-out, a
// snooze, a missing or permanently-undeliverable number all suppress their own
// leg here exactly as they do there. Growing a second, subtly different set of
// rules for the same florist is what that module exists to prevent.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const from = () => defaultFrom();

export interface AcceptConfirmInput {
  assignmentId: string;
  floristId: string;
  orderId: string;
  /** What this florist is paid for the order (`order_assignments.payout_price`). */
  payout?: number | null;
  /** Who triggered the accept — the florist's own email, or the staff member
   *  accepting on their behalf from the order page. */
  actor?: string | null;
}

/** Send the accept confirmation on every channel that can carry it. Never
 * throws; every skip is recorded in `communications` so the trail explains a
 * florist who wasn't told, rather than going silent. */
export async function notifyFloristOfAccept(input: AcceptConfirmInput): Promise<void> {
  try {
    const admin = createServiceClient();

    const { data: s } = await admin
      .from("app_settings")
      // One string literal on purpose — supabase-js infers the row type from
      // it, and splitting it across a concatenation collapses it to unknown.
      .select("test_mode, test_email, test_phone, email_accept_confirm_enabled, sms_accept_confirm_enabled")
      .eq("id", 1)
      .single();
    const testMode = s?.test_mode ?? true;
    const testEmail = s?.test_email ?? null;
    const testPhone = s?.test_phone ?? null;
    const acceptEmailEnabled = emailEnabled(s, "accept_confirm"); // fails OPEN
    const acceptSmsEnabled = smsEnabled(s, "accept_confirm"); // fails CLOSED

    const { data: florist } = await admin
      .from("florists")
      .select("id, name, email, locale, address, city_id, lat, lng, trust_tier, unsubscribe_token, order_emails_opt_out, order_emails_snoozed_until, phone_mobile, phone_web, phone_maps, order_sms_opt_out, order_sms_snoozed_until, is_test_shop, network_id, email_shared_count, email_bounced_at, sms_undeliverable_at")
      .eq("id", input.floristId)
      .single();
    if (!florist) return; // nothing to send to, and nothing meaningful to log against

    // Which payment story this confirmation tells. A tier with a 0% delivery leg
    // pays the whole payout on accept, so "70% is on its way, the photo releases
    // the other 30%" would contradict the app the florist is about to open and
    // would make the photo look optional the moment they notice it isn't holding
    // any money. Read from the tier row, not a tier code, so it stays true for
    // any future tier on the same shape (lib/payoutMath.ts::isSinglePayment).
    //
    // Fails toward the SPLIT wording: a missing tier or an unreadable row sends
    // the 70/30 text, which understates what a paid-in-full shop is getting rather
    // than overstating what a tier-2 shop is getting. Never throws — this whole
    // module is best-effort by construction and must not cost anyone an accept.
    let singlePayment = false;
    if (florist.trust_tier) {
      const { data: tierRow } = await admin
        .from("trust_tiers")
        .select("split_on_delivery")
        .eq("code", florist.trust_tier)
        .maybeSingle();
      if (tierRow) singlePayment = isSinglePayment(tierRow);
    }

    // Test mode redirects to the shared staff inbox/phone and substitutes inert
    // tokens — but not for a shop WE own, which is how the florist experience
    // is driven end to end before go-live. Same rule as lib/offerVars.ts.
    const testShop = florist.is_test_shop === true;
    const redirectToTestInbox = testMode && !testShop;

    const nowMs = Date.now();
    const emailSnoozedUntil = florist.order_emails_snoozed_until ? new Date(florist.order_emails_snoozed_until).getTime() : 0;
    const floristSuppressed = !!florist.order_emails_opt_out || emailSnoozedUntil > nowMs;
    const smsSnoozedUntil = florist.order_sms_snoozed_until ? new Date(florist.order_sms_snoozed_until).getTime() : 0;
    const floristSmsSuppressed = !!florist.order_sms_opt_out || smsSnoozedUntil > nowMs;

    // One `cities.country` read serving both consumers (locale fallback for a
    // florist ingested before locale derivation, and the region a scraped
    // national phone number needs to parse) — same collapse as offerVars.
    const needsRegionForLocale = !florist.locale && !!florist.city_id;
    const needsRegionForSms = acceptSmsEnabled && !!florist.city_id;
    let cityCountry: string | null = null;
    if (florist.city_id && (needsRegionForLocale || needsRegionForSms)) {
      const { data: cityRow } = await admin.from("cities").select("country").eq("id", florist.city_id).single();
      cityCountry = cityRow?.country ?? null;
    }
    const locale: Locale = resolveFloristSendLocale(florist, needsRegionForLocale ? cityCountry : null);

    const smsIntended = acceptSmsEnabled
      ? resolveFloristSmsPhone(florist, needsRegionForSms ? countryToRegion(cityCountry) : null)
      : null;

    let blockingError: "no-test-email" | "florist-no-email" | null = null;
    if (acceptEmailEnabled && redirectToTestInbox && (!testEmail || !EMAIL_RE.test(testEmail))) blockingError = "no-test-email";
    if (!blockingError && acceptEmailEnabled && (!florist.email || !EMAIL_RE.test(florist.email))) blockingError = "florist-no-email";

    // The offer's own channel rules, verbatim. `offerEmailEnabled` /
    // `smsOfferEnabled` are the field NAMES on the shared shape — what they
    // carry here is this message's toggles. (Renaming them across every offer
    // call site is a bigger change than this message warrants; the meaning
    // "is this channel's toggle on" is the same either way.)
    const channelVars: ChannelVars = {
      offerEmailEnabled: acceptEmailEnabled,
      floristSuppressed,
      smsOfferEnabled: acceptSmsEnabled,
      smsIntended,
      smsTo: acceptSmsEnabled ? (redirectToTestInbox ? testPhone : smsIntended) : null,
      redirectToTestInbox,
      floristSmsSuppressed,
      suppressReason: !floristSuppressed ? null : florist.order_emails_opt_out ? "opted-out" : "snoozed",
      smsSuppressReason: !floristSmsSuppressed ? null : florist.order_sms_opt_out ? "opted-out" : "snoozed",
      blockingError,
      emailIdentityProblem: florist.network_id
        ? "network"
        : (florist.email_shared_count ?? 1) > 1
          ? "shared"
          : florist.email_bounced_at
            ? "bounced"
            : null,
      smsUndeliverable: !!florist.sms_undeliverable_at,
    };
    const emailSkip = emailSkipReason(channelVars);
    const smsSkip = smsSkipReason(channelVars);

    const logBase = {
      audience: "florist" as const,
      orderId: input.orderId,
      floristId: florist.id,
      assignmentId: input.assignmentId,
      testMode,
      actor: input.actor ?? null,
    };

    // Both legs blocked — record why on each and stop before doing any of the
    // work (order read, overrides, magic-link mint) neither channel needs.
    if (emailSkip && smsSkip) {
      await logCommunication({ ...logBase, channel: "email", kind: "accept_confirm", status: "skipped", provider: "resend", error: emailSkip });
      await logCommunication({ ...logBase, channel: "sms", kind: "accept_confirm_sms", status: "skipped", provider: "telnyx", error: smsSkip });
      return;
    }

    const { data: order } = await admin
      .from("orders")
      .select("order_name, delivery_at")
      .eq("id", input.orderId)
      .single();
    // Same short-id fallback as lib/issueComms.ts, so a Shopify order with no
    // name still names something the florist can quote back to us.
    const orderLabel = order?.order_name ?? input.orderId.slice(0, 8);
    // The florist's OWN timezone, from the shop's coordinates — a Madrid shop
    // reading a London wall-clock delivery time is the bug formatOfferDeliverBy
    // was given a `tz` for.
    const deliverBy = formatOfferDeliverBy(locale, order?.delivery_at ?? null, floristTimeZone(florist.lat, florist.lng));
    const overrides = await loadOverrides(admin, locale);

    // ONE magic link per send, shared by the email CTA and the SMS body, so a
    // single message never puts two independent credentials into the world.
    // A redirected test send gets the inert sentinel: that inbox is shared by
    // several staff and this link is a LOGIN to a real shop.
    const orderUrl = await mintMagicLink(admin, {
      floristId: florist.id,
      dest: orderDest(input.assignmentId),
      purpose: "accept_confirm",
      assignmentId: input.assignmentId,
      placeholder: redirectToTestInbox,
    });

    if (emailSkip) {
      await logCommunication({ ...logBase, channel: "email", kind: "accept_confirm", status: "skipped", provider: "resend", error: emailSkip });
    } else {
      const { subject, html, bodyText } = buildAcceptConfirmEmail(locale, overrides, {
        orderLabel,
        floristName: florist.name ?? null,
        payout: input.payout == null ? null : `€${Number(input.payout).toFixed(2)}`,
        deliverBy,
        orderUrl,
        singlePayment,
        testMode,
      });
      await sendEmail({
        to: (redirectToTestInbox ? testEmail : florist.email)!,
        from: from(),
        subject,
        body: bodyText,
        html,
        context: { ...logBase, kind: "accept_confirm" },
      });
    }

    if (smsSkip) {
      await logCommunication({ ...logBase, channel: "sms", kind: "accept_confirm_sms", status: "skipped", provider: "telnyx", error: smsSkip });
    } else {
      // A test-mode send must never carry a real florist's opt-out token: a
      // staffer reviewing the shared test inbox could otherwise unsubscribe a
      // real shop. A test shop is exempt — its own address, its own opt-out.
      const unsubscribeToken = redirectToTestInbox
        ? TEST_MODE_UNSUBSCRIBE_TOKEN
        : await ensureUnsubscribeToken(admin, florist.id, florist.unsubscribe_token ?? null);
      // Both links shortened — a long URL costs a segment. `shorten` falls back
      // to the full URL on any failure, so a shortener problem costs a segment,
      // never the message.
      const smsOrderUrl = await shorten(admin, orderUrl, { kind: "magic", floristId: florist.id, assignmentId: input.assignmentId });
      const smsUnsubscribeUrl = await shorten(
        admin,
        `${FLORIST_BASE}/florist/unsubscribe/${unsubscribeToken}?locale=${locale}&channel=sms`,
        { kind: "unsubscribe", floristId: florist.id, assignmentId: input.assignmentId }
      );
      const body = buildAcceptConfirmSms(locale, overrides, {
        orderLabel,
        orderUrl: smsOrderUrl,
        unsubscribeUrl: smsUnsubscribeUrl,
        singlePayment,
      });
      await sendSms({
        to: channelVars.smsTo!,
        body,
        context: { ...logBase, operation: "accept_confirm_sms", kind: "accept_confirm_sms" },
      });
    }
  } catch (e) {
    captureError("acceptComms.notifyFloristOfAccept", e);
  }
}
