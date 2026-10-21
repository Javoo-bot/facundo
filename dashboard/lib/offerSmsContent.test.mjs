import test from "node:test";
import assert from "node:assert/strict";
import { buildOfferSmsContent } from "./offerSmsContent.ts";
import { smsSegments, isGsm7 } from "./smsSegments.ts";
import { FLORIST_BASE, BACKOFFICE_BASE } from "./emailLinks.ts";
import { LOCALES } from "./i18n/index.ts";

// Production-shaped IDs — NOT the 8-char/toy strings a naive fixture would
// use. assignmentId and the unsubscribe token are both real 36-char UUIDs in
// production (order_assignments.id, florists.unsubscribe_token), and every
// char counts against the segment budget.
const UNSUB_TOKEN = "f0e1d2c3-b4a5-4678-9abc-def012345678";
// The order link is now a magic sign-in URL (/florist/m/<uuid>) rather than
// /florist/orders/<uuid>. Same UUID length, so the segment budget below is
// measuring the real thing — but "/m/" is 6 chars shorter than "/orders/",
// which is why the worst-case assertions still hold.
const MAGIC_TOKEN = "9f8e7d6c-5b4a-4321-8765-0fedcba98765";
const ORDER_URL = `${FLORIST_BASE}/florist/m/${MAGIC_TOKEN}`;

// The longest string each locale's `email.offer.replyWindow.*` catalog can
// actually produce (see lib/offerEmailContent.ts::formatOfferReplyWindow) —
// picked by inspecting lib/i18n/messages/*.ts, not guessed. A short fixture
// like "1 hour" would hide the real worst case.
const LONGEST_REPLY_WINDOW = {
  en: "a couple of hours",
  de: "ein paar Minuten",
  fr: "quelques minutes",
  es: "un par de horas",
  it: "qualche minuto",
  pt: "alguns minutos",
};

// Real unsubscribe URL shape: FLORIST_BASE (lib/emailLinks.ts, itself built
// from lib/hostRouting.ts::FLORIST_HOST) + a 36-char token + the querystring
// lib/reachoutSend.ts actually sends — `?locale=xx` (minted by
// lib/offerVars.ts) with `&channel=sms` appended at send time so the SMS
// opt-out link only silences texts, not order emails.
function unsubscribeUrlFor(locale) {
  return `${FLORIST_BASE}/florist/unsubscribe/${UNSUB_TOKEN}?locale=${locale}&channel=sms`;
}

// Per-locale production-shaped vars: real IDs/URLs, a decimal payout (a
// whole-euro "42" undercounts — real payouts land on cents), and each
// locale's own longest reply-window string.
function realisticVars(locale, over = {}) {
  return {
    city: "Girona",
    payoutPrice: 42.35,
    replyWindow: LONGEST_REPLY_WINDOW[locale],
    // Worst case for the budget is the RELATIVE fallback: "a couple of hours"
    // is longer than any wall-clock time, so a null deadline is what the
    // segment assertions below should be measuring.
    deadlineTime: null,
    variant: "full",
    floristName: null,
    orderUrl: ORDER_URL,
    unsubscribeUrl: unsubscribeUrlFor(locale),
    ...over,
  };
}

test("renders an English body with every variable interpolated", () => {
  const body = buildOfferSmsContent("en", {}, realisticVars("en"));
  assert.match(body, /Facundo/);
  assert.match(body, /Girona/);
  // The 2026-08-05 copy sells the split, not the figure — {payout} is no
  // longer in the default body (it stays interpolable for overrides).
  assert.match(body, /70%/);
  assert.match(body, /30%/);
  assert.match(body, /a couple of hours/);
  assert.ok(body.includes(ORDER_URL), `order link missing from: ${body}`);
  assert.ok(!body.includes("{"), `unreplaced placeholder in: ${body}`);
});

