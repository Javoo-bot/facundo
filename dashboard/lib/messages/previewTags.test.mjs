import test from "node:test";
import assert from "node:assert/strict";
import {
  previewOverrides,
  tagPreviewHtml,
  stripSentinels,
  keysInOrder,
  hasSentinel,
} from "./previewTags.ts";
import { tWithOverrides } from "../i18n/index.ts";
import { buildOfferEmailContent } from "../offerEmailContent.ts";

const baseVars = {
  area: "Girona · Catalonia", city: "Girona", orderName: "#1234", when: "today",
  replyWindow: "1 hour", deadlineTime: null, deliverBy: "6 Aug 2026, 18:00", payoutPrice: 42,
  assignmentId: "a1", orderUrl: "https://florist.fc.example.com/florist/m/tok", testMode: false,
  floristName: "Floristeria Roser", variant: "full",
  unsubscribeUrl: "https://florist.fc.example.com/florist/unsubscribe/tok",
  howItWorksUrl: "https://florist.fc.example.com/florist/how-it-works",
  helpUrl: "https://florist.fc.example.com/help",
  supportEmail: "florists@fc.example.com",
};

test("previewOverrides tags a lookup with its key, and interpolation still runs", () => {
  const o = previewOverrides({}, "en");
  const out = tWithOverrides(o, "en", "email.offer.intro", { city: "Girona" });
  assert.ok(hasSentinel(out));
  assert.ok(out.includes("email.offer.intro"));
  assert.ok(out.includes("Girona"), "placeholder was not interpolated inside the marker");
  assert.ok(!out.includes("{city}"));
});

test("previewOverrides prefers a real override value over the catalog", () => {
  const o = previewOverrides({ "email.offer.greeting": "Bonjour," }, "en");
  assert.equal(stripSentinels(tWithOverrides(o, "en", "email.offer.greeting")), "Bonjour,");
});

test("previewOverrides falls back to EN for an untranslated key, and leaves a missing key to t()", () => {
  // email.client.* is English-only by design.
  const o = previewOverrides({}, "fr");
  assert.equal(
    stripSentinels(tWithOverrides(o, "fr", "email.client.delivered.subject")),
    tWithOverrides({}, "en", "email.client.delivered.subject")
  );
  // Genuinely absent: no marker, and t()'s echo-the-key behaviour is preserved.
  const missing = tWithOverrides(o, "en", "email.nope.not.real");
  assert.equal(missing, "email.nope.not.real");
  assert.ok(!hasSentinel(missing));
});

test("tagPreviewHtml wraps markers in text position", () => {
  const html = tagPreviewHtml("<p>\u0001a.b\u0002Hello\u0003</p>");
  assert.equal(html, '<p><span data-fc-key="a.b">Hello</span></p>');
});

test("tagPreviewHtml does NOT inject a span inside an attribute", () => {
  // A catalog string used as an attribute value must stay a plain value —
  // a <span> there would produce broken HTML.
  const html = tagPreviewHtml('<a title="\u0001a.b\u0002Open\u0003" href="#">x</a>');
  assert.equal(html, '<a title="Open" href="#">x</a>');
  assert.ok(!html.includes("data-fc-key"));
});

test("tagPreviewHtml escapes the key it writes into the attribute", () => {
  const html = tagPreviewHtml('<p>\u0001a"b\u0002v\u0003</p>');
  assert.ok(html.includes('data-fc-key="a&quot;b"'));
});

test("tagPreviewHtml drops a malformed marker rather than emitting a control character", () => {
  const html = tagPreviewHtml("<p>\u0001broken</p>");
  assert.ok(!hasSentinel(html), html);
});

test("stripSentinels leaves the plain value, including multi-line values", () => {
  assert.equal(stripSentinels("\u0001k\u0002line1\nline2\u0003"), "line1\nline2");
  assert.equal(stripSentinels("no markers here"), "no markers here");
});

test("keysInOrder reports what actually rendered, in order, de-duplicated", () => {
  const s = "\u0001a\u0002x\u0003 \u0001b\u0002y\u0003 \u0001a\u0002z\u0003";
  assert.deepEqual(keysInOrder(s), ["a", "b"]);
});

// ---- against a real message ----

test("the real offer email renders fully tagged, and the tagged HTML still contains the copy", () => {
  const o = previewOverrides({}, "en");
  const { subject, html } = buildOfferEmailContent("en", o, { ...baseVars, variant: "full" });
  const keys = keysInOrder(html);
  assert.ok(keys.includes("email.offer.greeting"), keys.join(","));
  assert.ok(keys.includes("email.offer.flowStep1"));
  assert.ok(keys.includes("email.offer.cta"));
  assert.ok(hasSentinel(subject));

  const tagged = tagPreviewHtml(html);
  assert.ok(!hasSentinel(tagged), "markers survived into the tagged HTML");
  assert.ok(tagged.includes('data-fc-key="email.offer.greeting"'));
  assert.ok(tagged.includes("Hi there,"));
  // Interpolated send-time data is untouched by tagging.
  assert.ok(tagged.includes("Girona"));
});

// The property the whole design rests on: preview machinery cannot reach a send.
test("a REAL send carries no marker and no data-fc-key", () => {
  for (const variant of ["full", "short"]) {
    const { subject, html, bodyText } = buildOfferEmailContent("en", {}, { ...baseVars, variant });
    for (const [what, s] of [["subject", subject], ["html", html], ["bodyText", bodyText]]) {
      assert.ok(!hasSentinel(s), `${variant} ${what} contained a preview marker`);
      assert.ok(!s.includes("data-fc-key"), `${variant} ${what} contained data-fc-key`);
    }
  }
});
