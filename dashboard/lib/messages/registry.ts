// Every message Facundo sends, in one list, with enough sample data to
// render each one. Pure — no I/O, no database — so it is unit-testable and the
// editor and its tests agree on what exists.
//
// `render` always goes through the message's real builder. Nothing here
// reimplements a message; if a builder changes, the preview changes with it.
import { buildOfferEmailContent } from "../offerEmailContent.ts";
import { buildOfferSmsContent } from "../offerSmsContent.ts";
import {
  buildRecruitingTouch,
  buildRecruitingSmsContent,
  RECRUIT_TOUCHES,
  REACTIVATE_TOUCHES,
  type RecruitTouch,
} from "../recruitingContent.ts";
import { buildAcceptConfirmEmail, buildAcceptConfirmSms } from "../acceptConfirmContent.ts";
import {
  buildIssueFloristEmail,
  buildIssueCxEmail,
  buildMagicLinkEmail,
  buildClientNoticeEmail,
  buildCxAlertEmail,
  buildTestEmail,
  type BuiltMessage,
} from "./builders.ts";
import { type Locale } from "../i18n/index.ts";
import { composeRecruitingEmail } from "../recruitingEmail.ts";
import type { Persona } from "../personas.ts";
import { isCopy, sourceOf } from "../flows/customSteps.ts";

export type Channel = "email" | "sms";
export type Audience = "florist" | "customer" | "staff";

/** A variable a message's send site can interpolate, with an example and one
 * line of what it actually is. The editor offers ONLY the variables in scope
 * for the message being edited: {payout} means nothing in a recruiting email,
 * and offering it there invites copy that renders as a literal token. */
export interface MessageVariable {
  name: string;
  example: string;
  what: string;
}

export interface MessageDef {
  id: string;
  label: string;
  /** One line on who gets this and when — shown above the preview. */
  note: string;
  channel: Channel;
  audience: Audience;
  /** True when this message also runs in the five non-EN locales. Customer and
   * internal mail is English-only by decision, and the editor shouldn't invite
   * translations that will never be sent. */
  localized: boolean;
  /** In scope for this message. Drives the editor's variable picker. */
  variables: MessageVariable[];
  render: (locale: Locale, overrides: Record<string, string>) => BuiltMessage;
}

// Shared variable descriptions, so the same {city} is explained the same way
// wherever it appears.
const V = {
  city: { name: "city", example: "Girona", what: "Delivery city, parsed from the order's area." },
  area: { name: "area", example: "Girona · Catalonia", what: "Full delivery area from the order." },
  orderName: { name: "orderName", example: "#1234", what: "The Shopify order name." },
  orderLabel: { name: "orderLabel", example: "#1234", what: "Order name, falling back to a short id." },
  floristName: { name: "floristName", example: "Floristería Roser", what: "Shop name. Falls back to a localized generic when we have none." },
  payout: { name: "payout", example: "42.35", what: "What this florist is paid, in euros." },
  time: { name: "time", example: "18:30", what: "Reply deadline as a wall-clock time in the FLORIST's timezone." },
  window: { name: "window", example: "30 minutes", what: "Reply deadline as a countdown. Used when we have no coordinates for the shop." },
  deadline: { name: "deadline", example: "by 18:30", what: "The whole deadline phrase, already localized." },
  url: { name: "url", example: "https://florist.fc.example.com/florist/m/…", what: "One-click sign-in link to this order." },
  joinUrl: { name: "joinUrl", example: "https://florist.fc.example.com/join/…", what: "Signup link for this shop." },
  when: { name: "when", example: "today", what: "When delivery is due: today, a short date, or soon." },
  count: { name: "count", example: "30", what: "Numeric part of a plural phrase." },
  issueType: { name: "issueType", example: "Wrong address", what: "The problem the florist picked, in their language." },
  author: { name: "author", example: "Floristería Roser", what: "Who wrote the issue message." },
  n: { name: "n", example: "3", what: "How many orders need attention." },
  deliverBy: { name: "deliverBy", example: "6 Aug 2026, 18:00", what: "When the order is due, in the FLORIST's timezone." },
} as const;

// The persona's own name, interpolated into the re-engagement text. Folded to
// GSM-7 at build time — see lib/recruitingContent.ts.
const PERSONA_NAME_VAR: MessageVariable = {
  name: "name",
  example: "Marta Ruiz",
  what: "The market's outreach persona, from Settings → Personas.",
};

