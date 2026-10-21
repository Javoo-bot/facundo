import { randomUUID } from "node:crypto";
import { defaultFrom } from "@/lib/emailFrom";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { suggestedTimeoutMinutes, DEFAULT_OFFER_WINDOWS, type OfferWindows } from "@/lib/reachout";
import { isUnintendedEnglish, type Locale } from "@/lib/i18n";
import { captureError } from "@/lib/monitor";
import { resolveFloristSendLocale } from "@/lib/floristLocale";
import { TEST_MODE_UNSUBSCRIBE_TOKEN } from "@/lib/unsubscribeChannel";
import { loadOverrides } from "@/lib/messageOverrides";
import { emailEnabled } from "@/lib/emailToggles";
import { isSinglePayment } from "@/lib/payoutMath";
import { resolveFloristSmsPhone, countryToRegion } from "@/lib/phone";
import { smsEnabled } from "@/lib/smsToggles";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";
import { orderDest } from "@/lib/floristMagicLink";
import {
  recentAcceptedCutoffIso,
  formatOfferWhen,
  formatOfferReplyWindow,
  formatOfferDeliverBy,
  type OfferEmailVars,
} from "@/lib/offerEmailContent";
import { floristTimeZone, formatOfferDeadline } from "@/lib/floristTime";
import type { OrderAssignment } from "@/lib/types";

// Shared read-only send-time-variable resolver for the offer email — the
// no-drift seam between an actual send (lib/reachoutSend.ts::sendOffer) and
// the staff preview-before-resend (app/api/orders/reachout/preview/route.ts).
// Both callers pass the SAME already-fetched `order_assignments` row through
// the SAME code below, so the preview can never show something a real send
// wouldn't produce.
//
// PROVABLE ZERO-WRITE PROPERTY: the only `.update(` / `.insert(` / `.upsert(`
// / `.delete(` anywhere in this file is inside `ensureUnsubscribeToken`,
// itself only ever invoked from the `opts.mintUnsubscribeToken` branch below.
// Every other Supabase call in this module is a `.select(`. `sendOffer`
// passes `mintUnsubscribeToken: true` (behaviour unchanged from before this
// refactor); the preview route passes `false` and this function never calls
// `ensureUnsubscribeToken` at all in that case.
//
// `mintMagicLink` (lib/floristMagicLinkMint.ts) is the ONE other write this
// module can reach, and it is gated the same way: `opts.mintMagicToken`, false
// for the preview, which then renders the inert sentinel link instead. The
// property above holds unchanged for a preview call.
//
// Everything that WRITES beyond the unsubscribe token (the atomic claim, the
// outreach/order_events inserts, logCommunication, the orders status update,
// the push send) stays in sendOffer, outside this resolver — this function
// only ever RETURNS a `blockingError`; the caller decides what to do about it.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Offer emails go to florists → florist host. (See lib/emailLinks.ts.)
const APP_BASE = FLORIST_BASE;

type Admin = ReturnType<typeof createServiceClient>;

export interface ResolvedOfferFlorist {
  id: string;
  name: string | null;
  email: string | null;
  locale: string | null;
}

export interface ResolvedOfferOrder {
  delivery_at: string | null;
  delivery_area: string | null;
  order_name: string | null;
  status: string | null;
  deleted_at: string | null;
}

