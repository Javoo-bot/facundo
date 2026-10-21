import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, serializeBlocks } from "./blocks.ts";
import { sanitizeRichText } from "./richText.ts";

// Mirrors the save path in app/api/messages/drafts/route.ts. Extracted here
// because the interaction it guards is genuinely surprising: two changes that
// are each correct on their own destroy each other when combined.
function saveBlocks(value) {
  const blocks = parseBlocks(value);
  if (!blocks) return null;
  return serializeBlocks(
    blocks.map((b) =>
      b.type === "steps"
        ? { ...b, items: (b.items ?? []).map(sanitizeRichText) }
        : { ...b, html: sanitizeRichText(b.html ?? "") }
    )
  );
}

test("running the sanitiser over the whole JSON payload would destroy it", () => {
  // The bug this exists to prevent. sanitizeRichText escapes every `"` that
  // isn't inside an allowed tag, so a blocks payload comes back out as
  // something JSON.parse rejects, and the render pipeline then silently falls
  // back to the fixed body: the author's edits vanish with no error anywhere.
  const json = serializeBlocks([{ type: "paragraph", html: "Hi there," }]);
  const naive = sanitizeRichText(json);
  assert.notEqual(naive, json);
  assert.equal(parseBlocks(naive), null, "the naive approach must be shown to break parsing");
});

test("saving blocks keeps the JSON parseable and still sanitises the content", () => {
  const json = serializeBlocks([
    { type: "paragraph", html: 'Hi <b>there</b> <script>alert(1)</script>' },
    { type: "steps", items: ["<i>one</i>", '<a href="javascript:alert(1)">two</a>'] },
  ]);
  const saved = saveBlocks(json);
  const round = parseBlocks(saved);
  assert.ok(round, "saved payload must still parse");
  // Formatting the author is allowed to use survives.
  assert.ok(round[0].html.includes("<b>there</b>"));
  assert.ok(round[1].items[0].includes("<i>one</i>"));
  // Everything else is neutralised, exactly as for a plain field.
  assert.ok(!round[0].html.includes("<script"), round[0].html);
  assert.ok(!round[1].items[1].includes("<a"), round[1].items[1]);
  assert.ok(round[1].items[1].includes("two"), "link text should survive");
});

test("an unparseable payload is refused rather than stored", () => {
  // Storing it would produce a draft that can never render: parseBlocks returns
  // null at render time and the message silently reverts to its fixed body.
  for (const bad of ["not json", "[]", '[{"type":"nope"}]', '[{"type":"paragraph","html":""}]']) {
    assert.equal(saveBlocks(bad), null, `accepted ${bad}`);
  }
});

test("saving is idempotent, so re-saving an unchanged body is a no-op", () => {
  const json = serializeBlocks([{ type: "paragraph", html: "Hi <b>there</b>," }]);
  const once = saveBlocks(json);
  assert.equal(saveBlocks(once), once);
});

// ---- formatting now renders in ordinary fields, not only body segments ----
import { buildOfferEmailContent } from "../offerEmailContent.ts";

const vars = {
  area: "Girona · Catalonia", city: "Girona", orderName: "#1234", when: "today",
  replyWindow: "1 hour", deadlineTime: "18:30", deliverBy: "6 Aug 2026, 18:00", payoutPrice: 42,
  assignmentId: "a1", orderUrl: "https://x.test/m/t", testMode: false, floristName: "Roser",
  variant: "full", unsubscribeUrl: "https://x.test/u", howItWorksUrl: "https://x.test/h", helpUrl: "https://x.test/help",
  supportEmail: "s@x.test",
};

test("an editor's bold survives into a real send, in an ordinary (non-blocks) field", () => {
  // Before this, the toolbar could apply formatting that saved fine and then
  // reached the florist as literal "<b>" text, because the shared helpers
  // escaped everything.
  const { html } = buildOfferEmailContent("en", { "email.offer.greeting": "Hi <b>there</b>," }, vars);
  assert.ok(html.includes("Hi <b>there</b>,"), "bold did not render");
  assert.ok(!html.includes("&lt;b&gt;"), "bold was escaped into visible text");
});

test("plain copy renders exactly as before, and dangerous copy is still neutralised", () => {
  const plain = buildOfferEmailContent("en", { "email.offer.greeting": "Tom & Jerry <ok>" }, vars);
  assert.ok(plain.html.includes("Tom &amp; Jerry &lt;ok&gt;"), "plain text escaping changed");

  const nasty = buildOfferEmailContent("en", {
    "email.offer.greeting": '<script>alert(1)</script><a href="javascript:alert(1)">x</a>',
  }, vars);
  assert.ok(!nasty.html.includes("<script"), nasty.html.slice(0, 200));
  assert.ok(!/href="javascript:/i.test(nasty.html));
});

test("markup can never reach a subject line, wherever an editor puts it", async () => {
  // A subject is plain text at the mail layer, so "<b>" would show up in an
  // inbox as literal characters. The builder itself is not the guard: the
  // strip lives in lib/email.ts, at the one point every outbound email passes
  // through, so a builder added later cannot forget it. The preview route
  // applies the same strip so what is shown matches what is sent.
  const { richTextToPlain } = await import("./richText.ts");
  const { subject } = buildOfferEmailContent("en", { "email.offer.subject": "Order in <b>{city}</b>" }, vars);
  const asSent = richTextToPlain(subject);
  assert.ok(!asSent.includes("<b>"), asSent);
  assert.ok(!asSent.includes("</b>"), asSent);
  assert.ok(asSent.includes("Girona"), "the interpolated value must survive the strip");
});