// The SMS must carry the one-click sign-in link, not the bare order path that
// bounced the florist to a six-digit-code sign-in wall — the worst version of
// that wall, since it lands on a phone.
test("the SMS carries the magic sign-in link, never a bare /florist/orders/ path", () => {
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, realisticVars(locale));
    assert.ok(body.includes(ORDER_URL), `${locale}: magic link missing from: ${body}`);
    assert.ok(!body.includes("/florist/orders/"), `${locale}: bare order path leaked into: ${body}`);
  }
});

test("uses the no-city variant when city is null", () => {
  const body = buildOfferSmsContent("en", {}, { ...realisticVars("en"), city: null });
  assert.ok(!body.includes("{"), `unreplaced placeholder in: ${body}`);
  assert.ok(!body.includes("null"), `leaked null into: ${body}`);
});

test("renders in every supported locale with no unreplaced placeholders", () => {
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, realisticVars(locale));
    assert.ok(body.length > 0, `${locale}: empty body`);
    assert.ok(!body.includes("{"), `${locale}: unreplaced placeholder in: ${body}`);
  }
});

test("includes the opt-out link in every locale (a legal requirement for SMS)", () => {
  for (const locale of LOCALES) {
    const vars = realisticVars(locale);
    const body = buildOfferSmsContent(locale, {}, vars);
    assert.ok(body.includes(vars.unsubscribeUrl), `${locale}: missing opt-out link`);
  }
});

test("a DB override replaces the catalog copy", () => {
  const overrides = { "sms.offer.body": "OVERRIDDEN {city} {payout} {window} {url}" };
  const body = buildOfferSmsContent("en", overrides, realisticVars("en"));
  assert.match(body, /OVERRIDDEN/);
  assert.match(body, /Girona/);
  // {payout} and {window} are still interpolated even though the default copy
  // no longer uses them — that's what makes putting them back a no-deploy edit.
  assert.match(body, /42\.35/);
  assert.match(body, /a couple of hours/);
});

test("a null payout renders GSM-7-safe, never an em dash (which would double the segments)", () => {
  // Only reachable via an override that reintroduces {payout}, but the cost of
  // getting it wrong is silent: one em dash flips the whole message to UCS-2.
  const overrides = { "sms.offer.body": "Order in {city}, payout {payout}. {url}" };
  const body = buildOfferSmsContent("en", overrides, { ...realisticVars("en"), payoutPrice: null });
  assert.ok(!body.includes("null"), `leaked null into: ${body}`);
  assert.ok(!body.includes("{"), `unreplaced placeholder in: ${body}`);
  assert.ok(isGsm7(body), `null payout left the message non-GSM-7: ${body}`);
});

test("the repeat variant greets the florist by name and skips the introduction", () => {
  const body = buildOfferSmsContent("en", {}, realisticVars("en", { variant: "short", floristName: "Floristeria Roser" }));
  assert.match(body, /Floristeria Roser/);
  assert.ok(!body.includes("international flower delivery"), `repeat SMS re-introduced Facundo: ${body}`);
  assert.ok(!body.includes("{"), `unreplaced placeholder in: ${body}`);
});

test("an accented florist name is folded to GSM-7 in the repeat variant", () => {
  // florists.name is free text from ingest — "Floristería" would otherwise
  // flip the whole message to UCS-2, exactly as an accented city would.
  const body = buildOfferSmsContent("en", {}, realisticVars("en", { variant: "short", floristName: "Floristería Málaga" }));
  assert.ok(isGsm7(body), `accented florist name left the message non-GSM-7: ${body}`);
});

test("an absolute deadline is used when we have one, and the countdown when we don't", () => {
  const withTime = buildOfferSmsContent("en", {}, realisticVars("en", { deadlineTime: "18:30" }));
  assert.match(withTime, /by 18:30/);
  assert.ok(!withTime.includes("a couple of hours"), `both deadline forms rendered: ${withTime}`);
  const withoutTime = buildOfferSmsContent("en", {}, realisticVars("en", { deadlineTime: null }));
  assert.match(withoutTime, /reply in a couple of hours/);
});

