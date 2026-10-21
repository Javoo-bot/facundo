import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecruitingEmail,
  buildRecruitingTouch,
  buildRecruitingSmsContent,
  RECRUIT_TOUCHES,
} from "./recruitingContent.ts";
import { smsSegments, isGsm7 } from "./smsSegments.ts";
import { LOCALES } from "./i18n/index.ts";

const JOIN_URL = "https://florist.fc.example.com/join/9f2c8a71-4d3e-4b52-9c1a-0e7f6d5b4a39";
const UNSUB_URL = "https://florist.fc.example.com/florist/unsubscribe/f0e1d2c3-b4a5-4678-9abc-def012345678?channel=sms";

const V = (over = {}) => ({ city: "Girona", hasReviews: true, joinUrl: JOIN_URL, ...over });

// ---- every touch, every locale ----

test("every touch renders in every locale with no unreplaced placeholders", () => {
  for (const touch of RECRUIT_TOUCHES) {
    for (const locale of LOCALES) {
      const { subject, body, cta } = buildRecruitingTouch(touch, locale, {}, V());
      const where = `${locale}/${touch}`;
      assert.ok(subject.length > 0, `${where}: empty subject`);
      assert.ok(!subject.includes("{"), `${where}: placeholder in subject: ${subject}`);
      assert.ok(!body.includes("{"), `${where}: placeholder in body: ${body}`);
      assert.ok(!/\bundefined\b|\bnull\b/.test(body), `${where}: leaked a JS value: ${body}`);
      // A missing key falls back to the key path itself (see i18n.ts::t), which
      // would render "email.recruit.t2.p3" to a florist. Catch that here.
      assert.ok(!body.includes("email.recruit."), `${where}: unresolved catalog key in body: ${body}`);
      assert.ok(!subject.includes("email.recruit."), `${where}: unresolved catalog key in subject: ${subject}`);
      assert.ok(cta && cta.url === JOIN_URL, `${where}: lost the CTA url`);
      assert.ok(cta && !cta.label.includes("email.recruit."), `${where}: unresolved CTA label`);
    }
  }
});

// The whole point of a funnel is that a prospect who ignored one argument meets
// a NEW one. Identical bodies would mean we're just resending the same email.
test("no two touches share a body — every touch is a different angle", () => {
  for (const locale of LOCALES) {
    const seen = new Map();
    for (const touch of RECRUIT_TOUCHES) {
      const { body } = buildRecruitingTouch(touch, locale, {}, V());
      const clash = seen.get(body);
      assert.ok(!clash, `${locale}: ${touch} and ${clash} render the identical body`);
      seen.set(body, touch);
    }
  }
});

test("a null city falls back to whole alternate sentences, never a bare placeholder", () => {
  for (const touch of RECRUIT_TOUCHES) {
    for (const locale of LOCALES) {
      const { subject, body } = buildRecruitingTouch(touch, locale, {}, V({ city: null }));
      const where = `${locale}/${touch}`;
      assert.ok(!subject.includes("{"), `${where}: ${subject}`);
      assert.ok(!body.includes("{"), `${where}: ${body}`);
      assert.ok(!/\bnull\b/.test(body), `${where}: leaked null`);
      assert.ok(!body.includes("NoCity"), `${where}: leaked a key name: ${body}`);
    }
  }
});

// ---- the day-0 email (t1) ----

test("the day-0 email carries the whole offer, in every locale", () => {
  for (const locale of LOCALES) {
    const { subject, body } = buildRecruitingEmail(locale, {}, V());
    // fr/es/de correctly typeset a space before the percent sign ("70 %"),
    // so match on the number + sign rather than the exact glyph run.
    assert.match(body, /70\s?%/, `${locale}: lost the 70% term`);
    assert.match(body, /30\s?%/, `${locale}: lost the 30% term`);
    assert.ok(body.includes("Girona"), `${locale}: lost the city`);
    assert.ok(body.includes(JOIN_URL), `${locale}: lost the join link`);
    assert.ok(subject.length > 0 && !subject.includes("{"), `${locale}: bad subject: ${subject}`);
  }
});

// The old copy promised "email, SMS or WhatsApp". WhatsApp is not a channel —
// OFFER_CHANNELS is ["email","sms","push"]. A promise broken on day one.
test("no touch promises WhatsApp, in any locale", () => {
  for (const touch of RECRUIT_TOUCHES) {
    for (const locale of LOCALES) {
      const { body } = buildRecruitingTouch(touch, locale, {}, V());
      assert.ok(!/whatsapp/i.test(body), `${locale}/${touch} promises WhatsApp: ${body}`);
    }
  }
});

// We only earned the right to praise a shop's reviews if we actually saw some.
// The line still renders either way — without it the email has no reason for
// having arrived at this particular shop.
test("the 'well reviewed' claim only appears when we have reviews", () => {
  const withReviews = buildRecruitingTouch("t1", "en", {}, V({ hasReviews: true }));
  assert.match(withReviews.body, /well reviewed/);

  const without = buildRecruitingTouch("t1", "en", {}, V({ hasReviews: false }));
  assert.ok(!/review/i.test(without.body), `claimed reviews with no review data: ${without.body}`);
  assert.match(without.body, /looking at florists/);
});

