// Pure offer-SMS content builder — the SMS sibling of lib/offerEmailContent.ts,
// and alias-free for the same reason: plain `node --test` can't resolve "@/"
// tsconfig path aliases, so any file under test must import only relative paths.
//
// The segment math deliberately lives in ./smsSegments.ts, not here.
import { tWithOverrides, type Locale } from "./i18n/index.ts";
import { toGsm7Safe } from "./smsSegments.ts";

export interface OfferSmsVars {
  city: string | null;
  payoutPrice: number | string | null;
  replyWindow: string;
  /** Florist-local wall-clock deadline ("18:30"), or null when we can't state
   * one honestly — see lib/floristTime.ts::formatOfferDeadline. Null falls back
   * to the relative `replyWindow`, exactly as the offer email does. */
  deadlineTime: string | null;
  /** "full" = a florist we haven't worked with recently (introduces
   * Facundo); "short" = a repeat florist (skips the introduction). Mirrors
   * the offer email's variant split so both channels say the same thing. */
  variant: "full" | "short";
  /** Only read by the "short" variant's greeting. */
  floristName: string | null;
  /** One-click sign-in link landing on this order — the SAME magic URL the
   * offer email's CTA carries (both resolved once by lib/offerVars.ts). This
   * matters most on SMS: typing a six-digit code or a password on a phone,
   * from a text, was the worst version of the old sign-in wall. */
  orderUrl: string;
  /** This florist's tier pays the WHOLE payout on accept (a 0% delivery leg —
   * lib/payoutMath.ts::isSinglePayment). Swaps the two flow steps that state
   * the split. Defaults false, so a caller that forgets it sends the 70/30
   * wording: wrong for a paid-in-full shop, but never wrong in the dangerous
   * direction of promising a split shop money it has not earned yet. */
  singlePayment?: boolean;
  unsubscribeUrl: string;
}

/** The full offer SMS body: localized offer line + the order link + the
 * opt-out line. One string, ready to hand to sendSms.
 *
 * The opt-out line is NOT optional — with no inbound webhook there is no
 * "reply STOP" to honor, so the link is the only opt-out mechanism we offer
 * (see the spec's compliance section). */
export function buildOfferSmsContent(
  locale: Locale,
  overrides: Record<string, string>,
  vars: OfferSmsVars
): string {
  const url = vars.orderUrl;
  // The 2026-08-05 copy dropped the euro figure in favour of the 70/30 split,
  // so {payout} is absent from the default bodies — but it is still
  // interpolated, so an editor override can put the amount back with no
  // deploy. The null fallback is an ASCII hyphen, NOT an em dash: an em dash
  // is outside GSM-7 and would flip the whole message to 67-char UCS-2
  // segments, doubling the bill on exactly the sends where we know least.
  const payout = vars.payoutPrice === null || vars.payoutPrice === undefined ? "-" : String(vars.payoutPrice);

  // The deadline fragment: an absolute florist-local time when we have one,
  // otherwise the relative countdown. Same fallback rule as the offer email.
  const deadline = vars.deadlineTime
    ? tWithOverrides(overrides, locale, "sms.offer.byTime", { time: vars.deadlineTime })
    : tWithOverrides(overrides, locale, "sms.offer.within", { window: vars.replyWindow });

  // Fold the florist-supplied strings to a GSM-7-safe form before
  // interpolation: one accented character (Málaga, Córdoba, "Floristería")
  // flips the ENTIRE message to UCS-2's 67-char segments and doubles the bill.
  // Catalog copy is written GSM-7-safe by hand; these two values come from the
  // database and can be anything.
  // Same three bodies, each with a paid-in-full twin that drops "30% before
  // delivery" rather than restating a split this shop is not on. The variants
  // are written no longer than the originals so the 3-segment budget asserted
  // in lib/offerSmsContent.test.mjs still holds.
  const base = vars.variant === "short" ? "sms.offer.repeat" : vars.city ? "sms.offer.body" : "sms.offer.bodyNoCity";
  const key = vars.singlePayment ? `${base}Full` : base;
  const line = tWithOverrides(overrides, locale, key, {
    ...(vars.city ? { city: toGsm7Safe(vars.city) } : {}),
    ...(vars.variant === "short"
      ? { floristName: toGsm7Safe(vars.floristName ?? tWithOverrides(overrides, locale, "email.offer.genericFloristName")) }
      : {}),
    payout,
    window: vars.replyWindow,
    deadline,
    url,
  });
  const optOut = tWithOverrides(overrides, locale, "sms.offer.optOut", { url: vars.unsubscribeUrl });
  return `${line} ${optOut}`;
}