const OFFER_VARS = [V.city, V.area, V.orderName, V.floristName, V.payout, V.time, V.window, V.when, V.url];

// What each funnel touch is for, in the editor's own words. Kept beside the
// registry rather than in the catalog because it describes WHEN a message
// fires, which is never something a translator should be editing.
const REACTIVATE_TOUCH_LABELS: Record<string, { label: string; note: string }> = {
  ra1: {
    label: "Reactivation A1 — no first order yet",
    note: "To a florist who joined but has never accepted an order. Answers the money question without being asked, because that is usually what stalls them.",
  },
  ra2: {
    label: "Reactivation A2 — anything I can help with?",
    note: "A week later. Offers a person rather than repeating the pitch.",
  },
  rd1: {
    label: "Reactivation D1 — it's been a while",
    note: "To a florist who HAS delivered for us and then went quiet. Assumes a reason exists and asks, rather than pitching what they already know.",
  },
  rd2: {
    label: "Reactivation D2 — keep sending you orders?",
    note: "Ten days later. A direct yes/no, because silence is the only answer we cannot act on.",
  },
};

const RECRUIT_TOUCH_LABELS: Record<RecruitTouch, { label: string; note: string }> = {
  t1: {
    label: "Recruiting 1 — the first email",
    note: "Day 0, from Facundo, branded. The first email a shop we have never worked with gets. No order attached.",
  },
  t2: {
    label: "Recruiting 2 — we're short here",
    note: "Day 3, from the named persona, plain. Only sent if they have not clicked anything yet.",
  },
  t3: {
    label: "Recruiting 3 — how the money works",
    note: "Day 7, from the persona, plain. The last cold touch; answers the 'this sounds too good' objection.",
  },
  r1: {
    label: "Re-engagement 1 — what stopped you?",
    note: "Two days after their FIRST click, on email and SMS together. The only touch that can honestly say 'you looked'.",
  },
  r2: {
    label: "Re-engagement 2 — closing this off",
    note: "Three days after re-engagement 1. The graceful exit; after this the prospect goes to long-term nurture.",
  },
  co1: {
    label: "Cold offer follow-up 1 — that order went elsewhere",
    note: "After a REAL order we offered to a non-network shop has gone to someone else. Our strongest recruiting email.",
  },
  co2: {
    label: "Cold offer follow-up 2 — the next order",
    note: "Four days after cold offer follow-up 1. Last word before the prospect goes quiet.",
  },
  ...REACTIVATE_TOUCH_LABELS,
} as Record<RecruitTouch, { label: string; note: string }>;

// Shared sample data. Deliberately production-shaped (real-length UUIDs, a
// decimal payout, an accented shop name) so the preview shows the real thing
// rather than a flattering short version.
const ORDER_URL = "https://florist.fc.example.com/florist/m/9f8e7d6c-5b4a-4321-8765-0fedcba98765";
const UNSUB_URL = "https://florist.fc.example.com/florist/unsubscribe/f0e1d2c3-b4a5-4678-9abc-def012345678";
const JOIN_URL = "https://florist.fc.example.com/join/9f2c8a71-4d3e-4b52-9c1a-0e7f6d5b4a39";
const HELP_URL = "https://florist.fc.example.com/help";
// Reactivation targets an existing account, so its CTA is a sign-in link.
const ACCOUNT_URL = "https://florist.fc.example.com/florist/m/9f8e7d6c-5b4a-4321-8765-0fedcba98765";
const BACKOFFICE = "https://backoffice.fc.example.com";

// Every funnel touch after the first is signed by the market's persona, and
// the shell it renders in depends on that. A preview with no persona would
// show a plain email with a missing signature — not a thing we ever send,
// because the scheduler SKIPS a persona step when a market has none.
const SAMPLE_PERSONA = {
  id: "preview",
  locale: "en",
  name: "Marta Ruiz",
  role_title: "Florist network",
  signature_note: "Reply to this and it comes straight to me.",
  reply_to: "persona@fc.example.com",
  active: true,
} as unknown as Persona;