test("the evidence line renders in both states, in every locale", () => {
  for (const locale of LOCALES) {
    for (const hasReviews of [true, false]) {
      const { body } = buildRecruitingTouch("t1", locale, {}, V({ hasReviews }));
      assert.ok(!/\n\n\n/.test(body), `${locale}/${hasReviews}: orphaned blank line:\n${body}`);
      assert.ok(body.includes("Girona"), `${locale}/${hasReviews}: lost the city`);
    }
  }
});

test("no join link means no CTA at all, never a dead button", () => {
  for (const touch of RECRUIT_TOUCHES) {
    const built = buildRecruitingTouch(touch, "en", {}, V({ joinUrl: null }));
    assert.equal(built.cta, null, `${touch}: rendered a CTA with no joinUrl`);
    assert.ok(!/https?:\/\//.test(built.body), `${touch}: rendered a link with no joinUrl`);
  }
  const legacy = buildRecruitingEmail("en", {}, V({ joinUrl: null }));
  assert.ok(!/https?:\/\//.test(legacy.body), `legacy wrapper rendered a link: ${legacy.body}`);
});

test("a DB override replaces recruiting copy without a deploy", () => {
  const { subject } = buildRecruitingTouch("t1", "en", { "email.recruit.t1.subject": "OVERRIDDEN {city}" }, V());
  assert.equal(subject, "OVERRIDDEN Girona");
});

// ---- SMS ----

test("both SMS touches always carry the opt-out link", () => {
  // This goes to a shop that never asked to hear from us, so the link is the
  // only way they can make it stop.
  for (const touch of ["t1", "r1"]) {
    for (const locale of LOCALES) {
      const body = buildRecruitingSmsContent(
        locale, {},
        { city: "Girona", joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL, personaName: "Marta Ruiz" },
        touch
      );
      assert.ok(body.includes(UNSUB_URL), `${locale}/${touch}: missing opt-out link`);
      assert.ok(body.includes(JOIN_URL), `${locale}/${touch}: missing join link`);
      assert.ok(!body.includes("{"), `${locale}/${touch}: unreplaced placeholder: ${body}`);
      assert.ok(!body.includes("sms.recruit."), `${locale}/${touch}: unresolved catalog key: ${body}`);
    }
  }
});

test("every locale's recruiting SMS stays GSM-7 and within 3 segments", () => {
  // One accented character flips the whole message to 67-char UCS-2 segments
  // and doubles the bill. If this fails, SHORTEN THE COPY — do not raise the
  // limit.
  for (const touch of ["t1", "r1"]) {
    for (const locale of LOCALES) {
      const body = buildRecruitingSmsContent(
        locale, {},
        { city: "Girona", joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL, personaName: "Marta Ruiz" },
        touch
      );
      assert.ok(isGsm7(body), `${locale}/${touch}: non-GSM-7 characters in: ${body}`);
      const segments = smsSegments(body);
      assert.ok(segments <= 3, `${locale}/${touch}: ${segments} segments (${body.length} chars): ${body}`);
    }
  }
});

test("an accented city is folded before it can wreck the segment count", () => {
  for (const locale of LOCALES) {
    const body = buildRecruitingSmsContent(locale, {}, { city: "Málaga", joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL });
    assert.ok(isGsm7(body), `${locale}: accented city left the message non-GSM-7: ${body}`);
    assert.ok(smsSegments(body) <= 3, `${locale}: over budget with an accented city`);
  }
});

// A persona name is the one piece of copy nobody proof-reads for encoding,
// and it is interpolated into every re-engagement text we send. Two cases that
// behave differently: "é" IS in the GSM-7 basic set and must survive intact,
// while "ç"/"ã" are NOT and must fold — getting the second one wrong doubles
// the bill on every send in that market.
test("a GSM-7 accent in a persona name survives intact", () => {
  for (const locale of LOCALES) {
    const body = buildRecruitingSmsContent(
      locale, {},
      { city: "Girona", joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL, personaName: "Amélie Rousseau" },
      "r1"
    );
    assert.ok(isGsm7(body), `${locale}: ${body}`);
    assert.ok(body.includes("Amélie"), `${locale}: mangled a GSM-7-safe name: ${body}`);
    assert.ok(smsSegments(body) <= 3, `${locale}: over budget`);
  }
});

test("a non-GSM-7 persona name is folded before it can wreck the segment count", () => {
  for (const locale of LOCALES) {
    const body = buildRecruitingSmsContent(
      locale, {},
      { city: "Girona", joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL, personaName: "Conceição Zoë" },
      "r1"
    );
    assert.ok(isGsm7(body), `${locale}: non-GSM-7 persona left the message non-GSM-7: ${body}`);
    assert.ok(body.includes("Conceicao Zoe"), `${locale}: fold went wrong: ${body}`);
    assert.ok(smsSegments(body) <= 3, `${locale}: over budget with a folded persona`);
  }
});

test("a null city uses the city-free SMS body", () => {
  const body = buildRecruitingSmsContent("en", {}, { city: null, joinUrl: JOIN_URL, unsubscribeUrl: UNSUB_URL });
  assert.ok(!body.includes("{"), body);
  assert.ok(!/\bnull\b/.test(body), body);
});