test("every locale's offer SMS fits within 3 segments", () => {
  // The real regression guard: accented locales drop to 70-char UCS-2
  // segments, so copy that looks fine in English can silently cost 3x in
  // Spanish. Fixtures here are production-shaped (real-length UUIDs, the
  // real unsubscribe URL shape incl. &channel=sms, a decimal payout, each
  // locale's longest reply-window string) — a fixture with 8-char IDs and a
  // toy short URL would pass this test while production sends 3 segments.
  // If this fails, SHORTEN THE COPY — do not raise the limit.
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, realisticVars(locale));
    const segments = smsSegments(body);
    assert.ok(
      segments <= 3,
      `${locale}: ${segments} segments (${body.length} chars, gsm7=${isGsm7(body)}): ${body}`
    );
  }
});

test("every locale's offer SMS fits within 3 segments with a real long city (Villingen-Schwenningen)", () => {
  // "Girona" is 6 chars and never exercises a long `city` — but `city` is a
  // live variable from order.delivery_area, NOT shortened, and real city
  // names run 20+ chars (Villingen-Schwenningen = 22 chars; Santiago de
  // Compostela = 22 chars). A 6-char-city test can stay green while a real
  // long city silently pushes some locales to 3 segments. Same
  // production-shaped fixture values as realisticVars (real-length UUIDs,
  // real unsubscribe URL shape incl. &channel=sms, a decimal payout, each
  // locale's longest reply-window string) — only `city` changes.
  // If this fails, SHORTEN THE COPY — do not raise the limit.
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, { ...realisticVars(locale), city: "Villingen-Schwenningen" });
    const segments = smsSegments(body);
    assert.ok(
      segments <= 3,
      `${locale}: ${segments} segments (${body.length} chars, gsm7=${isGsm7(body)}): ${body}`
    );
  }
});

test("every locale's offer SMS fits within 3 segments with a real accented city (Málaga)", () => {
  // "Girona" is accent-free and never exercises the UCS-2 path. A real
  // Spanish/Portuguese city like Málaga flips the whole message to UCS-2
  // (67-char segments) unless the city is transliterated before
  // interpolation. Assert both the segment count AND isGsm7 so a passing
  // count can't hide a message that's secretly UCS-2 by luck.
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, { ...realisticVars(locale), city: "Málaga" });
    const segments = smsSegments(body);
    assert.ok(
      segments <= 3,
      `${locale}: ${segments} segments (${body.length} chars, gsm7=${isGsm7(body)}): ${body}`
    );
    assert.ok(isGsm7(body), `${locale}: body is not GSM-7 (transliteration failed): ${body}`);
  }
});

// ---------------------------------------------------------------------------
// Short-link segment budget (docs/superpowers/specs/2026-08-05-url-shortener-design.md)
//
// This is the regression guard for the whole shortener. GSM-7 multipart allows
// 153 chars per segment, so two segments is 306. With 36-char root-mounted short
// links the worst locale (fr) lands at 288 — 18 to spare. If a copy edit pushes
// any locale past 306 this fails, instead of the SMS bill quietly rising 50%.
// ---------------------------------------------------------------------------

/** A real short URL: BACKOFFICE_BASE + "/" + 10 base62 chars = 36 chars. */
const SHORT_URL = `${BACKOFFICE_BASE}/aB3xK9mQ2p`;

test("a short URL is the 36 chars the budget was measured against", () => {
  assert.equal(SHORT_URL.length, 36);
});

test("offer SMS fits 2 segments in EVERY locale once links are shortened", () => {
  for (const locale of LOCALES) {
    const body = buildOfferSmsContent(locale, {}, {
      city: "Girona",
      payoutPrice: 42.5,
      replyWindow: "30 min",
      orderUrl: SHORT_URL,
      unsubscribeUrl: SHORT_URL,
    });
    const segs = smsSegments(body);
    assert.ok(
      segs <= 2,
      `${locale}: ${body.length} chars = ${segs} segments — budget is 2 (306 GSM-7 chars). ` +
      `Shorten the copy or the saving is gone.`
    );
  }
});