export interface ResolvedOffer {
  testMode: boolean;
  /** This florist's tier pays the whole payout on accept (a 0% delivery leg).
   *  Already folded into `vars` for the email; surfaced here too so the SMS
   *  build in lib/reachoutSend.ts (which assembles its own vars object) reads
   *  the same fact rather than resolving the tier a second time. */
  singlePayment: boolean;
  /** This florist is a shop WE own (`florists.is_test_shop`). While `testMode`
   *  is on, a test shop is exempt from the test-inbox redirect and from the
   *  inert placeholder tokens — it gets real mail at its real address with a
   *  working magic link. Reported so the audit trail can explain why real
   *  credentials went out on a test-mode send. */
  testShop: boolean;
  /** `testMode && !testShop` — the resolved answer to "is this send being
   *  diverted to the shared staff inbox with inert tokens?". Every consumer
   *  should branch on THIS, not on `testMode`. */
  redirectToTestInbox: boolean;
  testEmail: string | null;
  testPhone: string | null;
  offerEmailEnabled: boolean;
  smsOfferEnabled: boolean;
  smsIntended: string | null;
  smsTo: string | null;
  floristSmsSuppressed: boolean;
  smsSuppressReason: "opted-out" | "snoozed" | null;
  supportEmail: string;
  from: string;
  florist: ResolvedOfferFlorist | null;
  intended: string | null;
  locale: Locale;
  floristSuppressed: boolean;
  suppressReason: "opted-out" | "snoozed" | null;
  /** Why `intended` is not this shop's own address, or null when it is. Drives
   *  the email-leg skip in lib/offerChannels.ts::emailSkipReason. */
  emailIdentityProblem: "network" | "shared" | "bounced" | null;
  /** Telnyx reported a permanent delivery failure for this florist's number. */
  smsUndeliverable: boolean;
  order: ResolvedOfferOrder | null;
  expiresAt: string;
  overrides: Record<string, string>;
  variant: "full" | "short";
  vars: OfferEmailVars;
  to: string | null; // redirectToTestInbox ? testEmail : intended
  unsubscribeUrlIsPlaceholder: boolean;
  blockingError: "no-test-email" | "florist-no-email" | null;
}

export interface ResolveOfferVarsOpts {
  mintUnsubscribeToken: boolean;
  /** Mint the one-click sign-in link for this send. Same true/false split as
   * mintUnsubscribeToken: a real send mints, the zero-write preview doesn't
   * (it renders the inert sentinel instead — see lib/floristMagicLink.ts). */
  mintMagicToken: boolean;
  now?: Date;
}

// "Active" florists (accepted at least one order through this flow recently)
// get the short offer email — see buildOfferEmailContent's variant handling.
// accepted_at (not delivered_at) is the signal: a florist who's accepted at
// least once already knows how the flow works, which is what "active" is
// really a proxy for.
async function hasRecentAcceptedOrder(admin: Admin, floristId: string, nowMs: number): Promise<boolean> {
  const { data } = await admin
    .from("order_assignments")
    .select("id")
    .eq("florist_id", floristId)
    .not("accepted_at", "is", null)
    .gte("accepted_at", recentAcceptedCutoffIso(nowMs))
    .limit(1)
    .maybeSingle();
  return !!data;
}

// WRITE. Returns the florist's unsubscribe token, generating and persisting
// one if missing. CAS-guarded (`.is("unsubscribe_token", null)`) so two
// concurrent sendOffer calls for the same florist (different orders racing on
// a first-ever send) can't each mint a different token and orphan the loser's
// email link — whoever loses the race re-reads and uses whatever token
// actually landed, rather than emailing a token that was never persisted.
//
// Exported (rather than file-private) so lib/acceptComms.ts can mint the same
// token for the accept-confirmation SMS instead of growing a second copy of
// this CAS. It stays the ONLY write in this file, and it is still reached from
// resolveOfferVars solely via the `opts.mintUnsubscribeToken` branch — the
// zero-write property described above is unchanged.
export async function ensureUnsubscribeToken(admin: Admin, floristId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const { data: updated } = await admin
    .from("florists")
    .update({ unsubscribe_token: randomUUID() })
    .eq("id", floristId)
    .is("unsubscribe_token", null)
    .select("unsubscribe_token")
    .maybeSingle();
  if (updated?.unsubscribe_token) return updated.unsubscribe_token;
  const { data: current } = await admin.from("florists").select("unsubscribe_token").eq("id", floristId).single();
  return current?.unsubscribe_token ?? randomUUID(); // DB unreachable — send something rather than crash the offer
}

