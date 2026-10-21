// Why a given channel will NOT carry this offer.
//
// Lifted verbatim out of lib/reachoutSend.ts and lib/reachoutRenotify.ts, which
// had grown near-duplicate copies of these rules. The offer page's send-confirm
// dialog needs the SAME answers BEFORE sending, and a third copy would drift —
// drift on exactly this kind of shared predicate is what produced the
// withdrawn-offer bug (a live-looking offer no florist could accept).
//
// So: one function, three callers (sendOffer, renotifyOffer, and the preview
// route behind the dialog). Same answer by construction.
//
// Pure and dependency-free (relative imports only) so plain `node --test` can
// exercise it — same convention as lib/reachout.ts and lib/lateAccept.ts.
//
// NOT COVERED HERE: push. Its availability is "does this florist have a
// push_subscriptions row", which is a DB read rather than a function of the
// resolved offer vars — the preview route checks it separately.

import type { OfferChannel } from "./reachout.ts";

/** The already-resolved offer variables these rules read. A structural subset
 *  of lib/offerVars.ts::resolveOfferVars's return, so the tests can build
 *  fixtures without touching the database. */
export interface ChannelVars {
  offerEmailEnabled: boolean;
  floristSuppressed: boolean;
  smsOfferEnabled: boolean;
  /** The florist's own number, resolved only when SMS is enabled. */
  smsIntended: string | null;
  /** Where the text would actually go (the test phone under redirect). */
  smsTo: string | null;
  redirectToTestInbox: boolean;
  floristSmsSuppressed: boolean;
  suppressReason: string | null;
  smsSuppressReason: string | null;
  blockingError: "no-test-email" | "florist-no-email" | null;
  /** Why the stored address does not identify THIS shop, or null when it does.
   *  Resolved by lib/offerVars.ts from the florist's network link and email
   *  flags — see supabase/migrations/2026-08-06-florist-networks.sql. */
  emailIdentityProblem: "network" | "shared" | "bounced" | null;
  /** Telnyx reported a PERMANENT delivery failure for this number, so texting
   *  it again reaches nobody. Resolved by lib/offerVars.ts from
   *  `florists.sms_undeliverable_at`. */
  smsUndeliverable: boolean;
}

/** Skip reasons, matching the strings already logged to `communications` and
 *  already mapped to human copy in components/orders/ReachoutPanel.tsx. */
export type ChannelSkipReason =
  | "channel-not-selected"
  | "disabled-by-settings"
  | "no-test-email"
  | "florist-no-email"
  | "florist-email-is-network"
  | "florist-email-shared"
  | "florist-email-bounced"
  | "florist-opted-out"
  | "florist-snoozed"
  | "florist-no-sms-phone"
  | "florist-sms-undeliverable"
  | "no-test-phone"
  | "florist-sms-opted-out"
  | "florist-sms-snoozed";

/**
 * Skip reasons that are a fact about THIS SHOP — a missing/borrowed/bounced
 * address, a number that doesn't exist or has hard-failed, an opt-out. Retrying
 * reaches the same nobody; a DIFFERENT shop may well be reachable.
 *
 * The complement (`channel-not-selected`, `disabled-by-settings`,
 * `no-test-email`, `no-test-phone`) is a fact about OUR configuration: it blocks
 * that channel for every candidate equally and says nothing about this one.
 */
export const SHOP_SPECIFIC_SKIP_REASONS: readonly ChannelSkipReason[] = [
  "florist-no-email",
  "florist-email-is-network",
  "florist-email-shared",
  "florist-email-bounced",
  "florist-opted-out",
  "florist-snoozed",
  "florist-no-sms-phone",
  "florist-sms-undeliverable",
  "florist-sms-opted-out",
  "florist-sms-snoozed",
];

export function isShopSpecificSkip(reason: ChannelSkipReason | null): boolean {
  return reason != null && SHOP_SPECIFIC_SKIP_REASONS.includes(reason);
}

/**
 * Nothing reached this florist — is that THIS SHOP's fault, or ours?
 *
 * Answers the question `lib/waves.ts` has to ask when a send delivers on no
 * channel: skip this candidate and offer the next one, or leave the order alone
 * and retry the same shop next tick?
 *
 * Pass each channel's skip reason, or `null` for a channel that was actually
 * ATTEMPTED and failed at the provider (Telnyx out of funds, a Resend 429).
 *
 * True only when every channel was blocked before it was attempted AND at least
 * one of those blocks is about this shop. Both halves earn their place:
 *
 *  - A provider failure is transient and affects everyone, so a `null` here
 *    means "retry" — this is the Val-de-Moder case in reachoutSend.ts, where
 *    skipping would have burned all 15 candidates on one Telnyx outage.
 *  - All-environmental blocks (offers switched off, no test email) are an
 *    outage of ours. Skipping through the list would spend every candidate on a
 *    problem no candidate can fix; the order should sit and escalate instead so
 *    a human turns the channel back on.
 *
 * Note the deliberately asymmetric case: email blocked for this shop + SMS
 * unavailable to everyone (D in QA/A2) IS unreachable. Email is the only live
 * channel, and for this shop it is a dead end — but the next shop's address may
 * be fine, which is exactly why skipping forward is right.
 */
