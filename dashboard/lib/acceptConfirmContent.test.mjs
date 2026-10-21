import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceptConfirmEmail, buildAcceptConfirmSms } from "./acceptConfirmContent.ts";
import { smsSegments, isGsm7 } from "./smsSegments.ts";
import { BACKOFFICE_BASE, FLORIST_BASE } from "./emailLinks.ts";
import { LOCALES } from "./i18n/index.ts";

// Production-shaped links. The SMS carries SHORTENED URLs (lib/acceptComms.ts
// runs both through lib/shortLinkMint.ts::shorten before building the body),
// so the segment budget is measured against those, not against the 36-char
// UUID form — which is the whole point of shortening them.
const SHORT_ORDER_URL = `${BACKOFFICE_BASE}/aB3dE5gH7j`;
const SHORT_UNSUB_URL = `${BACKOFFICE_BASE}/kL9mN1pQ3r`;
const MAGIC_URL = `${FLORIST_BASE}/florist/m/9f8e7d6c-5b4a-4321-8765-0fedcba98765`;

// An accented shop name and an order label are the two florist-supplied values
// that reach the SMS. "Floristería" is exactly the case that flips a message to
// UCS-2 if it isn't folded (í is NOT in GSM-7 — see lib/smsSegments.ts).
const ACCENTED_NAME = "Floristería Roser";

test("the confirmation SMS stays GSM-7 in every locale, so it can't silently double the bill", () => {
  for (const locale of LOCALES) {
    const body = buildAcceptConfirmSms(locale, {}, {
      orderLabel: "#1234",
      orderUrl: SHORT_ORDER_URL,
      unsubscribeUrl: SHORT_UNSUB_URL,
    });
    assert.ok(isGsm7(body), `${locale}: confirmation SMS left GSM-7: ${body}`);
  }
});

test("an accented order label is folded rather than flipping the message to UCS-2", () => {
  const body = buildAcceptConfirmSms("es", {}, {
    orderLabel: ACCENTED_NAME,
    orderUrl: SHORT_ORDER_URL,
    unsubscribeUrl: SHORT_UNSUB_URL,
  });
  assert.ok(isGsm7(body));
  assert.ok(body.includes("Floristeria Roser"), body);
});

// The budget this message was written to. Not a style rule: every extra
// segment is billed on every accept, and the copy above was trimmed to fit.
test("the confirmation SMS fits its 2-segment budget in every locale", () => {
  for (const locale of LOCALES) {
    const body = buildAcceptConfirmSms(locale, {}, {
      orderLabel: "#1234",
      orderUrl: SHORT_ORDER_URL,
      unsubscribeUrl: SHORT_UNSUB_URL,
    });
    const n = smsSegments(body);
    assert.ok(n <= 2, `${locale}: ${n} segments (${body.length} chars) — over budget:\n${body}`);
  }
});

test("both links reach the florist: the order link and the opt-out", () => {
  const body = buildAcceptConfirmSms("en", {}, {
    orderLabel: "#1234",
    orderUrl: SHORT_ORDER_URL,
    unsubscribeUrl: SHORT_UNSUB_URL,
  });
  assert.ok(body.includes(SHORT_ORDER_URL), body);
  assert.ok(body.includes(SHORT_UNSUB_URL), body);
});

// ---- email

function emailFor(locale, over = {}) {
  return buildAcceptConfirmEmail(locale, {}, {
    orderLabel: "#1234",
    floristName: ACCENTED_NAME,
    payout: "€42.35",
    deliverBy: "6 Aug 2026, 18:00",
    orderUrl: MAGIC_URL,
    testMode: false,
    ...over,
  });
}

test("the confirmation email renders a real subject and CTA in every locale", () => {
  for (const locale of LOCALES) {
    const { subject, html, bodyText } = emailFor(locale);
    // A missing catalog key resolves to the key path itself (see i18n.test.mjs),
    // which is the failure this catches.
    assert.ok(subject.length > 0 && !subject.includes("email.acceptConfirm"), `${locale}: ${subject}`);
    assert.ok(!html.includes("email.acceptConfirm"), `${locale}: untranslated key in HTML`);
    assert.ok(!bodyText.includes("email.acceptConfirm"), `${locale}: untranslated key in text`);
    assert.ok(html.includes(MAGIC_URL), `${locale}: the CTA link is missing`);
    assert.ok(bodyText.includes(MAGIC_URL), `${locale}: the plain-text fallback has no link`);
  }
});

test("the order label, payout and deliver-by all reach the florist", () => {
  const { subject, html } = emailFor("en");
  assert.ok(subject.includes("#1234"));
  assert.ok(html.includes("42.35"));
  assert.ok(html.includes("6 Aug 2026, 18:00"));
});

