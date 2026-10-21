// Pure offer-email content builder, factored out of lib/reachoutSend.ts so it
// can be unit-tested directly: this file (unlike reachoutSend.ts) imports
// only relative paths, no "@/..." aliases — plain `node --test` can't resolve
// tsconfig path aliases, so any file under test must stay alias-free. Mirrors
// the same split lib/communications.ts uses for lib/communicationsRow.ts.
import { escapeHtml, renderEmailShell, renderFactsBlock, renderLinkLine, renderParagraphs } from "./emailTemplate.ts";
import { tWithOverrides, type Locale } from "./i18n/index.ts";
import { parseBlocks, renderBlocksHtml, renderBlocksText } from "./messages/blocks.ts";

// ~2 months, expressed in ms so it never drifts from calendar-month edge
// cases. Exported so lib/reachoutSend.test.mjs can assert the exact window
// without touching the DB.
export function recentAcceptedCutoffIso(nowMs: number): string {
  return new Date(nowMs - 60 * 24 * 3600_000).toISOString();
}

// True when `d` falls on the same local calendar day as `ref`.
function isSameDay(d: Date, ref: Date): boolean {
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

/** Locale-aware "when can you deliver" phrase for the offer subject —
 * "today" / a short "21 Jul"-style date / "soon" (order has no delivery_at
 * at all — rare, keep the subject sensible anyway). The two literal phrases
 * route through `tWithOverrides` (catalog keys `email.offer.when.*`) so a DB
 * override applies exactly like the rest of the offer email; the date branch
 * is inherently locale-aware already (`toLocaleDateString(locale, ...)`), so
 * it isn't a catalog key. `now` is injectable for tests. */
export function formatOfferWhen(
  locale: Locale,
  overrides: Record<string, string>,
  deliveryAtIso: string | null | undefined,
  now: Date = new Date()
): string {
  if (!deliveryAtIso) return tWithOverrides(overrides, locale, "email.offer.when.soon");
  const d = new Date(deliveryAtIso);
  if (Number.isNaN(d.getTime())) return tWithOverrides(overrides, locale, "email.offer.when.soon");
  if (isSameDay(d, now)) return tWithOverrides(overrides, locale, "email.offer.when.today");
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** Short, human, locale-aware reply-window phrase for the offer email's
 * closing note, derived from the actual `offer_expires_at` we just set for
 * this send (not re-guessed) — "15 minutes" / "1 hour" / "2 hours". Falls
 * back to a vague-but-honest phrase if the expiry is somehow missing or
 * already past. Plurals are separate catalog keys chosen by this branch
 * (`t()`/`interpolate()` has no plural machinery) and go through
 * `tWithOverrides` so a DB override applies. `nowMs` is injectable for tests. */
export function formatOfferReplyWindow(
  locale: Locale,
  overrides: Record<string, string>,
  expiresAtIso: string,
  nowMs: number = Date.now()
): string {
  const ms = new Date(expiresAtIso).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return tWithOverrides(overrides, locale, "email.offer.replyWindow.couple");
  const mins = Math.round(ms / 60_000);
  if (mins < 60) {
    return mins <= 1
      ? tWithOverrides(overrides, locale, "email.offer.replyWindow.fewMinutes")
      : tWithOverrides(overrides, locale, "email.offer.replyWindow.minutes", { count: mins });
  }
  const hours = Math.round(mins / 60);
  return hours === 1
    ? tWithOverrides(overrides, locale, "email.offer.replyWindow.hour")
    : tWithOverrides(overrides, locale, "email.offer.replyWindow.hours", { count: hours });
}

/** Locale-aware "deliver by" fact value. Not a catalog key (no translatable
 * text here, just Intl date/time formatting), so no `overrides` param.
 * `en` deliberately keeps the "en-GB" Intl locale rather than bare "en":
 * bare "en" (en-US) reorders to month-first + 12h AM/PM, a real regression
 * for EN florists used to the day-first + 24h shape the rest of the product
 * uses — every other locale gets its own resolved Intl locale.
 *
 * `tz` is the florist's own IANA zone (lib/floristTime.ts::floristTimeZone).
 * Passing null keeps the previous behaviour — formatting in the SERVER's zone —
 * which was wrong for every florist outside it: a Madrid shop was reading a
 * London wall-clock time for when the flowers were due. Null now only happens
 * when we genuinely have no coordinates for the shop. */
export function formatOfferDeliverBy(
  locale: Locale,
  iso: string | null | undefined,
  tz: string | null = null
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const intlLocale = locale === "en" ? "en-GB" : locale;
  try {
    return d.toLocaleString(intlLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    // Unknown zone — fall back to the server's rather than dropping the fact.
    return d.toLocaleString(intlLocale, { dateStyle: "medium", timeStyle: "short" });
  }
}

// Mirrors emailTemplate.ts's private FONT_STACK (not exported) — the same
// local-copy pattern lib/clientComms.ts uses for its photo caption.
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The four "how an order works" steps as a numbered list. Table-based and
 * inline-styled like every other helper in emailTemplate.ts — Outlook doesn't
 * lay out <ol> reliably, and a real <ol>'s markers can't be colored. */
function renderNumberedSteps(steps: string[]): string {
  const rows = steps
    .map(
      (s, i) => `
        <tr>
          <td width="26" valign="top" style="padding:${i === 0 ? "0" : "10px"} 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;font-weight:700;color:#1F7A55">${i + 1}.</td>
          <td valign="top" style="padding:${i === 0 ? "0" : "10px"} 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#52625A">${escapeHtml(s)}</td>
        </tr>`
    )
    .join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0">${rows}
      </table>`;
}

export interface OfferEmailVars {
  area: string | null;
  city: string | null; // parsed from area ("Girona · Catalonia" -> "Girona"), or null
  orderName: string;
  when: string;
  replyWindow: string;
  /** Florist-local wall-clock deadline ("18:30" / "7 Aug, 09:15"), or null when
   * we can't state one honestly — no coordinates for the shop, an unknown
   * zone, or a deadline already past. Null selects the relative countdown
   * sentence instead. Resolved by lib/floristTime.ts::formatOfferDeadline. */
  deadlineTime: string | null;
  deliverBy: string | null;
  payoutPrice: number | null;
  assignmentId: string;
  /** One-click sign-in link landing on this order's page. Resolved by
   * lib/offerVars.ts (which owns the mint) rather than built here, so the
   * email CTA and the offer SMS provably carry the SAME token — and so the
   * test-mode/preview sentinel substitution happens in exactly one place. */
  orderUrl: string;
  testMode: boolean;
  // Null when the florist record has no name (or wasn't resolvable) — the
  // localized fallback (catalog key email.offer.genericFloristName) is
  // resolved HERE, not in lib/offerVars.ts, so the English-leak guard test in
  // lib/reachoutSend.test.mjs can actually exercise it (offerVars.ts uses "@/"
  // aliases and isn't reachable from plain `node --test`).
  floristName: string | null;
  // "full" = today's existing content (headline/intro/5-step how-it-works);
  // "short" = a one-line greeting + facts only, for florists who already
  // know the flow (see lib/reachoutSend.ts::hasRecentAcceptedOrder).
  variant: "full" | "short";
  /** This florist's tier pays the WHOLE payout on accept (a 0% delivery leg —
   * lib/payoutMath.ts::isSinglePayment). Swaps the two flow steps that state
   * the split. Defaults false, so a caller that forgets it sends the 70/30
   * wording: wrong for a paid-in-full shop, but never wrong in the dangerous
   * direction of promising a split shop money it has not earned yet. */
  singlePayment?: boolean;
  unsubscribeUrl: string;
  howItWorksUrl: string;
  /** Public Q&A (app/help). Sits next to howItWorksUrl in the footer — the
   * pitch and the reference answer different questions. */
  helpUrl: string;
  supportEmail: string;
}

/** Builds the offer email's subject/html/plain-text from the catalog (via
 * `tWithOverrides`, so a DB override — dashboard/app/(staff)/email-templates —
 * takes effect with no deploy) and the resolved send-time facts in `vars`.
 * Exported so both `sendOffer` (lib/reachoutSend.ts) and the editor's preview
 * route (dashboard/app/api/settings/message-overrides/preview) render from
 * the exact same template code with the exact same overrides map — the
 * preview can never drift from what actually gets sent. Pure aside from
 * `t()`'s own (pure) lookups — no I/O, no DB. */
export function buildOfferEmailContent(
  locale: Locale,
  overrides: Record<string, string>,
  vars: OfferEmailVars
): { subject: string; html: string; bodyText: string } {
  const {
    area, city, orderName, when, replyWindow, deadlineTime, deliverBy, payoutPrice, testMode,
    floristName, variant, unsubscribeUrl, howItWorksUrl, helpUrl, orderUrl, supportEmail,
    singlePayment = false,
  } = vars;
  const tt = (key: string, v?: Record<string, string | number>) => tWithOverrides(overrides, locale, key, v);
  // Fallback for a missing florist name — localized (catalog key, not a
  // hardcoded English literal) so the short-variant greeting never leaks
  // English into a non-EN send. See the OfferEmailVars.floristName comment
  // for why this fallback lives here rather than in lib/offerVars.ts.
  const greetingName = floristName ?? tt("email.offer.genericFloristName");

  const subject = tt(area ? "email.offer.subject" : "email.offer.subjectNoCity", { city: city ?? "", orderName, when });

  const facts = [
    payoutPrice != null ? { label: tt("email.offer.factPayout"), value: `€${payoutPrice}` } : null,
    area ? { label: tt("email.offer.factArea"), value: area } : null,
    deliverBy ? { label: tt("email.offer.factDeliverBy"), value: deliverBy } : null,
  ].filter((f): f is { label: string; value: string } => f !== null);

  // Footer. The "Questions about this order?" support line was removed in the
  // 2026-08-05 review pass — the ask was to stop offering a contact route until
  // there was a chat behind it. It is BACK as of 2026-09-16, for two reasons:
  //
  //   1. The precondition is met. Florists have a real chat for order
  //      questions ("feat(support): a real chat for order questions").
  //   2. Removing it did not stop florists writing to us; it only removed the
  //      address they could write to. On order #2000034 a French florist with
  //      a question 43 minutes before expiry had nothing to reply to but the
  //      From address, which has no mailbox, and his message bounced. See
  //      docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.
  //
  // It points at `app_settings.florist_support_email`, the same address the
  // offer's List-Unsubscribe header already names and reply-to now falls back
  // to (lib/replyToken.ts::chooseReplyTo), so the three can never disagree.
  //
  // The "how it works" link now shows on BOTH variants: since the redesign it
  // points at a real explainer page, which is as useful to a first-time florist
  // as to a returning one. Unsubscribe stays last, always.
  const footerLinks =
    renderLinkLine(tt("email.offer.short.howItWorksLead"), tt("email.offer.short.howItWorksLink"), howItWorksUrl) +
    renderLinkLine(tt("email.offer.helpLead"), tt("email.offer.helpLink"), helpUrl) +
    renderLinkLine(tt("email.offer.supportLead"), supportEmail, `mailto:${supportEmail}`) +
    renderLinkLine(tt("email.offer.unsubscribeLead"), tt("email.offer.unsubscribeLink"), unsubscribeUrl);
  // The plain-text alternative previously carried NO link to the order at all
  // — only the HTML part had the CTA button, so a text-only client left the
  // florist with nothing to click. It leads the footer now.
  const footerTextLines = [
    `${tt("email.offer.cta")}: ${orderUrl}`,
    "",
    `${tt("email.offer.short.howItWorksLead")} ${howItWorksUrl}`,
    `${tt("email.offer.helpLead")} ${helpUrl}`,
    `${tt("email.offer.supportLead")} ${supportEmail}`,
    `${tt("email.offer.unsubscribeLead")} ${unsubscribeUrl}`,
  ];

  // Both variants run the SAME four numbered steps (flowStep1..4) — only the
  // framing around them differs. A repeat florist gets a one-line reminder of
  // who we are instead of the full introduction, because we can't tell how
  // long it's been since they last read it.
  const lead =
    variant === "short"
      ? [tt("email.offer.short.greeting", { floristName: greetingName }), tt("email.offer.short.reminder"), tt("email.offer.short.lead")]
      : [
          tt("email.offer.greeting"),
          city ? tt("email.offer.intro", { city }) : tt("email.offer.introNoCity"),
          tt("email.offer.orderLead"),
        ];
  // Steps 2 and 3 are the ones that state the split ("we pay 70% immediately",
  // "get the remaining 30%"). On a tier that pays in full they are replaced,
  // NOT dropped: step 3 still asks for the photo, because the risk on this tier
  // is a florist concluding that a photo which releases no money is optional.
  const SPLIT_STEPS = new Set([2, 3]);
  const steps = [1, 2, 3, 4].map((n) =>
    tt(`email.offer.flowStep${n}${singlePayment && SPLIT_STEPS.has(n) ? "Full" : ""}`)
  );
  const closing = variant === "short" ? tt("email.offer.short.closing") : tt("email.offer.closing");

  // Absolute florist-local deadline when we have one, else the countdown.
  // `deadlineTime` is null whenever we can't state a time honestly — no
  // coordinates, unknown zone, or a deadline already past.
  const deadlineLine = deadlineTime
    ? tt("email.offer.deadlineNote", { time: deadlineTime })
    : tt("email.offer.replyWindowNote", { window: replyWindow });

  // A `email.offer.blocks` override replaces the whole body with editor-authored
  // blocks. Absent or malformed (parseBlocks returns null), this is exactly the
  // fixed sequence below, so every send is byte-identical until someone opts a
  // message in — and deleting the override reverts it.
  const blocks = parseBlocks(overrides["email.offer.blocks"]);
  if (blocks) {
    const html = renderEmailShell(
      renderBlocksHtml(blocks) + renderFactsBlock(facts) + renderParagraphs(deadlineLine) + footerLinks,
      { testMode, locale, overrides, preheader: tt("email.offer.preheader"), cta: { label: tt("email.offer.cta"), url: orderUrl } }
    );
    const bodyText = [
      renderBlocksText(blocks),
      "",
      ...facts.map((f) => `${f.label}: ${f.value}`),
      "",
      deadlineLine,
      "",
      ...footerTextLines,
    ].join("\n");
    return { subject, html, bodyText };
  }

  const bodyContent =
    renderParagraphs(lead.join("\n\n")) +
    renderNumberedSteps(steps) +
    renderParagraphs(closing) +
    renderFactsBlock(facts) +
    renderParagraphs(deadlineLine) +
    footerLinks;
  const bodyTextLines = [
    ...lead.flatMap((p) => [p, ""]),
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    closing,
    "",
    ...facts.map((f) => `${f.label}: ${f.value}`),
    "",
    deadlineLine,
    "",
    ...footerTextLines,
  ];

  const html = renderEmailShell(bodyContent, {
    testMode,
    locale,
    overrides,
    preheader: tt("email.offer.preheader"),
    cta: { label: tt("email.offer.cta"), url: orderUrl },
  });
  const bodyText = bodyTextLines.join("\n");

  return { subject, html, bodyText };
}