const offerVars = {
  area: "Girona · Catalonia",
  city: "Girona",
  orderName: "#1234",
  when: "today",
  replyWindow: "30 minutes",
  deadlineTime: "18:30",
  deliverBy: "6 Aug 2026, 18:00",
  payoutPrice: 42.35,
  assignmentId: "preview",
  orderUrl: ORDER_URL,
  testMode: false,
  floristName: "Floristería Roser",
  unsubscribeUrl: `${UNSUB_URL}?locale=en`,
  howItWorksUrl: "https://florist.fc.example.com/florist/how-it-works",
  helpUrl: HELP_URL,
  supportEmail: "florists@fc.example.com",
};

/** SMS and push have no HTML. They still render through their real builders;
 * the preview just presents the text. */
function asText(text: string, subject = ""): BuiltMessage {
  return { subject, html: "", bodyText: text };
}

export const MESSAGES: MessageDef[] = [
  {
    id: "offer.full",
    variables: OFFER_VARS,
    label: "Offer email",
    note: "To a florist we haven't worked with recently. Sent the moment we have an order for their city.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) => buildOfferEmailContent(locale, o, { ...offerVars, variant: "full" }),
  },
  {
    id: "offer.short",
    variables: OFFER_VARS,
    label: "Offer email — repeat florist",
    note: "Same order, same moment, for a florist who has worked with us recently. Only the opening differs.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) => buildOfferEmailContent(locale, o, { ...offerVars, variant: "short" }),
  },
  // ---- The cold-outreach funnel ----
  // One registry entry per touch, all rendering through the SAME real builder
  // (buildRecruitingTouch). Without an entry per touch, a step's copy would be
  // uneditable and unpreviewable — which is how five of these seven would have
  // quietly drifted from what actually sends.
  ...RECRUIT_TOUCHES.map((touch) => ({
    id: `recruit.${touch}`,
    variables: [V.city, V.joinUrl],
    label: RECRUIT_TOUCH_LABELS[touch].label,
    note: RECRUIT_TOUCH_LABELS[touch].note,
    channel: "email" as Channel,
    audience: "florist" as Audience,
    localized: true,
    render: (locale: Locale, o: Record<string, string>) => {
      const built = buildRecruitingTouch(touch, locale, o, { city: "Girona", hasReviews: true, joinUrl: JOIN_URL });
      // Through the same composer lib/sequences/tick.ts sends with, so these
      // seven touches have a real rendered preview like every other message.
      // Until 2026-09-03 they returned `html: ""`, which showed as a blank
      // frame in the editor — invisible on /messages, where the key panel is
      // the way in, and fatal on /flows, where it is not.
      const isCompanyTouch = touch === "t1";
      return composeRecruitingEmail(built, {
        locale,
        overrides: o,
        voice: isCompanyTouch ? "branded" : "plain",
        persona: isCompanyTouch ? null : SAMPLE_PERSONA,
        unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=email`,
        testMode: false,
      });
    },
  })),
  {
    id: "acceptConfirm.email",
    variables: [V.orderLabel, V.floristName, V.payout, V.deliverBy, V.url],
    label: "Accept confirmation",
    note: "To the florist the moment they take an order (or CX takes it for them). The message that says thank you, that we trust them to deliver it correctly, and what happens next.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      buildAcceptConfirmEmail(locale, o, {
        orderLabel: "#1234",
        floristName: "Florister\u00eda Roser",
        payout: "\u20ac42.35",
        deliverBy: "6 Aug 2026, 18:00",
        orderUrl: ORDER_URL,
        testMode: false,
      }),
  },
  {
    id: "issue.replied",
    variables: [V.orderLabel, V.url],
    label: "We replied to your issue",
    note: "To a florist when we answer a problem they reported on an order.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      buildIssueFloristEmail(locale, o, {
        kind: "replied",
        orderLabel: "#1234",
        message: "We've checked with the customer and the buzzer code is 42B. Sorry for the confusion.",
        orderUrl: ORDER_URL,
        testMode: false,
      }),
  },
  {
    id: "issue.resolved",
    variables: [V.orderLabel, V.url],
    label: "Your issue was resolved",
    note: "To a florist when we close out a problem they reported.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      buildIssueFloristEmail(locale, o, {
        kind: "resolved",
        orderLabel: "#1234",
        message: "The recipient collected the bouquet from your shop. Nothing further needed, and you're paid in full.",
        orderUrl: ORDER_URL,
        testMode: false,
      }),
  },
  {
    id: "magicLink",
    variables: [V.orderLabel, V.url],
    label: "Sign-in link",
    note: "Sent by staff so a florist can get back into their account, or straight to one order.",
    channel: "email",
    audience: "florist",
    localized: true,
    render: (locale, o) => buildMagicLinkEmail(locale, o, { orderLabel: "#1234", url: ORDER_URL, testMode: false }),
  },
  {
    id: "client.assigned",
    variables: [],
    label: "Customer: being prepared",
    note: "To the person who bought the flowers, when a florist accepts. English only.",
    channel: "email",
    audience: "customer",
    localized: false,
    render: (locale, o) => buildClientNoticeEmail(locale, o, { kind: "assigned", testMode: false }),
  },
  {
    id: "client.on_the_way",
    variables: [],
    label: "Customer: on the way",
    note: "When the florist marks the bouquet as out for delivery. English only.",
    channel: "email",
    audience: "customer",
    localized: false,
    render: (locale, o) => buildClientNoticeEmail(locale, o, { kind: "on_the_way", testMode: false }),
  },
  {
    id: "client.delivered",
    variables: [],
    label: "Customer: delivered",
    note: "On delivery. Carries the florist's proof photo when there is one. English only.",
    channel: "email",
    audience: "customer",
    localized: false,
    render: (locale, o) => buildClientNoticeEmail(locale, o, { kind: "delivered", testMode: false }),
  },
  {
    id: "issue.toCx",
    variables: [V.orderLabel, V.issueType, V.author],
    label: "A florist reported an issue",
    note: "Lands in our CX inbox the moment a florist reports a problem. Internal, English only.",
    channel: "email",
    audience: "staff",
    localized: false,
    render: (_locale, o) =>
      buildIssueCxEmail(o, {
        orderLabel: "#1234",
        issueType: "wrong_address",
        author: "Floristería Roser",
        message: "The street number doesn't exist. Can you check with the customer?",
        orderUrl: `${BACKOFFICE}/orders/preview`,
        testMode: false,
      }),
  },
  {
    id: "cxAlert",
    variables: [V.n],
    label: "CX queue alert",
    note: "To our own inbox when orders are stuck past their deadline. Internal, English only.",
    channel: "email",
    audience: "staff",
    localized: false,
    render: (_locale, o) =>
      buildCxAlertEmail(o, {
        lines: ["- #1234: Photo not reviewed (urgency 82)", "- #1235: No florist accepted (urgency 71)"],
        more: 3,
        queueUrl: BACKOFFICE,
        testMode: false,
      }),
  },
  {
    id: "testEmail",
    variables: [],
    label: "Test email",
    note: "Sent only when a staff member clicks “Send test email” in Settings. Internal.",
    channel: "email",
    audience: "staff",
    localized: false,
    render: (_locale, o) =>
      buildTestEmail(o, { sentBy: "you@fc.example.com", sentAt: "6 Aug 2026, 18:00", backofficeUrl: BACKOFFICE }),
  },
  {
    id: "offer.sms",
    variables: [V.city, V.payout, V.deadline, V.time, V.window, V.url],
    label: "Offer text message",
    note: "Goes out with the offer email, same moment, same florist. Budgeted at 3 segments.",
    channel: "sms",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      asText(
        buildOfferSmsContent(locale, o, {
          city: "Girona",
          payoutPrice: 42.35,
          replyWindow: "30 minutes",
          deadlineTime: "18:30",
          variant: "full",
          floristName: null,
          orderUrl: ORDER_URL,
          unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=sms`,
        })
      ),
  },
  ...REACTIVATE_TOUCHES.map((touch) => ({
    id: `reactivate.${touch}`,
    variables: [V.city],
    label: REACTIVATE_TOUCH_LABELS[touch].label,
    note: REACTIVATE_TOUCH_LABELS[touch].note,
    channel: "email" as Channel,
    audience: "florist" as Audience,
    localized: true,
    render: (locale: Locale, o: Record<string, string>) => {
      // No joinUrl: these florists already have an account, so the CTA is
      // "open your account", not "join" — a join link would be nonsense to
      // someone who joined months ago.
      const built = buildRecruitingTouch(touch, locale, o, { city: "Girona", hasReviews: false, joinUrl: ACCOUNT_URL }, "reactivate");
      // Same composer as the recruiting touches above; reactivation is always
      // signed by a person, so there is no company-voice branch here.
      return composeRecruitingEmail(built, {
        locale,
        overrides: o,
        voice: "plain",
        persona: SAMPLE_PERSONA,
        unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=email`,
        testMode: false,
      });
    },
  })),
  {
    id: "acceptConfirm.sms",
    variables: [V.orderLabel, V.url],
    label: "Accept confirmation text message",
    note: "The SMS half of the accept confirmation, same moment as its email. Off by default in Settings. Budgeted at 2 segments.",
    channel: "sms",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      asText(
        buildAcceptConfirmSms(locale, o, {
          orderLabel: "#1234",
          orderUrl: ORDER_URL,
          unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=sms`,
        })
      ),
  },
  {
    id: "recruit.sms.t1",
    variables: [V.city, V.joinUrl],
    label: "Recruiting text — first contact",
    note: "Cold outreach to a shop we have never worked with, sent alongside the day-0 email. Off by default in Settings.",
    channel: "sms",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      asText(
        buildRecruitingSmsContent(
          locale, o,
          { city: "Girona", joinUrl: JOIN_URL, unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=sms` },
          "t1"
        )
      ),
  },
  {
    id: "recruit.sms.r1",
    variables: [V.joinUrl, PERSONA_NAME_VAR],
    label: "Recruiting text — after they clicked",
    note: "The one text an engaged prospect gets, two days after their first click. Signed by the market's persona.",
    channel: "sms",
    audience: "florist",
    localized: true,
    render: (locale, o) =>
      asText(
        buildRecruitingSmsContent(
          locale, o,
          {
            city: "Girona",
            joinUrl: JOIN_URL,
            unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=sms`,
            personaName: "Marta Ruiz",
          },
          "r1"
        )
      ),
  },
];

// NOT here yet: push notifications. Their copy is hardcoded at the send sites
// (lib/reachoutSend.ts, lib/cxAlerts.ts, the issue routes, public/sw.js) rather
// than read from the catalog, so there is no key an editor could change. Adding
// them means moving those strings into the catalog first — worth doing, but a
// field that silently does nothing would be worse than the current gap.
export function messageById(id: string): MessageDef | undefined {
  return MESSAGES.find((m) => m.id === id) ?? copyMessageDef(id);
}

/** A DUPLICATE's message, built on demand.
 *
 * Duplicates are created at runtime (lib/flows/customSteps.ts), so they cannot
 * be in the static list above — but everything that renders a message goes
 * through `messageById`, so resolving them here means the editor, the preview
 * and the test send all handle a copy without knowing it is one.
 *
 * It renders the SHAPE of the step it copied under its OWN keys, exactly as
 * lib/sequences/tick.ts does when it sends one. A copy whose source is no
 * longer a real touch returns undefined, which surfaces as "unknown message"
 * rather than a blank email. */
export function copyMessageDef(id: string): MessageDef | undefined {
  if (!id.startsWith("recruit.")) return undefined;
  const stepKey = id.slice("recruit.".length);
  if (!isCopy(stepKey)) return undefined;
  const touch = sourceOf(stepKey) as RecruitTouch;
  if (!RECRUIT_TOUCHES.includes(touch)) return undefined;
  const base = MESSAGES.find((m) => m.id === `recruit.${touch}`);
  if (!base) return undefined;

  return {
    ...base,
    id,
    label: `${base.label} (copy)`,
    note: "A duplicate. Its own words, its own wait, its own switch.",
    render: (locale: Locale, o: Record<string, string>) => {
      const built = buildRecruitingTouch(
        touch,
        locale,
        o,
        { city: "Girona", hasReviews: true, joinUrl: JOIN_URL },
        "recruit",
        stepKey
      );
      const isCompanyTouch = touch === "t1";
      return composeRecruitingEmail(built, {
        locale,
        overrides: o,
        voice: isCompanyTouch ? "branded" : "plain",
        persona: isCompanyTouch ? null : SAMPLE_PERSONA,
        unsubscribeUrl: `${UNSUB_URL}?locale=${locale}&channel=email`,
        testMode: false,
      });
    },
  };
}
