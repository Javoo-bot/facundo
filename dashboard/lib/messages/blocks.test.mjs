import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, serializeBlocks, renderBlocksHtml, renderBlocksText, blockTexts } from "./blocks.ts";

const SAMPLE = [
  { type: "paragraph", html: "Hi there," },
  { type: "steps", items: ["Click <b>Yes</b>", "Get paid 70%"] },
];

test("round-trips through serialize/parse", () => {
  assert.deepEqual(parseBlocks(serializeBlocks(SAMPLE)), SAMPLE);
});

// A malformed override must DEGRADE to the builder's fixed sequence, never
// blank an email. Every one of these returns null so the caller falls back.
test("refuses anything it can't read, rather than rendering a partial body", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "not json",
    "{}",
    "[]",
    '[{"type":"nope","html":"x"}]',
    '[{"type":"paragraph"}]',
    '[{"type":"paragraph","html":"   "}]',
    '[{"type":"steps","items":[]}]',
    '[{"type":"steps","items":["ok", 42]}]',
    '["just a string"]',
    "[null]",
  ]) {
    assert.equal(parseBlocks(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("one bad block refuses the whole override, rather than silently dropping it", () => {
  // Skipping the bad block would publish a body missing a segment the author
  // thinks is there — worse than falling back to the known-good default.
  assert.equal(parseBlocks('[{"type":"paragraph","html":"ok"},{"type":"bogus"}]'), null);
});

test("renders HTML with block content sanitised", () => {
  const html = renderBlocksHtml([
    { type: "paragraph", html: '<b>bold</b> <script>alert(1)</script>' },
    { type: "heading", html: "Title" },
  ]);
  assert.ok(html.includes("<b>bold</b>"));
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes("&lt;script&gt;"), "refused markup should stay visible");
});

test("steps render as a numbered list, in order", () => {
  const html = renderBlocksHtml([{ type: "steps", items: ["first", "second", "third"] }]);
  assert.ok(html.indexOf("first") < html.indexOf("second"));
  assert.ok(html.indexOf("second") < html.indexOf("third"));
  assert.ok(html.includes(">1.<") && html.includes(">2.<") && html.includes(">3.<"));
});

test("the plain-text alternative is derived from the same blocks", () => {
  const text = renderBlocksText(SAMPLE);
  assert.equal(text, "Hi there,\n\n1. Click Yes\n2. Get paid 70%");
  assert.ok(!text.includes("<b>"), "markup leaked into the plain part");
});

test("blockTexts lists every editable fragment in document order", () => {
  assert.deepEqual(blockTexts(SAMPLE), ["Hi there,", "Click <b>Yes</b>", "Get paid 70%"]);
});

test("an empty block list is refused, so a message can never render as nothing", () => {
  assert.equal(parseBlocks("[]"), null);
});

// ---- wired into a real message ----
import { buildOfferEmailContent } from "../offerEmailContent.ts";

const offerVars = {
  area: "Girona · Catalonia", city: "Girona", orderName: "#1234", when: "today",
  replyWindow: "1 hour", deadlineTime: "18:30", deliverBy: "6 Aug 2026, 18:00", payoutPrice: 42,
  assignmentId: "a1", orderUrl: "https://x.test/m/tok", testMode: false,
  floristName: "Roser", variant: "full", unsubscribeUrl: "https://x.test/u",
  howItWorksUrl: "https://x.test/h", helpUrl: "https://x.test/help", supportEmail: "s@x.test",
};

test("with no blocks override the offer email is byte-identical to today", () => {
  const a = buildOfferEmailContent("en", {}, offerVars);
  const b = buildOfferEmailContent("en", { "email.offer.greeting": "Hi," }, offerVars);
  assert.ok(a.html.includes("Hi there,"), "default body changed");
  assert.ok(b.html.includes("Hi,"), "a normal string override still applies");
});

test("a blocks override replaces the body, keeping facts, deadline and footer", () => {
  const blocks = serializeBlocks([
    { type: "heading", html: "A new headline" },
    { type: "paragraph", html: "Rewritten <b>body</b>." },
  ]);
  const { html, bodyText } = buildOfferEmailContent("en", { "email.offer.blocks": blocks }, offerVars);
  assert.ok(html.includes("A new headline"));
  assert.ok(html.includes("Rewritten <b>body</b>."));
  // The default body is gone...
  assert.ok(!html.includes("Hi there,"));
  // ...but everything the send needs is still there.
  assert.ok(html.includes("Your payout"), "facts block lost");
  assert.ok(html.includes("18:30"), "deadline lost");
  assert.ok(html.includes(offerVars.unsubscribeUrl), "unsubscribe lost");
  assert.ok(bodyText.includes("Rewritten body."), bodyText);
});

test("a MALFORMED blocks override falls back to the default body rather than blanking the email", () => {
  const { html } = buildOfferEmailContent("en", { "email.offer.blocks": "not json" }, offerVars);
  assert.ok(html.includes("Hi there,"), "malformed override did not fall back");
});