// The whole reason this message exists — if the trust sentence stops rendering,
// what's left is a receipt.
test("the trust sentence is present, named or not", () => {
  assert.ok(emailFor("en").html.includes("We trust you"));
  assert.ok(emailFor("en", { floristName: null }).html.includes("We trust you"));
});

test("a shop with no stored name gets a full alternate sentence, never a dangling comma", () => {
  for (const locale of LOCALES) {
    const { html } = emailFor(locale, { floristName: null });
    assert.ok(!/,\s*[.!]/.test(html), `${locale}: dangling comma where the shop name would be`);
    assert.ok(!html.includes("{floristName}"), `${locale}: unsubstituted placeholder`);
  }
});

// Nulls are the normal case here, not an edge: an order with no delivery_at,
// or an assignment whose payout_price was never set, must drop the row rather
// than print a label with nothing after it.
test("a null payout or deliver-by drops its fact row instead of rendering empty", () => {
  const { html } = emailFor("en", { payout: null, deliverBy: null });
  assert.ok(!html.includes("Deliver by"), "deliver-by row rendered with no value");
  assert.ok(!html.includes("Your payout"), "payout row rendered with no value");
  assert.ok(html.includes("#1234"), "the order row should still be there");
});

// ---- paid in full on accept (a tier with a 0% delivery leg) ------------------
//
// Same message, different deal. The variant is longer in every locale (it has
// to say two things where the split version said one), so the GSM-7 and
// segment-budget guarantees are re-asserted against it rather than assumed:
// this text goes out on every accept by these shops, and a third segment is a
// third segment whichever wording caused it.

test("the paid-in-full confirmation SMS stays GSM-7 in every locale", () => {
  for (const locale of LOCALES) {
    const body = buildAcceptConfirmSms(locale, {}, {
      orderLabel: "#1234",
      orderUrl: SHORT_ORDER_URL,
      unsubscribeUrl: SHORT_UNSUB_URL,
      singlePayment: true,
    });
    assert.ok(isGsm7(body), `${locale}: paid-in-full confirmation SMS left GSM-7: ${body}`);
  }
});

test("the paid-in-full confirmation SMS fits the same 2-segment budget", () => {
  for (const locale of LOCALES) {
    const body = buildAcceptConfirmSms(locale, {}, {
      orderLabel: "#1234",
      orderUrl: SHORT_ORDER_URL,
      unsubscribeUrl: SHORT_UNSUB_URL,
      singlePayment: true,
    });
    const n = smsSegments(body);
    assert.ok(n <= 2, `${locale}: ${n} segments (${body.length} chars) — over budget:\n${body}`);
  }
});

test("neither channel mentions a split to a florist paid in full", () => {
  const sms = buildAcceptConfirmSms("en", {}, {
    orderLabel: "#1234",
    orderUrl: SHORT_ORDER_URL,
    unsubscribeUrl: SHORT_UNSUB_URL,
    singlePayment: true,
  });
  assert.doesNotMatch(sms, /70%|30%/, sms);
  // ...and still asks for the photo. Dropping that sentence is the tempting
  // edit (it is what makes the message long) and the one that breaks the deal:
  // the photo is proof of delivery, and it is the only proof we get.
  assert.match(sms, /photo/i, sms);

  const { html, bodyText } = buildAcceptConfirmEmail("en", {}, {
    orderLabel: "#1234",
    floristName: "Fleurs de Paris",
    payout: "€120.50",
    deliverBy: "14 Aug 2026, 18:00",
    orderUrl: SHORT_ORDER_URL,
    singlePayment: true,
    testMode: false,
  });
  assert.doesNotMatch(bodyText, /70%|30%/, bodyText);
  assert.doesNotMatch(html, /70%|30%/);
  assert.match(bodyText, /proof of delivery/i, bodyText);
});

test("without the flag both channels keep the 70/30 wording", () => {
  // The default has to stay the split, and stay wrong in the SAFE direction:
  // under-promising to a paid-in-full shop is a correction, over-promising to a
  // tier-2 shop is money we said was coming and is not.
  const sms = buildAcceptConfirmSms("en", {}, {
    orderLabel: "#1234",
    orderUrl: SHORT_ORDER_URL,
    unsubscribeUrl: SHORT_UNSUB_URL,
  });
  assert.match(sms, /70%/, sms);
  const { bodyText } = buildAcceptConfirmEmail("en", {}, {
    orderLabel: "#1234",
    floristName: "Fleurs de Paris",
    payout: "€120.50",
    deliverBy: "14 Aug 2026, 18:00",
    orderUrl: SHORT_ORDER_URL,
    testMode: false,
  });
  assert.match(bodyText, /70%/, bodyText);
});