export function floristUnreachable(
  emailSkip: ChannelSkipReason | null,
  smsSkip: ChannelSkipReason | null
): boolean {
  if (emailSkip == null || smsSkip == null) return false; // a channel was attempted → transient
  return isShopSpecificSkip(emailSkip) || isShopSpecificSkip(smsSkip);
}

/**
 * Why the EMAIL leg won't fire, or null when it will.
 *
 * `wanted` is whether the caller asked for this channel at all; a caller doing
 * pre-flight (the preview) passes true, since it wants to know whether the
 * channel COULD fire, not whether it happens to be ticked.
 */
export function emailSkipReason(v: ChannelVars, wanted: boolean = true): ChannelSkipReason | null {
  if (!wanted) return v.offerEmailEnabled ? "channel-not-selected" : "disabled-by-settings";
  // blockingError first: it is the configuration problem the send itself
  // refuses on (a 400 from the POST), so it outranks the softer reasons.
  if (v.blockingError) return v.blockingError;
  if (!v.offerEmailEnabled) return "disabled-by-settings";
  // The address exists and is well-formed, but it isn't THIS shop's — it's a
  // network/franchise head office, an address several shops share, or one that
  // hard-bounced. Writing to it doesn't reach this florist, and in the network
  // case it spams a third party who can do nothing with the order.
  //
  // Ahead of the opt-out checks on purpose: when both apply, "we have the wrong
  // address" is the one CX can act on, and an opt-out recorded against an
  // address that was never this shop's says nothing about this shop anyway.
  //
  // Checked regardless of `redirectToTestInbox`, so a test-mode send reports the
  // same unreachability a live one would — the same reasoning that puts
  // `florist-no-sms-phone` ahead of the test-phone check in smsSkipReason.
  if (v.emailIdentityProblem) {
    return v.emailIdentityProblem === "network"
      ? "florist-email-is-network"
      : v.emailIdentityProblem === "shared"
        ? "florist-email-shared"
        : "florist-email-bounced";
  }
  if (v.floristSuppressed) return v.suppressReason === "opted-out" ? "florist-opted-out" : "florist-snoozed";
  return null;
}

/**
 * Why the SMS leg won't fire, or null when it will.
 *
 * ORDER IS LOAD-BEARING and preserved exactly from lib/reachoutSend.ts:
 * `florist-no-sms-phone` is checked AHEAD of the test-phone check so test mode
 * mirrors live behaviour — a florist with no parseable number is reported
 * unreachable whether or not test mode is redirecting the send elsewhere. And
 * the test-phone check keys off `redirectToTestInbox`, not `testMode`, because
 * a test shop texts its OWN number and a missing global test phone must not
 * block it.
 */
export function smsSkipReason(v: ChannelVars, wanted: boolean = true): ChannelSkipReason | null {
  if (!wanted) return v.smsOfferEnabled ? "channel-not-selected" : "disabled-by-settings";
  if (!v.smsOfferEnabled) return "disabled-by-settings";
  if (!v.smsIntended) return "florist-no-sms-phone";
  // Ahead of the test-phone check, and checked regardless of redirection, for
  // the same reason `florist-no-sms-phone` is: test mode must report the
  // unreachability a live send would hit rather than hide it behind the test
  // phone. Ahead of the opt-out checks too — "the number is dead" is the fact
  // CX can act on, and it is the counterpart of `florist-email-bounced`.
  if (v.smsUndeliverable) return "florist-sms-undeliverable";
  if (v.redirectToTestInbox && !v.smsTo) return "no-test-phone";
  if (v.floristSmsSuppressed) {
    return v.smsSuppressReason === "opted-out" ? "florist-sms-opted-out" : "florist-sms-snoozed";
  }
  return null;
}

export interface ChannelAvailability {
  channel: OfferChannel;
  available: boolean;
  /** Why not, when `available` is false. Null when the channel can fire. */
  reason: ChannelSkipReason | "no-push-subscription" | null;
}

/**
 * Pre-flight availability for all three channels, for the send-confirm dialog.
 *
 * `hasPushSubscription` is passed in rather than derived: it is the one signal
 * that needs a DB read (see the module comment).
 */
export function offerChannelAvailability(v: ChannelVars, hasPushSubscription: boolean): ChannelAvailability[] {
  const email = emailSkipReason(v);
  const sms = smsSkipReason(v);
  return [
    { channel: "email", available: email === null, reason: email },
    { channel: "sms", available: sms === null, reason: sms },
    { channel: "push", available: hasPushSubscription, reason: hasPushSubscription ? null : "no-push-subscription" },
  ];
}