export async function resolveOfferVars(
  admin: Admin,
  assignment: OrderAssignment,
  opts: ResolveOfferVarsOpts
): Promise<ResolvedOffer> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const { data: s } = await admin
    .from("app_settings")
    // One string literal on purpose: supabase-js infers the row type from this
    // literal, and splitting it across a concatenation collapses it to unknown.
    .select("test_mode, test_email, email_offer_enabled, offer_short_variant_enabled, florist_support_email, offer_window_rush_min, offer_window_sameday_min, offer_window_standard_min, offer_window_far_min, offer_window_nodate_min, test_phone, sms_offer_enabled")
    .eq("id", 1)
    .single();
  const testMode = s?.test_mode ?? true;
  const testEmail = s?.test_email ?? null;
  // Settings → Notifications toggle. Off = the offer STILL goes out (push,
  // handled by the caller), just without the email leg — so none of the
  // email-address validity checks below block anything when it's off.
  const offerEmailEnabled = emailEnabled(s, "offer");
  const testPhone = s?.test_phone ?? null;
  // Fails CLOSED (lib/smsToggles.ts) — SMS ships dark and only an explicit
  // `true` sends. Off = the offer still goes out by email + push.
  const smsOfferEnabled = smsEnabled(s, "offer");
  const supportEmail = s?.florist_support_email || "florists@fc.example.com";
  const from = defaultFrom();

  const { data: floristRow } = await admin
    .from("florists")
    .select("id, email, name, locale, address, city_id, lat, lng, trust_tier, unsubscribe_token, order_emails_opt_out, order_emails_snoozed_until, phone_mobile, phone_web, phone_maps, order_sms_opt_out, order_sms_snoozed_until, is_test_shop, network_id, email_shared_count, email_bounced_at, sms_undeliverable_at")
    .eq("id", assignment.florist_id)
    .single();
  const florist: ResolvedOfferFlorist | null = floristRow
    ? { id: floristRow.id, name: floristRow.name ?? null, email: floristRow.email ?? null, locale: floristRow.locale ?? null }
    : null;
  const intended = floristRow?.email ?? null;

  // Which payment story the OFFER tells. This is the first thing a florist reads
  // about money, and on a tier that pays the whole payout on accept the default
  // ("we pay 70% immediately... get the remaining 30% before you deliver") is
  // simply false. Read from the tier ROW, not the tier code, so it stays true
  // for any tier set to a 0% delivery leg (lib/payoutMath.ts::isSinglePayment).
  //
  // Fails toward the SPLIT wording on any gap — no tier assigned, an unreadable
  // row — which understates what a paid-in-full shop gets rather than promising
  // a split shop money it has not earned.
  let singlePayment = false;
  if (floristRow?.trust_tier) {
    const { data: tierRow } = await admin
      .from("trust_tiers")
      .select("split_on_delivery")
      .eq("code", floristRow.trust_tier)
      .maybeSingle();
    if (tierRow) singlePayment = isSinglePayment(tierRow);
  }

  // TEST SHOPS. Test mode exists to keep REAL florists out of test traffic: it
  // redirects every send to the shared staff test inbox/phone and substitutes
  // inert sentinel tokens for the magic link and the unsubscribe link — because
  // that inbox is readable by several staff and a magic link is a LOGIN to a
  // real shop. Neither concern applies to a shop WE own, and suppressing them
  // there makes the florist experience impossible to drive end to end (you can
  // never click the link you were sent).
  //
  // So test mode's REDIRECTION is scoped to non-test shops. `testMode` itself
  // stays true — it IS a test-mode send, and that is what the audit records —
  // with `testShop` reported alongside it to explain why real credentials went
  // out. A florist is opted in by an explicit admin flag on their row, never by
  // a per-send checkbox a mis-click could defeat.
  const testShop = floristRow?.is_test_shop === true;
  const redirectToTestInbox = testMode && !testShop;

  // Ordered after the florist read (it used to run before) so the test-inbox
  // address is only required when we're ACTUALLY redirecting there — a test
  // shop sends to its own real address and must not be blocked by an unset
  // `test_email`.
  let blockingError: "no-test-email" | "florist-no-email" | null = null;
  if (offerEmailEnabled && redirectToTestInbox && (!testEmail || !EMAIL_RE.test(testEmail))) {
    blockingError = "no-test-email";
  }
  if (!blockingError && offerEmailEnabled && (!intended || !EMAIL_RE.test(intended))) {
    blockingError = "florist-no-email";
  }

  // Does the stored address actually identify THIS shop? A well-formed,
  // deliverable address can still be the wrong one: ingest scrapes `email` from
  // `website_url`, and for a shop whose "website" is its profile page on a
  // network, franchise or trade-association site, what it found was the head
  // office's address, not the shop's.
  //
  // Deliberately NOT a `blockingError`. Of the two blocking errors only
  // `no-test-email` still aborts the whole send (no email, no SMS, no push) —
  // it is the right shape for a misconfiguration of OURS. `florist-no-email`
  // is handled the same way as this case: email leg suppressed, offer hedges
  // to SMS + push (see reachoutSend.ts).
  // This isn't one: the shop is real, wants the order, and its Maps-sourced
  // phone number is its own. So this suppresses the email leg alone and lets
  // the offer hedge to SMS + push — the same shape as an email opt-out.
  // Ordering and precedence live in lib/offerChannels.ts::emailSkipReason.
  const emailIdentityProblem: "network" | "shared" | "bounced" | null =
    floristRow?.network_id
      ? "network"
      : (floristRow?.email_shared_count ?? 1) > 1
        ? "shared"
        : floristRow?.email_bounced_at
          ? "bounced"
          : null;

  // The SMS counterpart of emailIdentityProblem: a number Telnyx has told us
  // permanently cannot receive texts. Suppresses only the SMS leg — email and
  // push still fire — via lib/offerChannels.ts::smsSkipReason.
  const smsUndeliverable = !!floristRow?.sms_undeliverable_at;

  const snoozedUntil = floristRow?.order_emails_snoozed_until ? new Date(floristRow.order_emails_snoozed_until).getTime() : 0;
  const floristSuppressed = !!floristRow?.order_emails_opt_out || snoozedUntil > nowMs;
  const suppressReason: "opted-out" | "snoozed" | null = !floristSuppressed
    ? null
    : floristRow?.order_emails_opt_out
      ? "opted-out"
      : "snoozed";
  // Last line of defence on the language an offer goes out in. `florists.locale`
  // is normally filled at ingest, but a florist ingested before that derivation
  // landed (or by a stale build — see ingest/backfill_locales.py) still has null
  // there, and null alone would render this offer in English for, say, a Paris
  // shop. So when the column is empty, fall back to the country of the city the
  // florist was ingested under. One extra read, and only in that null case.
  //
  // ONE `cities.country` read serves BOTH consumers: this locale fallback and
  // the SMS phone-region below. They arrived on separate branches, each with
  // its own read; collapsed here at merge time so a send makes at most one
  // extra round trip rather than two. The guards stay independent — each
  // consumer only *uses* the value under its own condition.
  const needsRegionForLocale = !!floristRow && !floristRow.locale && !!floristRow.city_id;
  const needsRegionForSms = smsOfferEnabled && !!floristRow?.city_id;
  let cityCountry: string | null = null;
  if (floristRow?.city_id && (needsRegionForLocale || needsRegionForSms)) {
    const { data: cityRow } = await admin
      .from("cities")
      .select("country")
      .eq("id", floristRow.city_id)
      .single();
    cityCountry = cityRow?.country ?? null;
  }
  const fallbackRegion: string | null = needsRegionForLocale ? cityCountry : null;

  // Stored locale > the shop's own address > the city's country. See
  // lib/floristLocale.ts for why that order, and why it is not in lib/i18n.
  const locale: Locale = resolveFloristSendLocale(floristRow, fallbackRegion);

  // An offer about to go out in English to a shop whose country is not an
  // English-speaking one. Recorded, never blocked: English mail a florist can
  // half-read still beats no offer at all, and blocking here would silently
  // shrink the wave. What we could not do before was SEE it — this send looked
  // identical to a correct one, which is how a French shop spent five days
  // trying to accept #2000034 through an English email. Not an Error, but
  // captureError is this build's one structured-event entry point (see
  // CLAUDE.md); a dashboard-side sink is still TODO, so today this lands as a
  // structured console.error.
  // `locale === "en"` is what narrows this to the genuine gap: the address
  // step above never yields EN (regionToLocale has no "en" entry, so an
  // English-country address returns null and falls through), so a non-EN
  // locale here means something positively decided it.
  if (locale === "en" && isUnintendedEnglish(floristRow ?? {}, fallbackRegion)) {
    captureError(
      "offer.locale.unintended_english",
      new Error(
        `florist ${floristRow?.id ?? "?"} (city country ${fallbackRegion}) has no locale and no mapping — offer sending in EN`
      )
    );
  }

  // SMS opt-out is tracked separately from the email opt-out: a florist may
  // tolerate texts while ignoring email, or the reverse.
  const smsSnoozedUntil = floristRow?.order_sms_snoozed_until ? new Date(floristRow.order_sms_snoozed_until).getTime() : 0;
  const floristSmsSuppressed = !!floristRow?.order_sms_opt_out || smsSnoozedUntil > nowMs;
  const smsSuppressReason: "opted-out" | "snoozed" | null = !floristSmsSuppressed
    ? null
    : floristRow?.order_sms_opt_out
      ? "opted-out"
      : "snoozed";

  // A scraped national number ("612 34 56 78") is meaningless without a
  // country, so parsing needs the country of the city this florist was
  // ingested under — reusing the single `cities.country` read above rather
  // than issuing a second one.
  //
  // `cities.country` is free text (lib/cityList.ts::parseCityList accepts
  // anything before the comma — a city added as "Spain, Girona" stores
  // "Spain", not "ES"), and libphonenumber-js silently DISCARDS an
  // unsupported defaultCountry rather than throwing. Feeding it the raw
  // string would silently null out every scraped national-format number for
  // an entire city. countryToRegion resolves it to the alpha-2 code
  // libphonenumber-js actually understands (or null if unresolvable).
  const smsRegion: string | null = needsRegionForSms ? countryToRegion(cityCountry) : null;
  const smsIntended = smsOfferEnabled && floristRow ? resolveFloristSmsPhone(floristRow, smsRegion) : null;
  // Gated on smsOfferEnabled so smsTo is null (not the test phone) when SMS
  // is off — otherwise a disabled toggle would still yield a truthy "send to"
  // address, a trap for any future consumer that checks smsTo alone.
  const smsTo = smsOfferEnabled ? (redirectToTestInbox ? testPhone : smsIntended) : null;

  // Binding per-offer expiry, deadline-aware (short when the delivery is
  // imminent). For a preview this is a HYPOTHETICAL value (never written) —
  // callers surface it as `expires_at_preview`, not `expires_at`.
  const { data: ordRow } = await admin
    .from("orders")
    .select("delivery_at, delivery_area, order_name, status, deleted_at")
    .eq("id", assignment.order_id)
    .single();
  const order: ResolvedOfferOrder | null = ordRow
    ? {
        delivery_at: ordRow.delivery_at ?? null,
        delivery_area: ordRow.delivery_area ?? null,
        order_name: ordRow.order_name ?? null,
        status: ordRow.status ?? null,
        deleted_at: ordRow.deleted_at ?? null,
      }
    : null;
  // Settings → Offers. Each tier falls back to the shipped default on its own,
  // so a settings row written before the migration (or a single null column)
  // degrades to today's ladder rather than to zero.
  const windows: OfferWindows = {
    rushMin: s?.offer_window_rush_min ?? DEFAULT_OFFER_WINDOWS.rushMin,
    samedayMin: s?.offer_window_sameday_min ?? DEFAULT_OFFER_WINDOWS.samedayMin,
    standardMin: s?.offer_window_standard_min ?? DEFAULT_OFFER_WINDOWS.standardMin,
    farMin: s?.offer_window_far_min ?? DEFAULT_OFFER_WINDOWS.farMin,
    noDateMin: s?.offer_window_nodate_min ?? DEFAULT_OFFER_WINDOWS.noDateMin,
  };
  const mins = suggestedTimeoutMinutes(order?.delivery_at ?? null, windows);
  const expiresAt = new Date(nowMs + mins * 60_000).toISOString();

  // Runtime DB-override layer (dashboard/app/(staff)/email-templates) — {}
  // when nothing's been edited for this locale, which makes buildOfferEmailContent
  // (and the formatters below) behave byte-for-byte like the plain t()-only
  // version.
  const overrides = await loadOverrides(admin, locale);
  const when = formatOfferWhen(locale, overrides, order?.delivery_at ?? null, now);
  const replyWindow = formatOfferReplyWindow(locale, overrides, expiresAt, nowMs);
  // The florist's OWN timezone, from the shop's coordinates. Null when the row
  // has no geocode — both formatters below degrade rather than guess: the
  // deadline falls back to the relative countdown, and "deliver by" falls back
  // to the server's zone (its behaviour before this existed).
  const tz = floristTimeZone(floristRow?.lat ?? null, floristRow?.lng ?? null);
  const deadlineTime = formatOfferDeadline(locale, expiresAt, tz, nowMs);
  const deliverBy = formatOfferDeliverBy(locale, order?.delivery_at ?? null, tz);

  // The repeat-florist opening, switchable from /flows. Off means every offer
  // uses the full opening — the offer itself is never suppressed by this, only
  // its first line. Defaults on, which is how offers have always behaved.
  const shortVariantEnabled = s?.offer_short_variant_enabled !== false;
  const variant: "full" | "short" =
    shortVariantEnabled && (await hasRecentAcceptedOrder(admin, assignment.florist_id, nowMs))
      ? "short"
      : "full";

  const area = order?.delivery_area ?? null;
  const city = area ? area.split(" · ")[0].trim() : null; // "Girona · Catalonia" -> "Girona"
  const orderName = order?.order_name ?? assignment.order_id.slice(0, 8); // mirrors lib/issueComms.ts's short-id fallback

  // Test-mode sends are redirected to the test inbox, but the REAL florist's
  // token must never appear in one — a staffer reviewing a test send (or a
  // preview) could otherwise click "Stop completely" and irreversibly
  // unsubscribe a real florist. Use a placeholder token that resolves to
  // nothing instead (app/florist/unsubscribe/[token]/page.tsx renders the
  // localized "not found" card for anything unrecognized).
  //
  // A test shop is exempt (see redirectToTestInbox above): its mail goes to its
  // own address, so the only unsubscribe it could ever action is its own.
  let unsubscribeUrl: string;
  let unsubscribeUrlIsPlaceholder = false;
  if (redirectToTestInbox) {
    unsubscribeUrl = `${APP_BASE}/florist/unsubscribe/${TEST_MODE_UNSUBSCRIBE_TOKEN}?locale=${locale}`;
  } else if (opts.mintUnsubscribeToken) {
    const token = await ensureUnsubscribeToken(admin, assignment.florist_id, floristRow?.unsubscribe_token ?? null);
    unsubscribeUrl = `${APP_BASE}/florist/unsubscribe/${token}?locale=${locale}`;
  } else if (floristRow?.unsubscribe_token) {
    // Read-only, byte-identical to what will be sent: the same token already
    // lives in communications.html for every previous send.
    unsubscribeUrl = `${APP_BASE}/florist/unsubscribe/${floristRow.unsubscribe_token}?locale=${locale}`;
  } else {
    // Florist never emailed before and we must NOT mint here (preview is
    // zero-write) — reuse the same inert sentinel as the test-mode case and
    // flag it so the caller can footnote "a real one-time token is minted
    // when you send." This is the ONLY way preview HTML can differ from the
    // sent HTML, and it differs in exactly one href.
    unsubscribeUrl = `${APP_BASE}/florist/unsubscribe/${TEST_MODE_UNSUBSCRIBE_TOKEN}?locale=${locale}`;
    unsubscribeUrlIsPlaceholder = true;
  }
  const howItWorksUrl = `${APP_BASE}/florist/how-it-works?locale=${locale}`;
  // The public Q&A (app/help/page.tsx). Sits beside how-it-works in the footer
  // rather than replacing it: that page is the pitch ("why bother with us"),
  // this one is the reference ("how does the 70/30 actually work, can I swap a
  // flower"). A florist deciding on their first offer wants both.
  const helpUrl = `${APP_BASE}/help?locale=${locale}`;

  // One-click sign-in straight to THIS order. Minted once per send and shared
  // by the email CTA and the SMS body below, so a single offer never puts two
  // independent credentials into the world.
  //
  // Test mode and the preview both get the inert sentinel, for the same reason
  // the unsubscribe URL does above — a test send lands in the SHARED staff test
  // inbox, and this link is a LOGIN to a real shop. A test shop is exempt: it is
  // a shop we own, its mail goes to its own address, and a working link there is
  // the entire point of the flag.
  const orderUrl = await mintMagicLink(admin, {
    floristId: assignment.florist_id,
    dest: orderDest(assignment.id),
    purpose: "offer",
    assignmentId: assignment.id,
    placeholder: redirectToTestInbox || !opts.mintMagicToken,
    now,
  });

  const vars: OfferEmailVars = {
    area,
    city,
    orderName,
    when,
    replyWindow,
    deliverBy,
    payoutPrice: assignment.payout_price ?? null,
    assignmentId: assignment.id,
    // Deliberately `testMode`, NOT `redirectToTestInbox`: this drives only the
    // email's test banner (lib/emailTemplate.ts), and a test shop's mail should
    // still carry a visible marker that the system as a whole is in test mode.
    // The banner blocks nothing — the CTA link inside is real for a test shop.
    testMode,
    // Null (not a hardcoded English "there") when the florist has no name —
    // buildOfferEmailContent (lib/offerEmailContent.ts) resolves the localized
    // fallback via the catalog, since that file (unlike this one) is reachable
    // from plain `node --test`.
    floristName: floristRow?.name ?? null,
    variant,
    singlePayment,
    deadlineTime,
    unsubscribeUrl,
    howItWorksUrl,
    helpUrl,
    orderUrl,
    supportEmail,
  };

  // Non-null exactly when blockingError is null (both checks above already
  // gate on this when offerEmailEnabled).
  const to = redirectToTestInbox ? testEmail : intended;

  return {
    testMode,
    testShop,
    redirectToTestInbox,
    testEmail,
    testPhone,
    offerEmailEnabled,
    smsOfferEnabled,
    smsIntended,
    smsTo,
    floristSmsSuppressed,
    smsSuppressReason,
    supportEmail,
    from,
    florist,
    intended,
    locale,
    floristSuppressed,
    suppressReason,
    emailIdentityProblem,
    smsUndeliverable,
    order,
    expiresAt,
    overrides,
    variant,
    singlePayment,
    vars,
    to,
    unsubscribeUrlIsPlaceholder,
    blockingError,
  };
}
