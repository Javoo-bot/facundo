// "Thank you for accepting" — the confirmation a florist gets the moment they
// take an order, in both channels it goes out on.
//
// Pure content, no I/O: same property (and the same reason) as
// lib/offerEmailContent.ts and lib/offerSmsContent.ts — the message editor's
// preview and the real send call THIS code, so the two cannot drift. The send
// site is lib/acceptComms.ts.
//
// Relative imports only, so plain `node --test` can reach it without tsconfig
// path aliases.
import {
  renderEmailShell,
  renderFactsBlock,
  renderHeadline,
  renderParagraphs,
  type FactRow,
} from "./emailTemplate.ts";
import { tWithOverrides, type Locale } from "./i18n/index.ts";
import { toGsm7Safe } from "./smsSegments.ts";

export interface BuiltMessage {
  subject: string;
  html: string;
  bodyText: string;
}

export interface AcceptConfirmVars {
  /** Order name ("#1234"), already falling back to a short id at the send site. */
  orderLabel: string;
  /** Shop name. Null when we have none — the greeting drops the name rather
   *  than addressing a real shop as "there". */
  floristName: string | null;
  /** What this florist is paid, formatted by the caller (it owns the currency
   *  and the locale's number format). Null when the payout is unknown, which
   *  drops the row instead of printing a euro sign with nothing after it. */
  payout: string | null;
  /** "6 Aug 2026, 18:00" — already formatted in the FLORIST's timezone by the
   *  send site (lib/floristTime.ts). Null drops the row. */
  deliverBy: string | null;
  /** One-click sign-in link landing on this order — the same magic URL the
   *  offer carries, minted once per send and shared by both channels. */
  orderUrl: string;
  /** This florist's tier paid the WHOLE payout on accept (a 0% delivery leg —
   *  lib/payoutMath.ts::isSinglePayment), so the split version of these two
   *  paragraphs would contradict the app they are about to open. Swaps `paid`
   *  and `next` for their `*Full` variants: the money arrives in one payment,
   *  and the delivery photo is still owed as PROOF rather than as the thing
   *  releasing the rest. Defaults false, so a caller that forgets it sends the
   *  70/30 wording — wrong for a paid-in-full shop, but never wrong in the dangerous
   *  direction of promising a split shop money it has not earned yet. */
  singlePayment?: boolean;
  testMode: boolean;
}

/** The confirmation email. `trust` is the paragraph the whole message exists
 * for; everything else is the practical follow-through (money, next step,
 * address, what to do when it goes wrong). */
export function buildAcceptConfirmEmail(
  locale: Locale,
  overrides: Record<string, string>,
  vars: AcceptConfirmVars
): BuiltMessage {
  const tt = (k: string, v?: Record<string, string | number>) =>
    tWithOverrides(overrides, locale, `email.acceptConfirm.${k}`, v);

  const subject = tt("subject", { orderLabel: vars.orderLabel });
  // A shop with no stored name gets a FULL alternate sentence, not the same
  // one with an empty slot — the same rule email.offer.introNoCity follows.
  // Interpolating "" would leave a dangling comma in every locale, and a
  // generic filler ("there") addresses a real shop as nobody.
  const trust = vars.floristName
    ? tt("trust", { orderLabel: vars.orderLabel, floristName: vars.floristName })
    : tt("trustNoName", { orderLabel: vars.orderLabel });

  const rows: FactRow[] = [{ label: tt("factOrder"), value: vars.orderLabel }];
  if (vars.deliverBy) rows.push({ label: tt("factDeliverBy"), value: vars.deliverBy });
  if (vars.payout) rows.push({ label: tt("factPayout"), value: vars.payout });

  const paragraphs = [
    trust,
    tt(vars.singlePayment ? "paidFull" : "paid"),
    tt(vars.singlePayment ? "nextFull" : "next"),
    tt("address"),
    tt("problem"),
  ];

  const html = renderEmailShell(
    renderHeadline(tt("headline")) + renderFactsBlock(rows) + renderParagraphs(paragraphs.join("\n\n")),
    {
      testMode: vars.testMode,
      locale,
      overrides,
      preheader: tt("preheader"),
      cta: { label: tt("cta"), url: vars.orderUrl },
    }
  );

  const bodyText = [tt("headline"), "", ...paragraphs, "", vars.orderUrl].join("\n");
  return { subject, html, bodyText };
}

/** The confirmation SMS: one localized body + the opt-out line, ready to hand
 * to sendSms.
 *
 * The opt-out line is not optional, for the same reason it isn't on the offer
 * SMS: we have no inbound webhook, so there is no "reply STOP" to honor and
 * the link is the only opt-out we offer.
 *
 * Everything is folded GSM-7-safe before it goes out — an accented shop name
 * or order label would otherwise flip the WHOLE message to UCS-2's 67-char
 * segments and double the bill. */
export function buildAcceptConfirmSms(
  locale: Locale,
  overrides: Record<string, string>,
  vars: { orderLabel: string; orderUrl: string; unsubscribeUrl: string; singlePayment?: boolean }
): string {
  // Same variant choice as the email above, and for the same reason: this text
  // lands on the florist's phone seconds before they open the app.
  const bodyKey = vars.singlePayment ? "sms.acceptConfirm.bodyFull" : "sms.acceptConfirm.body";
  const body = tWithOverrides(overrides, locale, bodyKey, {
    orderLabel: toGsm7Safe(vars.orderLabel),
    url: vars.orderUrl,
  });
  const optOut = tWithOverrides(overrides, locale, "sms.acceptConfirm.optOut", { url: vars.unsubscribeUrl });
  return `${toGsm7Safe(body)}\n${toGsm7Safe(optOut)}`;
}