// The saving only exists if the UN-shortened form is genuinely worse. If a copy
// rewrite ever brings full URLs under 2 segments on its own, the shortener has
// stopped paying for itself and this test says so.
test("full URLs really do cost more segments than short ones", () => {
  const full = `${FLORIST_BASE}/florist/m/${UNSUB_TOKEN}`;
  let anyWorse = false;
  for (const locale of LOCALES) {
    const mk = (u) => buildOfferSmsContent(locale, {}, {
      city: "Girona", payoutPrice: 42.5, replyWindow: "30 min", orderUrl: u, unsubscribeUrl: u,
    });
    if (smsSegments(mk(full)) > smsSegments(mk(SHORT_URL))) anyWorse = true;
  }
  assert.ok(anyWorse, "shortening no longer reduces segments in any locale — the feature has stopped paying for itself");
});

// ---- paid in full on accept (a tier with a 0% delivery leg) ------------------
//
// The offer SMS is the first thing a florist reads about money, and for a shop
// on a 100/0 tier the default ("30% before delivery") describes a payment that
// will never arrive. The variants below replace it. They are held to the SAME
// 3-segment budget as the originals, because the cost per send does not care
// which wording caused the third segment.

const PAID_IN_FULL_VARIANTS = [
  { variant: "full", city: "Girona" },
  { variant: "full", city: null },
  { variant: "short", city: "Girona" },
];

test("the paid-in-full offer SMS stays GSM-7 in every locale and variant", () => {
  for (const locale of LOCALES) {
    for (const { variant, city } of PAID_IN_FULL_VARIANTS) {
      const body = buildOfferSmsContent(locale, {}, {
        city, payoutPrice: 41, replyWindow: "2 h", deadlineTime: "18:30",
        variant, floristName: "Floristeria Roser",
        orderUrl: ORDER_URL, unsubscribeUrl: `${FLORIST_BASE}/florist/unsubscribe/${UNSUB_TOKEN}`,
        singlePayment: true,
      });
      assert.ok(isGsm7(body), `${locale}/${variant}: left GSM-7: ${body}`);
    }
  }
});

test("the paid-in-full offer SMS fits the same 3-segment budget", () => {
  for (const locale of LOCALES) {
    for (const { variant, city } of PAID_IN_FULL_VARIANTS) {
      const body = buildOfferSmsContent(locale, {}, {
        city, payoutPrice: 41, replyWindow: "2 h", deadlineTime: "18:30",
        variant, floristName: "Floristeria Roser",
        orderUrl: ORDER_URL, unsubscribeUrl: `${FLORIST_BASE}/florist/unsubscribe/${UNSUB_TOKEN}`,
        singlePayment: true,
      });
      const n = smsSegments(body);
      assert.ok(n <= 3, `${locale}/${variant}: ${n} segments (${body.length} chars):\n${body}`);
    }
  }
});

test("the offer SMS quotes no split to a paid-in-full shop, and the split one still does", () => {
  const args = (singlePayment) => [
    "en", {},
    { city: "Girona", payoutPrice: 41, replyWindow: "2 h", deadlineTime: "18:30",
      variant: "full", floristName: "Floristeria Roser",
      orderUrl: ORDER_URL, unsubscribeUrl: `${FLORIST_BASE}/florist/unsubscribe/${UNSUB_TOKEN}`,
      singlePayment },
  ];
  const full = buildOfferSmsContent(...args(true));
  assert.doesNotMatch(full, /70%|30%/, full);
  assert.match(full, /full/i, full);
  // The default must stay the split: it is what almost every florist is on, and
  // it is the direction that under-promises rather than over-promises.
  const split = buildOfferSmsContent(...args(false));
  assert.match(split, /70%/, split);
});
