import test from "node:test";
import assert from "node:assert/strict";

import { composeRecruitingEmail } from "./recruitingEmail.ts";
import { buildRecruitingTouch } from "./recruitingContent.ts";

const PERSONA = {
  id: "p1",
  locale: "en",
  name: "Marta Ruiz",
  role_title: "Florist network",
  signature_note: "Reply to this and it comes straight to me.",
  reply_to: "persona@fc.example.com",
  active: true,
};

function built(overrides = {}) {
  return buildRecruitingTouch("t2", "en", overrides, {
    city: "Girona",
    hasReviews: false,
    joinUrl: "https://florist.fc.example.com/join/abc",
  });
}

test("the plain voice renders no headline and the branded voice does", () => {
  // The one visible difference between the two: a person does not open with a
  // styled headline. If this inverted, every persona-signed follow-up would
  // arrive looking like a marketing email.
  const plain = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: null, testMode: false,
  });
  const branded = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "branded", persona: null, unsubscribeUrl: null, testMode: false,
  });
  assert.notEqual(plain.html, branded.html);
  assert.match(branded.html, /<h1|font-size:\s*2[0-9]px/i);
});

test("the plain-text half carries the same words, the signature and the link", () => {
  const b = built();
  const out = composeRecruitingEmail(b, {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: "https://x.test/u", testMode: false,
  });
  assert.ok(out.bodyText.includes(b.body), "the body itself is in the text half");
  assert.ok(out.bodyText.includes(PERSONA.name), "an email signed by a person says so in text too");
  assert.ok(out.bodyText.includes("https://x.test/u"), "a text-only client can still unsubscribe");
  assert.ok(out.bodyText.includes(b.cta.url), "the CTA survives as a link");
});

test("no persona means no signature, in either half", () => {
  const out = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "branded", persona: null, unsubscribeUrl: null, testMode: false,
  });
  assert.ok(!out.bodyText.includes(PERSONA.name));
  assert.ok(!out.html.includes(PERSONA.name));
});

test("no unsubscribe url renders no unsubscribe line rather than a dead one", () => {
  const out = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: null, testMode: false,
  });
  assert.ok(!/href="[^"]*unsubscribe/i.test(out.html));
});

test("the subject is the touch's subject, untouched", () => {
  const b = built();
  const out = composeRecruitingEmail(b, {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: null, testMode: false,
  });
  assert.equal(out.subject, b.subject);
});

test("an override reaches the composed email — the whole point of the editor", () => {
  // This is the acceptance criterion in one assertion: change the subject
  // string, and the thing that would be SENT carries the new subject.
  const subject = "Urgent, a big order for you today";
  const b = built({ "email.recruit.t2.subject": subject });
  const out = composeRecruitingEmail(b, {
    locale: "en", overrides: { "email.recruit.t2.subject": subject }, voice: "plain",
    persona: PERSONA, unsubscribeUrl: null, testMode: false,
  });
  assert.equal(out.subject, subject);
  // The preheader is the subject, so it must have moved too.
  assert.ok(out.html.includes(subject));
});

test("test mode is visible in the rendered email", () => {
  // That inbox is shared, and a test that looks exactly like a real send is
  // precisely what gets acted on by mistake.
  const real = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: null, testMode: false,
  });
  const testing = composeRecruitingEmail(built(), {
    locale: "en", overrides: {}, voice: "plain", persona: PERSONA, unsubscribeUrl: null, testMode: true,
  });
  assert.notEqual(real.html, testing.html);
});
